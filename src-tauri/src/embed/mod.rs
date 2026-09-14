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

#[cfg(not(target_os = "android"))]
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

/// No embedder on a phone: the ONNX runtime has no Android build. Ideas read
/// on the phone are reconciled when it next syncs with the desktop, which does
/// have one — so the vectors stay from the one fixed model, as above.
/// Uninhabited, so the methods below are provably never reached.
#[cfg(target_os = "android")]
pub enum Embedder {}

#[cfg(target_os = "android")]
impl Embedder {
    pub fn load(_cache_dir: &Path) -> Result<Self, EmbedError> {
        Err(EmbedError::Model("not available on the phone; merged on the desktop at sync".into()))
    }

    pub fn embed(&mut self, _texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        match *self {}
    }

    pub fn embed_one(&mut self, _text: &str) -> Result<Vec<f32>, EmbedError> {
        match *self {}
    }
}

#[cfg(not(target_os = "android"))]
pub struct Embedder {
    model: TextEmbedding,
}

#[cfg(not(target_os = "android"))]
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
        self.model.embed(texts, None).map_err(|e| EmbedError::Model(e.to_string()))
    }

    pub fn embed_one(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
        Ok(self.embed(&[text.to_string()])?.remove(0))
    }
}

/// How close two ideas have to be for the map to draw a correlation, as the
/// cosine of their claims. Higher than recall's floor for a message, because
/// two claims score higher against each other than a chatty message does
/// against a claim: at 0.3 almost every idea on a real map touched every
/// other, and the lines stopped meaning anything.
pub const MAP_CORRELATION_MIN: f32 = 0.45;

/// Correlations drawn from any one idea, at most.
pub const MAP_CORRELATION_PER_IDEA: usize = 2;

/// How far above an idea's usual closeness to everything else a pair has to
/// be, in standard deviations, before it counts as a correlation.
///
/// A fixed floor alone is what made almost every idea correlated: in a folder
/// about one subject every claim is fairly close to every other, so each one's
/// two nearest always cleared it. The line is meant to say "these two belong
/// together more than the rest do", and that is relative to the rest.
pub const MAP_CORRELATION_STANDOUT: f32 = 1.0;

/// Below this many other ideas, "usual closeness" is too few numbers to mean
/// anything, and only the floor and the mutual test apply.
const STANDOUT_MIN_POOL: usize = 5;

/// Pairs of ideas worth a correlation line, as `(a, b, score)` with `a < b`.
///
/// Three tests, all of which must pass:
/// - **floor**: at least `min` cosine;
/// - **mutual**: each is among the other's `k` nearest — so one generic idea
///   close to everything becomes nobody's hub, where before every idea's
///   nearest pointed at it;
/// - **stand-out**: the score is well above what either idea usually scores
///   against the pool (see `MAP_CORRELATION_STANDOUT`).
pub fn correlations(pool: &[(i64, Vec<f32>)], min: f32, k: usize) -> Vec<(i64, i64, f32)> {
    let n = pool.len();
    let mut sim = vec![vec![0.0f32; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let s = cosine(&pool[i].1, &pool[j].1);
            sim[i][j] = s;
            sim[j][i] = s;
        }
    }

    let others = n.saturating_sub(1);
    let bar: Vec<f32> = (0..n)
        .map(|i| {
            if others < STANDOUT_MIN_POOL {
                return f32::NEG_INFINITY;
            }
            let row = (0..n).filter(|&j| j != i).map(|j| sim[i][j]);
            let mean = row.clone().sum::<f32>() / others as f32;
            let var = row.map(|s| (s - mean) * (s - mean)).sum::<f32>() / others as f32;
            mean + MAP_CORRELATION_STANDOUT * var.sqrt()
        })
        .collect();

    // Each idea's k nearest above the floor. Stable, so ties keep pool order.
    let top: Vec<Vec<usize>> = (0..n)
        .map(|i| {
            let mut near: Vec<usize> = (0..n).filter(|&j| j != i && sim[i][j] >= min).collect();
            near.sort_by(|&a, &b| sim[i][b].total_cmp(&sim[i][a]));
            near.truncate(k);
            near
        })
        .collect();

    let mut out = Vec::new();
    for i in 0..n {
        for &j in &top[i] {
            let s = sim[i][j];
            if i < j && top[j].contains(&i) && s >= bar[i] && s >= bar[j] {
                let (a, b) = (pool[i].0, pool[j].0);
                out.push((a.min(b), a.max(b), s));
            }
        }
    }
    out
}

/// The closest vectors in `pool` to `query`: at least `min`, best first, at
/// most `k`. Stable, so ties keep the pool's order. Chat recall ranks with
/// this; the map's correlations are stricter, see `correlations`.
pub fn nearest(query: &[f32], pool: &[(i64, Vec<f32>)], min: f32, k: usize) -> Vec<(i64, f32)> {
    let mut scored: Vec<(i64, f32)> = pool
        .iter()
        .map(|(id, v)| (*id, cosine(query, v)))
        .filter(|(_, score)| *score >= min)
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
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
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
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

#[cfg(test)]
mod correlation_tests {
    use super::correlations;

    fn axis(dims: usize, on: &[usize]) -> Vec<f32> {
        let mut v = vec![0.0; dims];
        for &i in on {
            v[i] = 1.0;
        }
        v
    }

    #[test]
    fn a_generic_idea_does_not_become_everyones_hub() {
        // The hub is 0.5 from each spoke and the spokes nothing to each
        // other. Nearest-per-idea drew a line from every spoke to it; only the
        // hub's own two nearest are mutual.
        let pool = vec![
            (1, axis(4, &[0, 1, 2, 3])),
            (2, axis(4, &[0])),
            (3, axis(4, &[1])),
            (4, axis(4, &[2])),
            (5, axis(4, &[3])),
        ];
        let got = correlations(&pool, 0.45, 2);
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().all(|(a, _, _)| *a == 1));
    }

    #[test]
    fn in_a_folder_where_everything_is_close_only_the_pair_that_stands_out_is_drawn() {
        // Six ideas all 0.5 from each other, as claims on one subject are, and
        // one pair that share something the rest do not. Every idea clears the
        // floor with its two nearest; only the pair stands out.
        let dims = 10;
        let mut pool: Vec<(i64, Vec<f32>)> =
            (0..6).map(|i| (i as i64, axis(dims, &[0, 1 + i]))).collect();
        pool.push((100, axis(dims, &[0, 7, 9])));
        pool.push((101, axis(dims, &[0, 8, 9])));
        let got = correlations(&pool, 0.45, 2);
        let pairs: Vec<(i64, i64)> = got.iter().map(|(a, b, _)| (*a, *b)).collect();
        assert_eq!(pairs, vec![(100, 101)]);
    }
}

#[cfg(test)]
mod nearest_tests {
    use super::nearest;

    #[test]
    fn nearest_keeps_the_closest_above_the_floor_best_first() {
        let pool = vec![
            (1, vec![1.0, 0.0]),
            (2, vec![0.0, 1.0]),
            (3, vec![0.9, 0.1]),
            (4, vec![0.7, 0.7]),
        ];
        let got = nearest(&[1.0, 0.0], &pool, 0.5, 2);
        let ids: Vec<i64> = got.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec![1, 3], "best first, capped at k");
        assert!(
            nearest(&[1.0, 0.0], &pool, 0.5, 10).iter().all(|(id, _)| *id != 2),
            "below the floor is dropped"
        );
    }
}
