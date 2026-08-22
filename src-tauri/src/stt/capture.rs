//! Microphone capture, silence detection, and transcription.
//!
//! Runs on its own thread. cpal's `Stream` is not `Send` on every platform, so
//! it is created, owned, and dropped inside that thread and controlled by
//! channel — never handed across.
//!
//! Flow: mic → downmix to mono → resample to 16kHz → Silero VAD → on each
//! silence boundary, transcribe the segment and emit a phrase.
//!
//! Segmenting on silence rather than streaming word-by-word is deliberate.
//! Parakeet TDT is not built for streaming, and a think-out-loud tool wants
//! whole thoughts anyway — a per-syllable ticker invites you to watch the text
//! instead of following your own thought.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use sherpa_rs::silero_vad::{SileroVad, SileroVadConfig};

use super::model::ModelPaths;
use super::parakeet::Parakeet;
use super::{SpeechToText, SttError, SAMPLE_RATE};

/// Silero's window. Audio is fed in multiples of this.
const VAD_WINDOW: i32 = 512;

pub enum Event {
    /// A finished phrase, transcribed.
    Phrase(String),
    /// Speech detected or not, for a live indicator.
    Speaking(bool),
    Error(String),
}

pub struct Dictation {
    stop: Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Dictation {
    /// Open the microphone and start transcribing.
    ///
    /// `on_event` is called from the worker thread.
    pub fn start(
        paths: ModelPaths,
        on_event: Arc<dyn Fn(Event) + Send + Sync>,
    ) -> Result<Self, SttError> {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();

        let thread = std::thread::spawn(move || {
            // `run` signals readiness itself, the moment the microphone is
            // actually open — not when it finishes, which is never for a working
            // session. Reporting at the end would block `start` for the whole
            // timeout on the success path.
            let reporter = ready_tx.clone();
            if let Err(e) = run(paths, stop_rx, on_event.clone(), ready_tx) {
                let msg = e.to_string();
                // If nobody is waiting any more, the UI still needs to know.
                if reporter.send(Err(e)).is_err() {
                    on_event(Event::Error(msg));
                }
            }
        });

        // Surface setup failures — no microphone, model won't load — as errors
        // from `start` rather than silence that looks like a working mic.
        // Loading the recognizer is the slow part, hence the generous window.
        match ready_rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(Ok(())) => Ok(Self { stop: stop_tx, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SttError::Audio(
                "the microphone did not start within 120s".into(),
            )),
        }
    }

    /// Stop and release the microphone.
    pub fn stop(mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Dictation {
    fn drop(&mut self) {
        // An input device left open is both a privacy problem and a visible one
        // on most desktops, so make it very hard to leak.
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(
    paths: ModelPaths,
    stop: Receiver<()>,
    on_event: Arc<dyn Fn(Event) + Send + Sync>,
    ready: Sender<Result<(), SttError>>,
) -> Result<(), SttError> {
    let mut recognizer = Parakeet::load(&paths)?;

    let mut vad = SileroVad::new(
        SileroVadConfig {
            model: paths.vad.to_string_lossy().to_string(),
            // Long enough not to cut mid-sentence when someone is thinking,
            // short enough that a finished thought appears promptly.
            min_silence_duration: 0.8,
            min_speech_duration: 0.25,
            max_speech_duration: 30.0,
            threshold: 0.5,
            sample_rate: SAMPLE_RATE,
            window_size: VAD_WINDOW,
            provider: Some("cpu".into()),
            num_threads: Some(1),
            debug: false,
        },
        // Seconds of audio the VAD may buffer.
        60.0,
    )
    .map_err(|e| SttError::Recognizer(e.to_string()))?;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| SttError::Audio("no microphone found".into()))?;
    let config = device
        .default_input_config()
        .map_err(|e| SttError::Audio(e.to_string()))?;

    // cpal 0.18: SampleRate is a plain u32.
    let in_rate = config.sample_rate();
    let channels = config.channels() as usize;
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();

    let err_cb = {
        let on_event = on_event.clone();
        move |e: cpal::Error| on_event(Event::Error(e.to_string()))
    };

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config.clone().into(),
            move |data: &[f32], _: &_| {
                let _ = audio_tx.send(mono(data, channels));
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config.clone().into(),
            move |data: &[i16], _: &_| {
                let f: Vec<f32> = data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                let _ = audio_tx.send(mono(&f, channels));
            },
            err_cb,
            None,
        ),
        other => return Err(SttError::Audio(format!("unsupported sample format {other:?}"))),
    }
    .map_err(|e| SttError::Audio(e.to_string()))?;

    stream.play().map_err(|e| SttError::Audio(e.to_string()))?;

    // Open for business. Anything after this is a runtime error, reported as an
    // event rather than as a failure to start.
    let _ = ready.send(Ok(()));

    tracing::info!(in_rate, channels, "dictation started");

    let mut resampler = Resampler::new(in_rate, SAMPLE_RATE);
    let mut speaking = false;

    loop {
        if stop.try_recv().is_ok() {
            break;
        }

        match audio_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(chunk) => {
                let resampled = resampler.process(&chunk);
                if !resampled.is_empty() {
                    vad.accept_waveform(resampled);
                }

                let now_speaking = vad.is_speech();
                if now_speaking != speaking {
                    speaking = now_speaking;
                    on_event(Event::Speaking(speaking));
                }

                while !vad.is_empty() {
                    let segment = vad.front();
                    vad.pop();
                    match recognizer.transcribe(&segment.samples) {
                        Ok(text) if !text.is_empty() => on_event(Event::Phrase(text)),
                        Ok(_) => {}
                        Err(e) => on_event(Event::Error(e.to_string())),
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Whatever was mid-sentence when the user stopped still belongs to them.
    vad.flush();
    while !vad.is_empty() {
        let segment = vad.front();
        vad.pop();
        if let Ok(text) = recognizer.transcribe(&segment.samples) {
            if !text.is_empty() {
                on_event(Event::Phrase(text));
            }
        }
    }

    drop(stream);
    Ok(())
}

/// Average the channels down to mono.
fn mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Rate conversion with a box filter.
///
/// Public because it is genuinely reusable, and because testing it against real
/// speech (see `tests/speech.rs`) is worth far more than testing it against
/// synthetic tones.
///
/// Averaging across each output sample's input window rather than picking the
/// nearest sample matters: plain decimation aliases high frequencies down into
/// the speech band, which a recognizer hears as noise. Cheap, and enough for
/// 44.1/48kHz down to 16kHz.
pub struct Resampler {
    ratio: f64,
    position: f64,
    carry: Vec<f32>,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { ratio: from as f64 / to as f64, position: 0.0, carry: Vec::new() }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if (self.ratio - 1.0).abs() < f64::EPSILON {
            return input.to_vec();
        }

        // Samples left over from last call: an output window can straddle the
        // boundary between two callbacks.
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(input);

        let mut out = Vec::with_capacity((buf.len() as f64 / self.ratio) as usize + 1);
        let mut pos = self.position;

        loop {
            let start = pos;
            let end = pos + self.ratio;
            let (s, e) = (start.floor() as usize, end.ceil() as usize);
            if e > buf.len() {
                break;
            }
            let window = &buf[s..e.min(buf.len())];
            if window.is_empty() {
                break;
            }
            out.push(window.iter().sum::<f32>() / window.len() as f32);
            pos = end;
        }

        let consumed = pos.floor() as usize;
        self.carry = buf[consumed.min(buf.len())..].to_vec();
        self.position = pos - consumed as f64;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_averages_stereo_frames() {
        assert_eq!(mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
    }

    #[test]
    fn mono_passes_single_channel_through() {
        assert_eq!(mono(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resampling_48k_to_16k_thirds_the_samples() {
        let mut r = Resampler::new(48_000, 16_000);
        let out = r.process(&vec![1.0; 4800]);
        // A tenth of a second in, a tenth of a second out.
        assert!((out.len() as i32 - 1600).abs() <= 2, "got {}", out.len());
        assert!(out.iter().all(|s| (*s - 1.0).abs() < 1e-6), "constant signal preserved");
    }

    #[test]
    fn resampling_handles_non_integer_ratios() {
        let mut r = Resampler::new(44_100, 16_000);
        let out = r.process(&vec![0.5; 44_100]);
        assert!((out.len() as i32 - 16_000).abs() <= 3, "got {}", out.len());
    }

    #[test]
    fn resampling_across_chunks_loses_nothing() {
        // The same audio split into awkward chunks must yield the same count as
        // one pass — otherwise samples are dropped at every callback boundary.
        let mut whole = Resampler::new(48_000, 16_000);
        let total = whole.process(&vec![0.25; 9600]).len();

        let mut chunked = Resampler::new(48_000, 16_000);
        let mut n = 0;
        for chunk in vec![0.25f32; 9600].chunks(777) {
            n += chunked.process(chunk).len();
        }
        assert!((n as i32 - total as i32).abs() <= 1, "{n} vs {total}");
    }

    #[test]
    fn matching_rates_pass_through_untouched() {
        let mut r = Resampler::new(16_000, 16_000);
        assert_eq!(r.process(&[0.1, 0.2, 0.3]), vec![0.1, 0.2, 0.3]);
    }
}
