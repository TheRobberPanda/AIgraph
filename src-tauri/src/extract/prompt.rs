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
        "required": ["language", "ideas", "title"],
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
            // First, and written before anything else is.
            //
            // Telling the model to answer in the language of the transcript
            // does not work — these instructions are in English and it follows
            // them into English, however plainly and however late it is said.
            // Making it name the language before it writes a word does work:
            // it has to decide, and having decided it keeps to it.
            "language": { "type": "string" },
            "title": { "type": "string" },
            "conversation": {
                "type": "object",
                "properties": { "notes": { "$ref": "#/$defs/notes" } }
            },
            "ideas": {
                "type": "array",
                // What actually stops a long reply. Grammar-constrained
                // sampling honours this, so the model closes the array instead
                // of writing until a token limit cuts it off — which is how a
                // ten-minute read becomes a twenty-minute one. Stripped again
                // for Anthropic, whose strict schemas reject it.
                "maxItems": 14,
                "items": {
                    "type": "object",
                    "required": ["title", "claim", "quote", "category", "reasoning", "notes"],
                    "properties": {
                        "title": { "type": "string" },
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

Record the ideas in the USER lines. Ignore the ASSISTANT lines entirely: they
are shown only so the USER lines make sense, they are abridged for that reason,
and nothing in them can be quoted. An answer given to someone is not a thought
they had.

For each idea return:

- "title": two to six words, in the language named in "language" above, naming
  what the idea actually is, written from what
  it means, not sliced out of its own sentence. "Giving as a hedge against
  envy", not the first few words of the claim. This is what identifies the
  idea at a glance in a list of many, so it must say something the claim's
  first words don't already say.
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
  USER. Find it above and copy it across rather than writing it from memory.
  Do not paraphrase, trim, fix typos, or join separated fragments. If no exact
  span supports the claim, omit the idea entirely.
- "category": two or three words for the subject, in the language named in
  "language" above. Lowercase. Prefer a category
  already in use over coining a near-synonym.
- "reasoning": two or three sentences, in the language named in "language"
  above, that make the idea stand on its own.

  A quote is rarely enough on its own to know what was meant. "It basically
  socializes the losses of the American empire" is a sentence someone can read
  back a month later without recovering the thought behind it. So: say what is
  being claimed, what it is a claim *about*, and what makes it worth recording
  — the thing that would otherwise have to be reconstructed by rereading the
  whole conversation.

  Draw on the surrounding transcript, not only on the quoted words. The point
  is to crystallise the thought, not to paraphrase the sentence.

  Do not write "the user" or "the speaker" anywhere, in this field or any other.
  State what the words do, not who did it: not "The user characterizes this as a
  dilemma" but "Frames it as a choice between two bad outcomes." Drop the subject
  entirely rather than name one.
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
  a specific part of the argument does not hold.
- **A "questions" note names the flawed step, not the general topic.** Point at
  the exact claim, assumption, or link in the reasoning that breaks, and say
  what breaks it — "assumes the reader already agrees this is unfair" is a
  note; "this needs more thought" is not.
- One plain sentence, ten to twenty words. No hedging ("might", "could
  perhaps"), no academic throat-clearing ("one could argue that"). Say the
  problem directly.
- Same rule as above: no "the user", no "the speaker", in a note's text either.

## Other rules

- Record the ideas that carry weight. A ten-minute stretch of thinking usually
  holds three to seven, not thirty. Skip pleasantries and logistics.
- Merge restatements of one idea into a single entry.
- Where a view was revised mid-conversation, record the idea as it was LEFT, and
  quote the revision rather than the first version.

{style}

First return "language": the language the USER lines are written in, named in
English — "Polish", "Spanish", "English". Everything else you write is in that
language: the titles, the claims, the categories, the reasoning, the notes.
Quotes are copied, never translated.

Also return "title": a short name for this conversation, two to five words,
title case, no punctuation — the way a chat app names a thread from what was
said in it. Name the subject, not the format: "American Economic Empire", not
"Discussion About the Economy" or "Conversation Summary". This is what
identifies the conversation at a glance, so it must be specific to what was
actually said, never generic.

Also return "conversation": notes on the whole stretch of thinking, under the
same rules — usually none, and never more than two.

Return JSON: {{"language": "...", "title": "...", "ideas": [...],
"conversation": {{"notes": [...]}}}}.
Return {{"language": "...", "title": "...", "ideas": []}} if nothing substantive
was said.
{known_block}
--- TRANSCRIPT ---
{transcript}
--- END TRANSCRIPT ---"#
    )
}

#[derive(serde::Deserialize)]
struct Envelope {
    #[serde(default)]
    title: String,
    #[serde(default)]
    ideas: Vec<RawIdea>,
    #[serde(default)]
    conversation: ConversationNotes,
}

/// Everything one extraction call returns.
#[derive(Debug, Clone, Default)]
pub struct Extracted {
    pub title: String,
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
        return Ok(Extracted { title: env.title, ideas: env.ideas, conversation: env.conversation });
    }

    let start = text.find('{');
    let end = text.rfind('}');
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text[s..=e]) {
                return Ok(Extracted { title: env.title, ideas: env.ideas, conversation: env.conversation });
            }
        }
    }

    // Cut off mid-object, usually by a token limit. Everything before the cut
    // is real work the model already did, and throwing away eight good ideas
    // because a ninth was truncated loses a whole session over the last
    // sentence of it.
    if let Some(repaired) = repair(text) {
        if let Ok(env) = serde_json::from_str::<Envelope>(&repaired) {
            tracing::warn!("extraction output was truncated; salvaged what completed");
            return Ok(Extracted { title: env.title, ideas: env.ideas, conversation: env.conversation });
        }
    }

    Err(LlmError::BadOutput(truncate(text, 300)))
}

