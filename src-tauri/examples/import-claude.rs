//! One-off: bring a Claude JSONL conversation into the app's own store,
//! through the same parse → render → archive pipeline the import command
//! runs. Run with the app closed:
//!
//!   cargo run --example import-claude -- /path/to/conversation.jsonl

use aigraph_lib::llm::types::{Message, Role};

/// The same filter the app's `list_claude_imports` applies: what was said
/// stays, tool calls and their output do not.
fn claude_line_to_text(kind: &str, value: &serde_json::Value) -> Option<String> {
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if value.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
        return None;
    }
    if value.get("isSidechain").and_then(|m| m.as_bool()).unwrap_or(false) {
        return None;
    }
    let message = value.get("message")?;
    let content = message.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => {
            let mut out = String::new();
            for block in blocks {
                if block.get("type")?.as_str()? == "text" {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
            out
        }
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty()
        || text.starts_with("[Request interrupted")
        || text.starts_with("<scheduled-task")
        || text.starts_with("<local-command")
        || text.starts_with("@")
    {
        return None;
    }
    Some(text.to_string())
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: import-claude <file.jsonl>");
    let body = std::fs::read_to_string(&path).expect("read the file");
    let mut messages: Vec<Message> = Vec::new();
    for line in body.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        let Some(said) = claude_line_to_text(kind, &value) else {
            continue;
        };
        messages.push(Message {
            role: if kind == "assistant" { Role::Assistant } else { Role::User },
            content: said,
        });
    }
    println!("parsed {} turns", messages.len());
    if messages.is_empty() {
        return;
    }

    let rendered = aigraph_lib::session::transcript::render(&messages);
    let home = std::env::var("HOME").expect("home");
    let data_dir = std::path::Path::new(&home).join(".local/share/app.aigraph");
    let mut store =
        aigraph_lib::store::Store::open(&data_dir.join("aigraph.db")).expect("open the store");
    let id = store
        .archive_session(
            &rendered,
            "imported/claude",
            chrono::Utc::now(),
            Some(&data_dir.join("transcripts")),
        )
        .expect("archive the session");
    println!("imported as session {}", id);
}
