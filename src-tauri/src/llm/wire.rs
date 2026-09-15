//! What actually came back over the wire, second by second.
//!
//! [`super::pulse`] answers "is it alive" with two numbers. That is enough for
//! the queue, and not enough to tell *why* a read is slow: a router still
//! queueing the request, a model thinking before it answers, and a model
//! writing slowly all show up there as the same long wait. They look nothing
//! alike here. A router waiting on its provider sends keep-alive comments and
//! no tokens; a thinking model sends reasoning and no answer; a slow one sends
//! answer at a low rate.
//!
//! Kept for the debug log (the pulse icon in the top bar): per-second buckets for the last few
//! minutes, the request in flight, and a short list of the moments worth
//! naming. Characters, not tokens — nothing on the stream says how many tokens
//! a fragment was, and a guess dressed up as a count is worse than an honest
//! unit.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

/// How many seconds of buckets are kept.
const SECONDS_KEPT: usize = 300;
/// How many events are kept.
const EVENTS_KEPT: usize = 200;

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Second {
    /// Seconds since the epoch.
    pub at: u64,
    /// Raw bytes off the socket, pings and framing included.
    pub bytes: u64,
    /// Characters of answer.
    pub content: u64,
    /// Characters of reasoning — shown, never kept.
    pub reasoning: u64,
    /// Keep-alive comments: the server saying it is still there, and nothing else.
    pub pings: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub at_ms: u64,
    pub text: String,
}

/// The request in flight, or the last one.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Request {
    pub model: String,
    pub streamed: bool,
    pub prompt_chars: u64,
    pub started_ms: u64,
    pub first_byte_ms: Option<u64>,
    pub first_token_ms: Option<u64>,
    pub last_token_ms: Option<u64>,
    pub bytes: u64,
    pub content: u64,
    pub reasoning: u64,
    pub pings: u32,
    /// None while it runs; how it ended once it has.
    pub outcome: Option<String>,
    pub ended_ms: Option<u64>,
    /// The end of the answer so far, for reading along in the log.
    pub output: String,
    /// The end of the reasoning so far. Shown in the log, kept nowhere else.
    pub thinking: String,
    /// Reasoning is on only because this model will not answer with it off.
    pub reasoning_forced: bool,
}

