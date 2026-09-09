//! Does extraction actually work against a real OpenRouter model?
//!
//! `#[ignore]` by default: this needs a key and spends real money, so it must
//! not run for someone who just cloned the repo. Run with:
//!
//! ```sh
//! cargo test --test openrouter_live -- --ignored --nocapture
//! ```
//!
//! The key comes from the app's own keychain entry, so nothing has to be
//! pasted. `OPENROUTER_API_KEY` overrides it, and `AIGRAPH_OR_MODEL` picks a
//! different model than the one that was failing.
//!
//! This exists because a chain of correct-looking reasoning about a provider's
//! dialect is not evidence that a request works. Four separate fixes went out
//! for "the digest fails on OpenRouter", each argued from the code and none of
//! them tried. The catalogue says what a model *claims* to support; only a
//! request finds out what it does.
//!
//! The default is `z-ai/glm-5.2`, which works. `~z-ai/glm-flash-latest` (5.3)
//! does not, for reasons that were never pinned down — it reached an answer
//! once here and does not in the app — so the app is not contorted around it.
//! Point this at whichever model is in question.

use aigraph_lib::extract::{self, verify::Turn};
use aigraph_lib::llm::openai_compat::OpenAiCompat;
use aigraph_lib::llm::types::Role;

fn model() -> String {
    std::env::var("AIGRAPH_OR_MODEL").unwrap_or_else(|_| "z-ai/glm-5.2".into())
}

/// The key, from the environment or from the same keychain the app reads.
///
/// Falling back to the keychain is the point: it means running this needs no
/// secret handling at all, and it exercises the retrieval the app itself
/// depends on. If the keychain cannot be read here it cannot be read there
/// either, and every request goes out unauthenticated — which is worth
/// finding out from a test rather than from a confusing 401 mid-digest.
fn key() -> String {
    if let Ok(k) = std::env::var("OPENROUTER_API_KEY") {
        if !k.trim().is_empty() {
            return k;
        }
    }
    aigraph_lib::secrets::get(aigraph_lib::secrets::OPENROUTER).expect(
        "no OpenRouter key: not in OPENROUTER_API_KEY, and the keychain returned nothing. \
         If one is saved in the app, the keychain is not readable from this shell — \
         which is the same failure the app would hit, so it is worth knowing.",
    )
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
