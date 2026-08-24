//! OpenAI-compatible provider.
//!
//! One implementation covers every server that speaks `/v1/chat/completions`:
//! **LM Studio** and llama.cpp locally, OpenAI / OpenRouter / Groq remotely. The
//! only differences are the base URL and whether an API key is attached, so
//! there is no reason for LM Studio to be a separate code path from Ollama's —
//! both are just a local server behind the same two traits.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;

use super::types::{ChatRequest, Message, Role};
use super::{ChatProvider, ChunkKind, IdeaExtractor, LlmError};

/// LM Studio's default local server address.
pub const LM_STUDIO_HOST: &str = "http://127.0.0.1:1234/v1";

/// What a model is good for. An embedding model cannot chat, and offering one
/// as a chat model is a guaranteed dead end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Chat,
    Embedding,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    /// `None` when the server doesn't report load state (remote APIs).
    pub loaded: Option<bool>,
    pub kind: ModelKind,
}

pub struct OpenAiCompat {
    base_url: String,
    model: String,
    api_key: Option<String>,
    /// Shown in errors and stored on evidence rows, so a bad batch of ideas can
    /// be traced to the thing that produced it.
    label: String,
    http: reqwest::Client,
}

impl OpenAiCompat {
    pub fn new(
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: Option<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: model.into(),
            api_key,
            label: label.into(),
            http: reqwest::Client::new(),
        }
    }

    /// LM Studio with its default local server, no key needed.
    pub fn lm_studio(model: impl Into<String>) -> Self {
        Self::new(LM_STUDIO_HOST, model, None, "lmstudio")
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.post(format!("{}{path}", self.base_url));
        match &self.api_key {
            Some(k) => req.bearer_auth(k),
            None => req,
        }
    }

    pub async fn is_available(&self) -> bool {
        let req = self.http.get(format!("{}/models", self.base_url));
        let req = match &self.api_key {
            Some(k) => req.bearer_auth(k),
            None => req,
        };
        req.send().await.map(|r| r.status().is_success()).unwrap_or(false)
    }

    /// Richer model listing, via LM Studio's own endpoint.
    ///
    /// `/v1/models` is the OpenAI-compatible listing, and it reports every
    /// *downloaded* model with no indication of whether it is loaded or even
    /// what it is. Picking from it blindly gets you an embedding model or a 30B
    /// that won't fit, and the failure surfaces much later as a hang.
    ///
    /// `/api/v0/models` is LM Studio-specific and carries `state` and `type`.
    /// Returns `None` for servers that don't have it (OpenAI, OpenRouter, …),
    /// so callers fall back to the plain listing.
    pub async fn list_models_detailed(&self) -> Option<Vec<ModelInfo>> {
        #[derive(Deserialize)]
        struct Models { data: Vec<Model> }
        #[derive(Deserialize)]
        struct Model {
            id: String,
            #[serde(default)]
            state: Option<String>,
            #[serde(default)]
            r#type: Option<String>,
        }

        // This endpoint sits at the host root, not under /v1.
        let root = self.base_url.strip_suffix("/v1").unwrap_or(&self.base_url);
        let resp = self.http.get(format!("{root}/api/v0/models")).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let models: Models = resp.json().await.ok()?;

        Some(
            models
                .data
                .into_iter()
                .map(|m| ModelInfo {
                    loaded: m.state.as_deref().map(|s| s == "loaded"),
                    kind: match m.r#type.as_deref() {
                        Some("embeddings") => ModelKind::Embedding,
                        _ => ModelKind::Chat,
                    },
                    id: m.id,
                })
                .collect(),
        )
    }

    /// Plain OpenAI-compatible listing. Ids only — no state, no type.
    pub async fn list_models(&self) -> Result<Vec<String>, LlmError> {
        #[derive(Deserialize)]
        struct Models { data: Vec<Model> }
        #[derive(Deserialize)]
        struct Model { id: String }

        let req = self.http.get(format!("{}/models", self.base_url));
        let req = match &self.api_key {
            Some(k) => req.bearer_auth(k),
            None => req,
        };
        let models: Models = req
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;
        Ok(models.data.into_iter().map(|m| m.id).collect())
    }

    fn connect_error(&self, e: &reqwest::Error) -> LlmError {
        if e.is_connect() {
            LlmError::Unavailable(format!(
                "{} is not reachable at {}. Is the server running?",
                self.label, self.base_url
            ))
        } else {
            LlmError::Transport(e.to_string())
        }
    }
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Delta,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    /// LM Studio (and other OpenAI-compatible servers fronting reasoning models)
    /// stream chain-of-thought here, separately from `content`.
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[async_trait]
impl ChatProvider for OpenAiCompat {
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
    ) -> Result<String, LlmError> {
        // OpenAI-compatible servers take the system prompt as a leading message.
        let mut messages = Vec::with_capacity(req.messages.len() + 1);
        if let Some(system) = &req.system {
            messages.push(serde_json::json!({ "role": "system", "content": system }));
        }
        messages.extend(req.messages.iter().map(|m| {
            serde_json::json!({
                "role": match m.role { Role::User => "user", Role::Assistant => "assistant" },
                "content": m.content,
            })
        }));
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
        });
        // Two spellings because two families of server read different ones and
        // both ignore the other: llama.cpp takes `reasoning`, and the
        // `enable_thinking` template argument is what LM Studio and vLLM pass
        // through to the chat template. Sending both is how one request works
        // against either.
        if !req.reasoning {
            body["reasoning"] = serde_json::json!("off");
            body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
        }

        let resp = self
            .post("/chat/completions")
            .json(&body)
            .send()
            .await
            .map_err(|e| self.connect_error(&e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            return Err(LlmError::Transport(format!("{status}: {detail}")));
        }

        // Server-sent events: `data: {...}` lines, terminated by `data: [DONE]`.
        // Buffer across chunks — an event can split anywhere, including inside a
        // multibyte character, so decode only whole lines.
        let mut full = String::new();
        let mut buf = Vec::<u8>::new();
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(&chunk.map_err(|e| LlmError::Transport(e.to_string()))?);

            while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let line = line.trim();

                let Some(payload) = line.strip_prefix("data:") else {
                    continue; // comments, blank separators, other SSE fields
                };
                let payload = payload.trim();

                if payload == "[DONE]" {
                    return Ok(full);
                }
                if payload.is_empty() {
                    continue;
                }

                // A malformed frame mid-stream should not throw away the reply
                // the user is already reading. Skip it and keep going.
                let Ok(parsed) = serde_json::from_str::<StreamChunk>(payload) else {
                    tracing::debug!(frame = %payload, "skipping unparseable SSE frame");
                    continue;
                };

                for choice in parsed.choices {
                    // Shown, but deliberately not accumulated into `full`.
                    if let Some(text) = choice.delta.reasoning_content {
                        if !text.is_empty() {
                            on_chunk(ChunkKind::Reasoning, &text);
                        }
                    }
                    if let Some(text) = choice.delta.content {
                        if !text.is_empty() {
                            on_chunk(ChunkKind::Content, &text);
                            full.push_str(&text);
                        }
                    }
                }
            }
        }

        Ok(full)
    }

    fn model_id(&self) -> String {
        format!("{}/{}", self.label, self.model)
    }
}

