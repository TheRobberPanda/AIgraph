//! End-to-end speech recognition against the real model.
//!
//! Downloads ~488MB on first run into the app data directory — the same place
//! the app uses, so running this also installs dictation for real use.
//!
//! ```sh
//! cargo test --test speech -- --ignored --nocapture
//! ```
//!
//! Audio comes from the `test_wavs/` directory inside the model archive itself,
//! so this checks the actual recognizer against known-good speech rather than
//! against something we synthesized to be easy.

use aigraph_lib::stt::capture::Resampler;
use aigraph_lib::stt::model::Models;
use aigraph_lib::stt::parakeet::Parakeet;
use aigraph_lib::stt::{SpeechToText, SAMPLE_RATE};

fn app_data_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/app.aigraph")
}

#[test]
#[ignore = "downloads ~488MB on first run"]
fn transcribes_real_speech() {
    let models = Models::new(&app_data_dir());

    if !models.is_installed() {
        eprintln!("downloading speech models…");
    }
    let paths = models
        .ensure(&|p| {
            if p.total > 0 && p.received % (32 << 20) < (1 << 20) {
                eprintln!("  {} {:.0}%", p.what, (p.received as f64 / p.total as f64) * 100.0);
            }
        })
        .expect("model download failed");

    assert!(models.is_installed(), "install reported success but files are missing");

    let wav_dir = paths.encoder.parent().expect("model dir").join("test_wavs");
    let mut wavs: Vec<_> = std::fs::read_dir(&wav_dir)
        .unwrap_or_else(|e| panic!("no test_wavs at {wav_dir:?}: {e}"))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    wavs.sort();
    assert!(!wavs.is_empty(), "model archive shipped no test audio");

    let mut stt = Parakeet::load(&paths).expect("load recognizer");
    eprintln!("\nmodel: {}\n", stt.model_id());

    for wav in wavs.iter().take(3) {
        let reader = hound::WavReader::open(wav).expect("open wav");
        let spec = reader.spec();
        let raw: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => {
                reader.into_samples::<i16>().map(|s| s.unwrap() as f32 / i16::MAX as f32).collect()
            }
            hound::SampleFormat::Float => {
                reader.into_samples::<f32>().map(|s| s.unwrap()).collect()
            }
        };

        // These clips are 22.05kHz, so they exercise the same resampler the
        // microphone path uses — on real speech, against a real recognizer.
        // If the resampler mangles audio, the transcription degrades here.
        let samples = if spec.sample_rate == SAMPLE_RATE {
            raw
        } else {
            Resampler::new(spec.sample_rate, SAMPLE_RATE).process(&raw)
        };

        let started = std::time::Instant::now();
        let text = stt.transcribe(&samples).expect("transcribe");
        let audio_secs = samples.len() as f32 / SAMPLE_RATE as f32;
        let took = started.elapsed().as_secs_f32();

        eprintln!("{} ({}Hz)", wav.file_name().unwrap().to_string_lossy(), spec.sample_rate);
        eprintln!("  {text:?}");
        eprintln!(
            "  {audio_secs:.1}s audio in {took:.2}s  ({:.1}x real time)\n",
            audio_secs / took.max(0.001)
        );

        assert!(!text.is_empty(), "produced no transcription for {wav:?}");
    }
}

/// Open the microphone, run briefly, and shut down cleanly.
///
/// Needs a real input device. Catches the failures the unit tests cannot: the
/// audio device refusing the format, the recognizer failing to load in the
/// worker thread, and the microphone not being released on stop.
#[test]
#[ignore = "requires a microphone"]
fn dictation_starts_and_stops_cleanly() {
    use aigraph_lib::stt::capture::{Dictation, Event};
    use std::sync::{Arc, Mutex};

    let models = Models::new(&app_data_dir());
    assert!(models.is_installed(), "run transcribes_real_speech first");

    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();

    let started = std::time::Instant::now();
    let dictation = Dictation::start(
        models.paths(),
        Arc::new(move |e| {
            let line = match e {
                Event::Phrase(t) => format!("phrase: {t:?}"),
                Event::Speaking(on) => format!("speaking: {on}"),
                Event::Error(e) => format!("ERROR: {e}"),
            };
            eprintln!("  {line}");
            sink.lock().unwrap().push(line);
        }),
    )
    .expect("dictation failed to start");

    let startup = started.elapsed();
    eprintln!("started in {:.2}s", startup.as_secs_f32());
    assert!(
        startup.as_secs() < 30,
        "start blocked for {startup:?} — it should return once the mic is open, \
         not wait out a timeout"
    );

    eprintln!("listening for 5s (say something)…");
    std::thread::sleep(std::time::Duration::from_secs(5));

    dictation.stop();
    eprintln!("stopped cleanly");

    let seen = events.lock().unwrap();
    let errors: Vec<_> = seen.iter().filter(|l| l.starts_with("ERROR")).collect();
    assert!(errors.is_empty(), "runtime errors: {errors:?}");
}
