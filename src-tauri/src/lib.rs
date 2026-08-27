//! AIgraph — think out loud, get a map back.
//!
//! Pipeline, and the invariant each stage holds:
//!
//! ```text
//! chat/      the user's conversation, provably unsteered  (chat purity)
//! session/   boundary detection and archiving             (nothing is lost)
//! extract/   transcript -> proposed ideas -> verified      (no unverified quote)
//! reconcile/ new idea, or a change to an existing one?     (under-merge, never over-merge)
//! embed/     local vectors for shortlisting and layout     (never leaves the machine)
//! store/     SQLite, plus markdown you own                 (no lock-in)
//! ```

pub mod chat;
pub mod commands;
pub mod embed;
pub mod extract;
pub mod llm;
pub mod reconcile;
pub mod secrets;
pub mod session;
pub mod settings;
pub mod store;
pub mod stt;
pub mod tts;

/// Move a previous installation's data across, once.
///
/// The app was called Idea Graph, which put its database under a different
/// identifier and under a different filename. Renaming without this would leave
/// every existing user staring at an empty map with their thinking still on
/// disk under a name they have no reason to know.
///
/// Only ever a move into an empty directory: if there is anything here already
/// then this install is the one in use, and the old copy is left alone rather
/// than merged over the top of it.
fn carry_over_old_data(data_dir: &std::path::Path) {
    if data_dir.join("aigraph.db").exists() {
        return;
    }
    let Some(old) = data_dir.parent().map(|p| p.join("dev.ideagraph.app")) else {
        return;
    };
    if !old.join("idea-graph.db").exists() {
        return;
    }

    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::warn!(error = %e, "could not prepare the data directory");
        return;
    }
    // Copied rather than moved. If this goes wrong halfway the old install is
    // still whole, and someone can go back to it.
    for (from, to) in [
        (old.join("idea-graph.db"), data_dir.join("aigraph.db")),
        (old.join("settings.json"), data_dir.join("settings.json")),
    ] {
        if from.exists() {
            if let Err(e) = std::fs::copy(&from, &to) {
                tracing::warn!(error = %e, file = %from.display(), "could not carry over");
            }
        }
    }
    for dir in ["transcripts", "models", "llm", "embeddings"] {
        let (from, to) = (old.join(dir), data_dir.join(dir));
        if from.is_dir() && !to.exists() {
            // Several gigabytes of weights live in here, so it is a rename
            // where that works and nothing at all where it does not — a model
            // is downloadable again, a transcript is not.
            if let Err(e) = std::fs::rename(&from, &to) {
                tracing::warn!(error = %e, dir, "could not carry over");
            }
        }
    }
    tracing::info!(from = %old.display(), "carried over data from the previous name");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "aigraph_lib=info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::startup,
            commands::select_provider,
            commands::send_message,
            commands::transcript,
            commands::active_provider,
            commands::end_session,
            commands::session_idle,
            commands::list_sessions,
            commands::session_turns,
            commands::extract_session,
            commands::ideas,
            commands::diagnostics,
            commands::extract_now,
            commands::extraction_progress,
            commands::stop_digest,
            commands::pending_sessions,
            commands::pending_sessions,
            commands::source_view,
            commands::speech_model_status,
            commands::download_speech_model,
            commands::start_dictation,
            commands::stop_dictation,
            commands::dictation_active,
            commands::revert_revision,
            commands::graph,
            commands::conversation_view,
            commands::idea_view,
            commands::reextract_session,
            commands::continue_session,
            commands::install_llama_server,
            commands::runtime_status,
            commands::reset_runtime,
            commands::voice_status,
            commands::install_voice,
            commands::speak,
            commands::delete_session,
            commands::embedded_status,
            commands::download_embedded_model,
            commands::start_embedded,
            commands::stop_embedded,
            commands::search_models,
            commands::model_files,
            commands::download_model_file,
            commands::folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::current_folder,
            commands::set_current_folder,
            commands::move_session,
            commands::rename_session,
            commands::set_session_archived,
            commands::delete_turn,
            commands::rewind_conversation,
            commands::delete_idea,
            commands::get_settings,
            commands::save_settings,
            commands::active_models,
            commands::choose_model,
            commands::transcripts_dir,
            commands::set_transcripts_dir,
            commands::reextract_all,
            commands::key_status,
            commands::set_anthropic_key,
            commands::clear_anthropic_key,
            commands::idea_deep_dive,
            commands::preview_import,
            commands::import_conversation,
        ])
        .setup(|app| {
            use tauri::Manager;

            let data_dir = app.path().app_data_dir()?;
            carry_over_old_data(&data_dir);
            let state = commands::AppState::new(
                &data_dir.join("aigraph.db"),
                data_dir.join("transcripts"),
            )?;

            app.manage(state);

            // A session that ends because the user wandered off still has to be
            // archived. Without this, walking away from a good ramble loses it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    ticker.tick().await;
                    let state = handle.state::<commands::AppState>();
                    if !commands::is_session_idle(&state).await {
                        continue;
                    }
                    match commands::end_session_inner(&state, session::EndReason::Idle).await {
                        Ok(Some(archived)) => {
                            tracing::info!(session = archived.session_id, "archived idle session");
                            let _ = tauri::Emitter::emit(&handle, "session:archived", archived);
                        }
                        Ok(None) => {}
                        Err(e) => tracing::error!(error = %e, "failed to archive idle session"),
                    }
                    commands::drain_pending(&handle, &handle.state::<commands::AppState>()).await;
                }
            });

            // Anything left unextracted from a previous run gets picked up now.
            // Sessions interrupted mid-extraction are still marked `extracting`
            // and would be skipped by the queue forever, so requeue those first.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<commands::AppState>();
                match state.requeue_interrupted().await {
                    Ok(n) if n > 0 => tracing::info!(count = n, "requeued interrupted extractions"),
                    Ok(_) => {}
                    Err(e) => tracing::error!(error = %e, "could not requeue extractions"),
                }
                commands::drain_pending(&handle, &state).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AIgraph")
        .run(|app, event| {
            // Closing the app must not discard an unfinished session either.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                use tauri::Manager;
                let state = app.state::<commands::AppState>();
                let stop_result = tauri::async_runtime::block_on(async {
                    match commands::end_session_inner(&state, session::EndReason::AppClosing).await
                    {
                        Ok(Some(a)) => tracing::info!(session = a.session_id, "archived on exit"),
                        Ok(None) => {}
                        Err(e) => tracing::error!(error = %e, "failed to archive on exit"),
                    }
                    // `Embedded`'s own `Drop` stops the server too, but relying
                    // on that here means relying on Tauri actually dropping
                    // managed state on the way out — which is how a model kept
                    // running after the window closed, holding its RAM and
                    // VRAM until something else needed them and failed to get
                    // them. Stopping it explicitly does not depend on that,
                    // and the app does not close until this returns — closing
                    // instantly and hoping the server catches up is the same
                    // bug with extra steps.
                    commands::stop_embedded_now(&state).await
                });
                if let Err(e) = stop_result {
                    tracing::error!(error = %e, "failed to stop the embedded model on exit");
                    // The window stays open rather than vanishing on top of a
                    // model that is still holding its memory — a closed
                    // window with no error is indistinguishable from "it
                    // worked", and that is the one outcome this has to avoid.
                    api.prevent_exit();
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog()
                        .message(format!(
                            "AIgraph could not stop the local model:\n\n{e}\n\n\
                             The window has stayed open so this isn't hidden. \
                             You can try closing again, or end the process \
                             yourself before quitting."
                        ))
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .title("Could not stop the model")
                        .blocking_show();
                }
            }
        });
}
