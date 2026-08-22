//! Does adjudication actually judge the way the product needs it to?
//!
//! The unit tests cover what happens *given* a verdict. This covers whether a
//! real model produces the right verdict in the first place — which is a prompt
//! question, not a code question, and the only way to know is to ask it.
//!
//! ```sh
//! cargo test --test reconcile_fixtures -- --ignored --nocapture
//! ```
//!
//! # Scoring
//!
//! Deliberately asymmetric. A false `refines` or `duplicate` silently merges two
//! different thoughts and misrepresents what someone believes; a false `distinct`
//! only leaves a tidy graph slightly untidy. Wrong merges are therefore counted
//! as failures, while missed merges are counted as misses and tolerated.

use idea_graph_lib::llm::openai_compat::OpenAiCompat;
use idea_graph_lib::reconcile::{decide, Candidate, Decision};

fn model() -> String {
    std::env::var("IDEA_GRAPH_MODEL").unwrap_or_else(|_| "google/gemma-4-12b-qat".into())
}

/// What we expect, and what would be a *harmful* answer as opposed to a timid one.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Want {
    /// Should merge into the existing bubble (duplicate or refines).
    Merge,
    /// Must stay separate. Merging these would misrepresent the person.
    Separate,
}

struct Case {
    name: &'static str,
    existing: &'static str,
    incoming: &'static str,
    want: Want,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "the walk-back — same thought, made precise",
            existing: "Trump is a bad man.",
            incoming: "Trump is not a bad person exactly; he acts badly when cornered or when there is an audience.",
            want: Want::Merge,
        },
        Case {
            name: "plain restatement",
            existing: "Latency is the real bottleneck in this system.",
            incoming: "The main thing slowing this system down is latency.",
            want: Want::Merge,
        },
        Case {
            name: "same subject, different claim",
            existing: "Latency is the real bottleneck in this system.",
            incoming: "Latency is easy to measure but hard to explain to stakeholders.",
            want: Want::Separate,
        },
        Case {
            name: "shared vocabulary, unrelated thought",
            existing: "Open source works because contributors are motivated by reputation.",
            incoming: "Open source licences are badly understood by most companies.",
            want: Want::Separate,
        },
        Case {
            name: "a flat reversal, not a refinement",
            existing: "Remote work makes teams more productive.",
            incoming: "Remote work makes teams less productive.",
            want: Want::Separate,
        },
        Case {
            name: "different domains entirely",
            existing: "My sister needs more support than she asks for.",
            incoming: "Rust's borrow checker is worth the learning curve.",
            want: Want::Separate,
        },
    ]
}

#[tokio::test]
#[ignore = "requires a loaded model"]
async fn adjudication_merges_what_it_should_and_nothing_more() {
    let adjudicator = OpenAiCompat::lm_studio(model());

    let mut harmful = Vec::new();
    let mut missed = Vec::new();

    for case in cases() {
        let candidates = vec![Candidate {
            idea_id: 1,
            claim: case.existing.into(),
            similarity: 0.8,
        }];

        let decision = decide(&adjudicator, case.incoming, &candidates)
            .await
            .expect("adjudication failed");

        let merged = matches!(
            decision,
            Decision::Attach { .. } | Decision::Rewrite { .. }
        );

        let verdict = match (&decision, case.want) {
            (Decision::Rewrite { new_claim, .. }, Want::Merge) => {
                format!("merged, rewritten to {new_claim:?}")
            }
            (_, _) if merged && case.want == Want::Merge => "merged".into(),
            (_, _) if merged => "MERGED — should have stayed separate".into(),
            (Decision::Conflict { .. }, Want::Separate) => "separate, recorded as a conflict".into(),
            (_, Want::Separate) => "separate".into(),
            (_, Want::Merge) => "stayed separate (missed merge)".into(),
        };

        let ok = if merged { case.want == Want::Merge } else { case.want == Want::Separate };
        eprintln!("{} {}\n   → {verdict}\n", if ok { "✓" } else { "✗" }, case.name);

        if merged && case.want == Want::Separate {
            harmful.push(case.name);
        }
        if !merged && case.want == Want::Merge {
            missed.push(case.name);
        }
    }

    eprintln!(
        "=== {} harmful merges, {} missed merges ===",
        harmful.len(),
        missed.len()
    );
    if !missed.is_empty() {
        eprintln!("missed (tolerated, but worth watching): {missed:?}");
    }

    // The asymmetry, enforced: wrong merges fail the suite, timid ones do not.
    assert!(
        harmful.is_empty(),
        "merged ideas that should have stayed separate: {harmful:?}"
    );
}
