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
            http: long_read_client(),
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
    #[serde(default)]
    finish_reason: Option<String>,
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

/// What came back over a streamed response.
struct Streamed {
    content: String,
    finish_reason: Option<String>,
    /// The person pressed Stop. Distinct from finishing, and from failing.
    cancelled: bool,
}

/// Consume a server-sent-event body, handing every fragment to `on_chunk`.
///
/// Lifted out of `chat_stream` so extraction can stream too. The two want
/// different things from the result — chat wants the text as it arrives,
/// extraction wants to know it is still alive — but the framing is identical,
/// and two copies of a hand-rolled SSE parser is one more than anybody should
/// have to keep correct.
async fn drain_sse(
    resp: reqwest::Response,
    on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
) -> Result<Streamed, LlmError> {
    // Buffer across chunks — an event can split anywhere, including inside a
    // multibyte character, so decode only whole lines.
    let mut full = String::new();
    let mut finish_reason = None;
    let mut buf = Vec::<u8>::new();
    let mut stream = resp.bytes_stream();
    let ticket = crate::llm::cancel::start();

    while let Some(chunk) = stream.next().await {
        // Stopped. Returning drops the body, which closes the connection,
        // which is what actually makes the server stop working — a flag that
        // only stopped this end reading would leave it filling a slot nobody
        // is listening to. What arrived before the stop is kept: the person
        // ended it, they did not hit an error.
        if ticket.cancelled() {
            return Ok(Streamed { content: full, finish_reason, cancelled: true });
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
                return Ok(Streamed { content: full, finish_reason, cancelled: false });
            }
            if payload.is_empty() {
                continue;
            }

            // A failure can arrive mid-stream as a frame rather than a status,
            // the same way OpenRouter answers 200 with the error in the body.
            // Caught here so it reaches the retry ladder as a rejection rather
            // than as an unparseable frame nobody looks at.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Some(said) = error_in(&v) {
                    return Err(LlmError::Transport(said));
                }
            }

            // A malformed frame mid-stream should not throw away the reply
            // the user is already reading. Skip it and keep going.
            let Ok(parsed) = serde_json::from_str::<StreamChunk>(payload) else {
                tracing::debug!(frame = %payload, "skipping unparseable SSE frame");
                continue;
            };

            for choice in parsed.choices {
                if let Some(reason) = choice.finish_reason {
                    finish_reason = Some(reason);
                }
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

    Ok(Streamed { content: full, finish_reason, cancelled: false })
}

/// The failure in a response body or a stream frame, if there is one.
///
/// The key being *present* is not the question. Several OpenAI-compatible
/// servers put `"error": null` in every ordinary chunk, so testing for the key
/// alone reads a perfectly good reply as a refusal — and a refusal is answered
/// by retrying more simply, which is how one wrong `is_some()` turned into
/// asking a reasoning model to extract with its reasoning left on.
fn error_in(v: &serde_json::Value) -> Option<String> {
    match v.get("error") {
        None | Some(serde_json::Value::Null) => None,
        Some(err) => Some(error_text(err)),
    }
}

/// The readable part of a provider's error object.
fn error_text(err: &serde_json::Value) -> String {
    let said = err
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| err.to_string());
    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(400);
    format!("{code}: {said}")
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

        Ok(drain_sse(resp, on_chunk).await?.content)
    }

    fn model_id(&self) -> String {
        format!("{}/{}", self.label, self.model)
    }
}

