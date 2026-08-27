//! What the last stretch of model work actually cost.
//!
//! llama.cpp reports its own timings with every completion — how many tokens
//! it read, how many it wrote, and how long each took. They are the only
//! numbers here that are measured rather than inferred, and they are the ones
//! worth keeping: "the digest took four minutes" is a complaint, "it read
//! 6,200 tokens at 41/s and wrote 900 at 3/s" is a diagnosis.
//!
//! Kept in a static rather than threaded through the extractor trait, for the
//! same reason as the language pin: this is one number about one run, and
//! every signature between here and the caller would have to learn about it.
//! A digest resets the tally, runs however many passes it needs, and reads the
//! total back at the end.

use std::sync::Mutex;

/// Tokens and milliseconds, summed over every call in one run.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
pub struct Tally {
    pub calls: u32,
    pub read_tokens: u64,
    pub read_ms: f64,
    pub wrote_tokens: u64,
    pub wrote_ms: f64,
}

impl Tally {
    /// Prompt tokens a second, or None when nothing was measured.
    pub fn read_per_second(&self) -> Option<f64> {
        rate(self.read_tokens, self.read_ms)
    }

    /// Written tokens a second, or None when nothing was measured.
    pub fn wrote_per_second(&self) -> Option<f64> {
        rate(self.wrote_tokens, self.wrote_ms)
    }

    pub fn measured(&self) -> bool {
        self.calls > 0 && (self.read_ms > 0.0 || self.wrote_ms > 0.0)
    }
}

fn rate(tokens: u64, ms: f64) -> Option<f64> {
    if tokens == 0 || ms <= 0.0 {
        return None;
    }
    Some(tokens as f64 / (ms / 1000.0))
}

static TALLY: Mutex<Tally> =
    Mutex::new(Tally { calls: 0, read_tokens: 0, read_ms: 0.0, wrote_tokens: 0, wrote_ms: 0.0 });

/// Start counting again. Called at the top of a run.
pub fn reset() {
    if let Ok(mut t) = TALLY.lock() {
        *t = Tally::default();
    }
}

/// Add one completion's `timings` object, if the server sent one.
///
/// Servers that report nothing simply leave the tally where it was, which is
/// why the reader has to cope with an unmeasured run rather than showing a
/// zero as though it were a measurement.
pub fn record(timings: Option<&serde_json::Value>) {
    let Some(t) = timings else { return };
    let num = |k: &str| t.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    if let Ok(mut tally) = TALLY.lock() {
        tally.calls += 1;
        tally.read_tokens += num("prompt_n") as u64;
        tally.read_ms += num("prompt_ms");
        tally.wrote_tokens += num("predicted_n") as u64;
        tally.wrote_ms += num("predicted_ms");
    }
}

/// The tally so far.
pub fn read() -> Tally {
    TALLY.lock().map(|t| *t).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, not two: `reset`/`record`/`read` share one process-wide static,
    // so two tests touching it run as one no matter how they're written —
    // `cargo test`'s default parallelism was interleaving them and each saw
    // the other's numbers. Combined here rather than serialized, since they
    // were really assertions about one sequence of calls to begin with.
    #[test]
    fn a_run_is_measured_and_a_fresh_one_starts_from_nothing() {
        reset();
        record(None);
        assert!(!read().measured(), "no timings reported means nothing to measure");
        assert_eq!(read().wrote_per_second(), None);

        reset();
        let pass = serde_json::json!({
            "prompt_n": 1000, "prompt_ms": 2000.0,
            "predicted_n": 100, "predicted_ms": 10000.0
        });
        record(Some(&pass));
        record(Some(&pass));
        let t = read();
        assert_eq!(t.calls, 2);
        assert_eq!(t.read_tokens, 2000);
        assert_eq!(t.read_per_second(), Some(500.0));
        assert_eq!(t.wrote_per_second(), Some(10.0));
    }
}
