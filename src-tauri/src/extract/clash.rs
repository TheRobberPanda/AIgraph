//! Saying why two ideas cannot both stand, when nobody wrote it down.
//!
//! Reconciliation keeps a reason with every contradiction it judges now, but
//! links drawn before it did have none — and a settling view that shows two
//! claims side by side without saying what is wrong between them leaves the
//! person to find the conflict themselves. This names it, and nothing else:
//! it does not say which side is right, and it does not offer a way out.
//! That is the person's to write.

use crate::llm::{IdeaExtractor, LlmError};

pub fn build(a: &str, b: &str) -> String {
    let style =
        format!("{}{}", crate::extract::style::RULES, crate::settings::language_instruction());
    format!(
        r#"Two ideas someone recorded were judged unable to both be true. Say why.

FIRST IDEA:
  {a}

SECOND IDEA:
  {b}

Return JSON: {{"reasoning": "..."}}

- `reasoning` is one or two sentences naming exactly where they collide: the
  claim, word or assumption that one asserts and the other denies.
- Do not say which one is right, and do not suggest how both could hold.
  The person decides that.
- If they do not actually conflict, say so plainly, in one sentence.

{style}

Return only the JSON object."#
    )
}

/// Ask for the reason. Uses the extraction model, in its own context.
pub async fn run(model: &dyn IdeaExtractor, a: &str, b: &str) -> Result<String, LlmError> {
    let schema = serde_json::json!({
        "type": "object",
        "required": ["reasoning"],
        "properties": { "reasoning": { "type": "string" } }
    });
    let raw = model.judge(&build(a, b), schema).await?;
    Ok(parse(&raw))
}

/// The reason out of whatever came back: the object, the object inside prose,
/// or a bare sentence — every provider returns one of the three.
fn parse(raw: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Out {
        #[serde(default)]
        reasoning: String,
    }
    let text = raw.trim();
    if let Ok(o) = serde_json::from_str::<Out>(text) {
        return o.reasoning.trim().to_string();
    }
    if let (Some(open), Some(close)) = (text.find('{'), text.rfind('}')) {
        if open < close {
            if let Ok(o) = serde_json::from_str::<Out>(&text[open..=close]) {
                return o.reasoning.trim().to_string();
            }
        }
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reason_comes_out_of_any_of_the_three_shapes() {
        assert_eq!(parse(r#"{"reasoning":" one says always "}"#), "one says always");
        assert_eq!(parse("Here:\n{\"reasoning\":\"never\"}\nDone."), "never");
        assert_eq!(parse("They disagree about timing."), "They disagree about timing.");
    }

    #[test]
    fn the_prompt_carries_both_sides() {
        let p = build("Work late", "Never work late");
        assert!(p.contains("Work late") && p.contains("Never work late"));
    }
}
