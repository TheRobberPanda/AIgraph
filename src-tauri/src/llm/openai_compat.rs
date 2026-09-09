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
        struct Models {
            data: Vec<Model>,
        }
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
        struct Models {
            data: Vec<Model>,
        }
        #[derive(Deserialize)]
        struct Model {
            id: String,
        }

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
        // In whichever dialect this server speaks. OpenRouter's `reasoning` is
        // an object and it rejects the string llama.cpp wants, so sending both
        // spellings at once fails against it outright.
        if self.label == "openrouter" {
            body["reasoning"] = serde_json::json!({ "enabled": req.reasoning });
        } else {
            // The embedded server is started with thinking off, so a request
            // that wants it has to ask.
            body["reasoning"] = serde_json::json!(if req.reasoning { "on" } else { "off" });
            if !req.reasoning {
                body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
            }
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
        let ticket = crate::llm::cancel::start();

        while let Some(chunk) = stream.next().await {
            // Stopped. Returning drops the body, which closes the connection,
            // which is what actually makes the server stop working — a flag
            // that only stopped this end reading would leave it filling a slot
            // nobody is listening to. What arrived before the stop is kept:
            // the person ended it, they did not hit an error.
            if ticket.cancelled() {
                return Ok(full);
            }
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
/// Whether a failure looks like the server refusing a parameter rather than
/// failing at the work.
///
/// Anything in the 400s: a rejected field, a model that does not do structured
/// output, a switch this server has never heard of. Narrower than that was the
/// bug — it only matched the words "reasoning_effort", so OpenRouter replying
/// that `reasoning` should have been an object went unrecognised, no simpler
/// request was tried, and extraction failed for good.
fn looks_like_a_rejected_parameter(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.starts_with('4')
        || m.contains("400")
        || m.contains("422")
        || m.contains("unsupported")
        || m.contains("not support")
        || m.contains("invalid")
        || m.contains("unrecognized")
        || m.contains("unknown field")
}

impl OpenAiCompat {
    /// The `json_schema` block, in a shape this server will accept.
    ///
    /// We claimed `strict: true` while sending a schema that is not strict by
    /// OpenAI's rules — `conversation` is a property but not required, nothing
    /// declares `additionalProperties: false`, and `maxItems` is not allowed
    /// in strict mode at all. Providers that actually enforce those rules
    /// reject the request, which is every extraction against OpenRouter.
    ///
    /// So strict is claimed only where the schema has been made strict. Local
    /// servers keep the loose one on purpose: llama.cpp ignores the flag and
    /// uses the schema as a grammar, where `maxItems` is what stops a long
    /// reply — tightening it away turns a ten-minute read into a twenty-minute
    /// one.
    fn schema_for(&self, schema: serde_json::Value) -> serde_json::Value {
        if self.label == "openrouter" {
            return serde_json::json!({
                "name": "result",
                "strict": true,
                "schema": crate::extract::prompt::strict(&schema),
            });
        }
        serde_json::json!({ "name": "result", "strict": false, "schema": schema })
    }

    /// Ask this particular server not to think first.
    ///
    /// Extraction is a mechanical structured task, and a model that reasons
    /// its way through it spends the whole token budget and returns no JSON.
    /// There is no agreed way to say so, so it is said in whichever dialect
    /// the server at the other end speaks — sending all of them at once is
    /// what broke OpenRouter, whose `reasoning` is an object and which
    /// therefore rejected the string llama.cpp wants outright.
    fn quieten_reasoning(&self, body: &mut serde_json::Value) {
        if self.label == "openrouter" {
            body["reasoning"] = serde_json::json!({ "enabled": false });
            return;
        }
        // llama.cpp takes `reasoning`; `enable_thinking` is what LM Studio and
        // vLLM pass through to the chat template; `reasoning_effort` is the
        // OpenAI spelling. Servers ignore the ones they do not know.
        body["reasoning_effort"] = serde_json::json!("none");
        body["reasoning"] = serde_json::json!("off");
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }

    /// One structured call, giving up a parameter at a time.
    ///
    /// A server that refuses something is told less rather than treated as
    /// broken: first without the reasoning switches, then without the schema
    /// as well. The parser downstream salvages JSON out of prose, so a model
    /// that cannot do structured output still produces ideas — which is the
    /// difference between "this provider does not work" and "this provider
    /// needs asking more simply".
    async fn attempt(&self, prompt: &str, schema: serde_json::Value) -> Result<String, LlmError> {
        let first = self.structured(prompt, schema.clone(), true, true).await;
        let Err(LlmError::Transport(msg)) = &first else { return first };
        if !looks_like_a_rejected_parameter(msg) {
            return first;
        }

        tracing::debug!(error = %msg, "retrying without the reasoning switches");
        let second = self.structured(prompt, schema.clone(), false, true).await;
        let Err(LlmError::Transport(msg)) = &second else { return second };
        if !looks_like_a_rejected_parameter(msg) {
            return second;
        }

        tracing::debug!(error = %msg, "retrying without a response schema");
        self.structured(prompt, schema, false, false).await
    }
}

impl OpenAiCompat {
    async fn extract_once(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        let raw = self
            .attempt(
                &crate::extract::prompt::build_with_categories(transcript, known_categories),
                crate::extract::prompt::json_schema(),
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
        structured_output: bool,
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
                "json_schema": self.schema_for(schema)
            },
        });
        if disable_reasoning {
            self.quieten_reasoning(&mut body);
        }
        // Dropped on the way back up when a server rejects it — see `attempt`.
        if !structured_output {
            body.as_object_mut().expect("object").remove("response_format");
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

        // OpenRouter answers 200 with the failure in the body rather than in
        // the status. Read once and look, or a rejected request arrives as
        // "missing field `choices`" — which reads as the model misbehaving and
        // never reaches the retry that would have asked more simply.
        let raw = resp.text().await.map_err(|e| LlmError::Transport(e.to_string()))?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(err) = v.get("error") {
                let said = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| err.to_string());
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(400);
                return Err(LlmError::Transport(format!("{code}: {said}")));
            }
        }
        let completion: Completion =
            serde_json::from_str(&raw).map_err(|e| LlmError::BadOutput(e.to_string()))?;
        // What this call actually cost, straight from the server. Recorded
        // before anything can fail below, so a run that ends badly still
        // accounts for the time it spent.
        crate::llm::meter::record(completion.timings.as_ref());

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

        // Non-empty but cut short. Said plainly here rather than left to the
        // parser, which can only report that the JSON does not parse.
        if choice.finish_reason.as_deref() == Some("length") {
            tracing::warn!(
                limit = EXTRACT_MAX_TOKENS,
                "extraction reply was truncated; salvaging whatever completed"
            );
        }

        Ok(choice.message.content.clone())
    }
}

