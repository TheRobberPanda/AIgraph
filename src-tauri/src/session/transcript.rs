//! Rendering a conversation to the archived transcript.
//!
//! Text and offsets are produced **together, here, once**. Nothing else in the
//! codebase is allowed to render a transcript, because the instant two functions
//! both format one, they drift, and a drifted offset means a dot that highlights
//! the wrong sentence while looking perfectly confident.
//!
//! # Two offset frames
//!
//! There are two, and confusing them is the easiest way to corrupt provenance:
//!
//! - [`TurnSpan::start`] / `end` — where a turn's **content** sits inside the
//!   full transcript. Stored on `turns`.
//! - [`crate::extract::verify::Located`] — where a quote sits inside a single
//!   turn's text. Stored on `evidence`.
//!
//! Absolute position of a quote in the transcript is `turn.start + located.start`.
//! Use [`absolute`] rather than adding them by hand.

use crate::llm::types::{Message, Role};

pub const USER_MARKER: &str = "USER: ";
pub const ASSISTANT_MARKER: &str = "ASSISTANT: ";
const SEPARATOR: &str = "\n\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSpan {
    pub ord: usize,
    pub role: Role,
    /// Byte offset of this turn's content within the transcript.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct Rendered {
    pub text: String,
    pub spans: Vec<TurnSpan>,
}

impl Rendered {
    /// Absolute byte range of a quote located within one turn.
    pub fn absolute(
        &self,
        ord: usize,
        start_in_turn: usize,
        end_in_turn: usize,
    ) -> Option<(usize, usize)> {
        let span = self.spans.iter().find(|s| s.ord == ord)?;
        let (start, end) = (span.start + start_in_turn, span.start + end_in_turn);
        // A range that runs past the turn it belongs to means the offsets came
        // from different text than what was stored. Refuse rather than slice.
        (end <= span.end).then_some((start, end))
    }
}

/// Render messages into the transcript that gets archived and extracted from.
///
/// The `USER:` / `ASSISTANT:` markers let the extraction prompt tell whose words
/// are whose — which is what makes "quote the user, never the assistant"
/// enforceable rather than aspirational.
pub fn render(messages: &[Message]) -> Rendered {
    let mut text = String::new();
    let mut spans = Vec::with_capacity(messages.len());

    for (ord, m) in messages.iter().enumerate() {
        if ord > 0 {
            text.push_str(SEPARATOR);
        }
        text.push_str(match m.role {
            Role::User => USER_MARKER,
            Role::Assistant => ASSISTANT_MARKER,
        });

        let start = text.len();
        text.push_str(&m.content);
        spans.push(TurnSpan { ord, role: m.role, start, end: text.len() });
    }

    Rendered { text, spans }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: Role, content: &str) -> Message {
        Message { role, content: content.into() }
    }

    #[test]
    fn spans_select_exactly_the_content() {
        let msgs = vec![
            msg(Role::User, "latency is the problem"),
            msg(Role::Assistant, "say more"),
            msg(Role::User, "it compounds"),
        ];
        let r = render(&msgs);

        for (i, m) in msgs.iter().enumerate() {
            let span = &r.spans[i];
            assert_eq!(&r.text[span.start..span.end], m.content, "span {i} drifted");
            assert_eq!(span.role, m.role);
        }
    }

    #[test]
    fn absolute_maps_a_quote_into_the_transcript() {
        let msgs = vec![msg(Role::User, "first thing"), msg(Role::User, "latency is the problem")];
        let r = render(&msgs);

        let turn = "latency is the problem";
        let at = turn.find("the problem").unwrap();
        let (s, e) = r.absolute(1, at, at + "the problem".len()).unwrap();
        assert_eq!(&r.text[s..e], "the problem");
    }

    #[test]
    fn absolute_refuses_a_range_that_escapes_its_turn() {
        let r = render(&[msg(Role::User, "short"), msg(Role::User, "also short")]);
        // Past the end of turn 0 — would silently read into the next marker.
        assert_eq!(r.absolute(0, 0, 500), None);
        assert_eq!(r.absolute(99, 0, 1), None, "unknown turn");
    }

    #[test]
    fn multibyte_content_keeps_spans_on_char_boundaries() {
        let msgs = vec![
            msg(Role::User, "caf\u{e9} \u{1F600} thinking"),
            msg(Role::Assistant, "\u{1F680} ok"),
        ];
        let r = render(&msgs);
        for span in &r.spans {
            assert!(r.text.is_char_boundary(span.start));
            assert!(r.text.is_char_boundary(span.end));
        }
        assert_eq!(&r.text[r.spans[0].start..r.spans[0].end], "caf\u{e9} \u{1F600} thinking");
    }

    #[test]
    fn empty_conversation_renders_nothing() {
        let r = render(&[]);
        assert!(r.text.is_empty());
        assert!(r.spans.is_empty());
    }
}
