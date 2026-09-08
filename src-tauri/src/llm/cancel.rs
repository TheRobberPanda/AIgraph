//! Stopping a generation that is already running.
//!
//! Everything that streams takes a ticket before it starts and checks it
//! between frames. Stopping sets a watermark: every ticket issued so far is
//! cancelled, and anything started afterwards is not. That is the honest
//! meaning of a Stop button — end what is running now, without racing the
//! next request into the same switch.
//!
//! Held in statics rather than threaded through [`ChatProvider`] because the
//! signature would have to change in every provider and at every call site to
//! carry a flag that only ever means one thing.
//!
//! Returning early drops the response body, which closes the connection, which
//! is what actually stops the server working — not just this end reading. A
//! flag the loop merely ignores would leave llama.cpp filling a slot nobody is
//! listening to.

use std::sync::atomic::{AtomicU64, Ordering};

/// The next ticket to hand out. Starts at 1 so that 0 can mean "nothing
/// cancelled yet".
static NEXT: AtomicU64 = AtomicU64::new(1);
/// Every ticket less than or equal to this has been told to stop.
static STOP_UP_TO: AtomicU64 = AtomicU64::new(0);

/// A running generation's claim on being allowed to continue.
#[derive(Debug)]
pub struct Ticket(u64);

impl Ticket {
    /// Whether this generation has been told to stop since it started.
    pub fn cancelled(&self) -> bool {
        self.0 <= STOP_UP_TO.load(Ordering::SeqCst)
    }
}

/// Take a ticket. Called at the top of every stream.
pub fn start() -> Ticket {
    Ticket(NEXT.fetch_add(1, Ordering::SeqCst))
}

/// Stop everything currently running, and nothing that starts after this.
pub fn stop_all() {
    // Every ticket handed out so far is strictly below `NEXT`.
    let issued = NEXT.load(Ordering::SeqCst).saturating_sub(1);
    STOP_UP_TO.fetch_max(issued, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, not two: these share process-wide statics, so two of them run
    // as one however they are written — `cargo test`'s default parallelism
    // interleaves them and each sees the other's watermark.
    #[test]
    fn stopping_ends_what_is_running_and_spares_what_follows() {
        let running = start();
        assert!(!running.cancelled());

        stop_all();
        assert!(running.cancelled(), "the one in flight stops");

        // The whole point of the watermark: pressing Stop must not poison the
        // next question asked half a second later.
        let next = start();
        assert!(!next.cancelled(), "the one asked afterwards runs");

        // And stopping again reaches forward, never backwards.
        stop_all();
        assert!(next.cancelled());
        assert!(!start().cancelled());
    }
}
