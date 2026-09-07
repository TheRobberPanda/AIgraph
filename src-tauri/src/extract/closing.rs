//! The parts of a book that are about the book.
//!
//! A collection of ideas is not yet a book. What makes it one is that it opens
//! by saying what it is and closes by saying what it came to — and neither of
//! those can be extracted from any single conversation, because neither was
//! ever said in one. They are the only prose in the whole app written *about*
//! the thinking rather than taken from it, which is why they are asked for in
//! one call, from the ideas alone, and marked as generated on the page.
//!
//! Both are optional. A book with no model loaded still exports, without them;
//! a book that refuses to exist because a conclusion could not be written
//! would be the worse failure.

use crate::llm::{IdeaExtractor, LlmError};

/// What the model is asked to write, and gets back.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Closing {
    #[serde(default)]
    pub opening: String,
    #[serde(default)]
    pub conclusion: String,
}

fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        // `language` first, for the reason given in `extract::prompt`: a model
        // made to name the language before it writes a word keeps to it, and
        // one merely told to keeps to the language of the instructions.
        "required": ["language", "opening", "conclusion"],
        "properties": {
            "language": { "type": "string" },
            "opening": { "type": "string" },
            "conclusion": { "type": "string" }
        }
    })
}

/// `subject → the ideas recorded under it`.
pub fn build(title: &str, chapters: &[(String, Vec<String>)]) -> String {
    let style =
        format!("{}{}", crate::extract::style::RULES, crate::settings::language_instruction());

    let body = chapters
        .iter()
        .map(|(name, ideas)| {
            let list = ideas.iter().map(|i| format!("  - {i}")).collect::<Vec<_>>().join("\n");
            format!("## {name}\n{list}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"Everything one person has worked out, in one folder of their thinking,
collected to be printed as a book called "{title}". Below is every idea in it,
under the subject it was filed under. Each line is a position they hold, in
their own words.

Write the two pieces a book needs that no single conversation could contain.

- "opening": three or four sentences, at the front, saying what this thinking
  is about and what holds it together. Name the actual subjects and the actual
  through-line, from what is below. Not "this book explores a range of topics"
  — say which topics and what connects them. Someone who reads only this
  should know what they are about to read.

- "conclusion": four to six sentences, at the back, saying what it amounts to.
  Where the positions below reinforce one another, say so and say how. Where
  two of them are in tension, name both and leave the tension standing — do
  not resolve it on their behalf. End on what is still open: the question this
  thinking has arrived at rather than answered.

Both are about the thinking, never about the person doing it. Do not write
"the author", "the user", "the speaker", or "this book". State the substance
directly.

Do not invent positions. Everything you write must be traceable to the lines
below; this is the one place in this app that is not a quotation, so it has to
earn it. If the material is too thin to conclude anything, say what little it
supports rather than inflating it.

{style}

First return "language": the language the ideas below are written in, named in
English — "Polish", "Spanish", "English". Write both pieces in that language.

Return JSON: {{"language": "...", "opening": "...", "conclusion": "..."}}

--- THE IDEAS ---
{body}
--- END ---"#
    )
}

/// Ask for them. Uses the extraction model, in its own context.
pub async fn run(
    model: &dyn IdeaExtractor,
    title: &str,
    chapters: &[(String, Vec<String>)],
) -> Result<Closing, LlmError> {
    let raw = model.judge(&build(title, chapters), schema()).await?;
    // Schema-constrained servers return the object; the CLI returns whatever
    // it likes. A book missing its closing is worth more than an error.
    Ok(serde_json::from_str::<Closing>(raw.trim()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapters() -> Vec<(String, Vec<String>)> {
        vec![
            ("Work".into(), vec!["Teaching does not scale".into()]),
            ("Ethics".into(), vec!["Gratitude is a debt nobody agreed to".into()]),
        ]
    }

    #[test]
    fn every_idea_reaches_the_prompt_under_its_subject() {
        let p = build("Root", &chapters());
        assert!(p.contains("## Work"));
        assert!(p.contains("Teaching does not scale"));
        assert!(p.contains("## Ethics"));
        assert!(p.contains("Gratitude is a debt nobody agreed to"));
    }

    /// The one place in the app writing prose that is not a quotation, so the
    /// instruction that it stay traceable has to actually be in the prompt.
    #[test]
    fn the_prompt_forbids_inventing_positions() {
        let p = build("Root", &chapters());
        assert!(p.contains("Do not invent positions"));
        assert!(p.contains("traceable"));
    }

    #[test]
    fn language_is_named_before_anything_else_is_written() {
        let props = schema()["required"].as_array().unwrap().clone();
        assert_eq!(props[0], "language");
    }

    #[test]
    fn a_reply_that_is_not_the_object_leaves_the_book_without_a_closing() {
        assert_eq!(serde_json::from_str::<Closing>("nonsense").unwrap_or_default().opening, "");
    }
}
