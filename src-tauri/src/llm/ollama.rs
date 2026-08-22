//! Ollama provider — the local default.
//!
//! Used for both chat and extraction. Extraction defaults here so that turning
//! your thinking into a graph never costs money or leaves the machine,
//! regardless of which model you chose to talk to.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;

use super::types::{ChatRequest, Message, Role};
use super::{ChatProvider, ChunkKind, IdeaExtractor, LlmError};

pub const DEFAULT_HOST: &str = "http://127.0.0.1:11434";

pub struct Ollama {
    host: String,
    model: String,
    http: reqwest::Client,
}

impl Ollama {
    pub fn new(host: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            model: model.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Is the daemon up? Used to show a useful message instead of a failed call.
    pub async fn is_available(&self) -> bool {
        self.http
            .get(format!("{}/api/tags", self.host))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    message: Option<ChunkMessage>,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
struct ChunkMessage {
    #[serde(default)]
    content: String,
    /// Ollama's equivalent of `reasoning_content` for reasoning models.
    #[serde(default)]
    thinking: Option<String>,
}

#[async_trait]
impl ChatProvider for Ollama {
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
    ) -> Result<String, LlmError> {
        // `req` serializes to exactly {model, messages}. There is no system
        // prompt to forget to strip, because the type has nowhere to put one.
        let body = serde_json::json!({
            "model": req.model,
            "messages": req.messages,
            "stream": true,
        });

        let resp = self
            .http
            .post(format!("{}/api/chat", self.host))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() {
                    LlmError::Unavailable(format!(
                        "Ollama is not reachable at {}. Is it running?",
                        self.host
                    ))
                } else {
                    LlmError::Transport(e.to_string())
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            return Err(LlmError::Transport(format!("{status}: {detail}")));
        }

        // Ollama streams newline-delimited JSON. Chunks split anywhere, so
        // buffer until a newline rather than assuming one object per frame.
        let mut full = String::new();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| LlmError::Transport(e.to_string()))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parsed: ChatChunk = serde_json::from_str(line)
                    .map_err(|e| LlmError::BadOutput(format!("{e}: {line}")))?;
                if let Some(m) = parsed.message {
                    if let Some(thinking) = m.thinking.as_deref() {
                        if !thinking.is_empty() {
                            on_chunk(ChunkKind::Reasoning, thinking);
                        }
                    }
                    if !m.content.is_empty() {
                        on_chunk(ChunkKind::Content, &m.content);
                        full.push_str(&m.content);
                    }
                }
                if parsed.done {
                    return Ok(full);
                }
            }
        }

        Ok(full)
    }

    fn model_id(&self) -> String {
        format!("ollama/{}", self.model)
    }
}

#[async_trait]
impl IdeaExtractor for Ollama {
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

    async fn judge(
        &self,
        prompt: &str,
        schema: serde_json::Value,
    ) -> Result<String, LlmError> {
        self.structured(prompt, schema).await
    }

    fn model_id(&self) -> String {
        format!("ollama/{}", self.model)
    }
}

impl Ollama {
    /// One schema-constrained, reasoning-free JSON call.
    ///
    /// A *separate* conversation object, built from scratch each time. Nothing
    /// here is reachable from the user's chat context — extraction and
    /// reconciliation both depend on that isolation.
    async fn structured(
        &self,
        prompt: &str,
        schema: serde_json::Value,
    ) -> Result<String, LlmError> {
        let messages = vec![Message { role: Role::User, content: prompt.to_string() }];

        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            "format": schema,
            // Same reason as the OpenAI-compatible path: a reasoning model left
            // to itself will think until the budget is gone and return nothing.
            "think": false,
            "options": { "temperature": 0.0, "num_predict": 4096 },
        });

        let resp = self
            .http
            .post(format!("{}/api/chat", self.host))
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;

        #[derive(Deserialize)]
        struct Once {
            message: ChunkMessage,
        }

        let once: Once = resp
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;

        if once.message.content.trim().is_empty() {
            let thought = once.message.thinking.as_deref().unwrap_or("");
            return Err(LlmError::BadOutput(if thought.is_empty() {
                "the model returned an empty reply".into()
            } else {
                "the model produced only reasoning and never answered. Use a \
                 non-reasoning model for this."
                    .to_string()
            }));
        }

        Ok(once.message.content)
    }

    /// Models pulled locally. Parity with the OpenAI-compatible provider so the
    /// UI can offer one model picker regardless of which server is behind it.
    pub async fn list_models(&self) -> Result<Vec<String>, LlmError> {
        #[derive(Deserialize)]
        struct Tags { models: Vec<Tag> }
        #[derive(Deserialize)]
        struct Tag { name: String }

        let tags: Tags = self
            .http
            .get(format!("{}/api/tags", self.host))
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;
        Ok(tags.models.into_iter().map(|m| m.name).collect())
    }
}
