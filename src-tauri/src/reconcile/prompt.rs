//! Asking the model whether two claims are the same thought.

use serde::Deserialize;

use super::{Candidate, Verdict};
use crate::llm::{IdeaExtractor, LlmError};

#[derive(Debug, Clone, Deserialize)]
pub struct Judgement {
    pub idea_id: i64,
    pub verdict: Verdict,
    #[serde(default)]
    pub confidence: f32,
    /// Required when the verdict is `refines`: the rewritten claim.
    #[serde(default)]
    pub merged_claim: Option<String>,
    /// One sentence on what the two have to do with each other. Captured here
    /// because this is the only moment anything knows: reconstructing it later
    /// means a second call with less to go on.
    #[serde(default)]
    pub reason: String,
}

pub fn json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["judgements"],
        "properties": {
            "judgements": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["idea_id", "verdict", "confidence", "reason"],
                    "properties": {
                        "idea_id": { "type": "integer" },
                        "verdict": {
                            "type": "string",
                            "enum": ["distinct", "duplicate", "refines", "contradicts"]
                        },
                        "confidence": { "type": "number" },
                        "merged_claim": { "type": "string" },
                        "reason": { "type": "string" }
                    }
                }
            }
        }
    })
}

pub fn build(new_claim: &str, candidates: &[Candidate]) -> String {
    let list = candidates
        .iter()
        .map(|c| format!("  id {}: {}", c.idea_id, c.claim))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"These are ideas recorded from conversations. A new one has just been
extracted. Decide how it relates to the ideas already recorded.

NEW IDEA:
  {new_claim}

EXISTING IDEAS:
{list}

For each existing idea, return one verdict:

- "distinct": a different thought. Two ideas about the same topic are still
  distinct — sharing a subject is not the same as being the same claim.
- "duplicate": the same claim, said again in different words. Nothing is added.
- "refines": the new idea is a narrower or more precise version of the old one,
  the same underlying thought better stated. Include "merged_claim": the claim
  rewritten to reflect the more developed view, in the words already used. Use
  this for a move towards precision, not a reversal.
- "contradicts": both cannot be true at once.

Also return "confidence" from 0 to 1.

Also return "reason": one sentence, ten to twenty words, on what the two have
to do with each other — the thing someone would want to know when they see a
line drawn between them on a map. Name what is shared or what collides, not the
verdict: "both treat ownership as a debt owed to the owner", not "these are
similar". Do not write "the user" or "the speaker".

Judge conservatively. Marking two different thoughts as the same silently
misrepresents the record, and the mistake may never be spotted. Leaving a
near-duplicate separate is untidy and obvious. When unsure, answer "distinct"
with low confidence.

Return JSON: {{"judgements": [...]}} with one entry per existing idea."#
    )
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    judgements: Vec<Judgement>,
}

pub fn parse(raw: &str) -> Result<Vec<Judgement>, LlmError> {
    let text = raw.trim();
    if let Ok(env) = serde_json::from_str::<Envelope>(text) {
        return Ok(env.judgements);
    }
    // Same leniency as extraction: salvage the object from chatty wrappers.
    if let (Some(s), Some(e)) = (text.find('{'), text.rfind('}')) {
        if e > s {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text[s..=e]) {
                return Ok(env.judgements);
            }
        }
    }
    Err(LlmError::BadOutput(text.chars().take(300).collect()))
}

/// Ask the model. Reuses [`IdeaExtractor`] because it is the same shape of call
/// — a structured, reasoning-free JSON task against the archived text — and
/// because it must stay just as isolated from the user's chat context.
pub async fn adjudicate(
    adjudicator: &dyn IdeaExtractor,
    new_claim: &str,
    candidates: &[Candidate],
) -> Result<Vec<Judgement>, LlmError> {
    let raw = adjudicator.judge(&build(new_claim, candidates), json_schema()).await?;
    parse(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_judgements() {
        let out = parse(
            r#"{"judgements":[{"idea_id":3,"verdict":"refines","confidence":0.9,
                "merged_claim":"He acts badly in some circumstances"}]}"#,
        )
        .unwrap();
        assert_eq!(out[0].idea_id, 3);
        assert_eq!(out[0].verdict, Verdict::Refines);
        assert_eq!(out[0].merged_claim.as_deref(), Some("He acts badly in some circumstances"));
    }

    #[test]
    fn salvages_from_a_chatty_wrapper() {
        let out = parse("Sure!\n```json\n{\"judgements\":[{\"idea_id\":1,\"verdict\":\"distinct\",\"confidence\":0.2}]}\n```")
            .unwrap();
        assert_eq!(out[0].verdict, Verdict::Distinct);
    }

    #[test]
    fn empty_is_valid() {
        assert!(parse(r#"{"judgements":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn the_prompt_lists_every_candidate_with_its_id() {
        let cands = vec![
            Candidate { idea_id: 7, claim: "a".into(), similarity: 0.9 },
            Candidate { idea_id: 9, claim: "b".into(), similarity: 0.8 },
        ];
        let p = build("new", &cands);
        assert!(p.contains("id 7: a"));
        assert!(p.contains("id 9: b"));
        assert!(p.contains("new"));
    }
}
