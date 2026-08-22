//! The live conversation.
//!
//! # The purity rule
//!
//! The chat carries no persona, no tool definitions, no retrieved context, and
//! no extraction instructions — nothing built from what the user said or from
//! what the app knows. The one exception is [`style::SYSTEM_PROMPT`]: a fixed
//! house voice, identical for every conversation and every provider, asking for
//! direct engagement over agreeableness. It is a product decision, not a quiet
//! addition — see `style.rs`.
//!
//! This is enforced two ways:
//!
//! 1. [`Conversation`] only ever grows by real user and assistant turns; the
//!    system prompt is carried separately and is always the same constant.
//! 2. `tests/chat_purity.rs` asserts the serialized request body carries
//!    nothing but the user's own words and that one fixed string.

pub mod style;

use crate::llm::types::{ChatRequest, Message, Role};

#[derive(Debug, Clone)]
pub struct Conversation {
    model: String,
    messages: Vec<Message>,
}

impl Conversation {
    pub fn new(model: impl Into<String>) -> Self {
        Self { model: model.into(), messages: Vec::new() }
    }

    pub fn push_user(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::User, content: content.into() });
    }

    pub fn push_assistant(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::Assistant, content: content.into() });
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
            system: Some(style::SYSTEM_PROMPT.to_string()),
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
    fn request_contains_only_the_conversation_and_the_fixed_house_voice() {
        let mut c = Conversation::new("llama3.2");
        c.push_user("I think latency is the real problem");
        c.push_assistant("What makes you say that?");

        let req = c.to_request();
        let json = serde_json::to_value(&req).unwrap();

        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["messages", "model", "system"],
            "the chat payload grew a field beyond the conversation and the one \
             fixed system prompt — if that field steers the model per-request, \
             the purity promise is broken"
        );
        assert_eq!(req.messages.len(), 2);
        assert_eq!(req.system.as_deref(), Some(style::SYSTEM_PROMPT));
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
