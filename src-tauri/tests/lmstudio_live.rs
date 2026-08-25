//! End-to-end checks against a real local model.
//!
//! `#[ignore]` by default: these need a server with a model loaded, so they must
//! not break `cargo test` for someone who just cloned the repo. Run with:
//!
//! ```sh
//! IDEA_GRAPH_MODEL=google/gemma-4-12b-qat cargo test --test lmstudio_live -- --ignored --nocapture
//! ```
//!
//! These measure the number the plan says gates everything else: the share of
//! proposed ideas that cannot be traced back to something the user actually said.

use aigraph_lib::chat::Conversation;
use aigraph_lib::extract::{self, verify::Turn};
use aigraph_lib::llm::openai_compat::OpenAiCompat;
use aigraph_lib::llm::types::Role;
use aigraph_lib::llm::{ChatProvider, ChunkKind};
use std::sync::Mutex;

fn model() -> String {
    std::env::var("IDEA_GRAPH_MODEL").unwrap_or_else(|_| "google/gemma-4-12b-qat".into())
}

/// The plan's worked example: a claim, then the user walking it back to
/// something more precise in the same conversation.
fn refinement_session() -> Vec<Turn> {
    let lines = [
        (Role::User, "I've been thinking that Trump is a bad man, plain and simple."),
        (Role::Assistant, "What leads you to that?"),
        (Role::User, "Well, actually, I'm not sure he's a bad guy exactly. He acts like a bad person in certain circumstances, especially when he's cornered or when there's an audience. That's different from being rotten all the way through."),
        (Role::Assistant, "That's a meaningful distinction. What turns on it for you?"),
        (Role::User, "It matters because if it's situational then incentives could change the behaviour, but if it's character then nothing will. I lean towards situational, though I admit I'm partly saying that because the alternative is bleak."),
    ];
    lines
        .iter()
        .enumerate()
        .map(|(i, (role, text))| Turn { id: i as i64 + 1, role: *role, text: (*text).into() })
        .collect()
}

#[tokio::test]
#[ignore = "requires LM Studio with a model loaded"]
async fn chat_streams_and_keeps_reasoning_out_of_the_reply() {
    let provider = OpenAiCompat::lm_studio(model());

    let mut convo = Conversation::new(model());
    convo.push_user("Reply with exactly the word: acknowledged");

    let content = Mutex::new(String::new());
    let reasoning = Mutex::new(String::new());

    let reply = provider
        .chat_stream(&convo.to_request(), &|kind, text| match kind {
            ChunkKind::Content => content.lock().unwrap().push_str(text),
            ChunkKind::Reasoning => reasoning.lock().unwrap().push_str(text),
        })
        .await
        .expect("chat failed");

    assert!(!reply.trim().is_empty(), "model returned nothing");
    assert_eq!(
        reply,
        *content.lock().unwrap(),
        "the returned reply must be exactly the content stream"
    );

    let thought = reasoning.lock().unwrap().clone();
    if !thought.is_empty() {
        assert!(
            !reply.contains(&thought),
            "reasoning leaked into the reply, and would reach the archived transcript"
        );
        eprintln!("[reasoning streamed separately: {} chars]", thought.len());
    }
    eprintln!("reply: {reply:?}");
}

#[tokio::test]
#[ignore = "requires LM Studio with a model loaded"]
async fn extraction_traces_ideas_back_to_real_words() {
    let turns = refinement_session();

    let extractor = OpenAiCompat::lm_studio(model());

    let out = extract::run(&extractor, &turns).await.expect("extraction failed");

    eprintln!(
        "\n=== {} ideas kept, {} dropped, drop rate {:.0}%{} ===",
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
            if i.located.normalized_match { " [normalized]" } else { "" }
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
        eprintln!("\n✗ DROPPED ({:?}): {:?}", r.reason, r.raw.quote);
    }

    assert!(!out.ideas.is_empty(), "extracted nothing from a substantive conversation");

    // The guarantee, checked against the real transcript rather than trusted:
    // every surviving quote is genuinely present in the turn it claims.
    for i in &out.ideas {
        let turn = turns.iter().find(|t| t.id == i.located.turn_id).expect("unknown turn");
        assert_eq!(turn.role, Role::User, "an idea was sourced from the assistant");
        assert_eq!(
            &turn.text[i.located.start_byte..i.located.end_byte],
            i.located.matched_text,
            "byte offsets do not select the text they claim to"
        );
    }

    assert!(
        out.drop_rate() <= 0.5,
        "drop rate {:.0}% — the prompt or the model is not holding up",
        out.drop_rate() * 100.0
    );
}
