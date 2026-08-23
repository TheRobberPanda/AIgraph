//! Idea Graph — think out loud, get a map back.
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
pub mod stt;
pub mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "idea_graph_lib=info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            commands::delete_session,
            commands::embedded_status,
            commands::download_embedded_model,
            commands::start_embedded,
            commands::stop_embedded,
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
            let state = commands::AppState::new(
                &data_dir.join("idea-graph.db"),
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
        .expect("error while building Idea Graph")
        .run(|app, event| {
            // Closing the app must not discard an unfinished session either.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                let state = app.state::<commands::AppState>();
                tauri::async_runtime::block_on(async {
                    match commands::end_session_inner(&state, session::EndReason::AppClosing).await {
                        Ok(Some(a)) => tracing::info!(session = a.session_id, "archived on exit"),
                        Ok(None) => {}
                        Err(e) => tracing::error!(error = %e, "failed to archive on exit"),
                    }
                });
            }
        });
}
