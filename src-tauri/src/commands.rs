//! Tauri commands — the frontend's entire surface area.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::chat::Conversation;
use crate::llm::detect::{self, Detected, LocalKind};
use crate::llm::{ChatProvider, ChunkKind, IdeaExtractor};
use crate::session::{ActiveSession, EndReason};
use crate::stt::capture::{Dictation, Event as SttEvent};
use crate::stt::model::{DownloadProgress, Models};
use crate::embed::Embedder;
use crate::reconcile;
use crate::settings::{ModelChoice, Settings};
use crate::store::{
    ConversationView, Diagnostics, Graph, IdeaView, SessionSummary, SourceView, StoredIdea, Store,
    StoredTurn,
};

/// The provider currently in use, if one has been chosen.
struct Active {
    provider: Arc<dyn ChatProvider>,
    kind: LocalKind,
    model: String,
}

/// The model that reads sessions afterwards. Independent of the chat model, and
/// always a separate object even when both point at the same server — extraction
/// must never share the chat's context.
struct Extractor {
    provider: Arc<dyn IdeaExtractor>,
    label: String,
    model: String,
}

pub struct AppState {
    conversation: Mutex<Option<Conversation>>,
    active: Mutex<Option<Active>>,
    session: Mutex<Option<ActiveSession>>,
    store: Mutex<Store>,
    progress: Mutex<ExtractionProgress>,
    models: Models,
    dictation: Mutex<Option<Dictation>>,
    /// Loaded on first use — the model is ~90MB and most of a session's work
    /// happens before anything needs embedding.
    embedder: Mutex<Option<Embedder>>,
    embed_cache_dir: PathBuf,
    extractor: Mutex<Option<Extractor>>,
    settings: Mutex<Settings>,
    /// Where the conversation being had now will be filed once it ends.
    ///
    /// Backend state rather than frontend, because a session can be archived
    /// by the idle timer or by the app closing, with no UI involved.
    current_folder: Mutex<i64>,
    /// The model the app runs itself, when that is the one in use.
    embedded: Mutex<crate::llm::embedded::Embedded>,
    data_dir: PathBuf,
    /// Held for the duration of a drain. Extraction is serialized deliberately:
    /// two sessions decoding at once on one local model is slower than doing
    /// them in turn, and would make the progress display meaningless.
    drain_lock: tokio::sync::Mutex<()>,
    /// Sessions that failed and when to try them again.
    ///
    /// A failure puts a session back to `pending`, and the queue is drained on a
    /// timer — so with no model reachable, the same session was re-read every
    /// minute forever. Each failure now doubles the wait.
    retry_after: Mutex<std::collections::HashMap<i64, (chrono::DateTime<chrono::Utc>, u32)>>,
    /// Where the plain-markdown copies go. The user owns these.
    md_dir: PathBuf,
    /// The archived conversation being added to, if one was picked back up.
    /// Set by `continue_session` and cleared when the session ends.
    continuing: Mutex<Option<i64>>,
}

impl AppState {
    pub fn new(db_path: &std::path::Path, md_dir: PathBuf) -> Result<Self, crate::store::StoreError> {
        Ok(Self {
            conversation: Mutex::new(None),
            active: Mutex::new(None),
            session: Mutex::new(None),
            store: Mutex::new(Store::open(db_path)?),
            progress: Mutex::new(ExtractionProgress::default()),
            models: Models::new(
                db_path.parent().unwrap_or(std::path::Path::new(".")),
            ),
            dictation: Mutex::new(None),
            embedder: Mutex::new(None),
            extractor: Mutex::new(None),
            settings: Mutex::new(Settings::load(
                db_path.parent().unwrap_or(std::path::Path::new(".")),
            )),
            data_dir: db_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .to_path_buf(),
            embed_cache_dir: md_dir
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("embeddings"),
            current_folder: Mutex::new(crate::store::ROOT_FOLDER),
            continuing: Mutex::new(None),
            embedded: Mutex::new(crate::llm::embedded::Embedded::new(
                db_path.parent().unwrap_or(std::path::Path::new(".")),
            )),
            drain_lock: tokio::sync::Mutex::new(()),
            retry_after: Mutex::new(Default::default()),
            md_dir,
        })
    }

    /// Clear `extracting` marks left by a crash, so those sessions are picked up
    /// again instead of being skipped forever.
    pub async fn requeue_interrupted(&self) -> Result<usize, String> {
        self.store
            .lock()
            .await
            .reset_stale_extractions()
            .map_err(|e| e.to_string())
    }
}

/// What extraction is doing right now, and what it did last.
#[derive(Serialize, Clone, Default)]
pub struct ExtractionProgress {
    pub running: Option<RunningExtraction>,
    pub last: Option<LastExtraction>,
    pub pending: i64,
}

#[derive(Serialize, Clone)]
pub struct RunningExtraction {
    pub session_id: i64,
    pub phase: crate::extract::Phase,
    /// RFC3339. The UI derives elapsed time from this rather than being told,
    /// so the display keeps counting between events.
    pub started_at: String,
}