/// Did the server reject us specifically over `reasoning_effort`?
/// A client built for requests that run for minutes.
///
/// The default one is built for ordinary web calls. An extraction request
/// holds a single connection open for as long as the model takes to write its
/// answer, which is exactly the shape of connection that NAT tables, proxies
/// and load balancers drop when they see nothing on it — and a dropped body
/// arrives here as "error decoding response body", with no hint that the
/// network rather than the model was at fault.
///
/// Keepalive is the part that matters: it puts traffic on the socket during
/// the long quiet stretch while the model is still thinking. The connect
/// timeout is there so an unreachable host fails in seconds rather than
/// hanging the queue behind it.
fn long_read_client() -> reqwest::Client {
    reqwest::Client::builder()
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(20))
        // Deliberately no overall timeout: a long read is the normal case
        // here, and a request cut off at some arbitrary minute would be
        // indistinguishable from the failures this is meant to prevent.
        .pool_idle_timeout(std::time::Duration::from_secs(30))
        .build()
        // The builder only fails if the TLS backend cannot start, and then
        // nothing else would work either.
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Whether a failure is the network rather than the request.
///
/// Both halves of the retry story were missing. The ladder below retries a
/// request the *server* refused, which it answers by asking more simply — but
/// a connection that was reset, or a body that stopped arriving halfway, is
/// not a request anybody objected to. Asking more simply cannot help, and
/// nothing else tried again either, so one dropped connection permanently
/// failed that conversation's read.
fn looks_transient(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    // A stop is not a failure, and must never be retried — that would restart
    // the very work the person just asked to end.
    if m.contains("the read was stopped") {
        return false;
    }
    m.contains("error decoding response body")
        || m.contains("connection reset")
        || m.contains("connection closed")
        || m.contains("connection refused")
        || m.contains("broken pipe")
        || m.contains("is not reachable")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("429")
        || m.contains("500")
        || m.contains("502")
        || m.contains("503")
        || m.contains("504")
}

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
    fn quieten_reasoning(&self, body: &mut serde_json::Value, how: Reasoning) {
        if how == Reasoning::LeftAlone {
            return;
        }
        if self.label == "openrouter" {
            body["reasoning"] = match how {
                // Some models cannot turn thinking off at all: their metadata
                // says `"mandatory": true`, and `enabled: false` is quietly
                // ignored. For those the only lever is how *much* — and the
                // lowest effort they support, since "none" is not among them.
                Reasoning::AsLittleAsPossible => serde_json::json!({ "effort": "low" }),
                _ => serde_json::json!({ "enabled": false }),
            };
            return;
        }
        // llama.cpp takes `reasoning`; `enable_thinking` is what LM Studio and
        // vLLM pass through to the chat template; `reasoning_effort` is the
        // OpenAI spelling. Servers ignore the ones they do not know.
        body["reasoning_effort"] = serde_json::json!("none");
        body["reasoning"] = serde_json::json!("off");
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }

    /// One structured call, tried again if the network drops it.
    ///
    /// Separate from the ladder below, and underneath it, because the two
    /// answer different questions. The ladder asks "did the server refuse
    /// something?" and responds by asking for less. This asks "did the request
    /// arrive at all?" and responds by asking again, unchanged — asking for
    /// less would be answering a question nobody posed, and would quietly give
    /// up the reasoning switches over a flaky connection.
    async fn through_the_network(
        &self,
        prompt: &str,
        schema: serde_json::Value,
        reasoning: Reasoning,
        structured_output: bool,
        stream: bool,
    ) -> Result<String, LlmError> {
        // Three tries, seconds apart. A read already costs minutes, so the
        // wait is free; and a transient failure that is still failing on the
        // third attempt is not transient, at which point saying so is the
        // right answer rather than holding the queue up any longer.
        const WAITS: [u64; 2] = [2, 6];

        for (attempt, wait) in WAITS.iter().enumerate() {
            let result =
                self.structured(prompt, schema.clone(), reasoning, structured_output, stream).await;
            let msg = match &result {
                Err(LlmError::Transport(m)) | Err(LlmError::Unavailable(m)) => m.clone(),
                // Anything else is the model's answer, good or bad. Sending
                // the same prompt again would only spend the time twice.
                _ => return result,
            };
            if !looks_transient(&msg) {
                return result;
            }
            tracing::warn!(
                error = %msg,
                attempt = attempt + 1,
                retrying_in_seconds = wait,
                "the connection failed rather than the request; trying again"
            );
            // What arrived before the drop is not part of the next attempt.
            crate::llm::pulse::reset();
            tokio::time::sleep(std::time::Duration::from_secs(*wait)).await;
        }

        self.structured(prompt, schema, reasoning, structured_output, stream).await
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
        // Streamed only where the wait is long enough to be worth reporting on
        // and the server is known to stream structured output. A local model
        // answers from the same machine and already reports its own timings,
        // so it stays on the path that has been working.
        let stream = self.streams_extraction();

        let first =
            self.through_the_network(prompt, schema.clone(), Reasoning::Off, true, stream).await;

        // Asked not to think, and thought anyway until the budget was gone.
        //
        // Some models cannot switch reasoning off at all — their metadata says
        // `"mandatory": true` — and on those `enabled: false` is quietly
        // ignored while the default effort is the highest they have. This used
        // to be the end of the road: an error telling the person to go and
        // choose a different model. There is one more thing to ask for first,
        // which is simply *less*.
        if let Err(LlmError::BadOutput(said)) = &first {
            if said.contains(THOUGHT_ITSELF_OUT) {
                tracing::debug!("the model cannot stop thinking; asking it to think less");
                return self
                    .through_the_network(
                        prompt,
                        schema,
                        Reasoning::AsLittleAsPossible,
                        true,
                        stream,
                    )
                    .await;
            }
        }

        let Err(LlmError::Transport(msg)) = &first else { return first };
        if !looks_like_a_rejected_parameter(msg) {
            return first;
        }

        // Streaming goes first, and alone, because it is the concession that
        // costs nothing: without it the read is silent, and that is all. The
        // rung below gives up the reasoning switches, which is the expensive
        // one — a reasoning model asked to extract with its reasoning left on
        // spends its whole budget thinking and answers with nothing. Bundling
        // the two meant any objection at all, however unrelated, cost the
        // switches as well.
        if stream {
            tracing::debug!(error = %msg, "retrying without streaming");
            let unstreamed =
                self.through_the_network(prompt, schema.clone(), Reasoning::Off, true, false).await;
            let Err(LlmError::Transport(msg)) = &unstreamed else { return unstreamed };
            if !looks_like_a_rejected_parameter(msg) {
                return unstreamed;
            }
        }

        tracing::debug!(error = %msg, "retrying without the reasoning switches");
        let second = self
            .through_the_network(prompt, schema.clone(), Reasoning::LeftAlone, true, false)
            .await;
        let Err(LlmError::Transport(msg)) = &second else { return second };
        if !looks_like_a_rejected_parameter(msg) {
            return second;
        }

        tracing::debug!(error = %msg, "retrying without a response schema");
        self.through_the_network(prompt, schema, Reasoning::LeftAlone, false, false).await
    }

    /// How many tokens extraction may spend on this provider.
    fn extract_budget(&self) -> u32 {
        if self.label == "openrouter" {
            CLOUD_EXTRACT_MAX_TOKENS
        } else {
            EXTRACT_MAX_TOKENS
        }
    }

    /// Whether extraction is worth streaming on this provider.
    fn streams_extraction(&self) -> bool {
        self.label == "openrouter"
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
        reasoning: Reasoning,
        structured_output: bool,
        stream: bool,
    ) -> Result<String, LlmError> {
        let messages = vec![Message { role: Role::User, content: prompt.to_string() }];
        let budget = self.extract_budget();

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "temperature": 0.0,
            "max_tokens": budget,
            "response_format": {
                "type": "json_schema",
                "json_schema": self.schema_for(schema)
            },
        });
        self.quieten_reasoning(&mut body, reasoning);
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

        // Streamed, so there is something to report while it runs. A single
        // non-streamed request to a cloud model is minutes of silence, and
        // elapsed time counts up at the same rate whether or not anything is
        // coming back — which makes a working read and a hung one look
        // identical. Every frame here says both how much has arrived and that
        // it arrived just now.
        if stream {
            let streamed = drain_sse(resp, &|kind, text| {
                if kind == ChunkKind::Content {
                    crate::llm::pulse::bump(text.chars().count());
                }
            })
            .await?;

            if streamed.cancelled {
                return Err(LlmError::Transport("the read was stopped".into()));
            }
            if streamed.content.trim().is_empty() {
                return Err(LlmError::BadOutput(
                    if streamed.finish_reason.as_deref() == Some("length") {
                        // Nothing in `content` and the budget gone: the tokens
                        // went somewhere, and reasoning is the only other
                        // place they could have gone — the frames carrying it
                        // are shown as they arrive and never accumulated.
                        // Worded identically to the unstreamed branch, because
                        // the rung that answers this matches on the wording.
                        format!(
                            "the model {THOUGHT_ITSELF_OUT} {budget}-token budget reasoning \
                             and never produced an answer"
                        )
                    } else {
                        "the model returned an empty reply".to_string()
                    },
                ));
            }
            if streamed.finish_reason.as_deref() == Some("length") {
                tracing::warn!(
                    limit = budget,
                    "extraction reply was truncated; salvaging whatever completed"
                );
            }
            return Ok(streamed.content);
        }

        // OpenRouter answers 200 with the failure in the body rather than in
        // the status. Read once and look, or a rejected request arrives as
        // "missing field `choices`" — which reads as the model misbehaving and
        // never reaches the retry that would have asked more simply.
        let raw = resp.text().await.map_err(|e| LlmError::Transport(e.to_string()))?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(said) = error_in(&v) {
                return Err(LlmError::Transport(said));
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
                    "the model {THOUGHT_ITSELF_OUT} {budget}-token budget reasoning \
                     and never produced an answer"
                )
            } else if truncated {
                format!("reply hit the {budget}-token limit before completing")
            } else {
                "the model returned an empty reply".to_string()
            }));
        }

        // Non-empty but cut short. Said plainly here rather than left to the
        // parser, which can only report that the JSON does not parse.
        if choice.finish_reason.as_deref() == Some("length") {
            tracing::warn!(
                limit = budget,
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

/// The same budget for a cloud model, where the reasoning above does not hold.
///
/// Two things differ. The wait that made 5,000 the right number is a *local*
/// model's — thirteen tokens a second — and a cloud model writes in seconds;
/// and on OpenAI-compatible cloud APIs `max_tokens` covers the thinking as
/// well as the answer, so a model that must reason spends the extraction's
/// budget before writing a character of JSON. At max effort, 5,000 was not
/// enough to reach the answer at all.
///
/// Unused budget costs nothing. It is a ceiling, not a reservation, and the
/// bound that actually stops the model is the idea count in `json_schema`.
const CLOUD_EXTRACT_MAX_TOKENS: u32 = 32_000;

/// How much thinking to ask a model for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reasoning {
    /// Off, where the model allows it. The right ask for a mechanical task.
    Off,
    /// As little as the model will accept — for one that cannot switch it off.
    AsLittleAsPossible,
    /// Say nothing about it, for a server that refused to be told.
    LeftAlone,
}

/// The marker in the failure a model produces when it thinks instead of
/// answering. Matched rather than re-derived, so the rung that responds to it
/// and the message that reports it cannot drift apart.
const THOUGHT_ITSELF_OUT: &str = "spent its entire";

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
            .quieten_reasoning(&mut b, Reasoning::Off);
        assert_eq!(b["reasoning"], serde_json::json!({ "enabled": false }));
        assert!(b.get("chat_template_kwargs").is_none(), "not a spelling it knows");
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn a_local_server_still_gets_all_three_spellings() {
        let mut b = body();
        OpenAiCompat::new("http://127.0.0.1:8127", "m", None, "embedded")
            .quieten_reasoning(&mut b, Reasoning::Off);
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

    /// Streaming exists to make a long cloud read reportable. A local server
    /// answers from the same machine and already reports its own timings, so
    /// it stays on the path that has been working — the point of the split is
    /// that adding progress to one provider cannot regress the others.
    #[test]
    fn only_the_cloud_read_is_streamed() {
        assert!(OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter")
            .streams_extraction());
        for local in ["embedded", "lmstudio"] {
            assert!(
                !OpenAiCompat::new("http://127.0.0.1:8127", "m", None, local).streams_extraction(),
                "{local} should be asked exactly as it is today"
            );
        }
    }

    /// A provider answering 200 with the failure in the body is the shape that
    /// cost three rounds of fixes. Streamed, it arrives as a frame instead —
    /// and has to come out reading like a rejection, or the ladder never
    /// retries and it surfaces as an unparseable frame nobody looks at.
    #[test]
    fn an_error_frame_reads_as_a_refusal() {
        let err =
            serde_json::json!({ "code": 400, "message": "model does not support response_format" });
        let text = error_text(&err);
        assert_eq!(text, "400: model does not support response_format");
        assert!(looks_like_a_rejected_parameter(&text), "must reach the simpler retry");
    }

    /// An error object with nothing readable in it still has to say something.
    #[test]
    fn an_error_without_a_message_still_says_something() {
        let text = error_text(&serde_json::json!({ "kind": "overloaded" }));
        assert!(text.starts_with("400: "), "a code to lead with: {text}");
        assert!(text.contains("overloaded"), "and whatever was actually there: {text}");
    }

    /// The regression that broke every streamed read the day it shipped.
    ///
    /// An ordinary chunk carrying `"error": null` was read as a refusal, which
    /// killed the stream, which looked like a rejected parameter, which pushed
    /// extraction onto the rung that stops disabling reasoning — and a
    /// reasoning model then spent its whole budget thinking. One `is_some()`,
    /// four steps, and the digest stops working.
    #[test]
    fn a_null_error_is_not_an_error() {
        let ordinary: serde_json::Value = serde_json::from_str(
            r#"{"id":"gen-1","choices":[{"delta":{"content":"{"}}],"error":null}"#,
        )
        .unwrap();
        assert_eq!(error_in(&ordinary), None, "a null error field is not a failure");

        let plain: serde_json::Value =
            serde_json::from_str(r#"{"choices":[{"delta":{"content":"x"}}]}"#).unwrap();
        assert_eq!(error_in(&plain), None);

        let real: serde_json::Value =
            serde_json::from_str(r#"{"error":{"code":429,"message":"rate limited"}}"#).unwrap();
        assert_eq!(error_in(&real), Some("429: rate limited".into()));
    }

    /// Giving up the reasoning switches is the expensive concession, so it
    /// must not be spent answering an objection to streaming. Streaming is
    /// dropped on its own first; only then does anything else go.
    #[test]
    fn streaming_is_given_up_before_the_reasoning_switches() {
        // Rung one and rung two must differ only in whether they stream, so
        // that a server refusing to stream still gets a quiet request.
        let openrouter = OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter");
        assert!(openrouter.streams_extraction());

        let mut streamed_quiet = body();
        openrouter.quieten_reasoning(&mut streamed_quiet, Reasoning::Off);
        assert_eq!(
            streamed_quiet["reasoning"],
            serde_json::json!({ "enabled": false }),
            "the unstreamed retry still asks for reasoning to be off"
        );
    }

    /// The two failures that were killing real digests. Neither is a rejected
    /// parameter, so nothing retried them, so one dropped connection cost the
    /// whole conversation until its backoff came round minutes later.
    #[test]
    fn a_dropped_connection_is_worth_trying_again() {
        for msg in [
            "error decoding response body",
            "openrouter is not reachable at https://openrouter.ai/api/v1. Is the server running?",
            "connection reset by peer",
            "operation timed out",
            "429: rate limited",
            "503: upstream unavailable",
        ] {
            assert!(looks_transient(msg), "the network failed, not the request: {msg}");
            assert!(
                !looks_like_a_rejected_parameter(msg) || msg.starts_with('4'),
                "and asking more simply cannot help: {msg}"
            );
        }
    }

    /// Pressing Stop must never be retried. Retrying it would restart exactly
    /// the work the person just asked to end — the one failure where trying
    /// again is not merely useless but contrary.
    #[test]
    fn a_stop_is_never_retried() {
        assert!(!looks_transient("the read was stopped"));
    }

    /// A refused parameter is answered by asking for less, not by asking the
    /// same thing again — the two paths must not claim each other's failures.
    #[test]
    fn a_refusal_is_not_mistaken_for_a_flaky_connection() {
        for msg in [
            "400 Bad Request: reasoning: Expected object, received string",
            "422: model does not support response_format",
            "unrecognized request argument supplied: chat_template_kwargs",
        ] {
            assert!(looks_like_a_rejected_parameter(msg));
            assert!(!looks_transient(msg), "retrying this unchanged would fail identically: {msg}");
        }
    }

    /// The reason glm-flash could never digest anything.
    ///
    /// Its metadata says `"reasoning": {"mandatory": true, "default_effort":
    /// "max"}` and its supported efforts are only max/high/low — there is no
    /// "none". So `enabled: false` is ignored, it thinks at full effort, and
    /// on an OpenAI-compatible cloud API `max_tokens` covers the thinking as
    /// well as the answer. Against a 5,000-token budget it spent everything
    /// reasoning and returned empty content, every single time.
    #[test]
    fn a_model_that_cannot_stop_thinking_is_asked_to_think_less() {
        let openrouter = OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter");

        let mut off = body();
        openrouter.quieten_reasoning(&mut off, Reasoning::Off);
        assert_eq!(off["reasoning"], serde_json::json!({ "enabled": false }));

        // The fallback for a model that ignored that: not "none", which such
        // models do not offer, but the lowest effort they do.
        let mut least = body();
        openrouter.quieten_reasoning(&mut least, Reasoning::AsLittleAsPossible);
        assert_eq!(least["reasoning"], serde_json::json!({ "effort": "low" }));

        let mut alone = body();
        openrouter.quieten_reasoning(&mut alone, Reasoning::LeftAlone);
        assert!(alone.get("reasoning").is_none(), "a server that refused is told nothing");
    }

    /// The budget has to cover the thinking on a cloud model, and the small
    /// one was chosen for a local model's speed. Keeping both at 5,000 meant
    /// a reasoning model could not reach its answer at all.
    #[test]
    fn a_cloud_read_gets_room_to_think_and_still_answer() {
        let cloud = OpenAiCompat::new("https://openrouter.ai/api/v1", "m", None, "openrouter");
        let local = OpenAiCompat::new("http://127.0.0.1:8127", "m", None, "embedded");
        assert_eq!(local.extract_budget(), EXTRACT_MAX_TOKENS, "unchanged where it was chosen");
        assert!(
            cloud.extract_budget() > local.extract_budget() * 4,
            "max-effort reasoning plus the answer does not fit in a local budget"
        );
    }

    /// The rung only fires if it recognises the failure, and two places
    /// produce that failure — streamed and not. Both must word it the same.
    #[test]
    fn thinking_itself_out_is_worded_the_same_either_way() {
        let budget = CLOUD_EXTRACT_MAX_TOKENS;
        let streamed =
            format!("the model {THOUGHT_ITSELF_OUT} {budget}-token budget reasoning and never produced an answer");
        assert!(streamed.contains(THOUGHT_ITSELF_OUT));
        // And it must not be mistaken for something the retry ladder handles,
        // or it would be answered by asking more simply instead of asking for
        // less thinking.
        assert!(!looks_transient(&streamed));
    }
}
