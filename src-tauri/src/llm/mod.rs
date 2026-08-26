//! Provider abstraction.
//!
//! Two traits, deliberately separate:
//!
//! - [`ChatProvider`] carries the user's conversation and nothing else.
//! - [`IdeaExtractor`] runs over an archived transcript, in its own context.
//!
//! They never share a context. See [`chat`](crate::chat) for why that matters.

pub mod anthropic;
pub mod claude_cli;
pub mod detect;
pub mod embedded;
pub mod meter;
pub mod ollama;
pub mod openai_compat;
pub mod types;

use async_trait::async_trait;
pub use types::*;

/// What a streamed chunk is.
///
/// Reasoning models emit their scratchpad on a separate channel. The two must
/// not be conflated: reasoning is the model thinking, not the model answering.
/// It is shown live so the user isn't staring at a frozen screen, then dropped —
/// it never enters the reply, the archived transcript, or extraction. The
/// diagram maps the user's thinking; the model's scratchpad has no place in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    /// The actual reply.
    Content,
    /// Chain-of-thought. Display-only, never persisted.
    Reasoning,
}

/// A plain conversation with a model.
///
/// Note what [`ChatRequest`] does *not* have: a system prompt, tool definitions,
/// or any other slot for app instructions. The purity rule is enforced by the
/// type, not by reviewer discipline — you cannot leak what you cannot represent.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// Stream a reply, handing each chunk to `on_chunk` as it arrives.
    ///
    /// The returned `String` is the reply alone — reasoning chunks are streamed
    /// to the callback for display but excluded from it.
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
    ) -> Result<String, LlmError>;

    fn model_id(&self) -> String;
}

/// Extraction and reconciliation. Runs against archived text, never live chat.
#[async_trait]
pub trait IdeaExtractor: Send + Sync {
    /// One call over a whole session. Returns raw, *unverified* ideas — the
    /// caller must run them through [`crate::extract::verify`] before trusting
    /// a single quote — plus notes on the conversation as a whole.
    async fn extract(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError>;

    /// A general structured-JSON call, used by reconciliation to adjudicate
    /// whether two claims are the same thought.
    ///
    /// On this trait rather than its own because it shares every property that
    /// matters: reasoning disabled, temperature zero, schema-constrained, and —
    /// most importantly — a context with nothing of the user's chat in it.
    async fn judge(&self, prompt: &str, schema: serde_json::Value) -> Result<String, LlmError>;

    fn model_id(&self) -> String;
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("transport: {0}")]
    Transport(String),
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("model returned unparseable output: {0}")]
    BadOutput(String),
}
