//! The extraction prompt and its output contract.
//!
//! Kept in one place because prompt quality *is* the product quality here, and
//! two things in the plan depend on being able to change this file and re-measure:
//! the drop rate, and whether nudges are insightful or generic filler.

use crate::llm::types::{ConversationNotes, RawIdea};
use crate::llm::LlmError;

/// Structured-output schema. Providers that support it get the shape enforced;
/// the parser below still assumes nothing.
pub fn json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["ideas"],
        "properties": {
            "conversation": {
                "type": "object",
                "properties": {
                    "strong_points": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
                    "weak_points": { "type": "array", "items": { "type": "string" }, "maxItems": 3 }
                }
            },
            "ideas": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["claim", "quote", "category", "reasoning", "strong_points", "weak_points"],
                    "properties": {
                        "claim": { "type": "string" },
                        "quote": { "type": "string" },
                        "category": { "type": "string" },
                        "reasoning": { "type": "string" },
                        "strong_points": {
                            "type": "array", "items": { "type": "string" }, "maxItems": 3
                        },
                        "weak_points": {
                            "type": "array", "items": { "type": "string" }, "maxItems": 3
                        }
                    }
                }
            }
        }
    })
}

/// Tighten a schema for Anthropic's structured outputs.
///
/// It requires every object to declare `additionalProperties: false` and to list
/// all of its properties as required. Derived from the base schema rather than
/// written twice, so the two cannot drift.
pub fn strict(schema: &serde_json::Value) -> serde_json::Value {
    let mut out = schema.clone();
    tighten(&mut out);
    out
}

fn tighten(node: &mut serde_json::Value) {
    if let Some(obj) = node.as_object_mut() {
        if obj.get("type").and_then(|t| t.as_str()) == Some("object") {
            obj.insert("additionalProperties".into(), serde_json::json!(false));
            if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
                let names: Vec<String> = props.keys().cloned().collect();
                obj.insert("required".into(), serde_json::json!(names));
            }
        }
        // `maxItems` is advisory here and unsupported in strict schemas.
        obj.remove("maxItems");
        for (_, v) in obj.iter_mut() {
            tighten(v);
        }
    } else if let Some(arr) = node.as_array_mut() {
        for v in arr.iter_mut() {
            tighten(v);
        }
    }
}

pub fn build(transcript: &str) -> String {
    build_with_categories(transcript, &[])
}

