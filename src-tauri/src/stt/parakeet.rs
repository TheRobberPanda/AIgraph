//! Parakeet TDT via sherpa-onnx.

use sherpa_rs::transducer::{TransducerConfig, TransducerRecognizer};

use super::model::ModelPaths;
use super::{SpeechToText, SttError, SAMPLE_RATE};

pub struct Parakeet {
    recognizer: TransducerRecognizer,
}

impl Parakeet {
    pub fn load(paths: &ModelPaths) -> Result<Self, SttError> {
        let recognizer = TransducerRecognizer::new(TransducerConfig {
            encoder: path(&paths.encoder),
            decoder: path(&paths.decoder),
            joiner: path(&paths.joiner),
            tokens: path(&paths.tokens),
            // Leave headroom: the chat model may be decoding on the same machine,
            // and starving it to transcribe faster is the wrong trade.
            num_threads: (std::thread::available_parallelism()
                .map(|n| n.get() as i32)
                .unwrap_or(4)
                / 2)
            .max(2),
            sample_rate: SAMPLE_RATE as i32,
            feature_dim: 80,
            decoding_method: "greedy_search".into(),
            model_type: "nemo_transducer".into(),
            provider: Some("cpu".into()),
            debug: false,
            ..Default::default()
        })
        .map_err(|e| SttError::Recognizer(e.to_string()))?;

        Ok(Self { recognizer })
    }
}

fn path(p: &std::path::Path) -> String {
    p.to_string_lossy().to_string()
}

impl SpeechToText for Parakeet {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, SttError> {
        Ok(self.recognizer.transcribe(SAMPLE_RATE, samples).trim().to_string())
    }

    fn model_id(&self) -> String {
        "parakeet-tdt-0.6b-v3-int8".into()
    }
}
