//! Claude through the `claude` command-line tool.
//!
//! The point of this provider is people who pay for Claude Pro or Max and have
//! no API key. MCP cannot do this — it carries tools, not inference — but the
//! CLI authenticates against the same subscription, so shelling out to it works.
//!
//! **Stated plainly because it should be:** this rides a subscription intended
//! for interactive use, and Anthropic could reasonably tighten that at any time.
//! It is never the default, and the README says so too.

use async_trait::async_trait;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use super::types::ChatRequest;
use super::{ChatProvider, ChunkKind, IdeaExtractor, LlmError};

pub struct ClaudeCli {
    /// The model to pass through, or None for whatever the CLI defaults to.
    model: Option<String>,
}

impl ClaudeCli {
    pub fn new(model: Option<String>) -> Self {
        Self { model }
    }

    /// Is the CLI on PATH? The UI hides this provider entirely when it is not,
    /// rather than offering something that cannot work.
    pub fn is_available() -> bool {
        std::process::Command::new("claude")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Run one prompt through `claude -p`.
    ///
    /// The prompt goes in on stdin rather than as an argument: transcripts run to
    /// tens of kilobytes and would blow past the command-line length limit.
    async fn run(&self, prompt: &str) -> Result<String, LlmError> {
        let mut cmd = tokio::process::Command::new("claude");
        cmd.arg("-p")
            .arg("--output-format")
            .arg("json")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(model) = &self.model {
            cmd.arg("--model").arg(model);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| LlmError::Unavailable(format!("could not run `claude`: {e}")))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| LlmError::Transport(e.to_string()))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| LlmError::Transport(e.to_string()))?;
        }

        let out = child
            .wait_with_output()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(LlmError::Transport(format!(
                "`claude` exited with {}: {}",
                out.status,
                err.trim()
            )));
        }

        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default)]
            result: Option<String>,
            #[serde(default)]
            is_error: bool,
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        match serde_json::from_str::<Envelope>(stdout.trim()) {
            Ok(env) if !env.is_error => Ok(env.result.unwrap_or_default()),
            Ok(_) => Err(LlmError::BadOutput(
                env_error(&stdout).unwrap_or_else(|| "the CLI reported an error".into()),
            )),
            // Older CLI builds, or a non-JSON mode, print the answer directly.
            Err(_) => Ok(stdout.to_string()),
        }
    }
}

fn env_error(raw: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()?
        .get("result")?
        .as_str()
        .map(|s| s.to_string())
}

#[async_trait]
impl ChatProvider for ClaudeCli {
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_chunk: &(dyn for<'a> Fn(ChunkKind, &'a str) + Send + Sync),
    ) -> Result<String, LlmError> {
        // The CLI takes a single prompt, not a message list, so the conversation
        // is flattened. Speaker markers are the only addition — no instructions,
        // no persona — because without them a multi-turn exchange reads as one
        // undifferentiated block.
        let prompt = req
            .messages
            .iter()
            .map(|m| match m.role {
                super::types::Role::User => format!("Human: {}", m.content),
                super::types::Role::Assistant => format!("Assistant: {}", m.content),
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let reply = self.run(&prompt).await?;
        // No token stream from the CLI, so the whole reply arrives at once.
        on_chunk(ChunkKind::Content, &reply);
        Ok(reply)
    }

    fn model_id(&self) -> String {
        format!("claude-cli/{}", self.model.as_deref().unwrap_or("default"))
    }
}

#[async_trait]
impl IdeaExtractor for ClaudeCli {
    async fn extract(
        &self,
        transcript: &str,
        known_categories: &[String],
    ) -> Result<crate::extract::prompt::Extracted, LlmError> {
        let raw = self
            .run(&crate::extract::prompt::build_with_categories(
                transcript,
                known_categories,
            ))
            .await?;
        crate::extract::prompt::parse(&raw)
    }

    async fn judge(&self, prompt: &str, _schema: serde_json::Value) -> Result<String, LlmError> {
        // No schema enforcement through the CLI, so the parsers' leniency about
        // chatty wrappers is doing the work here.
        self.run(prompt).await
    }

    fn model_id(&self) -> String {
        format!("claude-cli/{}", self.model.as_deref().unwrap_or("default"))
    }
}
