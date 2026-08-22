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
/// This struct is the chat-purity guarantee made structural. There is no
/// `system` field, no `tools` field, and no `instructions` field — so no future
/// feature can quietly add app instructions to a user's conversation without a
/// visible change to this type and the test that guards it.
///
/// `Role` has no `System` variant for the same reason.
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
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
    #[serde(default)]
    pub strong_points: Vec<String>,
    #[serde(default)]
    pub weak_points: Vec<String>,
}

/// What the model made of the conversation as a whole.
///
/// A session is more than the sum of its claims, and the gaps between them are
/// often the interesting part — so conversation nodes carry their own nudges.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConversationNotes {
    #[serde(default)]
    pub strong_points: Vec<String>,
    #[serde(default)]
    pub weak_points: Vec<String>,
}