/// Did the server reject us specifically over `reasoning_effort`?
fn mentions_reasoning_effort(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("reasoning_effort") || m.contains("reasoning effort")
}

impl OpenAiCompat {
    async fn extract_once(
        &self,
        transcript: &str,
        known_categories: &[String],
        disable_reasoning: bool,
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        let raw = self
            .structured(
                &crate::extract::prompt::build_with_categories(transcript, known_categories),
                crate::extract::prompt::json_schema(),
                disable_reasoning,
            )
            .await?;
        crate::extract::prompt::parse(&raw)
    }

    /// One schema-constrained, reasoning-free JSON call.
    ///
    /// Shared by extraction and reconciliation: both are mechanical structured
    /// tasks, and both must run in a context containing nothing of the user's
    /// conversation.
    async fn structured(
        &self,
        prompt: &str,
        schema: serde_json::Value,
        disable_reasoning: bool,
    ) -> Result<String, LlmError> {
        let messages = vec![Message { role: Role::User, content: prompt.to_string() }];

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            "temperature": 0.0,
            "max_tokens": EXTRACT_MAX_TOKENS,
            "response_format": {
                "type": "json_schema",
                "json_schema": { "name": "result", "strict": true, "schema": schema }
            },
        });
        if disable_reasoning {
            body["reasoning_effort"] = serde_json::json!("none");
        }

        let resp = self
            .post("/chat/completions")
            .json(&body)
            .send()
            .await
            .map_err(|e| self.connect_error(&e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            return Err(LlmError::Transport(format!("{status}: {detail}")));
        }

        let completion: Completion = resp
            .json()
            .await
            .map_err(|e| LlmError::BadOutput(e.to_string()))?;

        let Some(choice) = completion.choices.first() else {
            return Err(LlmError::BadOutput("no choices in response".into()));
        };

        // An empty reply is not a mystery worth debugging twice. Say which of
        // the two things actually happened.
        if choice.message.content.trim().is_empty() {
            let thought = choice.message.reasoning_content.as_deref().unwrap_or("");
            let truncated = choice.finish_reason.as_deref() == Some("length");
            return Err(LlmError::BadOutput(if !thought.is_empty() && truncated {
                format!(
                    "the model spent its entire {EXTRACT_MAX_TOKENS}-token budget reasoning                      and never produced an answer. Use a non-reasoning model for extraction,                      or one whose reasoning can be disabled."
                )
            } else if truncated {
                format!("reply hit the {EXTRACT_MAX_TOKENS}-token limit before completing")
            } else {
                "the model returned an empty reply".to_string()
            }));
        }

        Ok(choice.message.content.clone())
    }
}

