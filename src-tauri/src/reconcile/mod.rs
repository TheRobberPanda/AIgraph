//! Deciding whether a freshly extracted idea is new, or changes an existing one.
//!
//! Ideas are mutable. Saying "Trump is a bad man" and later "he's not a bad guy,
//! he acts like one in certain circumstances" should not produce two dots: the
//! bubble is **rewritten** to the more nuanced claim and carries both quotes.
//!
//! # The rule that governs everything here
//!
//! **Over-merging is worse than under-merging.** A wrongly merged bubble quietly
//! misrepresents what someone thinks, and they may never notice. A duplicate dot
//! is merely untidy, and it is visible. Every threshold and tie-break below is
//! set accordingly, and a low-confidence verdict always falls back to `Distinct`.

pub mod prompt;

use serde::{Deserialize, Serialize};

use crate::embed::cosine;
use crate::llm::{IdeaExtractor, LlmError};

/// Ideas closer than this are worth asking the model about. Below it they are
/// not even considered — cheap, and keeps the shortlist honest.
pub const SHORTLIST_FLOOR: f32 = 0.55;

/// Never ask about more than this many candidates for one new idea.
pub const SHORTLIST_SIZE: usize = 10;

/// Below this the model's verdict is not acted on, and the idea stays separate.
/// Set high on purpose: see the rule above.
pub const MERGE_CONFIDENCE: f32 = 0.75;

/// Distinct ideas at least this similar get a faint link in the graph — related,
/// but not asserted to be the same thing. This is what keeps a conservative
/// merge threshold from leaving the graph with no structure at all.
pub const RELATED_FLOOR: f32 = 0.62;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// A genuinely new idea.
    Distinct,
    /// The same idea, said again. Attach the evidence, leave the claim alone.
    Duplicate,
    /// A narrower or more nuanced version. Rewrite the claim, keep history.
    Refines,
    /// They cannot both be true. Recorded now, drawn later.
    Contradicts,
}

/// One existing idea a new one might relate to.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub idea_id: i64,
    pub claim: String,
    pub similarity: f32,
}

/// What to do with a newly extracted idea.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Insert as a new idea. `related` get faint links, not merges.
    ///
    /// The third element is why the two relate, where the adjudicator said so.
    /// A shortlist entry that was never judged has none — it is a similarity
    /// score and nothing more, and inventing a sentence for it would be worse
    /// than saying nothing.
    New { related: Vec<(i64, f32, Option<String>)> },
    /// Attach evidence to an existing idea; claim unchanged.
    Attach { idea_id: i64, confidence: f32 },
    /// Rewrite an existing idea's claim and attach the evidence.
    Rewrite {
        idea_id: i64,
        new_claim: String,
        confidence: f32,
    },
    /// Separate idea, but recorded as contradicting an existing one.
    Conflict { idea_id: i64, confidence: f32, reason: Option<String> },
}

/// Nearest existing ideas above the floor, best first.
pub fn shortlist(new_vec: &[f32], existing: &[(i64, String, Vec<f32>)]) -> Vec<Candidate> {
    let mut scored: Vec<Candidate> = existing
        .iter()
        .map(|(id, claim, vec)| Candidate {
            idea_id: *id,
            claim: claim.clone(),
            similarity: cosine(new_vec, vec),
        })
        .filter(|c| c.similarity >= SHORTLIST_FLOOR)
        .collect();

    scored.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
    scored.truncate(SHORTLIST_SIZE);
    scored
}