#[derive(Serialize, Clone)]
pub struct LastExtraction {
    pub session_id: i64,
    pub ideas: usize,
    pub dropped: usize,
    pub drop_rate: f32,
    pub seconds: i64,
    pub retried: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Token {
    pub text: String,
}

#[derive(Serialize)]
pub struct Startup {
    pub servers: Vec<Detected>,
    /// Set when exactly one usable server was found and we selected it outright.
    pub selected: Option<Selected>,
}

#[derive(Serialize, Clone)]
pub struct Selected {
    pub kind: LocalKind,
    pub label: String,
    pub model: String,
}

/// Probe for local servers and, when the choice is unambiguous, make it.
#[tauri::command]
pub async fn startup(state: State<'_, AppState>) -> Result<Startup, String> {
    let servers = detect::probe_local().await;

    // A saved choice wins over anything detected. Without this, picking a model
    // would be forgotten at the next launch, because auto-selection runs first
    // and would quietly overrule it.
    let saved = state.settings.lock().await.clone();
    if let Some(choice) = &saved.chat {
        let still_there = servers.iter().any(|s| {
            s.kind == choice.kind && s.models.iter().any(|m| m.id == choice.model)
        });
        if still_there {
            set_active(&state, choice.kind, &choice.host, &choice.model).await;
            if let Some(ex) = &saved.extraction {
                *state.extractor.lock().await = Some(Extractor {
                    provider: detect::extractor(ex.kind, &ex.host, &ex.model),
                    label: ex.kind.label().to_string(),
                    model: ex.model.clone(),
                });
            }
            return Ok(Startup {
                servers,
                selected: Some(Selected {
                    kind: choice.kind,
                    label: choice.kind.label().to_string(),
                    model: choice.model.clone(),
                }),
            });
        }
        tracing::info!(model = %choice.model, "saved model is no longer available");
    }

    // Auto-select only when there is genuinely nothing to decide: exactly one
    // server with exactly one ready chat model. Anything else is a real choice
    // and belongs to the user — guessing picks which model shapes their thinking,
    // and can pick one that cannot run at all.
    let selected = match detect::obvious_choice(&servers) {
        Some((server, model)) => {
            let (kind, host, id) = (server.kind, server.host.clone(), model.id.clone());
            set_active(&state, kind, &host, &id).await;
            // Written down, not just applied. Leaving the file naming a server
            // that is gone means every later save tries to go back to it.
            remember_choice(&state, kind, &host, &id).await;
            Some(Selected { kind, label: kind.label().to_string(), model: id })
        }
        None => None,
    };

    Ok(Startup { servers, selected })
}

#[tauri::command]
pub async fn select_provider(
    state: State<'_, AppState>,
    kind: LocalKind,
    host: String,
    model: String,
) -> Result<Selected, String> {
    set_active(&state, kind, &host, &model).await;
    remember_choice(&state, kind, &host, &model).await;
    Ok(Selected { kind, label: kind.label().to_string(), model })
}

/// Record which model is in use, so the settings file agrees with reality.
async fn remember_choice(state: &State<'_, AppState>, kind: LocalKind, host: &str, model: &str) {
    let mut settings = state.settings.lock().await;
    let choice = crate::settings::ModelChoice {
        kind,
        host: host.to_string(),
        model: model.to_string(),
    };
    // Extraction follows only where it was following already — someone who
    // chose a separate extractor meant it.
    if settings.extraction == settings.chat {
        settings.extraction = Some(choice.clone());
    }
    settings.chat = Some(choice);
    let _ = settings.save(&state.data_dir);
}

async fn set_active(state: &State<'_, AppState>, kind: LocalKind, host: &str, model: &str) {
    *state.active.lock().await = Some(Active {
        provider: detect::chat_provider(kind, host, model),
        kind,
        model: model.to_string(),
    });

    // Extraction follows the chat model unless it has been chosen explicitly.
    // Most people never touch it, and an unset extractor would mean sessions
    // silently piling up unextracted.
    if state.extractor.lock().await.is_none() {
        *state.extractor.lock().await = Some(Extractor {
            provider: detect::extractor(kind, host, model),
            label: kind.label().to_string(),
            model: model.to_string(),
        });
    }
    // Switching models mid-conversation would mean the transcript was written by
    // two different models. Start clean instead.
    *state.conversation.lock().await = Some(Conversation::new(model));
    *state.session.lock().await = None;
}

/// How many idea titles the chat is handed. Past a few hundred this stops
/// being a prompt and starts being a retrieval problem — the same
/// embedding-shortlist machinery reconciliation already uses.
const RECALL_LIMIT: usize = 200;

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty message".into());
    }

    let provider = {
        let active = state.active.lock().await;
        let a = active.as_ref().ok_or("no model selected yet")?;
        a.provider.clone()
    };

    // First message of a stretch of thinking starts the session clock.
    {
        let mut session = state.session.lock().await;
        match session.as_mut() {
            Some(s) => s.touch(),
            None => {
                let model = state.active.lock().await.as_ref().map(|a| a.model.clone());
                *session = Some(ActiveSession::new(model.unwrap_or_default()));
            }
        }
    }

    let (call_mode, recall, reasoning) = {
        let s = state.settings.lock().await;
        (s.call_mode, s.recall, s.reasoning)
    };

    // What has already been thought, by title, so the reply can connect the
    // two. Fetched once per conversation rather than every turn: the system
    // prompt is the beginning of every request, and a changing one throws away
    // the work the server already did on the prefix. Nothing new can appear
    // here mid-conversation anyway — extraction runs when one ends.
    let needs_recall = {
        let guard = state.conversation.lock().await;
        guard.as_ref().map(|c| !c.recall_decided()).unwrap_or(false)
    };
    let titles = if recall && needs_recall {
        let folder = *state.current_folder.lock().await;
        Some(state.store.lock().await.idea_titles(Some(folder), RECALL_LIMIT).unwrap_or_default())
    } else if needs_recall {
        Some(Vec::new())
    } else {
        None
    };

    let request = {
        let mut guard = state.conversation.lock().await;
        let convo = guard.as_mut().ok_or("no conversation")?;
        convo.set_call_mode(call_mode);
        convo.set_reasoning(reasoning);
        if let Some(titles) = titles {
            convo.set_recall(titles);
        }
        convo.push_user(&text);
        convo.to_request()
    };

    let emitter = app.clone();
    let reply = provider
        .chat_stream(&request, &move |kind, text| {
            // Reasoning goes out on its own channel so the UI can show that
            // something is happening without ever treating it as the reply.
            let event = match kind {
                ChunkKind::Content => "chat:token",
                ChunkKind::Reasoning => "chat:reasoning",
            };
            let _ = emitter.emit(event, Token { text: text.to_string() });
        })
        .await
        .map_err(|e| e.to_string())?;

    if let Some(convo) = state.conversation.lock().await.as_mut() {
        convo.push_assistant(&reply);
    }
    if let Some(s) = state.session.lock().await.as_mut() {
        s.touch();
    }
    Ok(reply)
}

/// Remove one turn from the conversation still being had, without touching
/// the rest of it.
#[tauri::command]
pub async fn delete_turn(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let mut guard = state.conversation.lock().await;
    let convo = guard.as_mut().ok_or("no conversation")?;
    convo.remove(index);
    Ok(())
}

/// Rewind the conversation still being had to before one turn, dropping it
/// and everything said after it.
#[tauri::command]
pub async fn rewind_conversation(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let mut guard = state.conversation.lock().await;
    let convo = guard.as_mut().ok_or("no conversation")?;
    convo.rewind(index);
    Ok(())
}