/// Close a JSON object that was cut off part-way through.
///
/// Walks the text tracking strings, escapes and bracket depth, remembers the
/// last point at which everything open could be closed cleanly — the end of a
/// complete element — then truncates there and appends the closers. A partial
/// element at the tail is dropped rather than guessed at: half an idea is not
/// an idea, and inventing the rest of one would put words in someone's mouth.
fn repair(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let body = &text[start..];

    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    // Byte index just past the last complete element, with the stack as it was
    // there. Only a closing bracket counts. A comma looks like a boundary too,
    // but a comma *inside* an object leaves half an element behind — and since
    // every field has a default, half an element deserializes happily into an
    // idea nobody had.
    let mut safe: Option<(usize, Vec<char>)> = None;

    for (i, c) in body.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_string {
            match c {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' | '[' => stack.push(c),
            '}' | ']' => {
                stack.pop()?;
                safe = Some((i + c.len_utf8(), stack.clone()));
            }
            _ => {}
        }
    }

    // Nothing was cut off, or nothing usable survived.
    if stack.is_empty() {
        return None;
    }
    let (cut, open) = safe?;
    let mut out = body[..cut].to_string();
    for c in open.iter().rev() {
        out.push(if *c == '{' { '}' } else { ']' });
    }
    Some(out)
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
        for field in ["title", "claim", "quote", "category", "reasoning", "notes"] {
            assert!(
                required.iter().any(|r| r == field),
                "{field} must be required under a strict schema"
            );
        }
        // The top level gains `conversation`, which the base schema leaves optional.
        let top = out["required"].as_array().unwrap();
        assert!(top.iter().any(|r| r == "conversation"));
        assert!(top.iter().any(|r| r == "ideas"));
        assert!(top.iter().any(|r| r == "title"));
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

    /// A reply cut off by a token limit keeps the ideas that finished.
    #[test]
    fn truncated_output_keeps_what_completed() {
        let raw = r#"{"title":"Teaching and Income","ideas":[
            {"title":"Education as time","claim":"a","quote":"q","category":"work","reasoning":"r","notes":[]},
            {"title":"Local ceilings","claim":"b","quote":"w","category":"work","reasoning":"r","notes":[]},
            {"title":"Half an idea","claim":"c","quote":"e","categ"#;
        let out = parse(raw).unwrap();
        assert_eq!(out.title, "Teaching and Income");
        assert_eq!(out.ideas.len(), 2, "the two complete ideas survive");
        // The third is dropped rather than guessed at: half an idea is not an
        // idea, and completing one would put words in someone's mouth.
        assert!(out.ideas.iter().all(|i| i.claim != "c"));
    }

    /// Non-ASCII must not be cut mid-character while repairing.
    #[test]
    fn truncation_repair_is_safe_on_accented_text() {
        let raw = r#"{"ideas":[{"claim":"Edukacja to usługa oparta na moim czasie","quote":"q","notes":[]},
            {"claim":"myślenie o tym, że lokalny biznes zapewni duży przychód"#;
        let out = parse(raw).unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert!(out.ideas[0].claim.contains("usługa"));
    }

    #[test]
    fn unparseable_output_errors_with_a_sample() {
        assert!(matches!(parse("I'm sorry, I can't."), Err(LlmError::BadOutput(_))));
    }
}
