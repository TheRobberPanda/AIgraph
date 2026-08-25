//! Extraction against a real archived session from the running app.
//!
//! Works on a *copy* of the live database so a test run can never disturb the
//! user's own data. `#[ignore]` — needs both a populated database and a model.
//!
//! ```sh
//! IDEA_GRAPH_MODEL=google/gemma-4-12b-qat \
//!   cargo test --test real_session -- --ignored --nocapture
//! ```

use aigraph_lib::extract;
use aigraph_lib::llm::openai_compat::OpenAiCompat;
use aigraph_lib::llm::types::Role;
use aigraph_lib::store::Store;

fn model() -> String {
    std::env::var("IDEA_GRAPH_MODEL").unwrap_or_else(|_| "google/gemma-4-12b-qat".into())
}

#[tokio::test]
#[ignore = "requires a populated database and a loaded model"]
async fn extracts_ideas_from_a_real_archived_session() {
    let live = dirs_db();
    if !live.exists() {
        eprintln!("no database at {live:?} — run the app and archive a session first");
        return;
    }

    // Copy, never touch the original. In WAL mode the recent writes live in the
    // `-wal` sidecar, not the main file — copying only the `.db` yields a
    // database that opens fine and looks empty.
    let tmp = std::env::temp_dir().join(format!("aigraph-real-{}.db", std::process::id()));
    std::fs::copy(&live, &tmp).expect("copy database");
    for ext in ["-wal", "-shm"] {
        let from =
            live.with_file_name(format!("{}{ext}", live.file_name().unwrap().to_string_lossy()));
        if from.exists() {
            let to =
                tmp.with_file_name(format!("{}{ext}", tmp.file_name().unwrap().to_string_lossy()));
            std::fs::copy(&from, &to).expect("copy wal sidecar");
        }
    }

    let mut store = Store::open(&tmp).expect("open copy");
    let sessions = store.list_sessions(10, None).expect("list");
    assert!(!sessions.is_empty(), "no archived sessions to extract from");

    let session = &sessions[0];
    eprintln!(
        "\nsession {} · {} turns · model {} · state {}",
        session.id, session.turn_count, session.model, session.extract_state
    );

    let turns = store.verify_turns(session.id).unwrap();
    let user_turns = turns.iter().filter(|t| t.role == Role::User).count();
    eprintln!("{user_turns} user turns, {} in all\n", turns.len());

    let extractor = OpenAiCompat::lm_studio(model());
    let out = extract::run(&extractor, &turns).await.expect("extraction failed");

    eprintln!(
        "=== {} kept, {} dropped, drop rate {:.0}%{} ===",
        out.ideas.len(),
        out.rejected.len(),
        out.drop_rate() * 100.0,
        if out.retried { " (after retry)" } else { "" }
    );

    for i in &out.ideas {
        eprintln!("\n• {}", i.raw.claim);
        eprintln!(
            "  quote: {:?}{}",
            i.located.matched_text,
            if i.located.normalized_match { "  [normalized match]" } else { "" }
        );
        for n in &i.raw.notes {
            let mark = match n.kind {
                aigraph_lib::llm::types::NoteKind::Supports => "+",
                aigraph_lib::llm::types::NoteKind::Questions => "?",
            };
            eprintln!("  {mark} {}", n.text);
        }
    }
    for r in &out.rejected {
        eprintln!("\n✗ DROPPED ({:?}) {:?}", r.reason, r.raw.quote);
    }

    // Every surviving quote must really be in the turn it names, and that turn
    // must be the user's. Checked against the stored text, not assumed.
    for i in &out.ideas {
        let turn = turns.iter().find(|t| t.id == i.located.turn_id).expect("turn");
        assert_eq!(turn.role, Role::User, "idea sourced from the assistant");
        assert_eq!(&turn.text[i.located.start_byte..i.located.end_byte], i.located.matched_text);
    }

    // Persisting works too, and diagnostics reflect it.
    store.save_extraction(session.id, &out, "lmstudio", &model()).expect("save");
    let d = store.diagnostics().unwrap();
    eprintln!(
        "\ndiagnostics: {} ideas, {} rejected, {:.0}% drop, {} normalized, {} sessions done",
        d.ideas,
        d.rejected,
        d.drop_rate * 100.0,
        d.normalized,
        d.sessions_extracted
    );
    assert_eq!(d.ideas as usize, out.ideas.len());

    std::fs::remove_file(&tmp).ok();
    for ext in ["-wal", "-shm"] {
        std::fs::remove_file(
            tmp.with_file_name(format!("{}{ext}", tmp.file_name().unwrap().to_string_lossy())),
        )
        .ok();
    }
}

fn dirs_db() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap())
        .join(".local/share/app.aigraph/aigraph.db")
}
