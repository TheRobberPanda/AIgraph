use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// The complete outgoing chat payload.
///
/// No `tools` field, no `instructions` field, no retrieved context. `system` is
/// the one deliberate exception — see `chat::style` — and it is always the
/// same fixed string, never built from the user's words or from extraction.
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Whether the model may think out loud first. Off means the answer starts
    /// arriving immediately rather than after a page of deliberation nobody
    /// reads.
    #[serde(default)]
    pub reasoning: bool,
}

/// One idea as the model reported it — before verification.
///
/// `quote` is a claim by the model that this text appears verbatim in the
/// transcript. It is not trusted until [`crate::extract::verify`] locates it by
/// exact string search. Deliberately no offset fields: models are unreliable at
/// reporting them, so we never give ourselves the option of believing one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawIdea {
    pub claim: String,
    /// A short, glanceable name for this idea, written from what it means in
    /// context rather than sliced out of the claim's own wording.
    #[serde(default)]
    pub title: String,
    pub quote: String,
    /// Why this passage yields this claim. Shown on hover in a conversation's
    /// deep dive, so the extraction is inspectable rather than magic.
    ///
    /// Asked for while the model is already reading the passage — it cannot be
    /// reconstructed afterwards without a second, worse-informed call.
    #[serde(default)]
    pub reasoning: String,
    /// A short label for what this idea is *about* — "moral philosophy",
    /// "latency", "my sister". Groups the map by subject rather than by which
    /// conversation happened to produce it.
    #[serde(default)]
    pub category: String,
    /// Marginal notes. Often empty — an idea with nothing to add is finished.
    ///
    /// One list rather than a balanced pair on purpose: two arrays invite the
    /// model to fill both, which produced three-for-three every time and meant
    /// no idea could ever be left alone.
    #[serde(default)]
    pub notes: Vec<Note>,
}

/// What the model made of the conversation as a whole.
///
/// A session is more than the sum of its claims, and the gaps between them are
/// often the interesting part — so conversation nodes carry their own nudges.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConversationNotes {
    /// Marginal notes. Often empty — an idea with nothing to add is finished.
    ///
    /// One list rather than a balanced pair on purpose: two arrays invite the
    /// model to fill both, which produced three-for-three every time and meant
    /// no idea could ever be left alone.
    #[serde(default)]
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    /// Something that strengthens the idea.
    Supports,
    /// Something unclear, assumed, or in tension with the rest.
    #[default]
    Questions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub text: String,
    #[serde(default)]
    pub kind: NoteKind,
}

impl NoteKind {
    /// Stored as `strong` / `weak`, the column values already in the database.
    pub fn column(self) -> &'static str {
        match self {
            NoteKind::Supports => "strong",
            NoteKind::Questions => "weak",
        }
    }
}
