//! Reading a reply to one of the AI's notes back as a claim.
//!
//! The notes are the model's doubts about an idea. Answering one is the person
//! saying "no, here is why" — and until it is read back, that answer is a
//! paragraph in a box that nothing else in the app can see.
//!
//! What comes out is deliberately small: one claim and a short name for it.
//! Not an argument, not a verdict on who was right — the answer already says
//! what it says, and this only has to be a sentence the map can draw and the
//! reader can recognise as theirs.

use crate::llm::{IdeaExtractor, LlmError};

/// A reply read back as one claim, and a name for it.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Digested {
    pub claim: String,
    #[serde(default)]
    pub title: String,
}

pub fn build(idea: &str, challenge: &str, answer: &str) -> String {
    let style =
        format!("{}{}", crate::extract::style::RULES, crate::settings::language_instruction());
    format!(
        r#"Someone recorded an idea. A model raised a doubt about it. They have
answered the doubt. Read their answer back.

THE IDEA:
  {idea}

THE DOUBT RAISED:
  {challenge}

THEIR ANSWER, IN THEIR OWN WORDS:
  {answer}

Return JSON: {{"claim": "...", "title": "..."}}

- `claim` is one sentence saying what THEY said, in their voice, as a claim
  that could stand on its own. Not "the user argues that…" — the thing they
  argued.
- `title` is at most six words naming it, the way a heading names a section.

Hard rules:

- Only what is in their answer. If they gave a reason, the claim is that
  reason. If they gave none, the claim is the position without one — do not
  supply the missing reason, and do not improve the argument.
- Do not judge whether the doubt was answered. Nobody asked.
- Do not repeat the idea or the doubt back. Both are above.
- If the answer says nothing that can stand as a claim, return an empty
  `claim`. An empty answer is a better outcome than an invented one.

{style}

Return only the JSON object."#
    )
}

/// Ask for the reading. Uses the extraction model, in its own context.
pub async fn run(
    model: &dyn IdeaExtractor,
    idea: &str,
    challenge: &str,
    answer: &str,
) -> Result<Digested, LlmError> {
    let schema = serde_json::json!({
        "type": "object",
        "required": ["claim"],
        "properties": {
            "claim": { "type": "string" },
            "title": { "type": "string" }
        }
    });
    let raw = model.judge(&build(idea, challenge, answer), schema).await?;
    Ok(parse(&raw))
}

/// Pull the claim out of whatever came back.
///
/// Schema-constrained providers return the object; the CLI returns prose with
/// the object somewhere in it, or sometimes just the sentence. All three are
/// usable, and refusing two of them would make this feature work on one
/// backend out of three.
fn parse(raw: &str) -> Digested {
    let text = raw.trim();
    if let Ok(d) = serde_json::from_str::<Digested>(text) {
        return tidy(d);
    }
    if let (Some(open), Some(close)) = (text.find('{'), text.rfind('}')) {
        if open < close {
            if let Ok(d) = serde_json::from_str::<Digested>(&text[open..=close]) {
                return tidy(d);
            }
        }
    }
    // A bare sentence is still an answer read back; it is only missing a name,
    // and a name can be made from the sentence.
    tidy(Digested { claim: text.to_string(), title: String::new() })
}

/// A title if one came back, and one cut from the claim if not.
fn tidy(d: Digested) -> Digested {
    let claim = d.claim.trim().to_string();
    let title = d.title.trim().to_string();
    if claim.is_empty() {
        return Digested::default();
    }
    let title = if title.is_empty() { short(&claim) } else { title };
    Digested { claim, title }
}

/// Six words of a claim, which is what a moon has room for.
fn short(claim: &str) -> String {
    let words: Vec<&str> = claim.split_whitespace().take(6).collect();
    let joined = words.join(" ");
    let trimmed = joined.trim_end_matches(['.', ',', ';', ':']);
    if claim.split_whitespace().count() > 6 {
        format!("{trimmed}…")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_carries_all_three_parts() {
        let p =
            build("Latency is the problem", "No measurement is offered", "We measured it in March");
        assert!(p.contains("Latency is the problem"));
        assert!(p.contains("No measurement is offered"));
        assert!(p.contains("We measured it in March"));
    }

    #[test]
    fn a_clean_object_is_taken_as_it_is() {
        let d = parse(r#"{"claim": "We measured it in March.", "title": "Measured in March"}"#);
        assert_eq!(d.claim, "We measured it in March.");
        assert_eq!(d.title, "Measured in March");
    }

    #[test]
    fn an_object_buried_in_prose_is_still_found() {
        let d = parse("Sure! Here you go:\n{\"claim\": \"It was measured.\"}\nHope that helps.");
        assert_eq!(d.claim, "It was measured.");
    }

    #[test]
    fn a_bare_sentence_gets_a_name_cut_from_itself() {
        let d = parse("The deployment pipeline was measured twice last quarter.");
        assert_eq!(d.claim, "The deployment pipeline was measured twice last quarter.");
        assert_eq!(d.title, "The deployment pipeline was measured twice…");
    }

    #[test]
    fn a_short_claim_keeps_its_whole_self_as_the_name() {
        let d = parse(r#"{"claim": "We measured it."}"#);
        assert_eq!(d.title, "We measured it");
    }

    #[test]
    fn an_empty_claim_stays_empty_rather_than_becoming_a_moon() {
        let d = parse(r#"{"claim": "   ", "title": "Something"}"#);
        assert!(d.claim.is_empty());
        assert!(d.title.is_empty());
    }
}
