//! The live conversation.
//!
//! # The purity rule
//!
//! The chat carries no persona, no tool definitions, no retrieved context, and
//! no extraction instructions — nothing built from what the user said or from
//! what the app knows. The one exception is the system prompt: a fixed house
//! voice, identical for every conversation and every provider that shares its
//! stance. There are two of them — [`style::SYSTEM_PROMPT`], which argues, and
//! [`style::ORGANIZE_SYSTEM_PROMPT`], which doesn't — and which one is sent is
//! a setting the person chose, not something built from what they said. It is
//! a product decision, not a quiet addition — see `style.rs`.
//!
//! This is enforced two ways:
//!
//! 1. [`Conversation`] only ever grows by real user and assistant turns; the
//!    system prompt is carried separately and is always one of the two fixed
//!    constants.
//! 2. `tests/chat_purity.rs` asserts the serialized request body carries
//!    nothing but the user's own words and one of those two fixed strings.

pub mod style;

use crate::llm::types::{ChatRequest, Message, Role};

/// Remove `[[recall:N]]` markers from a reply.
///
/// The marker earns its keep for exactly as long as the reply is fresh on
/// screen and there's a UI on the other end to turn it into a highlight — a
/// stored turn, a future prompt, or a transcript file has no such UI, so it
/// gets a plain sentence instead of a bracketed number nobody there can use.
pub fn strip_recall_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[[recall:") {
        out.push_str(&rest[..start]);
        match rest[start..].find("]]") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                // Unterminated — a truncated stream, most likely. Drop the
                // dangling fragment rather than show it.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Debug, Clone)]
pub struct Conversation {
    model: String,
    messages: Vec<Message>,
    /// Short answers, because they are being spoken rather than read.
    call_mode: bool,
    /// Ideas already recorded, by id and title, when the setting asks for them.
    ///
    /// The only user-derived thing that ever reaches the system prompt. It is
    /// off by construction unless someone turns it on, and the purity test
    /// checks the shape without it. The id travels with the title so a reply
    /// that draws on one can mark exactly which — see [`style::RECALL_TAIL`].
    recall: Vec<(i64, String)>,
    /// Whether recall has been decided for this conversation. Distinct from
    /// the list being empty, which is a legitimate answer.
    recall_set: bool,
    /// Whether the model may think out loud before answering.
    reasoning: bool,
    /// Argue the substance, or just help lay it out. See
    /// [`crate::settings::ChatStance`].
    stance: crate::settings::ChatStance,
}

impl Conversation {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            messages: Vec::new(),
            call_mode: false,
            recall: Vec::new(),
            recall_set: false,
            reasoning: false,
            stance: crate::settings::ChatStance::Challenge,
        }
    }

    pub fn push_user(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::User, content: content.into() });
    }

    pub fn push_assistant(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::Assistant, content: content.into() });
    }

    pub fn set_call_mode(&mut self, on: bool) {
        self.call_mode = on;
    }

    pub fn set_stance(&mut self, stance: crate::settings::ChatStance) {
        self.stance = stance;
    }

    /// Hand the model what has already been thought, by title.
    ///
    /// Titles scale linearly, so this is capped. Past the cap it becomes a
    /// retrieval problem — an embedding shortlist over titles, which is the
    /// same machinery reconciliation already uses.
    pub fn set_recall(&mut self, titles: Vec<(i64, String)>) {
        self.recall = titles;
        self.recall_set = true;
    }

    /// Whether recall has already been decided for this conversation.
    ///
    /// It is decided once and then left alone. The system prompt is the
    /// beginning of every request, and a server keeps the work it did on a
    /// prefix it has seen before — so a prompt that changes between turns
    /// throws that away from the first token and every turn pays to re-read
    /// the whole conversation. Nothing new can appear in the list mid-way
    /// regardless: extraction runs when a conversation ends.
    pub fn recall_decided(&self) -> bool {
        self.recall_set
    }

    pub fn set_reasoning(&mut self, on: bool) {
        self.reasoning = on;
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Remove one turn, leaving everything else in place.
    ///
    /// Out-of-range is a no-op rather than a panic: by the time this runs the
    /// index came from a UI snapshot that may already be stale (a reply
    /// finished streaming, another turn was deleted), and losing nothing is
    /// the safe direction when that happens.
    pub fn remove(&mut self, index: usize) {
        if index < self.messages.len() {
            self.messages.remove(index);
        }
    }

    /// Take back the last thing said, when it never reached the model.
    ///
    /// Only ever removes a trailing user turn, so it cannot silently swallow
    /// an exchange that did happen.
    pub fn drop_last_user(&mut self) {
        if self.messages.last().map(|m| m.role == Role::User).unwrap_or(false) {
            self.messages.pop();
        }
    }

    /// Rewind to before a turn, dropping it and everything said after it.
    ///
    /// Chat is sequential — a later reply can only be understood in light of
    /// what came before it, so "go back" has to mean the conversation from
    /// that point on, not one arbitrary turn plucked out of the middle.
    pub fn rewind(&mut self, index: usize) {
        if index < self.messages.len() {
            self.messages.truncate(index);
        }
    }

    /// Build the outgoing request. The only additions are a `clone` and the
    /// one fixed house-style system prompt — see the module doc.
    pub fn to_request(&self) -> ChatRequest {
        ChatRequest {
            model: self.model.clone(),
            messages: self.messages.clone(),
            reasoning: self.reasoning,
            system: Some({
                let mut sys = String::from(match self.stance {
                    crate::settings::ChatStance::Challenge => style::SYSTEM_PROMPT,
                    crate::settings::ChatStance::Organize => style::ORGANIZE_SYSTEM_PROMPT,
                });
                sys.push_str(style::NAVIGATION);
                sys.push_str(&crate::settings::language_instruction());
                if self.call_mode {
                    sys.push_str(style::CALL_MODE);
                }
                if !self.recall.is_empty() {
                    sys.push_str(style::RECALL);
                    for (id, title) in &self.recall {
                        sys.push_str("\n- [");
                        sys.push_str(&id.to_string());
                        sys.push_str("] ");
                        sys.push_str(title);
                    }
                    sys.push_str(style::RECALL_TAIL);
                }
                sys
            }),
        }
    }

    /// Render the session for archiving and extraction.
    ///
    /// Delegates to [`crate::session::transcript::render`], which is the single
    /// place transcripts are formatted — text and turn offsets have to be
    /// produced together or they drift.
    pub fn render(&self) -> crate::session::transcript::Rendered {
        crate::session::transcript::render(&self.messages)
    }

    pub fn to_transcript(&self) -> String {
        self.render().text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_one_marker_and_leaves_the_sentence() {
        assert_eq!(
            strip_recall_markers("Debt cuts both ways.[[recall:12]] So does trust."),
            "Debt cuts both ways. So does trust."
        );
    }

    #[test]
    fn strips_several_markers_in_one_reply() {
        assert_eq!(
            strip_recall_markers("First point.[[recall:1]]\n\nSecond point.[[recall:2]]"),
            "First point.\n\nSecond point."
        );
    }

    #[test]
    fn a_reply_with_no_marker_is_untouched() {
        assert_eq!(strip_recall_markers("Nothing recalled here."), "Nothing recalled here.");
    }

    #[test]
    fn a_marker_cut_off_mid_stream_is_dropped_rather_than_shown_raw() {
        assert_eq!(strip_recall_markers("Debt cuts both ways.[[recall:1"), "Debt cuts both ways.");
    }

    #[test]
    fn organize_stance_replaces_the_argumentative_prompt() {
        let mut c = Conversation::new("m");
        c.push_user("something");
        c.set_stance(crate::settings::ChatStance::Organize);
        let sys = c.to_request().system.unwrap();
        assert!(sys.starts_with(style::ORGANIZE_SYSTEM_PROMPT));
        assert!(!sys.starts_with(style::SYSTEM_PROMPT));
    }

    #[test]
    fn the_default_stance_is_unchanged_from_before_the_setting_existed() {
        let c = Conversation::new("m");
        assert!(c.to_request().system.unwrap().starts_with(style::SYSTEM_PROMPT));
    }

    #[test]
    fn request_contains_only_the_conversation_and_the_fixed_house_voice() {
        let mut c = Conversation::new("llama3.2");
        c.push_user("I think latency is the real problem");
        c.push_assistant("What makes you say that?");

        let req = c.to_request();
        let json = serde_json::to_value(&req).unwrap();

        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        // `reasoning` is a switch the person set, carrying nothing of theirs
        // and saying nothing about the subject — it decides whether the model
        // deliberates before answering, not what it answers. Anything beyond
        // these four is a field steering the model per-request, which is what
        // the promise is about.
        assert_eq!(
            keys,
            vec!["messages", "model", "reasoning", "system"],
            "the chat payload grew a field beyond the conversation, the one \
             fixed system prompt, and the reasoning switch — if that field \
             steers the model per-request, the purity promise is broken"
        );
        assert_eq!(req.messages.len(), 2);
        // Composed from compile-time constants only — never from anything the
        // person said. That is the part worth guarding.
        let sys = req.system.as_deref().unwrap();
        assert!(sys.starts_with(style::SYSTEM_PROMPT));
        assert!(sys.contains(style::NAVIGATION));
        assert!(!sys.contains("latency"), "the system prompt drew on the conversation");
    }

    #[test]
    fn call_mode_only_adds_the_brevity_rule() {
        let mut plain = Conversation::new("m");
        plain.push_user("x");
        let mut brief = Conversation::new("m");
        brief.push_user("x");
        brief.set_call_mode(true);

        let a = plain.to_request().system.unwrap();
        let b = brief.to_request().system.unwrap();
        assert!(!a.contains(style::CALL_MODE));
        assert!(b.contains(style::CALL_MODE));
        assert!(b.starts_with(&a), "call mode should append, not rewrite the voice");
    }

    #[test]
    fn transcript_marks_speakers_for_the_extractor() {
        let mut c = Conversation::new("m");
        c.push_user("hello");
        c.push_assistant("hi");
        assert_eq!(c.to_transcript(), "USER: hello\n\nASSISTANT: hi");
    }

    #[test]
    fn removing_a_turn_leaves_the_rest_in_order() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.push_assistant("two");
        c.push_user("three");
        c.remove(1);
        let texts: Vec<_> = c.messages().iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, vec!["one", "three"]);
    }

    #[test]
    fn removing_out_of_range_does_nothing() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.remove(5);
        assert_eq!(c.messages().len(), 1);
    }

    #[test]
    fn rewinding_drops_a_turn_and_everything_after_it() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.push_assistant("two");
        c.push_user("three");
        c.push_assistant("four");
        c.rewind(1);
        let texts: Vec<_> = c.messages().iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, vec!["one"], "everything from the rewind point on should be gone");
    }
}
