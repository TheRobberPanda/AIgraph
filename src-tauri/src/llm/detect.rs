//! Finding a local model server without asking the user to configure one.
//!
//! "Quick use over personalization" means the app should open and work. Both
//! supported local servers advertise themselves on a known port, so we probe
//! rather than interrogate the user on first run. Settings can override later.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::anthropic::{Anthropic as AnthropicProvider, SUGGESTED as ANTHROPIC_MODELS};
use super::claude_cli::ClaudeCli;
use super::ollama::{Ollama, DEFAULT_HOST as OLLAMA_HOST};
use super::openai_compat::{ModelInfo, ModelKind, OpenAiCompat, LM_STUDIO_HOST};
use super::{ChatProvider, IdeaExtractor};

/// Where a model runs.
///
/// Named `LocalKind` when everything was local; it now covers remote providers
/// too, and the name is kept because it is threaded through stored settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalKind {
    Ollama,
    LmStudio,
    /// The `llama-server` the app started for itself. Speaks the same API as
    /// LM Studio, so it is a provider like any other rather than a special
    /// case threaded through the app.
    Embedded,
    Anthropic,
    ClaudeCli,
}

impl LocalKind {
    pub fn label(self) -> &'static str {
        match self {
            LocalKind::Ollama => "Ollama",
            LocalKind::LmStudio => "LM Studio",
            LocalKind::Embedded => "In the app",
            LocalKind::Anthropic => "Anthropic",
            LocalKind::ClaudeCli => "Claude CLI",
        }
    }

    /// Does using this send your thinking off the machine?
    pub fn is_remote(self) -> bool {
        matches!(self, LocalKind::Anthropic | LocalKind::ClaudeCli)
    }
}

/// A local server that answered a probe.
#[derive(Debug, Clone, Serialize)]
pub struct Detected {
    pub kind: LocalKind,
    pub host: String,
    pub models: Vec<ModelInfo>,
}

impl Detected {
    /// Models that can actually hold a conversation.
    pub fn chat_models(&self) -> impl Iterator<Item = &ModelInfo> {
        self.models.iter().filter(|m| m.kind == ModelKind::Chat)
    }

    /// Chat models the server has loaded and ready.
    ///
    /// Only meaningful where the server reports state. Ollama runs whatever you
    /// name, so everything it lists counts as ready.
    pub fn ready_models(&self) -> Vec<&ModelInfo> {
        self.chat_models().filter(|m| m.loaded.unwrap_or(true)).collect()
    }
}

/// The model to select without asking, if there is an obvious one.
///
/// Deliberately conservative. Auto-selecting a model that is merely *downloaded*
/// means a 30B gets pulled into a 12GB card on the user's first message, and the
/// app appears to hang with no explanation. Better to ask than to guess wrong:
/// the model shapes what ends up in the diagram.
pub fn obvious_choice(servers: &[Detected]) -> Option<(&Detected, &ModelInfo)> {
    // The one exception to being conservative: a model the app started itself
    // was started deliberately, by someone pressing a button, with one model
    // named on it. There is nothing left to ask.
    if let Some(own) = servers.iter().find(|s| s.kind == LocalKind::Embedded) {
        if let [model] = own.ready_models()[..] {
            return Some((own, model));
        }
    }
    let with_ready: Vec<&Detected> =
        servers.iter().filter(|s| !s.ready_models().is_empty()).collect();
    let [server] = with_ready[..] else { return None };
    let ready = server.ready_models();
    let [model] = ready[..] else { return None };
    Some((server, model))
}

/// Probe both local servers concurrently.
///
/// Returns every one that responded — if the user runs both, that is their
/// business and the UI should show the choice rather than pick silently.
/// Where the app's own `llama-server` listens. Loopback only.
pub const EMBEDDED_HOST: &str = "http://127.0.0.1:8127";

