//! Everything said, on disk before it is anywhere else.
//!
//! A conversation used to live only in memory until it was filed. Filing ran
//! when Done was pressed, when it went quiet, or when the app was asked to
//! close — and an app that is killed, crashes, loses power or is restarted by
//! a rebuild is never asked anything. On 2026-09-14 that lost a whole
//! conversation with no copy anywhere.
//!
//! So the live conversation is written here every time it changes, and the
//! words of a message are written the moment it is sent, before the model is
//! asked anything. What is being typed and not yet sent has a file of its own.
//! Every write goes to a temporary file, is flushed to the disk, and is then
//! renamed over the old one: a crash mid-write leaves the previous copy whole,
//! never half of a new one.
//!
//! Nothing here is ever deleted. A conversation that is filed has its journal
//! moved into `filed/`, beside every one before it.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::llm::types::Message;

/// The live conversation as it stood at its last change.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Live {
    #[serde(default)]
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub model: String,
    /// The folder it would be filed in.
    #[serde(default)]
    pub folder: i64,
    /// The archived conversation this one continues, if it was picked back up.
    #[serde(default)]
    pub continuing: Option<i64>,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// A message sent and not yet part of the conversation — on its way to
    /// the model, or refused by it. Kept so it cannot fall between the two.
    #[serde(default)]
    pub pending: Option<String>,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("journal")
}

fn live_path(data_dir: &Path) -> PathBuf {
    dir(data_dir).join("live.json")
}

fn draft_path(data_dir: &Path) -> PathBuf {
    dir(data_dir).join("draft.txt")
}

/// Write a file so that, whatever happens, it is either the old contents or
/// the new ones — and whichever it is has reached the disk.
pub fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    // The rename itself lives in the directory; flush that too, or a power cut
    // can leave the directory pointing at the old file.
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(parent) {
        let _ = d.sync_all();
    }
    Ok(())
}

pub fn save_live(data_dir: &Path, live: &Live) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(live).map_err(std::io::Error::other)?;
    write_durably(&live_path(data_dir), &bytes)
}

/// The live conversation left by the last run, if there is one.
pub fn load_live(data_dir: &Path) -> Option<Live> {
    let text = std::fs::read_to_string(live_path(data_dir)).ok()?;
    match serde_json::from_str(&text) {
        Ok(live) => Some(live),
        Err(e) => {
            // Unreadable is not a reason to lose it: set it aside under its
            // own name, where a person can still open it.
            tracing::error!(error = %e, "live journal unreadable; keeping it aside");
            let _ = std::fs::rename(
                live_path(data_dir),
                dir(data_dir).join(format!("unreadable-{}.json", stamp())),
            );
            None
        }
    }
}

/// Move the live journal into `filed/` once the conversation is safely in the
/// database. Moved, not deleted.
pub fn retire_live(data_dir: &Path, session_id: i64) -> std::io::Result<()> {
    let from = live_path(data_dir);
    if !from.exists() {
        return Ok(());
    }
    let filed = dir(data_dir).join("filed");
    std::fs::create_dir_all(&filed)?;
    std::fs::rename(from, filed.join(format!("{}-session-{session_id}.json", stamp())))
}

/// Where every conversation is kept as a plain file a person can open without
/// the app — the place to look after a crash.
pub fn conversations_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("conversations")
}

/// Write the live conversation as markdown into `conversations/`, one file per
/// conversation, rewritten as it grows. Never deleted by the app.
pub fn save_readable(data_dir: &Path, live: &Live) -> std::io::Result<()> {
    if live.messages.is_empty() && live.pending.is_none() {
        return Ok(());
    }
    let started = live.started_at.unwrap_or_else(chrono::Utc::now);
    let local = started.with_timezone(&chrono::Local);
    // No colons: Windows will not have them in a file name.
    let name = format!("{}.md", local.format("%Y-%m-%d %H.%M.%S"));
    let mut text = format!("# Conversation, {}\n\n", local.format("%Y-%m-%d %H:%M"));
    if !live.model.is_empty() {
        text.push_str(&format!("Model: {}\n\n", live.model));
    }
    for m in &live.messages {
        let who = match m.role {
            crate::llm::types::Role::User => "You",
            crate::llm::types::Role::Assistant => "AIgraph",
        };
        text.push_str(&format!("## {who}\n\n{}\n\n", m.content.trim_end()));
    }
    if let Some(p) = &live.pending {
        text.push_str(&format!("## You (sent, not yet answered)\n\n{}\n\n", p.trim_end()));
    }
    write_durably(&conversations_dir(data_dir).join(name), text.as_bytes())
}