/// As [`build`], offering the categories already in use.
///
/// Passing them matters: left to itself the model invents a fresh label for the
/// same subject every session — "ethics", "moral philosophy", "morality" — and
/// the map ends up with a colour per conversation instead of per subject.
pub fn build_with_categories(transcript: &str, known: &[String]) -> String {
    let known_block = if known.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nCategories already in use. Reuse one wherever it fits, exactly \
             as written, rather than coining a near-synonym:\n{}\n",
            known
                .iter()
                .map(|c| format!("  {c}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        r#"Below is a transcript of someone thinking out loud with an assistant.

Extract the ideas THE USER expressed. Ignore the assistant's contributions
entirely — this is a map of the user's thinking, not the assistant's.

For each idea return:

- "claim": one self-contained sentence stating the idea in the user's own terms.
  It must stand alone, out of context, months later. Do not soften or improve it;
  if the user was blunt, be blunt.
- "quote": text copied EXACTLY, character for character, from a line marked USER.
  Do not paraphrase, trim, fix typos, or join separated fragments. If you cannot
  copy an exact span that supports the claim, omit the idea entirely.
- "category": two or three words for what this idea is *about* — its subject,
  not a judgement of it. Lowercase. Prefer a category you have already been given
  over inventing a new one.
- "reasoning": one or two sentences on why those particular words carry this
  idea — what you read them as claiming, and what you had to assume to get from
  the quote to the claim. This is shown to the user next to their own sentence,
  so it must explain the leap, not restate the claim.
- "strong_points": up to 3 specific reasons this idea holds up.
- "weak_points": up to 3 specific problems, gaps, or unexamined assumptions.

Rules:

- Extract the ideas that carry weight. A ten-minute ramble usually holds three to
  seven, not thirty. Skip pleasantries, logistics, and thinking-out-loud filler.
- Merge restatements of one idea into a single entry.
- If the user revised a view mid-conversation, state the idea as they LEFT it,
  and quote the revision rather than the first version.
- Nudges must bite on this specific idea. "This could be more specific" is
  useless — name the actual gap, the actual counter-case, the actual assumption.
  If you cannot say something specific, return fewer nudges. Zero is fine.

Also return "conversation": up to 3 "strong_points" and 3 "weak_points" about
this line of thinking as a whole — not about individual claims, but about where
the thinking is solid and where it is thin or avoids something. The gaps between
someone's claims are often more revealing than the claims.

Return JSON: {{"ideas": [...], "conversation": {{...}}}}. Return {{"ideas": []}}
if nothing substantive was said.

{known_block}
--- TRANSCRIPT ---
{transcript}
--- END TRANSCRIPT ---"#
    )
}

#[derive(serde::Deserialize)]
struct Envelope {
    #[serde(default)]
    ideas: Vec<RawIdea>,
    #[serde(default)]
    conversation: ConversationNotes,
}

/// Everything one extraction call returns.
#[derive(Debug, Clone, Default)]
pub struct Extracted {
    pub ideas: Vec<RawIdea>,
    pub conversation: ConversationNotes,
}

/// Parse the model's reply.
///
/// Small local models wrap JSON in prose or fences even when told not to, so we
/// salvage the outermost object rather than failing the whole session over a
/// stray "Here you go:". This is leniency about *packaging* only — the contents
/// still face the verifier, which is where the actual trust boundary sits.
pub fn parse(raw: &str) -> Result<Extracted, LlmError> {
    let text = raw.trim();

    if let Ok(env) = serde_json::from_str::<Envelope>(text) {
        return Ok(Extracted { ideas: env.ideas, conversation: env.conversation });
    }

    let start = text.find('{');
    let end = text.rfind('}');
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text[s..=e]) {
                return Ok(Extracted { ideas: env.ideas, conversation: env.conversation });
            }
        }
    }

    Err(LlmError::BadOutput(truncate(text, 300)))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_requires_every_property_and_forbids_extras() {
        let out = strict(&json_schema());
        let ideas = &out["properties"]["ideas"]["items"];
        assert_eq!(ideas["additionalProperties"], serde_json::json!(false));
        let required = ideas["required"].as_array().unwrap();
        for field in ["claim", "quote", "category", "reasoning", "strong_points", "weak_points"] {
            assert!(
                required.iter().any(|r| r == field),
                "{field} must be required under a strict schema"
            );
        }
        // The top level gains `conversation`, which the base schema leaves optional.
        let top = out["required"].as_array().unwrap();
        assert!(top.iter().any(|r| r == "conversation"));
        assert!(top.iter().any(|r| r == "ideas"));
        assert!(ideas["properties"]["strong_points"].get("maxItems").is_none());
    }

    #[test]
    fn parses_clean_json() {
        let out = parse(
            r#"{"ideas":[{"claim":"c","quote":"q","reasoning":"why","strong_points":[],"weak_points":[]}],
                "conversation":{"strong_points":["s"],"weak_points":["w"]}}"#,
        )
        .unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert_eq!(out.ideas[0].claim, "c");
        assert_eq!(out.ideas[0].reasoning, "why");
        assert_eq!(out.conversation.strong_points, vec!["s"]);
    }

    #[test]
    fn salvages_json_from_chatty_wrapper() {
        let raw = "Sure! Here are the ideas:\n```json\n{\"ideas\":[{\"claim\":\"c\",\"quote\":\"q\"}]}\n```\nHope that helps!";
        let out = parse(raw).unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert!(out.ideas[0].strong_points.is_empty());
    }

    #[test]
    fn empty_result_is_valid_not_an_error() {
        assert!(parse(r#"{"ideas":[]}"#).unwrap().ideas.is_empty());
    }

    #[test]
    fn unparseable_output_errors_with_a_sample() {
        assert!(matches!(parse("I'm sorry, I can't."), Err(LlmError::BadOutput(_))));
    }
}
