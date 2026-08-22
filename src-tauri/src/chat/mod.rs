//! The live conversation.
//!
//! # The purity rule
//!
//! The chat must behave exactly as the model would outside this app. No system
//! prompt, no persona, no tool definitions, no retrieved context, no extraction
//! instructions. The chat is a listener that helps the user get ideas out; the
//! moment it starts steering, the thing being mapped is no longer purely the
//! user's own thinking.
//!
//! This is enforced three ways, deliberately redundant because it is the kind of
//! promise that erodes quietly:
//!
//! 1. [`ChatRequest`] has no field for app instructions, and [`Role`] has no
//!    `System` variant. There is nowhere to put one.
//! 2. [`Conversation`] only ever grows by real user and assistant turns.
//! 3. `tests/chat_purity.rs` asserts the serialized request body carries nothing
//!    but the user's own words.
//!
//! If a future feature needs to inject context — the backlogged idea-lookup
//! feature will — that is a real product decision that retires this promise. It
//! should require editing this module and deleting a failing test, not slip in
//! as a quiet addition somewhere else.

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

    /// Build the outgoing request. The only transformation applied is `clone`.
    pub fn to_request(&self) -> ChatRequest {
        ChatRequest {
            model: self.model.clone(),
            messages: self.messages.clone(),
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
    fn request_contains_only_the_users_conversation() {
        let mut c = Conversation::new("llama3.2");
        c.push_user("I think latency is the real problem");
        c.push_assistant("What makes you say that?");

        let req = c.to_request();
        let json = serde_json::to_value(&req).unwrap();

        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["messages", "model"],
            "the chat payload grew a field — if that field steers the model, \
             the purity promise is broken"
        );
        assert_eq!(req.messages.len(), 2);
    }

    #[test]
    fn transcript_marks_speakers_for_the_extractor() {
        let mut c = Conversation::new("m");
        c.push_user("hello");
        c.push_assistant("hi");
        assert_eq!(c.to_transcript(), "USER: hello\n\nASSISTANT: hi");
    }
}