/// Pick an archived conversation back up.
///
/// The turns are loaded into the live conversation and the session is
/// remembered, so pressing Done again grows it rather than filing a second one
/// beside it. Anything already being said is archived first — losing it to a
/// button press would be the worst kind of bug this app could have.
///
/// Safe for provenance because it can only add at the end: the bytes before the
/// join do not move, so every span already recorded still points at the words
/// it was taken from. Editing an earlier turn would not be, and this does not
/// offer to.
#[tauri::command]
pub async fn continue_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<usize, String> {
    if let Some(a) = end_session_inner(&state, EndReason::Done).await? {
        let _ = app.emit("session:archived", a);
    }

    let turns = state.store.lock().await.turns(session_id).map_err(|e| e.to_string())?;
    let model = state
        .active
        .lock()
        .await
        .as_ref()
        .map(|a| a.model.clone())
        .unwrap_or_default();

    let mut convo = Conversation::new(&model);
    convo.set_call_mode(state.settings.lock().await.call_mode);
    for turn in &turns {
        if turn.role == "assistant" {
            convo.push_assistant(turn.text.clone());
        } else {
            convo.push_user(turn.text.clone());
        }
    }
    let n = turns.len();
    *state.conversation.lock().await = Some(convo);
    *state.continuing.lock().await = Some(session_id);

    // The folder follows the conversation being continued, not whatever was
    // last chosen — this is that conversation again, wherever it was filed.
    if let Ok(folder) = state.store.lock().await.session_folder(session_id) {
        *state.current_folder.lock().await = folder;
    }
    Ok(n)
}

#[derive(Serialize, Clone)]
pub struct Archived {
    pub session_id: i64,
    pub reason: EndReason,
    pub turn_count: usize,
}

/// Finish the current session: archive it, then clear the stream.
///
/// Archiving comes first and the stream is only cleared if it succeeded. Losing
/// someone's thinking to a failed write would be the worst bug this app could
/// have, and "it looked like it saved" is exactly how that happens.
pub async fn end_session_inner(
    state: &AppState,
    reason: EndReason,
) -> Result<Option<Archived>, String> {
    let (rendered, model) = {
        let guard = state.conversation.lock().await;
        let Some(convo) = guard.as_ref() else { return Ok(None) };
        if convo.is_empty() {
            return Ok(None);
        }
        let model = state
            .active
            .lock()
            .await
            .as_ref()
            .map(|a| a.model.clone())
            .unwrap_or_default();
        (convo.render(), model)
    };

    let started_at = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.started_at)
        .unwrap_or_else(chrono::Utc::now);

    // Picked back up rather than started fresh: the same session grows instead
    // of a second one appearing beside it. Every offset already recorded points
    // into the part that has not moved.
    let resumed = state.continuing.lock().await.take();

    let session_id = match resumed {
        Some(id) => {
            let mut store = state.store.lock().await;
            store
                .extend_session(id, &rendered, &model, Some(&state.md_dir))
                .map_err(|e| e.to_string())?;
            id
        }
        None => {
            let mut store = state.store.lock().await;
            store
                .archive_session(&rendered, &model, started_at, Some(&state.md_dir))
                .map_err(|e| e.to_string())?
        }
    };

    if resumed.is_none() {
        let folder = *state.current_folder.lock().await;
        let mut store = state.store.lock().await;
        let _ = store.set_session_folder(session_id, folder);
    }

    let turn_count = rendered.spans.len();

    // Only now is it safe to let go of the conversation.
    *state.conversation.lock().await = Some(Conversation::new(&model));
    *state.session.lock().await = None;

    Ok(Some(Archived { session_id, reason, turn_count }))
}

#[tauri::command]
pub async fn end_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    reason: EndReason,
) -> Result<Option<Archived>, String> {
    let out = end_session_inner(&state, reason).await?;
    if let Some(a) = &out {
        let _ = app.emit("session:archived", a.clone());

        // Extraction runs in the background: it can take minutes on a local
        // model, and the user should be free to start thinking again immediately
        // rather than watching a spinner. The queue makes it safe to detach —
        // if this task never finishes, the session is still marked pending and
        // gets picked up later.
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Manager;
            let state = handle.state::<AppState>();
            drain_pending(&handle, &state).await;
        });
    }
    Ok(out)
}

pub async fn is_session_idle(state: &AppState) -> bool {
    state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.is_idle(chrono::Utc::now()))
        .unwrap_or(false)
}

