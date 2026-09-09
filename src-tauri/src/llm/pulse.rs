//! Whether a read that has not finished is still going.
//!
//! A digest against a cloud model is one HTTP request that takes minutes and
//! says nothing until it is done. From the outside that is indistinguishable
//! from a hang, and the only honest thing the screen could show was elapsed
//! time — which counts up just as steadily when nothing is coming back.
//!
//! So the streamed extraction path reports here as each frame arrives: how
//! much has come back, and when the last of it did. Two numbers, and between
//! them they answer the two different questions — how far along is it, and is
//! it still alive.
//!
//! Held in statics for the same reason as [`super::meter`]: this is one fact
//! about one run, and threading it out through the extractor trait would mean
//! teaching every provider and every call site about a callback that only ever
//! means one thing.

use std::sync::atomic::{AtomicU64, Ordering};

/// Characters of reply received so far in this run.
static RECEIVED: AtomicU64 = AtomicU64::new(0);
/// Milliseconds since the epoch when the last frame landed. 0 means none yet.
static LAST_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start counting again. Called at the top of a run, beside `meter::reset`.
pub fn reset() {
    RECEIVED.store(0, Ordering::Relaxed);
    LAST_AT.store(0, Ordering::Relaxed);
}

/// Record that `chars` more arrived, just now.
pub fn bump(chars: usize) {
    RECEIVED.fetch_add(chars as u64, Ordering::Relaxed);
    LAST_AT.store(now_ms(), Ordering::Relaxed);
}

/// How much has come back, and how long it has been quiet.
///
/// The silence is `None` before the first frame — at that point nothing has
/// gone quiet, the request simply has not started answering, and reporting a
/// growing silence there would be alarming about the ordinary case.
pub fn read() -> (u64, Option<u64>) {
    let received = RECEIVED.load(Ordering::Relaxed);
    let last = LAST_AT.load(Ordering::Relaxed);
    let quiet = (last > 0).then(|| now_ms().saturating_sub(last));
    (received, quiet)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, not several: these are process-wide statics, so separate
    // tests would interleave and each would see the others' counts.
    #[test]
    fn counts_what_arrives_and_forgets_on_reset() {
        reset();
        assert_eq!(read(), (0, None), "nothing has arrived, so nothing is quiet");

        bump(120);
        let (received, quiet) = read();
        assert_eq!(received, 120);
        assert!(quiet.is_some(), "once something has arrived, silence is measurable");

        bump(80);
        assert_eq!(read().0, 200, "frames add up across a run");

        reset();
        assert_eq!(read(), (0, None));
    }
}
