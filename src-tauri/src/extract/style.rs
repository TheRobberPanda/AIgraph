//! House style for everything the model writes into the record.
//!
//! Kept in one place and appended to every generating prompt, so the notes, the
//! condensed answers and the margin readings all sound like one hand. Written as
//! prohibitions because that is what models respond to: a positive instruction
//! like "write naturally" produces the same output it would have produced
//! anyway.
//!
//! The patterns listed are the ones that make short notes read as machine
//! output. Most are cheap to avoid and cost nothing in meaning.

pub const RULES: &str = r#"## How to write it

Write like a person taking notes for themselves, not like a model producing a
deliverable. Avoid every pattern below.

Openers and filler:
- No throat-clearing. Not "Here's the thing", not "It's worth noting", not
  "Importantly". Start with the substance.
- No meta-commentary about what is being written or what comes next.
- No closing summary and no restatement of what was just said.

Sentence shapes:
- No "not X, but Y" contrasts. State Y.
- No sentence fragments stacked for emphasis.
- No rhetorical question followed by its own answer.
- No lists of three. Two items, or one.
- No em dashes. Use a comma, a full stop, or brackets.

Words to avoid outright: delve, nuanced, landscape, tapestry, leverage, robust,
underscore, testament, realm, navigate (unless literal), crucial, pivotal,
holistic, multifaceted, "serves as", "plays a role in", "sheds light on",
"highlights the importance of".
- No magic adverbs doing the work of an argument: quietly, simply, merely,
  arguably, effectively.
- No participle tacked on to sound analytical: "..., highlighting the tension",
  "..., reflecting a deeper issue".

Substance:
- Be specific. Name the thing rather than describing its category.
- No inflated stakes. Nothing is profound, fundamental, or transformative.
- No vague declaratives. "The implications are significant" says nothing.
- Active voice with a real subject wherever there is one.
- Vary sentence length. Three sentences of the same shape in a row reads as
  generated.

Language:
- Write in the language of the text you are given, not in English. Every field
  you write — without exception, whatever it is called — is in that language.
  Polish in, Polish out. The same for any other language.
- This is not a list of fields to check against. If you are writing it, it is
  in the language of the source.
- Never translate a quote. The quote is located by searching the transcript
  for it character for character, so a translated quote is not found and the
  idea is thrown away.
- Where a text mixes languages, follow the language of the USER lines if there
  are any, and otherwise the language most of it is written in.

Who is speaking:
- Never write "the user" or "the speaker", in any field, anywhere. State what
  the words do, not who did it: not "The user argues that X" but "Argues X."
  Drop the subject entirely rather than name one.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// Every prompt that writes prose into the record must carry the style
    /// rules. Adding a new one and forgetting them is the likely mistake, and it
    /// would show up as one feature quietly sounding different from the rest.
    #[test]
    fn every_generating_prompt_carries_the_rules() {
        let prompts = [
            ("extraction", crate::extract::prompt::build_with_categories("USER: hi", &[])),
            ("margin reading", crate::extract::deepen::build("c", &[], &[], &[])),
            ("reply condensing", crate::extract::replies::build(&[(1, "a".into())])),
        ];
        for (name, body) in prompts {
            assert!(body.contains("## How to write it"), "{name} is missing the style rules");
            assert!(body.contains("No em dashes"), "{name} lost part of the rules");
            assert!(
                body.contains("Never write \"the user\""),
                "{name} lost the rule against naming who is speaking"
            );
            // Without this the model answers in English whatever was spoken,
            // and a translated quote fails verification outright.
            assert!(
                body.contains("Write in the language of the text you are given"),
                "{name} lost the rule about matching the source language"
            );
        }
    }

    #[test]
    /// The language rule has to bind whatever the field is called.
    ///
    /// It used to list them — claim, title, category, reasoning, note — and a
    /// digest, which is none of those, came back in English from a Polish
    /// conversation. A list of fields is a list of exceptions waiting to be
    /// found.
    /// Telling a model to answer in the source language does not work on its
    /// own — the instructions are in English and it follows them there. What
    /// works is making it name the language before it writes anything else,
    /// which is why the schemas put that field first and why the field
    /// descriptions point back at it. This guards the half that lives here.
    #[test]
    fn the_language_rule_is_not_a_list_of_fields() {
        for field in ["claim", "title", "category", "reasoning", "digest"] {
            assert!(
                !RULES.contains(&format!("{field}, ")),
                "the language rule went back to naming fields, and left {field:?} \
                 to be forgotten"
            );
        }
        assert!(RULES.contains("whatever it is called"));
    }

    #[test]
    fn the_rules_name_the_patterns_they_forbid() {
        // Vague instruction produces the output it would have produced anyway.
        for word in ["delve", "not X, but Y", "throat-clearing", "lists of three"] {
            assert!(RULES.contains(word), "the rules stopped naming {word:?}");
        }
    }
}
