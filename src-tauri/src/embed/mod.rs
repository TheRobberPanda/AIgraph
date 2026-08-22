//! Local sentence embeddings.
//!
//! Used to shortlist which existing ideas a new idea might duplicate or refine,
//! so reconciliation never compares all pairs.
//!
//! **Deliberately independent of the chat provider.** Embeddings could be had
//! from whatever server is running — LM Studio and Ollama both expose an
//! embeddings endpoint — but then every model switch would invalidate every
//! stored vector, because vectors from different models aren't comparable. The
//! app has a model picker and expects people to use it, so tying the graph's
//! structure to that choice would mean rebuilding the graph each time. A small
//! fixed local model keeps vectors stable for the life of the database.

use std::path::Path;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

/// Recorded alongside every vector. If this ever changes, stored vectors are no
/// longer comparable with new ones and everything must be re-embedded — hence
/// pinning it here rather than leaving it implicit.
pub const MODEL_ID: &str = "all-MiniLM-L6-v2";
pub const DIMS: usize = 384;

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("embedding model: {0}")]
    Model(String),
}

pub struct Embedder {
    model: TextEmbedding,
}

impl Embedder {
    /// Load the model, downloading it (~90MB) on first use.
    pub fn load(cache_dir: &Path) -> Result<Self, EmbedError> {
        let model = TextEmbedding::try_new(
            TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
                .with_cache_dir(cache_dir.to_path_buf())
                .with_show_download_progress(false),
        )
        .map_err(|e| EmbedError::Model(e.to_string()))?;
        Ok(Self { model })
    }

    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        self.model
            .embed(texts, None)
            .map_err(|e| EmbedError::Model(e.to_string()))
    }

    pub fn embed_one(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
        Ok(self.embed(&[text.to_string()])?.remove(0))
    }
}

/// Cosine similarity.
///
/// fastembed returns normalized vectors, so this is a dot product — but the
/// normalization is not re-checked here, and a caller storing vectors from
/// elsewhere would silently get wrong numbers. Hence the explicit division.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    (dot / denom).clamp(-1.0, 1.0)
}

/// Pack a vector for SQLite. Little-endian f32, which `unpack` reverses.
pub fn pack(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn unpack(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_vectors_are_one() {
        let v = vec![0.3, -0.4, 0.5];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn opposite_vectors_are_minus_one() {
        assert!((cosine(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn orthogonal_vectors_are_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn magnitude_does_not_affect_similarity() {
        // The whole point of cosine: direction matters, length does not.
        assert!((cosine(&[1.0, 2.0], &[10.0, 20.0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn mismatched_or_empty_vectors_are_not_similar() {
        assert_eq!(cosine(&[1.0, 2.0], &[1.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0, "zero vector, no division by zero");
    }

    #[test]
    fn packing_round_trips() {
        let v = vec![0.1, -0.25, 1e-7, 12345.6];
        assert_eq!(unpack(&pack(&v)), v);
    }
}