/// Whether the current session has gone quiet long enough to be over.
#[tauri::command]
pub async fn session_idle(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(is_session_idle(&state).await)
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    folder: Option<i64>,
) -> Result<Vec<SessionSummary>, String> {
    state.store.lock().await.list_sessions(100, folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_turns(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<StoredTurn>, String> {
    state.store.lock().await.turns(session_id).map_err(|e| e.to_string())
}

/// Current transcript. Milestone 2 hands this to the archiver; for now it makes
/// the chat-purity boundary inspectable from the UI.
#[tauri::command]
pub async fn transcript(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .conversation
        .lock()
        .await
        .as_ref()
        .map(|c| c.to_transcript())
        .unwrap_or_default())
}

/// Which provider is in use, if any.
#[tauri::command]
pub async fn active_provider(state: State<'_, AppState>) -> Result<Option<Selected>, String> {
    Ok(state.active.lock().await.as_ref().map(|a| Selected {
        kind: a.kind,
        label: a.kind.label().to_string(),
        model: a.model.clone(),
    }))
}

/// Extract ideas from one archived session.
///
/// Driven off the `sessions.extract_state` queue rather than fired once at
/// archive time, so a crash or a quit mid-extraction is recoverable: the session
/// stays `pending` and gets picked up next launch.
pub async fn extract_session_inner(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: i64,
) -> Result<usize, String> {
    let (extractor, provider_label, model) = {
        let guard = state.extractor.lock().await;
        let e = guard.as_ref().ok_or("no extraction model selected")?;
        (e.provider.clone(), e.label.clone(), e.model.clone())
    };

    let (transcript, turns) = {
        let store = state.store.lock().await;
        let t = store
            .transcript(session_id)
            .map_err(|e| e.to_string())?
            .ok_or("no such session")?;
        let turns = store.verify_turns(session_id).map_err(|e| e.to_string())?;
        (t, turns)
    };

    let started = chrono::Utc::now();
    state
        .store
        .lock()
        .await
        .set_extract_state(session_id, "extracting", None)
        .map_err(|e| e.to_string())?;

    set_running(
        app,
        state,
        Some(RunningExtraction {
            session_id,
            phase: crate::extract::Phase::Asking,
            started_at: started.to_rfc3339(),
        }),
    )
    .await;

    // Phase updates cross into a sync callback, so they go through a channel
    // rather than trying to await inside it.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let pump = {
        let app = app.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Manager;
            while let Some(phase) = rx.recv().await {
                let state = handle.state::<AppState>();
                let mut p = state.progress.lock().await;
                if let Some(r) = p.running.as_mut() {
                    r.phase = phase;
                }
                let snapshot = p.clone();
                drop(p);
                let _ = app.emit("extraction:progress", snapshot);
            }
        })
    };

    // The store lock is deliberately not held across this call — extraction can
    // take minutes on a local model, and holding it would freeze the whole app.
    // Hand the model the categories already in use so it reuses them instead of
    // coining a synonym for a subject it has seen before.
    let known = state
        .store
        .lock()
        .await
        .categories()
        .unwrap_or_default();

    let result = crate::extract::run_with_progress(
        extractor.as_ref(),
        &transcript,
        &turns,
        &known,
        &move |phase| {
            let _ = tx.send(phase);
        },
    )
    .await;

    pump.abort();
    let seconds = (chrono::Utc::now() - started).num_seconds();

    match result {
        Ok(extraction) => {
            let (kept, dropped) = (extraction.ideas.len(), extraction.rejected.len());
            tracing::info!(
                session = session_id,
                kept,
                dropped,
                drop_rate = extraction.drop_rate(),
                retried = extraction.retried,
                seconds,
                "extracted"
            );
            reconcile_and_save(state, session_id, &extraction, &provider_label, &model)
                .await
                .map_err(|e| format!("saving ideas: {e}"))?;

            if !extraction.title.is_empty() {
                let _ = state.store.lock().await.set_session_title_ai(session_id, &extraction.title);
            }

            finish(
                app,
                state,
                LastExtraction {
                    session_id,
                    ideas: kept,
                    dropped,
                    drop_rate: extraction.drop_rate(),
                    seconds,
                    retried: extraction.retried,
                    error: None,
                },
            )
            .await;
            Ok(kept)
        }
        Err(e) => {
            let msg = e.to_string();
            // Back to `pending`, not `failed` — a model that was merely unloaded
            // shouldn't cost the user their session permanently.
            let _ = state
                .store
                .lock()
                .await
                .set_extract_state(session_id, "pending", Some(&msg));
            finish(
                app,
                state,
                LastExtraction {
                    session_id,
                    ideas: 0,
                    dropped: 0,
                    drop_rate: 0.0,
                    seconds,
                    retried: false,
                    error: Some(msg.clone()),
                },
            )
            .await;
            Err(msg)
        }
    }
}

async fn set_running(app: &tauri::AppHandle, state: &AppState, running: Option<RunningExtraction>) {
    let snapshot = {
        let mut p = state.progress.lock().await;
        p.running = running;
        p.pending = state.store.lock().await.diagnostics().map(|d| d.sessions_pending).unwrap_or(0);
        p.clone()
    };
    let _ = app.emit("extraction:progress", snapshot);
}

async fn finish(app: &tauri::AppHandle, state: &AppState, last: LastExtraction) {
    let snapshot = {
        let mut p = state.progress.lock().await;
        p.running = None;
        p.last = Some(last);
        p.pending = state.store.lock().await.diagnostics().map(|d| d.sessions_pending).unwrap_or(0);
        p.clone()
    };
    let _ = app.emit("extraction:progress", snapshot);
}

#[tauri::command]
pub async fn extract_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<usize, String> {
    let _guard = state.drain_lock.lock().await;
    let n = extract_session_inner(&app, &state, session_id).await?;
    let _ = app.emit("ideas:changed", ());
    Ok(n)
}

/// Run extraction now, rather than waiting for the queue.
///
/// Returns false if a run is already in flight — the common case being an
/// impatient second click, which should be a no-op rather than a second
/// concurrent decode competing for the same model.
#[tauri::command]
pub async fn extract_now(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if state.progress.lock().await.running.is_some() {
        return Ok(false);
    }
    // Asking for it explicitly clears any waiting period.
    state.retry_after.lock().await.clear();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state = handle.state::<AppState>();
        drain_pending(&handle, &state).await;
    });
    Ok(true)
}

/// The conversations waiting to be read, in the order they will be.
///
/// The queue is invisible otherwise: the count in the corner says how many are
/// waiting and nothing says *which*, so the only way to stop one being read is
/// to find it in the list and guess.
#[tauri::command]
pub async fn pending_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::store::SessionSummary>, String> {
    let store = state.store.lock().await;
    let ids = store.pending_extraction().map_err(|e| e.to_string())?;
    let all = store.list_sessions(500, None).map_err(|e| e.to_string())?;
    Ok(ids
        .iter()
        .filter_map(|id| all.iter().find(|s| s.id == *id).cloned())
        .collect())
}

#[tauri::command]
pub async fn extraction_progress(
    state: State<'_, AppState>,
) -> Result<ExtractionProgress, String> {
    let mut p = state.progress.lock().await.clone();
    p.pending = state.store.lock().await.diagnostics().map(|d| d.sessions_pending).unwrap_or(0);
    Ok(p)
}

/// Work through every session awaiting extraction, oldest first.
pub async fn drain_pending(app: &tauri::AppHandle, state: &AppState) {
    // Serialized: one extraction at a time, whoever asked for it.
    let _guard = state.drain_lock.lock().await;

    let pending = match state.store.lock().await.pending_extraction() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "could not read extraction queue");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    let now = chrono::Utc::now();
    for id in pending {
        // Skip anything still serving a backoff.
        if let Some((when, _)) = state.retry_after.lock().await.get(&id) {
            if now < *when {
                continue;
            }
        }

        match extract_session_inner(app, state, id).await {
            Ok(n) => {
                state.retry_after.lock().await.remove(&id);
                tracing::info!(session = id, ideas = n, "extraction complete");
            }
            Err(e) => {
                let mut backoff = state.retry_after.lock().await;
                let attempts = backoff.get(&id).map(|(_, n)| *n).unwrap_or(0) + 1;
                // 2, 4, 8 … capped at an hour. A model that is simply switched
                // off should not keep the machine busy.
                let wait = 2u32.saturating_pow(attempts.min(6)).min(60);
                backoff.insert(
                    id,
                    (now + chrono::TimeDelta::minutes(wait as i64), attempts),
                );
                tracing::warn!(
                    session = id,
                    attempts,
                    retry_in_minutes = wait,
                    error = %e,
                    "extraction deferred"
                );
                // Usually means no model is reachable, so the rest of the queue
                // would fail the same way.
                break;
            }
        }
    }
    let _ = app.emit("ideas:changed", ());
    release_model_if_asked(state).await;
}