#[derive(Deserialize)]
struct Completion {
    choices: Vec<CompletionChoice>,
    /// llama.cpp's own measurement of the call. Absent on servers that do not
    /// report one.
    #[serde(default)]
    timings: Option<serde_json::Value>,
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
/// A ceiling, not a target.
///
/// This was raised to 16000 to stop a Polish session being truncated, which
/// worked and cost four times the worst-case wait: a local model writing at
/// thirteen tokens a second takes twenty minutes to fill that, and filling it
/// is exactly what a model does when nothing else stops it. The bound that
/// belongs here is on the number of ideas — see `json_schema` — so the model
/// stops when it is finished rather than when it is cut off. This is what is
/// left over for the rare long one, and a truncation now keeps whatever
/// completed rather than losing the session.
const EXTRACT_MAX_TOKENS: u32 = 5_000;

#[async_trait]
impl IdeaExtractor for OpenAiCompat {
    async fn extract(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        // Reasoning is switched off for extraction — a mechanical structured
        // task, where a reasoning model spends the whole token budget thinking
        // and emits no JSON at all. Chat is left alone: there the model's
        // normal behaviour is the whole point.
        //
        // `attempt` inside handles a server that refuses a parameter, giving
        // one up at a time rather than treating the refusal as a failure.
        self.extract_once(transcript, known_categories).await
    }