/// Decide what happens to one new idea.
///
/// With no candidates above the floor, no model call is made at all — most ideas
/// in a fresh session are genuinely new, and asking about them would double the
/// cost of extraction for nothing.
pub async fn decide(
    adjudicator: &dyn IdeaExtractor,
    new_claim: &str,
    candidates: &[Candidate],
) -> Result<Decision, LlmError> {
    let mut related: Vec<(i64, f32, Option<String>)> = candidates
        .iter()
        .filter(|c| c.similarity >= RELATED_FLOOR)
        .map(|c| (c.idea_id, c.similarity, None))
        .collect();

    if candidates.is_empty() {
        return Ok(Decision::New { related: Vec::new() });
    }

    let judgements = prompt::adjudicate(adjudicator, new_claim, candidates).await?;

    // The adjudicator saw every candidate, including the ones it called
    // distinct — so a faint link can carry its sentence too.
    for r in related.iter_mut() {
        if let Some(j) = judgements.iter().find(|j| j.idea_id == r.0) {
            if !j.reason.trim().is_empty() {
                r.2 = Some(j.reason.trim().to_string());
            }
        }
    }

    // Highest confidence wins, and ties break towards leaving things alone.
    let best = judgements
        .into_iter()
        .filter(|j| candidates.iter().any(|c| c.idea_id == j.idea_id))
        .max_by(|a, b| a.confidence.total_cmp(&b.confidence));

    let Some(j) = best else {
        return Ok(Decision::New { related });
    };

    // Contradictions are recorded whatever the confidence — they draw nothing
    // yet, so a wrong one costs little, while a missed one loses information.
    if j.verdict == Verdict::Contradicts {
        let reason = (!j.reason.trim().is_empty()).then(|| j.reason.trim().to_string());
        return Ok(Decision::Conflict { idea_id: j.idea_id, confidence: j.confidence, reason });
    }

    if j.confidence < MERGE_CONFIDENCE {
        return Ok(Decision::New { related });
    }

    Ok(match j.verdict {
        Verdict::Duplicate => Decision::Attach { idea_id: j.idea_id, confidence: j.confidence },
        Verdict::Refines => match j.merged_claim {
            // A rewrite with no replacement text would blank the bubble.
            Some(claim) if !claim.trim().is_empty() => Decision::Rewrite {
                idea_id: j.idea_id,
                new_claim: claim,
                confidence: j.confidence,
            },
            _ => Decision::Attach { idea_id: j.idea_id, confidence: j.confidence },
        },
        Verdict::Distinct | Verdict::Contradicts => Decision::New { related },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vecs() -> Vec<(i64, String, Vec<f32>)> {
        vec![
            (1, "latency is the problem".into(), vec![1.0, 0.0, 0.0]),
            (2, "cost is the problem".into(), vec![0.0, 1.0, 0.0]),
            (3, "latency dominates".into(), vec![0.9, 0.1, 0.0]),
        ]
    }

    #[test]
    fn shortlist_ranks_by_similarity_and_drops_the_unrelated() {
        let out = shortlist(&[1.0, 0.0, 0.0], &vecs());
        assert_eq!(out[0].idea_id, 1);
        assert_eq!(out[1].idea_id, 3);
        assert!(
            !out.iter().any(|c| c.idea_id == 2),
            "an orthogonal idea should not be a candidate"
        );
    }

    #[test]
    fn shortlist_is_capped() {
        let many: Vec<_> = (0..50)
            .map(|i| (i, format!("claim {i}"), vec![1.0, 0.0, 0.0]))
            .collect();
        assert_eq!(shortlist(&[1.0, 0.0, 0.0], &many).len(), SHORTLIST_SIZE);
    }

    #[test]
    fn nothing_similar_means_nothing_to_shortlist() {
        assert!(shortlist(&[0.0, 0.0, 1.0], &vecs()).is_empty());
    }

    // ---- decisions -------------------------------------------------------

    use async_trait::async_trait;

    struct Scripted(String);

    #[async_trait]
    impl IdeaExtractor for Scripted {
        async fn extract(
            &self,
            _t: &str,
            _c: &[String],
        ) -> Result<crate::extract::prompt::Extracted, LlmError> {
            unimplemented!()
        }
        async fn judge(&self, _p: &str, _s: serde_json::Value) -> Result<String, LlmError> {
            Ok(self.0.clone())
        }
        fn model_id(&self) -> String {
            "test".into()
        }
    }

    fn candidate(id: i64, sim: f32) -> Candidate {
        Candidate { idea_id: id, claim: format!("claim {id}"), similarity: sim }
    }

    #[tokio::test]
    async fn no_candidates_means_no_model_call_at_all() {
        // Scripted would return junk; reaching it at all is the failure.
        let out = decide(&Scripted("not json".into()), "new", &[]).await.unwrap();
        assert_eq!(out, Decision::New { related: vec![] });
    }

    #[tokio::test]
    async fn a_confident_refinement_rewrites_the_claim() {
        let judged = r#"{"judgements":[{"idea_id":1,"verdict":"refines","confidence":0.92,
            "merged_claim":"He acts badly in certain circumstances"}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(1, 0.8)])
            .await
            .unwrap();
        assert_eq!(
            out,
            Decision::Rewrite {
                idea_id: 1,
                new_claim: "He acts badly in certain circumstances".into(),
                confidence: 0.92
            }
        );
    }

    #[tokio::test]
    async fn an_unconfident_merge_is_refused() {
        // The rule: over-merging is worse than under-merging. Below the
        // threshold the idea stays separate, however tempting the verdict.
        let judged = r#"{"judgements":[{"idea_id":1,"verdict":"duplicate","confidence":0.6}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(1, 0.9)])
            .await
            .unwrap();
        assert_eq!(out, Decision::New { related: vec![(1, 0.9, None)] });
    }

    #[tokio::test]
    async fn a_refinement_with_no_replacement_text_attaches_instead_of_blanking() {
        let judged = r#"{"judgements":[{"idea_id":1,"verdict":"refines","confidence":0.95}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(1, 0.9)])
            .await
            .unwrap();
        assert_eq!(out, Decision::Attach { idea_id: 1, confidence: 0.95 });
    }

    #[tokio::test]
    async fn contradictions_are_recorded_even_when_unconfident() {
        // They render nothing yet, so a wrong one is cheap while a missed one
        // loses information the graph will want later.
        let judged = r#"{"judgements":[{"idea_id":2,"verdict":"contradicts","confidence":0.4}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(2, 0.7)])
            .await
            .unwrap();
        assert_eq!(out, Decision::Conflict { idea_id: 2, confidence: 0.4, reason: None });
    }

    #[tokio::test]
    async fn a_verdict_about_an_unknown_idea_is_ignored() {
        // The model can hallucinate an id. Acting on one would attach evidence
        // to an unrelated bubble.
        let judged = r#"{"judgements":[{"idea_id":999,"verdict":"duplicate","confidence":0.99}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(1, 0.9)])
            .await
            .unwrap();
        assert_eq!(out, Decision::New { related: vec![(1, 0.9, None)] });
    }

    #[tokio::test]
    async fn merely_related_ideas_get_links_not_merges() {
        let judged = r#"{"judgements":[{"idea_id":1,"verdict":"distinct","confidence":0.9}]}"#;
        let out = decide(&Scripted(judged.into()), "new", &[candidate(1, 0.7), candidate(2, 0.56)])
            .await
            .unwrap();
        // 0.70 is above RELATED_FLOOR and links; 0.56 is below and does not.
        assert_eq!(out, Decision::New { related: vec![(1, 0.7, None)] });
    }
}