/// Put the embedded model down once there is nothing left to read.
///
/// This is where `keep_in_memory` finally means something. It runs after the
/// queue is drained rather than when Done is pressed, because Done is
/// immediately followed by an extraction that would only load it again —
/// several gigabytes off disk to do the work we were already doing.
async fn release_model_if_asked(state: &AppState) {
    if state.settings.lock().await.runtime.keep_in_memory {
        return;
    }
    let mut embedded = state.embedded.lock().await;
    if embedded.is_running() {
        tracing::info!("releasing the embedded model — keep in memory is off");
        embedded.stop();
    }
}

#[tauri::command]
pub async fn ideas(
    state: State<'_, AppState>,
    folder: Option<i64>,
) -> Result<Vec<StoredIdea>, String> {
    state.store.lock().await.ideas(folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn diagnostics(state: State<'_, AppState>) -> Result<Diagnostics, String> {
    state.store.lock().await.diagnostics().map_err(|e| e.to_string())
}

/// The archived conversation, split around one quote.
///
/// Errors rather than guessing if the stored offsets no longer select the
/// stored text — see `Store::source_view`.
#[tauri::command]
pub async fn source_view(
    state: State<'_, AppState>,
    evidence_id: i64,
) -> Result<SourceView, String> {
    state
        .store
        .lock()
        .await
        .source_view(evidence_id)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- dictation

#[derive(Serialize, Clone)]
pub struct SpeechModelStatus {
    pub installed: bool,
    /// Roughly what the first-run download costs, so the user can decide.
    pub download_mb: u32,
}

#[tauri::command]
pub async fn speech_model_status(state: State<'_, AppState>) -> Result<SpeechModelStatus, String> {
    Ok(SpeechModelStatus {
        installed: state.models.is_installed(),
        download_mb: 488,
    })
}

/// Download the speech models if they aren't already present.
///
/// Blocking work on a worker thread — half a gigabyte of download and a bzip2
/// unpack would otherwise stall the async runtime the chat is streaming on.
#[tauri::command]
pub async fn download_speech_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.models.is_installed() {
        return Ok(());
    }
    let models = Models::new(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .as_path(),
    );
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        models.ensure(&move |p: DownloadProgress| {
            let _ = emitter.emit("speech:download", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let _ = app.emit("speech:ready", ());
    Ok(())
}

#[tauri::command]
pub async fn start_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.dictation.lock().await.is_some() {
        return Ok(());
    }
    if !state.models.is_installed() {
        return Err("speech model not downloaded yet".into());
    }
    let paths = state.models.paths();

    let emitter = app.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        Dictation::start(
            paths,
            Arc::new(move |event| match event {
                // Phrases land in the composer, never straight into the
                // conversation. Transcription errors would otherwise become
                // evidence errors that look authoritative — the one failure the
                // verifier cannot catch. The user stays the last check.
                SttEvent::Phrase(text) => {
                    let _ = emitter.emit("dictation:phrase", text);
                }
                SttEvent::Speaking(on) => {
                    let _ = emitter.emit("dictation:speaking", on);
                }
                SttEvent::Error(e) => {
                    let _ = emitter.emit("dictation:error", e);
                }
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    *state.dictation.lock().await = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn stop_dictation(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(d) = state.dictation.lock().await.take() {
        // Blocking join, but only for as long as one in-flight segment takes.
        tauri::async_runtime::spawn_blocking(move || d.stop())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn dictation_active(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.dictation.lock().await.is_some())
}

/// Fold one session's extracted ideas into the existing graph.
///
/// Each idea is embedded, shortlisted against what is already there, and
/// adjudicated. Most turn out to be new — the shortlist is usually empty, and
/// then no model call happens at all.
///
/// A failure here must not lose the session: on error the session stays
/// `pending` and is retried, rather than being marked done with nothing saved.
async fn reconcile_and_save(
    state: &AppState,
    session_id: i64,
    extraction: &crate::extract::Extraction,
    provider: &str,
    model: &str,
) -> Result<(), String> {
    // Embed every claim in one batch, off the async runtime — ONNX inference is
    // blocking work and would otherwise stall the chat stream.
    let claims: Vec<String> = extraction.ideas.iter().map(|i| i.raw.claim.clone()).collect();
    let vectors = if claims.is_empty() {
        Vec::new()
    } else {
        let cache = state.embed_cache_dir.clone();
        let mut guard = state.embedder.lock().await;
        if guard.is_none() {
            let cache2 = cache.clone();
            *guard = Some(
                tauri::async_runtime::spawn_blocking(move || Embedder::load(&cache2))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?,
            );
        }
        let embedder = guard.as_mut().expect("just loaded");
        embedder.embed(&claims).map_err(|e| e.to_string())?
    };

    let adjudicator = {
        let guard = state.extractor.lock().await;
        guard.as_ref().ok_or("no extraction model selected")?.provider.clone()
    };

    for (idea, vector) in extraction.ideas.iter().zip(vectors) {
        // Re-read each time: a decision may have added an idea that the next one
        // should be compared against, including within this same session.
        let existing = state
            .store
            .lock()
            .await
            .ideas_with_embeddings()
            .map_err(|e| e.to_string())?;

        let candidates = reconcile::shortlist(&vector, &existing);
        let decision = reconcile::decide(adjudicator.as_ref(), &idea.raw.claim, &candidates)
            .await
            .unwrap_or_else(|e| {
                // A failed adjudication must not merge anything. Keeping the
                // idea separate is the safe direction — see the over-merging rule.
                tracing::warn!(error = %e, "adjudication failed; keeping idea separate");
                reconcile::Decision::New { related: Vec::new() }
            });

        if !matches!(decision, reconcile::Decision::New { .. }) {
            tracing::info!(?decision, claim = %idea.raw.claim, "reconciled");
        }

        let mut store = state.store.lock().await;
        let idea_id = store
            .apply_decision(session_id, idea, &decision, provider, model)
            .map_err(|e| e.to_string())?;

        // A rewritten claim needs a fresh vector; a new one needs its first.
        match &decision {
            reconcile::Decision::Attach { .. } => {}
            reconcile::Decision::Rewrite { new_claim, .. } => {
                let claim = new_claim.clone();
                drop(store);
                let mut guard = state.embedder.lock().await;
                if let Some(e) = guard.as_mut() {
                    if let Ok(v) = e.embed_one(&claim) {
                        let _ = state.store.lock().await.set_embedding(idea_id, &v);
                    }
                }
            }
            _ => {
                store.set_embedding(idea_id, &vector).map_err(|e| e.to_string())?;
            }
        }
    }

    // Rejected ideas are recorded separately: the drop rate is only honest if
    // the failures are kept.
    state
        .store
        .lock()
        .await
        .save_rejections(session_id, extraction)
        .map_err(|e| e.to_string())?;

    condense_replies(state, session_id, adjudicator.as_ref(), model).await;
    Ok(())
}

/// Shorten the answers in a session, after the fact.
///
/// Best-effort: a failure here leaves the full answers readable, which is the
/// state everything already handles. It must not fail the extraction that
/// produced the ideas.
async fn condense_replies(
    state: &AppState,
    session_id: i64,
    model: &dyn IdeaExtractor,
    model_name: &str,
) {
    let pending = match state.store.lock().await.replies_needing_digest(session_id) {
        Ok(p) if !p.is_empty() => p,
        _ => return,
    };

    let input: Vec<(i64, String)> = pending.iter().map(|(_, ord, t)| (*ord, t.clone())).collect();
    let digests = match crate::extract::replies::run(model, &input).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "could not condense replies; leaving them in full");
            return;
        }
    };

    let store = state.store.lock().await;
    for d in digests {
        if let Some((turn_id, _, _)) = pending.iter().find(|(_, ord, _)| *ord == d.turn) {
            let _ = store.set_reply_digest(*turn_id, d.digest.trim(), model_name);
        }
    }
}

#[tauri::command]
pub async fn revert_revision(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    revision_id: i64,
) -> Result<(), String> {
    state
        .store
        .lock()
        .await
        .revert_revision(revision_id)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn graph(state: State<'_, AppState>, folder: Option<i64>) -> Result<Graph, String> {
    state.store.lock().await.graph(folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn conversation_view(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<ConversationView, String> {
    state
        .store
        .lock()
        .await
        .conversation_view(session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn idea_view(state: State<'_, AppState>, idea_id: i64) -> Result<IdeaView, String> {
    state.store.lock().await.idea_view(idea_id).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct Cleared {
    pub evidence_removed: usize,
    pub ideas_removed: usize,
}

/// Throw away a session's ideas and extract it again.
///
/// The prompt changes as this project develops, and old sessions otherwise keep
/// whatever the prompt of the day produced. This is also the recovery path for a
/// run that went badly.
#[tauri::command]
pub async fn reextract_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Cleared, String> {
    let (evidence_removed, ideas_removed) = state
        .store
        .lock()
        .await
        .clear_extraction(session_id)
        .map_err(|e| e.to_string())?;

    let _ = app.emit("ideas:changed", ());

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        drain_pending(&handle, &state).await;
    });

    Ok(Cleared { evidence_removed, ideas_removed })
}

#[tauri::command]
pub async fn delete_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<(), String> {
    state
        .store
        .lock()
        .await
        .delete_session(session_id)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn embedded_status(
    state: State<'_, AppState>,
) -> Result<crate::llm::embedded::EmbeddedStatus, String> {
    Ok(state.embedded.lock().await.status())
}

/// Fetch the weights, reporting progress on the same channel dictation uses.
#[tauri::command]
pub async fn download_embedded_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // A few gigabytes over a blocking reader has no business on the async
    // runtime, so it goes to a blocking thread like the speech model does.
    let root = {
        let mut e = state.embedded.lock().await;
        e.status();
        e.model_path()
    };
    if root.is_file() {
        return Ok(());
    }
    let data_dir = state.data_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let embedded = crate::llm::embedded::Embedded::new(&data_dir);
        embedded.download(&move |p| {
            let _ = handle.emit("model:download", p);
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit("model:download:done", ());
    Ok(())
}

/// Start the bundled model and point both roles at it.
/// Fetch a `llama-server` so the app can run a model without one installed.
/// What the model is doing right now, in numbers.
///
/// Straight from `llama-server`'s own `/slots`, not from anything this app
/// infers. A local model can spend a minute reading a long prompt before it
/// writes a word, and with nothing on screen that is indistinguishable from
/// being hung — which is what makes "it is slow" impossible to tell apart from
/// "it is broken" without this.
#[derive(Debug, Clone, Serialize, Default)]
pub struct RuntimeStatus {
    /// `reading` while the prompt is being processed, `writing` once tokens
    /// are coming out, `idle` otherwise.
    pub phase: String,
    pub prompt_done: u64,
    pub prompt_total: u64,
    /// Prompt tokens that were already cached, and so cost nothing.
    pub prompt_cached: u64,
    pub context: u64,
    /// Present only when the server is ours and answering.
    pub reachable: bool,
}

#[tauri::command]
pub async fn runtime_status(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let host = state.embedded.lock().await.host();
    let Ok(resp) = reqwest::Client::new()
        .get(format!("{host}/slots"))
        .timeout(std::time::Duration::from_millis(700))
        .send()
        .await
    else {
        return Ok(RuntimeStatus::default());
    };
    let Ok(slots) = resp.json::<Vec<serde_json::Value>>().await else {
        return Ok(RuntimeStatus { reachable: true, ..Default::default() });
    };
    let num = |v: &serde_json::Value, k: &str| v.get(k).and_then(|n| n.as_u64()).unwrap_or(0);

    // The busy slot, if any. With several slots only one is usually working,
    // and the idle ones have nothing worth reporting.
    let busy = slots
        .iter()
        .find(|s| s.get("is_processing").and_then(|b| b.as_bool()).unwrap_or(false));
    let Some(slot) = busy else {
        return Ok(RuntimeStatus {
            phase: "idle".into(),
            context: slots.first().map(|s| num(s, "n_ctx")).unwrap_or(0),
            reachable: true,
            ..Default::default()
        });
    };
    let total = num(slot, "n_prompt_tokens");
    let done = num(slot, "n_prompt_tokens_processed");
    Ok(RuntimeStatus {
        // Reading the prompt and writing the answer are different waits, and
        // only one of them has an end you can see coming.
        phase: if total > 0 && done < total { "reading" } else { "writing" }.into(),
        prompt_done: done,
        prompt_total: total,
        prompt_cached: num(slot, "n_prompt_tokens_cache"),
        context: num(slot, "n_ctx"),
        reachable: true,
    })
}

#[tauri::command]
pub async fn voice_status(state: State<'_, AppState>) -> Result<crate::tts::VoiceStatus, String> {
    Ok(crate::tts::Voices::new(&state.data_dir).status())
}

#[tauri::command]
pub async fn install_voice(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let voices = crate::tts::Voices::new(&state.data_dir);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        voices.install(&move |p| {
            let _ = handle.emit("voice:download", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Read a reply out in the downloaded voice.
///
/// Blocking work on a blocking thread: synthesis is a second or two of CPU and
/// playback runs for as long as the sentence takes, neither of which belongs on
/// the async runtime.
#[tauri::command]
pub async fn speak(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let voices = crate::tts::Voices::new(&state.data_dir);
    tauri::async_runtime::spawn_blocking(move || voices.speak(&text, 1.0))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_llama_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    flavour: Option<String>,
) -> Result<(), String> {
    // Stopped first: the running server holds the file being replaced.
    state.embedded.lock().await.stop();
    let flavour = flavour.unwrap_or_else(|| "cpu".into());
    let handle = app.clone();
    let embedded = crate::llm::embedded::Embedded::new(&state.data_dir);
    tauri::async_runtime::spawn_blocking(move || {
        embedded.install_server(&flavour, &move |p| {
            let _ = handle.emit("server:download", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_embedded(
    state: State<'_, AppState>,
    file: Option<String>,
) -> Result<String, String> {
    let rt = state.settings.lock().await.runtime;
    let host = {
        let mut e = state.embedded.lock().await;
        e.start(&rt, file.as_deref())?;
        e.host()
    };

    // llama-server takes a moment to map the weights before it answers. Poll
    // rather than sleeping a guessed amount — a cold 3.8 GB read off a slow
    // disk is much longer than a warm one.
    let url = format!("{host}/v1/models");
    let client = reqwest::Client::new();
    for _ in 0..120 {
        if client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            return Ok(host);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    state.embedded.lock().await.stop();
    Err("llama-server did not come up in time".into())
}

/// Search Hugging Face for GGUF models.
#[tauri::command]
pub async fn search_models(
    query: String,
) -> Result<Vec<crate::llm::embedded::RemoteModel>, String> {
    crate::llm::embedded::search(&query).await
}

/// The GGUF files inside one repository, with their sizes.
#[tauri::command]
pub async fn model_files(repo: String) -> Result<Vec<crate::llm::embedded::RemoteFile>, String> {
    crate::llm::embedded::files(&repo).await
}

/// Fetch a chosen GGUF rather than only the one the app suggests.
#[tauri::command]
pub async fn download_model_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo: String,
    file: String,
    size: u64,
) -> Result<(), String> {
    let data_dir = state.data_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let embedded = crate::llm::embedded::Embedded::new(&data_dir);
        embedded.download_file(&repo, &file, size, &move |p| {
            let _ = handle.emit("model:download", p);
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit("model:download:done", ());
    Ok(())
}

#[tauri::command]
pub async fn stop_embedded(state: State<'_, AppState>) -> Result<(), String> {
    state.embedded.lock().await.stop();
    Ok(())
}

#[tauri::command]
pub async fn folders(state: State<'_, AppState>) -> Result<Vec<crate::store::Folder>, String> {
    state.store.lock().await.folders().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, name: String) -> Result<i64, String> {
    if name.trim().is_empty() {
        return Err("a folder needs a name".into());
    }
    state.store.lock().await.create_folder(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    folder_id: i64,
    name: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("a folder needs a name".into());
    }
    state.store.lock().await.rename_folder(folder_id, &name).map_err(|e| e.to_string())
}

/// Remove a folder. Whatever was filed in it goes back to Root.
#[tauri::command]
pub async fn delete_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder_id: i64,
) -> Result<(), String> {
    state.store.lock().await.delete_folder(folder_id).map_err(|e| e.to_string())?;
    let mut current = state.current_folder.lock().await;
    if *current == folder_id {
        *current = crate::store::ROOT_FOLDER;
    }
    drop(current);
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

/// Which folder the conversation being had now will be filed into.
#[tauri::command]
pub async fn current_folder(state: State<'_, AppState>) -> Result<i64, String> {
    Ok(*state.current_folder.lock().await)
}

#[tauri::command]
pub async fn set_current_folder(state: State<'_, AppState>, folder_id: i64) -> Result<(), String> {
    *state.current_folder.lock().await = folder_id;
    Ok(())
}

/// Move a conversation, and the ideas it produced, to another folder.
#[tauri::command]
pub async fn move_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
    folder_id: i64,
) -> Result<(), String> {
    state
        .store
        .lock()
        .await
        .set_session_folder(session_id, folder_id)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn rename_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
    title: String,
) -> Result<(), String> {
    state
        .store
        .lock()
        .await
        .rename_session(session_id, &title)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_session_archived(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: i64,
    archived: bool,
) -> Result<(), String> {
    state
        .store
        .lock()
        .await
        .set_session_archived(session_id, archived)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn delete_idea(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    idea_id: i64,
) -> Result<(), String> {
    state.store.lock().await.delete_idea(idea_id).map_err(|e| e.to_string())?;
    let _ = app.emit("ideas:changed", ());
    Ok(())
}

// ------------------------------------------------------------ settings

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

/// Save settings and apply the ones that take effect immediately.
#[tauri::command]
pub async fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    // What was saved before, so a save can tell what this one actually changed.
    let previous = state.settings.lock().await.clone();
    settings.save(&state.data_dir).map_err(|e| e.to_string())?;
    *state.settings.lock().await = settings.clone();

    // Only when *this* save changed the choice.
    //
    // It used to compare the saved choice against the live provider and switch
    // whenever they differed — which meant every unrelated save, a voice
    // toggle, a slider, dismissing a dialog, dragged the model back to
    // whatever the file said. With a stale entry naming a server that is no
    // longer running, that silently replaced a working model with a dead one
    // and the next message failed against a host nobody had chosen.
    if settings.chat != previous.chat {
        if let Some(choice) = &settings.chat {
            set_active(&state, choice.kind, &choice.host, &choice.model).await;
        }
    }

    if settings.extraction != previous.extraction {
        if let Some(choice) = &settings.extraction {
            *state.extractor.lock().await = Some(Extractor {
                provider: detect::extractor(choice.kind, &choice.host, &choice.model),
                label: choice.kind.label().to_string(),
                model: choice.model.clone(),
            });
        }
    }

    let _ = app.emit("settings:changed", settings.clone());
    Ok(settings)
}

/// Which models are in use right now.
#[derive(Serialize, Clone)]
pub struct ActiveModels {
    pub chat: Option<Selected>,
    pub extraction: Option<Selected>,
}

#[tauri::command]
pub async fn active_models(state: State<'_, AppState>) -> Result<ActiveModels, String> {
    let chat = state.active.lock().await.as_ref().map(|a| Selected {
        kind: a.kind,
        label: a.kind.label().to_string(),
        model: a.model.clone(),
    });
    let extraction = state.extractor.lock().await.as_ref().map(|e| Selected {
        // `kind` is informational here; the label is what the UI shows.
        kind: LocalKind::LmStudio,
        label: e.label.clone(),
        model: e.model.clone(),
    });
    Ok(ActiveModels { chat, extraction })
}

/// Choose the model for one role.
#[tauri::command]
pub async fn choose_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    role: String,
    kind: LocalKind,
    host: String,
    model: String,
) -> Result<(), String> {
    let choice = ModelChoice { kind, host: host.clone(), model: model.clone() };
    let mut settings = state.settings.lock().await.clone();
    match role.as_str() {
        "chat" => settings.chat = Some(choice),
        "extraction" => settings.extraction = Some(choice),
        other => return Err(format!("unknown role {other}")),
    }
    drop(settings.save(&state.data_dir));
    *state.settings.lock().await = settings.clone();

    match role.as_str() {
        "chat" => set_active(&state, kind, &host, &model).await,
        _ => {
            *state.extractor.lock().await = Some(Extractor {
                provider: detect::extractor(kind, &host, &model),
                label: kind.label().to_string(),
                model: model.clone(),
            });
        }
    }

    let _ = app.emit("settings:changed", settings);
    Ok(())
}

/// Where transcripts are written, so Settings can show it.
#[tauri::command]
pub async fn transcripts_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .settings
        .lock()
        .await
        .transcripts_path(&state.md_dir)
        .to_string_lossy()
        .to_string())
}

/// Re-extract every archived session.
///
/// The prompts change as this develops, and old sessions otherwise keep whatever
/// the prompt of the day produced.
#[tauri::command]
pub async fn reextract_all(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder: Option<i64>,
) -> Result<usize, String> {
    // Scoped to a folder when one is given: re-reading everything to fix one
    // line of thinking means paying for every other one too.
    let sessions: Vec<i64> = state
        .store
        .lock()
        .await
        .list_sessions(1000, folder)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|s| s.id)
        .collect();

    for id in &sessions {
        state
            .store
            .lock()
            .await
            .clear_extraction(*id)
            .map_err(|e| e.to_string())?;
    }

    let _ = app.emit("ideas:changed", ());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        drain_pending(&handle, &state).await;
    });
    Ok(sessions.len())
}

// ------------------------------------------------------------ API keys

#[derive(Serialize, Clone)]
pub struct KeyStatus {
    /// Whether a key is stored. The key itself is never sent to the frontend.
    pub anthropic: bool,
    /// Whether the `claude` CLI is on PATH.
    pub claude_cli: bool,
}

#[tauri::command]
pub async fn key_status() -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        anthropic: crate::secrets::get(crate::secrets::ANTHROPIC).is_some(),
        claude_cli: crate::llm::claude_cli::ClaudeCli::is_available(),
    })
}

/// Store an Anthropic API key in the OS keychain.
///
/// Checked against the API before saving, so a typo is caught here rather than
/// surfacing later as a failed extraction.
#[tauri::command]
pub async fn set_anthropic_key(key: String) -> Result<Vec<String>, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("no key given".into());
    }
    let models = crate::llm::anthropic::Anthropic::new(key.clone(), "")
        .list_models()
        .await
        .map_err(|e| e.to_string())?;
    crate::secrets::set(crate::secrets::ANTHROPIC, &key).map_err(|e| e.to_string())?;
    Ok(models)
}

#[tauri::command]
pub async fn clear_anthropic_key() -> Result<(), String> {
    crate::secrets::delete(crate::secrets::ANTHROPIC).map_err(|e| e.to_string())
}

/// The long-form argument about an idea, generated on first open and kept.
#[tauri::command]
pub async fn idea_deep_dive(
    state: State<'_, AppState>,
    idea_id: i64,
    regenerate: bool,
) -> Result<String, String> {
    if !regenerate {
        if let Ok(Some(cached)) = state.store.lock().await.deep_dive(idea_id) {
            return Ok(cached);
        }
    }

    let (model, label) = {
        let guard = state.extractor.lock().await;
        let e = guard.as_ref().ok_or("no extraction model selected")?;
        (e.provider.clone(), e.model.clone())
    };

    let (claim, strong, weak, quotes) = state
        .store
        .lock()
        .await
        .idea_context(idea_id)
        .map_err(|e| e.to_string())?;

    let text = crate::extract::deepen::run(model.as_ref(), &claim, &strong, &weak, &quotes)
        .await
        .map_err(|e| e.to_string())?;

    let _ = state.store.lock().await.set_deep_dive(idea_id, &text, &label);
    Ok(text)
}

// ------------------------------------------------------------ import

/// Read a pasted conversation without committing to it.
///
/// Preview first, always: getting the roles the wrong way round would file the
/// assistant's words as the person's own, which is the one mistake the rest of
/// the design exists to prevent.
#[tauri::command]
pub async fn preview_import(text: String) -> Result<crate::session::import::Import, String> {
    Ok(crate::session::import::parse(&text))
}

#[tauri::command]
pub async fn import_conversation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    swap_roles: bool,
    source: String,
) -> Result<i64, String> {
    let mut parsed = crate::session::import::parse(&text);
    if swap_roles {
        parsed = crate::session::import::swap(&parsed);
    }
    if parsed.turns.is_empty() {
        return Err("nothing to import".into());
    }

    let messages = crate::session::import::to_messages(&parsed.turns);
    let rendered = crate::session::transcript::render(&messages);
    let label = if source.trim().is_empty() {
        "imported".to_string()
    } else {
        format!("imported/{}", source.trim())
    };

    let session_id = {
        let mut store = state.store.lock().await;
        store
            .archive_session(&rendered, &label, chrono::Utc::now(), Some(&state.md_dir))
            .map_err(|e| e.to_string())?
    };

    let _ = app.emit("session:archived", Archived {
        session_id,
        reason: EndReason::Done,
        turn_count: parsed.turns.len(),
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        drain_pending(&handle, &state).await;
    });

    Ok(session_id)
}
