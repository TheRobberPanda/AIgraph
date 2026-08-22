//! Anthropic's API, over raw HTTP.
//!
//! There is no official Anthropic SDK for Rust, so this follows the documented
//! REST shapes directly rather than an OpenAI-compatible shim — the Messages API
//! is not OpenAI-shaped, and pretending otherwise loses thinking blocks,
//! structured outputs, and the refusal stop reason.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;

use super::types::{ChatRequest, Message, Role};
use super::{ChatProvider, ChunkKind, IdeaExtractor, LlmError};

const API: &str = "https://api.anthropic.com/v1";
const VERSION: &str = "2023-06-01";

/// Enough for a long session's worth of ideas without letting a runaway
/// generation cost real money.
const EXTRACT_MAX_TOKENS: u32 = 16_000;
/// Streaming, so a long reply cannot hit the request timeout.
const CHAT_MAX_TOKENS: u32 = 64_000;

/// Models worth offering. Shown in the Models tab when a key is present; the
/// live list comes from the API, and this is only the fallback ordering.
pub const SUGGESTED: &[&str] = &[
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
];

pub struct Anthropic {
    api_key: String,
    model: String,
    http: reqwest::Client,
}

impl Anthropic {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            http: reqwest::Client::new(),
        }
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{API}{path}"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", VERSION)
    }

    /// Models this key can reach.
    pub async fn list_models(&self) -> Result<Vec<String>, LlmError> {
        #[derive(Deserialize)]
        struct Models {
            data: Vec<Model>,
        }
        #[derive(Deserialize)]
        struct Model {
            id: String,
        }

        let resp = self
            .http
            .get(format!("{API}/models"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", VERSION)
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(LlmError::Unavailable("that API key was rejected".into()));
        }
        let models: Models = resp
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;
        Ok(models.data.into_iter().map(|m| m.id).collect())
    }

    async fn error_for(resp: reqwest::Response) -> LlmError {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        match status {
            reqwest::StatusCode::UNAUTHORIZED => {
                LlmError::Unavailable("that API key was rejected".into())
            }
            reqwest::StatusCode::TOO_MANY_REQUESTS => {
                LlmError::Transport("rate limited by Anthropic; try again shortly".into())
            }
            _ => LlmError::Transport(format!("{status}: {body}")),
        }
    }
}

/// Messages are `{role, content}` with the same role names, so the chat request
/// serializes as-is — and, as with every provider here, it has nowhere to put a
/// system prompt.
fn messages_json(messages: &[Message]) -> serde_json::Value {
    serde_json::json!(messages
        .iter()
        .map(|m| serde_json::json!({
            "role": match m.role { Role::User => "user", Role::Assistant => "assistant" },
            "content": m.content,
        }))
        .collect::<Vec<_>>())
}

#[derive(Deserialize)]
struct StreamEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    delta: Option<Delta>,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(rename = "type")]
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[async_trait]
impl ChatProvider for Anthropic {
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
    ) -> Result<String, LlmError> {
        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": CHAT_MAX_TOKENS,
            "messages": messages_json(&req.messages),
            "stream": true,
            // Summarised rather than the default omitted, so a long think reads
            // as working rather than as a frozen screen.
            "thinking": { "type": "adaptive", "display": "summarized" },
        });
        if let Some(system) = &req.system {
            body["system"] = serde_json::json!(system);
        }

        let resp = self
            .post("/messages")
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }

        let mut full = String::new();
        let mut buf = Vec::<u8>::new();
        let mut stream = resp.bytes_stream();
        let mut refused = false;

        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(&chunk.map_err(|e| LlmError::Transport(e.to_string()))?);

            while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let Some(payload) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<StreamEvent>(payload) else {
                    continue;
                };

                if event.kind == "message_delta" {
                    if let Some(d) = &event.delta {
                        if d.stop_reason.as_deref() == Some("refusal") {
                            refused = true;
                        }
                    }
                }

                if event.kind != "content_block_delta" {
                    continue;
                }
                let Some(d) = event.delta else { continue };
                match d.kind.as_deref() {
                    Some("text_delta") => {
                        if let Some(t) = d.text {
                            on_chunk(ChunkKind::Content, &t);
                            full.push_str(&t);
                        }
                    }
                    // Shown live, never kept — same rule as the local providers.
                    Some("thinking_delta") => {
                        if let Some(t) = d.thinking {
                            on_chunk(ChunkKind::Reasoning, &t);
                        }
                    }
                    _ => {}
                }
            }
        }

        if refused && full.trim().is_empty() {
            return Err(LlmError::BadOutput(
                "the model declined to answer this one".into(),
            ));
        }
        Ok(full)
    }

    fn model_id(&self) -> String {
        format!("anthropic/{}", self.model)
    }
}

#[derive(Deserialize)]
struct Completion {
    #[serde(default)]
    content: Vec<Block>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

impl Anthropic {
    /// One schema-constrained JSON call.
    ///
    /// Effort is dialled down rather than thinking switched off: on current
    /// models disabling thinking can push a tool call into the visible text or
    /// leak reasoning tags, while low effort gets the same saving safely.
    async fn structured(
        &self,
        prompt: &str,
        schema: serde_json::Value,
    ) -> Result<String, LlmError> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": EXTRACT_MAX_TOKENS,
            "messages": [{ "role": "user", "content": prompt }],
            "output_config": {
                "effort": "low",
                "format": {
                    "type": "json_schema",
                    "schema": crate::extract::prompt::strict(&schema),
                }
            },
        });

        let resp = self
            .post("/messages")
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(Self::error_for(resp).await);
        }

        let completion: Completion = resp
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;

        if completion.stop_reason.as_deref() == Some("refusal") {
            return Err(LlmError::BadOutput(
                "the model declined to read this conversation back".into(),
            ));
        }

        let text: String = completion
            .content
            .iter()
            .filter(|b| b.kind == "text")
            .filter_map(|b| b.text.clone())
            .collect();

        if text.trim().is_empty() {
            return Err(LlmError::BadOutput("the model returned an empty reply".into()));
        }
        Ok(text)
    }
}

#[async_trait]
impl IdeaExtractor for Anthropic {
    async fn extract(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        let raw = self
            .structured(
                &crate::extract::prompt::build_with_categories(transcript, known_categories),
                crate::extract::prompt::json_schema(),
            )
            .await?;
        crate::extract::prompt::parse(&raw)
    }

    async fn judge(&self, prompt: &str, schema: serde_json::Value) -> Result<String, LlmError> {
        self.structured(prompt, schema).await
    }

    fn model_id(&self) -> String {
        format!("anthropic/{}", self.model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_messages_carry_no_system_prompt() {
        // The purity rule holds for remote providers too.
        let json = messages_json(&[
            Message { role: Role::User, content: "hello".into() },
            Message { role: Role::Assistant, content: "hi".into() },
        ]);
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr.iter().all(|m| m["role"] != "system"));
        assert_eq!(arr[0]["content"], "hello");
    }
}
