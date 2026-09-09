//! Does extraction actually work against a real OpenRouter model?
//!
//! `#[ignore]` by default: this needs a key and spends real money, so it must
//! not run for someone who just cloned the repo. Run with:
//!
//! ```sh
//! OPENROUTER_API_KEY=sk-or-... \
//! AIGRAPH_OR_MODEL='~z-ai/glm-flash-latest' \
//!   cargo test --test openrouter_live -- --ignored --nocapture
//! ```
//!
//! This exists because a chain of correct-looking reasoning about a provider's
//! dialect is not evidence that a request works. Four separate fixes went out
//! for "the digest fails on OpenRouter", each argued from the code and none of
//! them tried. The catalogue says what a model *claims* to support; only a
//! request finds out what it does.
//!
//! The model to point it at is whichever one is failing. `~z-ai/glm-flash-latest`
//! is the default because that is the one that could not be made to work: its
//! metadata says reasoning is mandatory at maximum effort, which is the case
//! the extraction path had no answer for.

use aigraph_lib::extract::{self, verify::Turn};
use aigraph_lib::llm::openai_compat::OpenAiCompat;
use aigraph_lib::llm::types::Role;

fn model() -> String {
    std::env::var("AIGRAPH_OR_MODEL").unwrap_or_else(|_| "~z-ai/glm-flash-latest".into())
}

fn key() -> String {
    std::env::var("OPENROUTER_API_KEY")
        .expect("set OPENROUTER_API_KEY to run this; it is never read from the keychain here")
}

/// Short, and unmistakably the user's own words, so a failure is about the
/// request rather than about anything subtle in the material.
fn session() -> Vec<Turn> {
    let lines = [
        (Role::User, "I keep choosing the tool I already know over the better one, and I think it is fear rather than judgement."),
        (Role::Assistant, "What would tell the two apart?"),
        (Role::User, "If it were judgement I could say what the tradeoff was. I cannot, so it is fear."),
    ];
    lines
        .iter()
        .enumerate()
        .map(|(i, (role, text))| Turn { id: i as i64 + 1, role: *role, text: (*text).into() })
        .collect()
}

/// The whole question, end to end: ask a real model, get JSON back, and have
/// at least one idea survive verification against what was actually said.
#[tokio::test]
#[ignore]
async fn a_real_openrouter_read_produces_verified_ideas() {
    let model = model();
    let provider =
        OpenAiCompat::new("https://openrouter.ai/api/v1", &model, Some(key()), "openrouter");

    let turns = session();
    let started = std::time::Instant::now();
    let result = extract::run(&provider, &turns).await;
    let took = started.elapsed();

    match &result {
        Ok(e) => {
            println!(
                "\n{model}: {} ideas, {} dropped, in {took:?}",
                e.ideas.len(),
                e.rejected.len()
            );
            for idea in &e.ideas {
                println!("  · {}", idea.raw.claim);
                println!("    quoting: {:?}", idea.located.matched_text);
            }
            for r in &e.rejected {
                println!("  dropped: {:?} — {:?}", r.raw.quote, r.reason);
            }
        }
        // Printed rather than only asserted: the message is the entire point
        // of running this, and a bare assertion failure hides it.
        Err(e) => println!("\n{model} failed after {took:?}:\n  {e}\n"),
    }

    let extraction = result.expect("extraction should reach an answer");
    assert!(
        !extraction.ideas.is_empty(),
        "the model answered but nothing survived verification — \
         every quote it offered was absent from what was actually said"
    );
}
