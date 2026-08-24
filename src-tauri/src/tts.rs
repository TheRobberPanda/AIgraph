//! Reading a reply out in a downloaded voice.
//!
//! The machine's own speech is the default and stays the fallback: it needs no
//! download and it honours whatever voice and rate someone has already tuned,
//! which for anyone who relies on speech is usually the right answer. This is
//! the other option — a Piper VITS voice, run through the sherpa-onnx runtime
//! the dictation model already brings in, so it costs a voice file and no new
//! toolchain.
//!
//! Synthesis is offline and whole-utterance: the text goes in, samples come
//! out, and they are played through the same audio stack `cpal` already gives
//! us for capture. Nothing streams, because a reply short enough to be spoken
//! is short enough to synthesise in one go.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::stt::model::{DownloadProgress, ModelError};

/// A medium-quality English voice: 60 MB, natural enough to listen to, and
/// small enough that the download is not an event. MIT, like Piper itself.
const VOICE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts_r-medium.tar.bz2";
const VOICE_DIR: &str = "vits-piper-en_US-libritts_r-medium";
const VOICE_APPROX_BYTES: u64 = 78_000_000;

pub struct Voices {
    root: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceStatus {
    pub installed: bool,
    pub download_mb: u32,
}

impl Voices {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("models") }
    }

    fn dir(&self) -> PathBuf {
        self.root.join(VOICE_DIR)
    }

    fn model(&self) -> PathBuf {
        self.dir().join("en_US-libritts_r-medium.onnx")
    }

    pub fn status(&self) -> VoiceStatus {
        VoiceStatus {
            installed: self.is_installed(),
            download_mb: (VOICE_APPROX_BYTES / 1_000_000) as u32,
        }
    }

    pub fn is_installed(&self) -> bool {
        self.model().is_file() && self.dir().join("tokens.txt").is_file()
    }

    pub fn install(
        &self,
        on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
    ) -> Result<(), ModelError> {
        if self.is_installed() {
            return Ok(());
        }
        crate::stt::model::fetch_archive(VOICE_URL, &self.root, "voice", VOICE_APPROX_BYTES, on_progress)?;
        if !self.is_installed() {
            return Err(ModelError::Incomplete(VOICE_DIR.into()));
        }
        Ok(())
    }

    /// Speak, blocking until the last sample has been played.
    ///
    /// The voice is built per utterance rather than held open. Loading it costs
    /// well under the time it takes to say a sentence, and a reply that is
    /// being read aloud is not a hot loop — holding an ONNX session for a
    /// feature used a few times an hour is memory spent on nothing.
    pub fn speak(&self, text: &str, speed: f32) -> Result<(), String> {
        use sherpa_rs::tts::{VitsTts, VitsTtsConfig};

        if !self.is_installed() {
            return Err("the voice has not been downloaded yet".into());
        }
        let mut tts = VitsTts::new(VitsTtsConfig {
            model: self.model().to_string_lossy().to_string(),
            tokens: self.dir().join("tokens.txt").to_string_lossy().to_string(),
            data_dir: self.dir().join("espeak-ng-data").to_string_lossy().to_string(),
            length_scale: 1.0,
            noise_scale: 0.667,
            noise_scale_w: 0.8,
            ..Default::default()
        });
        let audio = tts.create(text, 0, speed.clamp(0.5, 2.0)).map_err(|e| e.to_string())?;
        play(&audio.samples, audio.sample_rate)
    }
}

/// Play mono f32 samples at the rate they were produced.
///
/// Resampled by repetition to whatever the device actually offers. Crude, and
/// audible only as a very slight roughness — the alternative is a resampling
/// dependency for one feature that speaks at 22 kHz into a 48 kHz device.
fn play(samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no audio output device")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    let out_rate = config.sample_rate() as f64;
    let channels = config.channels() as usize;
    let step = sample_rate as f64 / out_rate;

    let source: Arc<Vec<f32>> = Arc::new(samples.to_vec());
    let cursor = Arc::new(Mutex::new(0.0f64));
    let done = Arc::new(Mutex::new(false));

    let (src, cur, fin) = (source.clone(), cursor.clone(), done.clone());
    let stream = device
        .build_output_stream(
            config.config(),
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut pos = cur.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    let i = *pos as usize;
                    let v = if i < src.len() {
                        *pos += step;
                        src[i]
                    } else {
                        *fin.lock().unwrap() = true;
                        0.0
                    };
                    for s in frame.iter_mut() {
                        *s = v;
                    }
                }
            },
            move |e| tracing::warn!(error = %e, "speech playback"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;

    // Wall-clock bounded rather than waiting only on the flag: a device that
    // stops calling back would otherwise hang the task forever.
    let expected = samples.len() as f64 / sample_rate as f64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(expected + 2.0);
    while !*done.lock().unwrap() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    Ok(())
}