    async fn judge(&self, prompt: &str, schema: serde_json::Value) -> Result<String, LlmError> {
        self.attempt(prompt, schema).await
    }

    fn model_id(&self) -> String {
        format!("{}/{}", self.label, self.model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> serde_json::Value {
        serde_json::json!({})
    }

    /// The bug this split exists for: OpenRouter's `reasoning` is an object,
    /// and it rejects the string llama.cpp wants — which failed every
    /// extraction against it, since the request never got as far as the model.
    #[test]
    fn openrouter_is_asked_in_its_own_dialect() {
        let mut b = body();
        OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter")
            .quieten_reasoning(&mut b);
        assert_eq!(b["reasoning"], serde_json::json!({ "enabled": false }));
        assert!(b.get("chat_template_kwargs").is_none(), "not a spelling it knows");
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn a_local_server_still_gets_all_three_spellings() {
        let mut b = body();
        OpenAiCompat::new("http://127.0.0.1:8127", "m", None, "embedded").quieten_reasoning(&mut b);
        assert_eq!(b["reasoning"], serde_json::json!("off"));
        assert_eq!(b["reasoning_effort"], serde_json::json!("none"));
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], serde_json::json!(false));
    }

    /// It used to match the words "reasoning_effort" and nothing else, so a
    /// provider complaining about anything else was treated as broken rather
    /// than as wanting a simpler request.
    #[test]
    fn a_refused_parameter_is_recognised_however_it_is_worded() {
        for msg in [
            "400 Bad Request: reasoning: Expected object, received string",
            "422: model does not support response_format",
            "Invalid value for 'reasoning_effort'",
            "unrecognized request argument supplied: chat_template_kwargs",
        ] {
            assert!(looks_like_a_rejected_parameter(msg), "should retry more simply: {msg}");
        }
    }

    /// A model that ran out of context, or a server that fell over, is not a
    /// parameter problem — retrying the same call more simply would only
    /// spend the time twice.
    /// Claiming strict about a schema that is not strict is what every
    /// OpenRouter extraction died of.
    #[test]
    fn strict_is_only_claimed_where_the_schema_has_been_made_strict() {
        let loose = crate::extract::prompt::json_schema();
        let router = OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter")
            .schema_for(loose.clone());
        assert_eq!(router["strict"], serde_json::json!(true));
        let sent = &router["schema"];
        assert_eq!(sent["additionalProperties"], serde_json::json!(false));
        // Every property listed as required, and no keyword strict mode bans.
        let props = sent["properties"].as_object().unwrap().len();
        assert_eq!(sent["required"].as_array().unwrap().len(), props);
        assert!(sent["properties"]["ideas"].get("maxItems").is_none());
    }

    /// And the local grammar keeps the cap that stops a runaway reply.
    #[test]
    fn a_local_server_keeps_the_loose_schema_and_its_cap() {
        let loose = crate::extract::prompt::json_schema();
        let local =
            OpenAiCompat::new("http://127.0.0.1:8127", "m", None, "embedded").schema_for(loose);
        assert_eq!(local["strict"], serde_json::json!(false));
        assert_eq!(local["schema"]["properties"]["ideas"]["maxItems"], serde_json::json!(14));
    }

    #[test]
    fn a_real_failure_is_not_mistaken_for_a_refused_parameter() {
        for msg in ["500 Internal Server Error", "connection refused", "503: overloaded"] {
            assert!(!looks_like_a_rejected_parameter(msg), "should not retry: {msg}");
        }
    }
}
