//! Session boundaries and archiving.
//!
//! A session is one stretch of thinking. It ends when the user says so, when
//! they've been idle long enough that they've clearly moved on, or when the app
//! closes. All three archive; none discard.

pub mod import;
pub mod transcript;

use std::time::Duration;

use chrono::{DateTime, Utc};

/// How long without a message before a session is considered finished.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Why a session ended. Recorded because "I pressed Done" and "the app decided
/// I was finished" are different events, and if idle-timeouts turn out to be
/// chopping people's thinking in half, this is what shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Done,
    Idle,
    AppClosing,
}

/// A conversation in progress.
#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub started_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub model: String,
}

impl ActiveSession {
    pub fn new(model: impl Into<String>) -> Self {
        let now = Utc::now();
        Self { started_at: now, last_activity: now, model: model.into() }
    }

    pub fn touch(&mut self) {
        self.last_activity = Utc::now();
    }

    pub fn idle_for(&self, now: DateTime<Utc>) -> Duration {
        (now - self.last_activity).to_std().unwrap_or_default()
    }

    pub fn is_idle(&self, now: DateTime<Utc>) -> bool {
        self.is_idle_after(now, IDLE_TIMEOUT)
    }

    /// Whether the session has been quiet for at least `timeout`.
    ///
    /// The caller passes the window because how long counts as "gone" is the
    /// person's decision, not this module's.
    pub fn is_idle_after(&self, now: DateTime<Utc>, timeout: Duration) -> bool {
        self.idle_for(now) >= timeout
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeDelta;

    #[test]
    fn a_fresh_session_is_not_idle() {
        let s = ActiveSession::new("m");
        assert!(!s.is_idle(Utc::now()));
    }

    #[test]
    fn idle_is_measured_from_last_activity_not_start() {
        let mut s = ActiveSession::new("m");
        s.started_at = Utc::now() - TimeDelta::hours(3);
        // Long session, but the user spoke a moment ago — still going.
        assert!(!s.is_idle(Utc::now()));
    }

    #[test]
    fn silence_past_the_timeout_ends_it() {
        let mut s = ActiveSession::new("m");
        s.last_activity = Utc::now() - TimeDelta::minutes(31);
        assert!(s.is_idle(Utc::now()));
    }

    #[test]
    fn touch_keeps_it_alive() {
        let mut s = ActiveSession::new("m");
        s.last_activity = Utc::now() - TimeDelta::minutes(31);
        s.touch();
        assert!(!s.is_idle(Utc::now()));
    }
}