fn running_path(data_dir: &Path) -> PathBuf {
    dir(data_dir).join("running")
}

/// Mark the app as running. Returns true when the last run never reached
/// [`mark_stopped`] — it crashed, was killed, or lost power.
pub fn mark_running(data_dir: &Path) -> bool {
    let path = running_path(data_dir);
    let crashed = path.exists();
    if let Err(e) = write_durably(&path, stamp().as_bytes()) {
        tracing::warn!(error = %e, "could not write the running marker");
    }
    crashed
}

/// The app is closing the way it was asked to.
pub fn mark_stopped(data_dir: &Path) {
    let _ = std::fs::remove_file(running_path(data_dir));
}

pub fn save_draft(data_dir: &Path, text: &str) -> std::io::Result<()> {
    write_durably(&draft_path(data_dir), text.as_bytes())
}

pub fn load_draft(data_dir: &Path) -> String {
    std::fs::read_to_string(draft_path(data_dir)).unwrap_or_default()
}

fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::Role;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aigraph-journal-{name}-{}-{}",
            std::process::id(),
            stamp()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_live_conversation_survives_a_round_trip_and_is_never_deleted() {
        let d = scratch("live");
        let live = Live {
            model: "m".into(),
            folder: 2,
            messages: vec![Message { role: Role::User, content: "one single word".into() }],
            pending: Some("and this".into()),
            ..Default::default()
        };
        save_live(&d, &live).unwrap();
        let back = load_live(&d).expect("the journal reads back");
        assert_eq!(back.messages[0].content, "one single word");
        assert_eq!(back.pending.as_deref(), Some("and this"));
        assert_eq!(back.folder, 2);

        retire_live(&d, 7).unwrap();
        assert!(load_live(&d).is_none(), "filed, so no longer live");
        let filed: Vec<_> = std::fs::read_dir(dir(&d).join("filed")).unwrap().collect();
        assert_eq!(filed.len(), 1, "moved into filed/, not deleted");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_draft_is_kept_and_a_new_one_replaces_it_whole() {
        let d = scratch("draft");
        assert_eq!(load_draft(&d), "");
        save_draft(&d, "half a thought").unwrap();
        save_draft(&d, "half a thought, finished").unwrap();
        assert_eq!(load_draft(&d), "half a thought, finished");
        assert!(!dir(&d).join("draft.tmp").exists(), "no temporary file left behind");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_conversation_is_written_where_a_person_can_read_it() {
        let d = scratch("readable");
        let mut live = Live {
            started_at: Some(chrono::Utc::now()),
            messages: vec![Message { role: Role::User, content: "first".into() }],
            ..Default::default()
        };
        save_readable(&d, &live).unwrap();
        live.messages.push(Message { role: Role::Assistant, content: "second".into() });
        save_readable(&d, &live).unwrap();
        let files: Vec<_> = std::fs::read_dir(conversations_dir(&d))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .collect();
        assert_eq!(files.len(), 1, "one file per conversation, rewritten as it grows");
        let text = std::fs::read_to_string(files[0].path()).unwrap();
        assert!(text.contains("first") && text.contains("second"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_that_never_stopped_is_noticed() {
        let d = scratch("running");
        assert!(!mark_running(&d), "a first launch is not a crash");
        assert!(mark_running(&d), "launched again without stopping");
        mark_stopped(&d);
        assert!(!mark_running(&d), "a clean stop is not a crash");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_journal_is_set_aside_rather_than_lost() {
        let d = scratch("bad");
        std::fs::create_dir_all(dir(&d)).unwrap();
        std::fs::write(live_path(&d), b"{ not json").unwrap();
        assert!(load_live(&d).is_none());
        let kept = std::fs::read_dir(dir(&d))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("unreadable-"));
        assert!(kept, "the bytes are still on disk under another name");
        let _ = std::fs::remove_dir_all(&d);
    }
}