/// What the app has spent on one model since it started.
#[derive(Debug, Clone, Serialize)]
pub struct ModelSpend {
    pub model: String,
    pub usd: f64,
    pub calls: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Snapshot {
    pub now_ms: u64,
    pub seconds: Vec<Second>,
    pub events: Vec<Event>,
    pub request: Option<Request>,
}

struct Wire {
    seconds: VecDeque<Second>,
    events: VecDeque<Event>,
    request: Option<Request>,
}

static WIRE: Mutex<Wire> =
    Mutex::new(Wire { seconds: VecDeque::new(), events: VecDeque::new(), request: None });

/// Dollars and priced calls by model, since the app started.
static SPENT: Mutex<std::collections::BTreeMap<String, (f64, u32)>> =
    Mutex::new(std::collections::BTreeMap::new());

/// How many bytes of answer, and of reasoning, the log keeps to show.
const TAIL_KEPT: usize = 16_000;

/// Append, keeping only the last `TAIL_KEPT` bytes or so. Trimmed in one go
/// once it has grown to twice that, so a long reply is not re-cut every token.
fn keep_tail(s: &mut String, add: &str) {
    s.push_str(add);
    if s.len() > 2 * TAIL_KEPT {
        let mut cut = s.len() - TAIL_KEPT;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with(f: impl FnOnce(&mut Wire, u64)) {
    let now = now_ms();
    let mut w = WIRE.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut w, now);
}

impl Wire {
    /// This second's bucket, started if the clock has moved on.
    fn bucket(&mut self, now: u64) -> &mut Second {
        let at = now / 1000;
        if self.seconds.back().map_or(true, |s| s.at != at) {
            self.seconds.push_back(Second { at, ..Default::default() });
            while self.seconds.len() > SECONDS_KEPT {
                self.seconds.pop_front();
            }
        }
        self.seconds.back_mut().expect("just pushed")
    }

    fn event(&mut self, now: u64, text: String) {
        self.events.push_back(Event { at_ms: now, text });
        while self.events.len() > EVENTS_KEPT {
            self.events.pop_front();
        }
    }

    /// The request still running, if there is one.
    fn live(&mut self) -> Option<&mut Request> {
        self.request.as_mut().filter(|r| r.outcome.is_none())
    }
}

/// A request is about to be sent.
pub fn begin(model: &str, prompt_chars: usize, streamed: bool) {
    with(|w, now| {
        w.request = Some(Request {
            model: model.to_string(),
            streamed,
            prompt_chars: prompt_chars as u64,
            started_ms: now,
            ..Default::default()
        });
        let how =
            if streamed { "streamed" } else { "not streamed — nothing to see until it ends" };
        w.event(now, format!("sent {prompt_chars} chars to {model} ({how})"));
    });
}

/// Bytes arrived off the socket.
pub fn bytes(n: usize) {
    with(|w, now| {
        w.bucket(now).bytes += n as u64;
        if let Some(r) = w.live() {
            r.bytes += n as u64;
            if r.first_byte_ms.is_none() {
                r.first_byte_ms = Some(now);
                let wait = now.saturating_sub(r.started_ms);
                w.event(now, format!("first byte after {:.1}s", wait as f64 / 1000.0));
            }
        }
    });
}

/// A keep-alive comment: the server is there, the model has said nothing.
pub fn ping() {
    with(|w, now| {
        w.bucket(now).pings += 1;
        if let Some(r) = w.live() {
            r.pings += 1;
        }
    });
}

/// Model output arrived.
pub fn token(reasoning: bool, text: &str) {
    let chars = text.chars().count();
    with(|w, now| {
        let b = w.bucket(now);
        if reasoning {
            b.reasoning += chars as u64;
        } else {
            b.content += chars as u64;
        }
        let Some(r) = w.live() else { return };
        if reasoning {
            r.reasoning += chars as u64;
            keep_tail(&mut r.thinking, text);
        } else {
            r.content += chars as u64;
            keep_tail(&mut r.output, text);
        }
        r.last_token_ms = Some(now);
        if r.first_token_ms.is_none() {
            r.first_token_ms = Some(now);
            let wait = now.saturating_sub(r.started_ms);
            let kind = if reasoning { "reasoning" } else { "answer" };
            w.event(now, format!("first {kind} after {:.1}s", wait as f64 / 1000.0));
        }
    });
}

/// Something worth a line in the log.
pub fn note(text: impl Into<String>) {
    let text = text.into();
    with(|w, now| w.event(now, text));
}

/// The request in flight has reasoning on because the model insists.
///
/// Said in the log because it is usually the whole explanation for a long
/// wait before the first word of the answer.
pub fn forced(model: &str) {
    with(|w, now| {
        let Some(r) = w.live() else { return };
        if r.reasoning_forced {
            return;
        }
        r.reasoning_forced = true;
        w.event(
            now,
            format!(
                "reasoning turned on: {model} will not answer with it off — asking it to keep \
                 the thinking short"
            ),
        );
    });
}

/// What one call cost, from the `usage` object OpenRouter sends when asked.
pub fn spent(model: &str, usage: Option<&serde_json::Value>) {
    let Some(cost) = usage.and_then(|u| u.get("cost")).and_then(|c| c.as_f64()) else { return };
    let mut s = SPENT.lock().unwrap_or_else(|p| p.into_inner());
    let e = s.entry(model.to_string()).or_insert((0.0, 0));
    e.0 += cost;
    e.1 += 1;
}

/// Spending by model since the app started.
pub fn spending() -> Vec<ModelSpend> {
    let s = SPENT.lock().unwrap_or_else(|p| p.into_inner());
    s.iter()
        .map(|(m, (usd, calls))| ModelSpend { model: m.clone(), usd: *usd, calls: *calls })
        .collect()
}

/// The request ended, however it ended.
pub fn end(outcome: &str) {
    with(|w, now| {
        let Some(r) = w.live() else { return };
        r.outcome = Some(outcome.to_string());
        r.ended_ms = Some(now);
        let took = now.saturating_sub(r.started_ms) as f64 / 1000.0;
        let line = format!(
            "{outcome} after {took:.1}s — {} chars of answer, {} of reasoning, {} pings",
            r.content, r.reasoning, r.pings
        );
        w.event(now, line);
    });
}

pub fn snapshot() -> Snapshot {
    let now = now_ms();
    let w = WIRE.lock().unwrap_or_else(|p| p.into_inner());
    Snapshot {
        now_ms: now,
        seconds: w.seconds.iter().copied().collect(),
        events: w.events.iter().cloned().collect(),
        request: w.request.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the log is a process-wide static.
    #[test]
    fn a_request_is_followed_from_sending_to_its_end() {
        begin("m", 1200, true);
        bytes(40);
        ping();
        forced("m");
        token(true, "0123456789");
        token(false, &"a".repeat(25));
        end("finished");
        // Arrivals after the end still count on the wire, not on the request.
        token(false, "bbbbb");

        let s = snapshot();
        let r = s.request.expect("a request was begun");
        assert_eq!((r.bytes, r.pings, r.reasoning, r.content), (40, 1, 10, 25));
        assert_eq!((r.thinking.as_str(), r.output.len()), ("0123456789", 25));
        assert!(r.reasoning_forced);
        assert!(s.events.iter().any(|e| e.text.starts_with("reasoning turned on")));
        assert_eq!(r.outcome.as_deref(), Some("finished"));
        assert!(r.first_byte_ms.is_some() && r.first_token_ms.is_some());
        let total: u64 = s.seconds.iter().map(|b| b.content).sum();
        assert!(total >= 30);
        assert!(s.events.iter().any(|e| e.text.starts_with("first reasoning")));

        spent("m", Some(&serde_json::json!({ "cost": 0.25 })));
        spent("m", Some(&serde_json::json!({ "cost": 0.5 })));
        spent("m", Some(&serde_json::json!({ "prompt_tokens": 3 })));
        let m = spending().into_iter().find(|m| m.model == "m").expect("spent on m");
        assert_eq!((m.usd, m.calls), (0.75, 2));
    }

    #[test]
    fn the_kept_tail_stays_bounded_and_whole() {
        let mut s = String::new();
        for _ in 0..TAIL_KEPT {
            keep_tail(&mut s, "é");
        }
        assert!(s.len() <= 2 * TAIL_KEPT && s.chars().all(|c| c == 'é'));
    }
}
