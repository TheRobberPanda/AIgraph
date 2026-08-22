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
        "$defs": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["text", "kind"],
                    "properties": {
                        "text": { "type": "string" },
                        "kind": { "type": "string", "enum": ["supports", "questions"] }
                    }
                }
            }
        },
        "properties": {
            "conversation": {
                "type": "object",
                "properties": { "notes": { "$ref": "#/$defs/notes" } }
            },
            "ideas": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["claim", "quote", "category", "reasoning", "notes"],
                    "properties": {
                        "claim": { "type": "string" },
                        "quote": { "type": "string" },
                        "category": { "type": "string" },
                        "reasoning": { "type": "string" },
                        "notes": { "$ref": "#/$defs/notes" }
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
    let style = crate::extract::style::RULES;
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
        r#"A transcript of a conversation. The lines marked USER are the thinking; the
lines marked ASSISTANT are answers given during it.

Take notes the way a student takes notes in a seminar. The thinking belongs to
the USER lines. The job is to record it faithfully, not to improve it, grade it,
or add to it.

Record the ideas in the USER lines. Ignore the ASSISTANT lines entirely.

For each idea return:

- "claim": one sentence, in the words as spoken.

  **Where a sentence already stands on its own, use it exactly as spoken.** That
  is the best possible claim. Rewrite only when the original cannot be understood
  out of context, and then change as little as possible.

  Never correct anything. Keep the word choices, the grammar, the emphasis and
  the bluntness, including whatever reads as a mistake: "systematic" stays
  "systematic". Do not tidy, do not soften, do not make it sound more considered
  than it was, and do not add what was not said. This records thinking as it
  happened rather than improving on it.
- "quote": text copied EXACTLY, character for character, from a line marked
  USER. Do not paraphrase, trim, fix typos, or join separated fragments. If no
  exact span supports the claim, omit the idea entirely.
- "category": two or three words for the subject. Lowercase. Prefer a category
  already in use over coining a near-synonym.
- "reasoning": at most one sentence on what in those words carries this idea.
  Brief — it sits beside the sentence it describes.
- "notes": questions or observations, ONLY where there is a real one. See below.

## Notes are optional, and usually absent

A note is a marginal question, raised because something is genuinely unclear or
genuinely load-bearing. It is not a critique quota.

- **Most ideas should have no notes at all.** An idea that is clear and
  self-contained is finished; recording that is the correct outcome.
- Never produce a note to fill a slot. There is no expected number. Zero, one, or
  two is normal; more than three means the transcript was unusually rich.
- A note must be specific to this idea and say something that could not be said
  about any other idea. "This could be more specific" is not a note.
- Mark each note "supports" where it strengthens the idea, or "questions" where
  something is unclear, assumed, or in tension with something else said.
- Keep every note to one short sentence.

## Other rules

- Record the ideas that carry weight. A ten-minute stretch of thinking usually
  holds three to seven, not thirty. Skip pleasantries and logistics.
- Merge restatements of one idea into a single entry.
- Where a view was revised mid-conversation, record the idea as it was LEFT, and
  quote the revision rather than the first version.

{style}

Also return "conversation": notes on the whole stretch of thinking, under the
same rules — usually none, and never more than two.

Return JSON: {{"ideas": [...], "conversation": {{"notes": [...]}}}}. Return
{{"ideas": []}} if nothing substantive was said.
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
        for field in ["claim", "quote", "category", "reasoning", "notes"] {
            assert!(
                required.iter().any(|r| r == field),
                "{field} must be required under a strict schema"
            );
        }
        // The top level gains `conversation`, which the base schema leaves optional.
        let top = out["required"].as_array().unwrap();
        assert!(top.iter().any(|r| r == "conversation"));
        assert!(top.iter().any(|r| r == "ideas"));
        // No cap and no floor on notes — the model must be free to return none.
        assert!(out["$defs"]["notes"].get("maxItems").is_none());
        assert!(out["$defs"]["notes"].get("minItems").is_none());
    }

    #[test]
    fn parses_clean_json() {
        let out = parse(
            r#"{"ideas":[{"claim":"c","quote":"q","reasoning":"why","notes":[]}],
                "conversation":{"notes":[{"text":"s","kind":"supports"}]}}"#,
        )
        .unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert_eq!(out.ideas[0].claim, "c");
        assert_eq!(out.ideas[0].reasoning, "why");
        assert_eq!(out.conversation.notes.len(), 1);
    }

    #[test]
    fn salvages_json_from_chatty_wrapper() {
        let raw = "Sure! Here are the ideas:\n```json\n{\"ideas\":[{\"claim\":\"c\",\"quote\":\"q\"}]}\n```\nHope that helps!";
        let out = parse(raw).unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert!(out.ideas[0].notes.is_empty(), "an idea with nothing to add is finished");
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