#[derive(Deserialize)]
struct Completion {
    choices: Vec<CompletionChoice>,
}

#[derive(Deserialize)]
struct CompletionChoice {
    message: CompletionMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct CompletionMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    reasoning_content: Option<String>,
}

/// Generous enough for a long session's worth of ideas, tight enough that a
/// runaway generation fails in seconds rather than minutes.
const EXTRACT_MAX_TOKENS: u32 = 4096;

#[async_trait]
impl IdeaExtractor for OpenAiCompat {
    async fn extract(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        // Reasoning is switched off for extraction. This is a mechanical
        // structured task, and a reasoning model will otherwise spend its entire
        // token budget thinking and emit no JSON at all — an empty reply after
        // ten minutes of work. Chat is deliberately left alone: there the
        // model's normal behaviour is the whole point.
        //
        // Not every server accepts the parameter, so a rejection falls back to
        // sending the request without it.
        match self.extract_once(transcript, known_categories, true).await {
            Err(LlmError::Transport(msg)) if mentions_reasoning_effort(&msg) => {
                tracing::debug!("server rejected reasoning_effort; retrying without it");
                self.extract_once(transcript, known_categories, false).await
            }
            other => other,
        }
    }

    async fn judge(
        &self,
        prompt: &str,
        schema: serde_json::Value,
    ) -> Result<String, LlmError> {
        match self.structured(prompt, schema.clone(), true).await {
            Err(LlmError::Transport(msg)) if mentions_reasoning_effort(&msg) => {
                self.structured(prompt, schema, false).await
            }
            other => other,
        }
    }

    fn model_id(&self) -> String {
        format!("{}/{}", self.label, self.model)
    }
}
