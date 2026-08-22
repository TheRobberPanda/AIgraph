//! Arguing an idea out properly.
//!
//! The nudges shown everywhere else are one-liners, which is right for a hover
//! and thin for a page you opened deliberately. This expands them — generated on
//! first open and cached, because doing it for every idea at extraction time
//! would multiply the cost of every session for material most ideas are never
//! asked about.

use crate::llm::{IdeaExtractor, LlmError};

pub fn build(claim: &str, strong: &[String], weak: &[String], quotes: &[String]) -> String {
    let list = |items: &[String]| {
        if items.is_empty() {
            "  (none noted)".to_string()
        } else {
            items
                .iter()
                .map(|s| format!("  - {s}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    format!(
        r#"Someone is thinking through an idea of their own. Argue it out with
them properly.

THE IDEA:
  {claim}

THEIR OWN WORDS:
{}

WHAT SEEMS TO HOLD:
{}

WHERE IT SEEMS THIN:
{}

Write a short piece — three or four short paragraphs — that takes this idea
seriously and develops it. Say what follows from it if it is right, name the
strongest objection someone who disagreed would actually make, and be specific
about what would have to be true for the idea to survive that objection.

Write to the person, in plain prose. No headings, no bullet lists, no preamble
about what you are about to do. Do not flatter the idea and do not perform
even-handedness — if the objection is fatal, say so; if it is weak, say that
too. This is their thinking, so do not tell them what to conclude.

Return only the prose."#,
        list(quotes),
        list(strong),
        list(weak),
    )
}

/// Ask for the expansion. Uses the extraction model, in its own context.
pub async fn run(
    model: &dyn IdeaExtractor,
    claim: &str,
    strong: &[String],
    weak: &[String],
    quotes: &[String],
) -> Result<String, LlmError> {
    let schema = serde_json::json!({
        "type": "object",
        "required": ["text"],
        "properties": { "text": { "type": "string" } }
    });
    let raw = model.judge(&build(claim, strong, weak, quotes), schema).await?;

    // Schema-constrained providers return {"text": ...}; the CLI returns prose.
    // Accept either rather than failing on the shape.
    match serde_json::from_str::<serde_json::Value>(raw.trim()) {
        Ok(v) => Ok(v
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .unwrap_or(raw)),
        Err(_) => Ok(raw),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_carries_their_words_and_both_sides() {
        let p = build(
            "Latency is the problem",
            &["measurable".into()],
            &["ignores cost".into()],
            &["latency is the real problem".into()],
        );
        assert!(p.contains("Latency is the problem"));
        assert!(p.contains("latency is the real problem"));
        assert!(p.contains("measurable"));
        assert!(p.contains("ignores cost"));
    }

    #[test]
    fn missing_nudges_do_not_leave_an_empty_section() {
        let p = build("A claim", &[], &[], &[]);
        assert!(p.contains("(none noted)"));
    }
}