pub async fn probe_local() -> Vec<Detected> {
    let embedded = async {
        let e = OpenAiCompat::new(EMBEDDED_HOST, "", None, "embedded");
        if !e.is_available().await {
            return None;
        }
        let models = match e.list_models_detailed().await {
            Some(detailed) => detailed,
            None => e
                .list_models()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|id| ModelInfo { id, loaded: Some(true), kind: ModelKind::Chat })
                .collect(),
        };
        Some(Detected { kind: LocalKind::Embedded, host: EMBEDDED_HOST.to_string(), models })
    };

    let ollama = async {
        let o = Ollama::new(OLLAMA_HOST, "");
        if !o.is_available().await {
            return None;
        }
        // Ollama loads on demand and every listed model is a real chat model,
        // so there is no state or type to distinguish.
        Some(Detected {
            kind: LocalKind::Ollama,
            host: OLLAMA_HOST.to_string(),
            models: o
                .list_models()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|id| ModelInfo { id, loaded: None, kind: ModelKind::Chat })
                .collect(),
        })
    };

    let lm_studio = async {
        let l = OpenAiCompat::lm_studio("");
        if !l.is_available().await {
            return None;
        }
        // Prefer the detailed listing; fall back to ids only if unavailable.
        let models = match l.list_models_detailed().await {
            Some(detailed) => detailed,
            None => l
                .list_models()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|id| ModelInfo { id, loaded: None, kind: ModelKind::Chat })
                .collect(),
        };
        Some(Detected { kind: LocalKind::LmStudio, host: LM_STUDIO_HOST.to_string(), models })
    };

    // Remote providers are not probed by network — that would spend a request
    // just to draw a list. They appear when they are usable: Anthropic when a key
    // is stored, the CLI when it is installed.
    let anthropic = async {
        let key = crate::secrets::get(crate::secrets::ANTHROPIC)?;
        let provider = AnthropicProvider::new(key, "");
        // Ask the API what this key can reach; fall back to the known-good list
        // if that call fails, so a network blip does not empty the picker.
        let models = provider
            .list_models()
            .await
            .unwrap_or_else(|_| ANTHROPIC_MODELS.iter().map(|m| m.to_string()).collect());
        Some(Detected {
            kind: LocalKind::Anthropic,
            host: "https://api.anthropic.com".to_string(),
            models: models
                .into_iter()
                .map(|id| ModelInfo { id, loaded: None, kind: ModelKind::Chat })
                .collect(),
        })
    };

    let claude_cli = async {
        if !ClaudeCli::is_available() {
            return None;
        }
        Some(Detected {
            kind: LocalKind::ClaudeCli,
            host: String::new(),
            models: ANTHROPIC_MODELS
                .iter()
                .map(|id| ModelInfo { id: id.to_string(), loaded: None, kind: ModelKind::Chat })
                .collect(),
        })
    };

    let (e, a, b, c, d) = tokio::join!(embedded, ollama, lm_studio, anthropic, claude_cli);
    // Servers with nothing usable are kept in the list so the UI can say
    // "running, but load a model" instead of "not found", which would send the
    // user hunting the wrong problem.
    //
    // The app's own server comes first, and everything downstream that picks
    // "the first usable one" therefore prefers it — which is the right default:
    // it is the one the app is responsible for and the one that needs nothing
    // else installed.
    [e, a, b, c, d].into_iter().flatten().collect()
}

/// Build a chat provider.
pub fn chat_provider(kind: LocalKind, host: &str, model: &str) -> Arc<dyn ChatProvider> {
    match kind {
        LocalKind::Ollama => Arc::new(Ollama::new(host, model)),
        LocalKind::LmStudio => Arc::new(OpenAiCompat::new(host, model, None, "lmstudio")),
        LocalKind::Embedded => Arc::new(OpenAiCompat::new(host, model, None, "embedded")),
        LocalKind::Anthropic => Arc::new(AnthropicProvider::new(
            crate::secrets::get(crate::secrets::ANTHROPIC).unwrap_or_default(),
            model,
        )),
        LocalKind::ClaudeCli => {
            Arc::new(ClaudeCli::new((!model.is_empty()).then(|| model.to_string())))
        }
    }
}

/// Build an extractor. Same servers, separate object — extraction never borrows
/// the chat's provider instance or its context.
pub fn extractor(kind: LocalKind, host: &str, model: &str) -> Arc<dyn IdeaExtractor> {
    match kind {
        LocalKind::Ollama => Arc::new(Ollama::new(host, model)),
        LocalKind::LmStudio => Arc::new(OpenAiCompat::new(host, model, None, "lmstudio")),
        LocalKind::Embedded => Arc::new(OpenAiCompat::new(host, model, None, "embedded")),
        LocalKind::Anthropic => Arc::new(AnthropicProvider::new(
            crate::secrets::get(crate::secrets::ANTHROPIC).unwrap_or_default(),
            model,
        )),
        LocalKind::ClaudeCli => {
            Arc::new(ClaudeCli::new((!model.is_empty()).then(|| model.to_string())))
        }
    }
}
