//! Writing a Make instruction from an example of the result.
//!
//! Describing a voice is harder than showing one. The person pastes text that
//! looks like what they want back, lists what they never want in it, and the
//! model turns both into a full instruction they can read and edit before it
//! becomes a button. Nothing here is sent anywhere but the model that writes
//! the instruction, and nothing is saved until the person saves it.

/// The fixed brief for the model that writes the instruction.
const SYSTEM: &str = "\
You write instructions for another language model. That model will be handed \
a folder of someone's recorded conversations and asked to turn them into a \
piece of writing. Your instruction is what it will be told to do.

Write the instruction only: no preface, no explanation, no quotation marks \
around it, no headings like \"Prompt:\".";

/// Build the request text from the sample and the things to avoid.
pub fn build(sample: &str, avoid: &[String]) -> String {
    let mut out = String::from(
        "Write an instruction that makes the output read like the SAMPLE below.\n\n\
         Study the sample and spell out, concretely, what makes it what it is: \
         sentence length and rhythm, vocabulary and register, person and tense, \
         how paragraphs open and close, how points are made and supported, \
         formatting (or its absence), and overall structure and length. Say \
         these as direct rules the other model can follow. Do not tell it to \
         copy the sample's subject or facts — the subject comes from the \
         conversations it is given.\n\n\
         Include that it must keep the person's own words and positions from the \
         conversations and not invent facts, quotes or opinions.\n",
    );
    let avoid: Vec<&str> = avoid.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect();
    if !avoid.is_empty() {
        out.push_str(
            "\nThe result must NEVER do any of the following. Give them their own \
             section in the instruction, each as a firm rule, stated plainly:\n",
        );
        for a in avoid {
            out.push_str("- Don't ");
            out.push_str(a.strip_prefix("Don't ").or(a.strip_prefix("don't ")).unwrap_or(a));
            out.push('\n');
        }
    }
    out.push_str("\nSAMPLE:\n\"\"\"\n");
    out.push_str(sample.trim());
    out.push_str("\n\"\"\"\n");
    out
}

pub fn system() -> String {
    format!("{SYSTEM}{}", crate::settings::language_instruction())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_thing_to_avoid_reaches_the_request_once() {
        let req = build(
            "Short. Blunt.",
            &["sound robotic".into(), "Don't add lists".into(), "  ".into()],
        );
        assert!(req.contains("- Don't sound robotic\n"));
        assert!(req.contains("- Don't add lists\n"), "a typed \"Don't\" is not doubled");
        assert_eq!(req.matches("- Don't").count(), 2, "blank rows are dropped");
        assert!(req.contains("Short. Blunt."));
    }

    #[test]
    fn no_avoid_section_when_nothing_is_listed() {
        assert!(!build("x", &[]).contains("NEVER"));
    }
}
