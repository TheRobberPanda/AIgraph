//! Breaking a wall of typing into paragraphs, without touching a character of it.
//!
//! Thinking out loud arrives as one block. It is written in one go, and read
//! back weeks later as an unbroken page — which is the point at which the
//! record stops being worth having, because nobody rereads a wall.
//!
//! The obvious fix is to have a model rewrite it more readably, and that fix
//! is unavailable here. Every idea's provenance is a byte range into the exact
//! text of the turn it was said in. Rewriting even a comma shifts those ranges
//! and quietly moves every highlight onto the wrong words — the failure would
//! not be visible until somebody noticed a quote no longer matched what it
//! claimed, by which time the original is gone.
//!
//! So the model is not asked for prose. It is asked *where the paragraphs
//! start*: the opening words of each one, quoted exactly. Those are then found
//! in the text by the same search that verifies an idea's quote, and anything
//! that cannot be found is dropped. The worst case is a turn that keeps the
//! paragraphing it has now. The text itself is never edited, so the highlights
//! cannot drift — not because the prompt asks nicely, but because nothing in
//! this path is capable of writing to it.

use serde::Deserialize;

use crate::llm::{IdeaExtractor, LlmError};

/// Below this, a turn is already a readable length and asking is a waste of a
/// model's time — and of the person's, since the answer would be "no breaks".
pub const WORTH_BREAKING: usize = 700;

/// The shortest run of characters worth calling a paragraph. Below this the
/// model is splitting sentences, not paragraphs, and the result reads worse
/// than the wall it replaced.
const MIN_PARAGRAPH: usize = 180;

pub fn json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["language", "turns"],
        "properties": {
            // First, and for the same reason as everywhere else: told to work
            // in the language of the text, the model follows these English
            // instructions into English. Made to name the language before it
            // writes anything, it keeps to it.
            "language": { "type": "string" },
            "turns": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["turn", "breaks"],
                    "properties": {
                        "turn": { "type": "integer" },
                        "breaks": { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}

pub fn build(turns: &[(i64, String)]) -> String {
    let body = turns
        .iter()
        .map(|(ord, text)| format!("### turn {ord}\n{text}"))
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"Below are things somebody wrote during a conversation, each marked with
a turn number. They were typed in one go and have no paragraph breaks.

Say where the paragraphs should start.

For each turn, return the first few words of each new paragraph after the
first — copied exactly, character for character, from the text below.

- Copy the words exactly as they appear. Do not correct spelling, punctuation,
  capitalisation or anything else. A break that does not match the text
  character for character is discarded, and that turn keeps its wall of text.
- Six to twelve words is right: enough that the words appear only once in the
  turn, short enough to stay exact.
- Break where the subject turns, not every few sentences. Most turns want two
  to four paragraphs. A turn that is genuinely one thought wants none — return
  an empty list and that is a good answer, not a failure.
- Never break mid-sentence. A paragraph starts where a sentence starts.
- Do not rewrite, summarise, reorder or add anything. You are marking places in
  someone else's writing, not editing it.

Return JSON: {{"language": "...", "turns": [{{"turn": <number>, "breaks": ["...", "..."]}}]}}
with one entry per turn given.

First return "language": the language the text below is written in, named in
English — "Polish", "Spanish", "English". The breaks you quote will be in that
language, because they are copied from it. Translating them is a mistake.

{body}"#
    )
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    turns: Vec<Breaks>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Breaks {
    pub turn: i64,
    #[serde(default)]
    pub breaks: Vec<String>,
}

pub fn parse(raw: &str) -> Result<Vec<Breaks>, LlmError> {
    let text = raw.trim();
    if let Ok(env) = serde_json::from_str::<Envelope>(text) {
        return Ok(env.turns);
    }
    if let (Some(s), Some(e)) = (text.find('{'), text.rfind('}')) {
        if e > s {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text[s..=e]) {
                return Ok(env.turns);
            }
        }
    }
    Err(LlmError::BadOutput(text.chars().take(300).collect()))
}

/// Turn the model's quoted openings into byte offsets into `text`.
///
/// The same discipline as verifying an idea's quote, and for the same reason:
/// what the model says about where something is, is not evidence that it is
/// there. Each opening is searched for; a break that is not found, is found
/// more than once, or lands somewhere that would make a paragraph too short to
/// be one is dropped. Offsets always land on character boundaries, because
/// they come from `find` on the string itself.
pub fn locate(text: &str, breaks: &[String]) -> Vec<usize> {
    let mut found: Vec<usize> = Vec::new();

    for quote in breaks {
        let quote = quote.trim();
        if quote.is_empty() {
            continue;
        }
        let Some(at) = text.find(quote) else {
            tracing::debug!(quote, "paragraph break not found in the text; dropping it");
            continue;
        };
        // Ambiguous: the same opening occurs twice, so which one was meant is a
        // guess. Guessing here puts a break in a place nobody chose.
        if text[at + quote.len()..].contains(quote) {
            continue;
        }
        found.push(at);
    }

    found.sort_unstable();
    found.dedup();

    // Keep only breaks that leave a paragraph worth the name on either side.
    let mut kept: Vec<usize> = Vec::new();
    for at in found {
        let previous = kept.last().copied().unwrap_or(0);
        if at.saturating_sub(previous) < MIN_PARAGRAPH {
            continue;
        }
        if text.len().saturating_sub(at) < MIN_PARAGRAPH {
            continue;
        }
        kept.push(at);
    }
    kept
}

/// Find the paragraph breaks for every turn long enough to want them.
///
/// One call for the session, not one per turn.
pub async fn run(
    model: &dyn IdeaExtractor,
    turns: &[(i64, String)],
) -> Result<Vec<Breaks>, LlmError> {
    if turns.is_empty() {
        return Ok(Vec::new());
    }
    let raw = model.judge(&build(turns), json_schema()).await?;
    parse(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three subjects, each long enough to be a paragraph, with no sentence
    /// repeated — a repeated sentence would be ambiguous by design, and would
    /// be testing the ambiguity guard rather than the location.
    fn wall() -> String {
        let filler = |tag: &str| {
            (0..6)
                .map(|i| format!("{tag} point {i} follows on from the last. "))
                .collect::<String>()
        };
        format!(
            "I keep coming back to latency. {}But the deployment story is what actually blocks us. {}And none of that matters if nobody uses the thing. {}",
            filler("Latency"),
            filler("Deployment"),
            filler("Adoption"),
        )
    }

    #[test]
    fn every_turn_is_offered_with_its_number() {
        let p = build(&[(2, "first".into()), (5, "second".into())]);
        assert!(p.contains("### turn 2"));
        assert!(p.contains("### turn 5"));
    }

    #[test]
    fn parses_breaks_and_salvages_a_chatty_wrapper() {
        let out = parse(r#"{"turns":[{"turn":2,"breaks":["But the"]}]}"#).unwrap();
        assert_eq!(out[0].turn, 2);
        assert_eq!(out[0].breaks, vec!["But the"]);

        let out = parse("Sure:\n```json\n{\"turns\":[{\"turn\":1,\"breaks\":[]}]}\n```").unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].breaks.is_empty(), "no breaks is an answer, not a failure");
    }

    /// The whole point of the design: a break is only believed if the words
    /// are actually there, and the offset comes from finding them rather than
    /// from anything the model said about where they are.
    #[test]
    fn a_break_is_located_by_its_own_words() {
        let text = wall();
        let at = locate(&text, &["But the deployment story is what actually blocks us.".into()]);
        assert_eq!(at.len(), 1);
        assert!(text[at[0]..].starts_with("But the deployment story"));
        assert!(text.is_char_boundary(at[0]));
    }

    /// A near miss — one word rewritten — must be dropped rather than placed
    /// approximately. Approximately is how a highlight ends up on the wrong
    /// words, and there is no way to notice afterwards.
    #[test]
    fn a_rewritten_break_is_dropped_rather_than_guessed() {
        let text = wall();
        assert!(
            locate(&text, &["But the deployment story is what really blocks us.".into()])
                .is_empty(),
            "one changed word, and it is not the text any more"
        );
        assert!(locate(&text, &["something never written".into()]).is_empty());
        assert!(locate(&text, &["   ".into()]).is_empty());
    }

    /// An opening that occurs twice names two places, so it names neither.
    #[test]
    fn an_ambiguous_break_is_dropped() {
        let text = wall();
        assert!(
            locate(&text, &["I keep coming back to the same thing".into()]).is_empty(),
            "repeated openings are a guess, not a location"
        );
    }

    /// Splitting every sentence is worse than the wall it replaces.
    #[test]
    fn breaks_too_close_together_are_refused() {
        let text = wall();
        let both = locate(
            &text,
            &[
                "But the deployment story is what actually blocks us.".into(),
                "And none of that matters if nobody uses the thing.".into(),
            ],
        );
        assert_eq!(both.len(), 2, "genuinely separate turns of subject are kept");

        // A break a few characters after another one is not a paragraph.
        let crowded = locate(
            &text,
            &[
                "But the deployment story is what actually blocks us.".into(),
                "Deployment point 0 follows on from the last.".into(),
            ],
        );
        assert_eq!(crowded.len(), 1, "the second is a sentence away, not a paragraph away");
    }

    #[tokio::test]
    async fn nothing_to_break_makes_no_call() {
        struct Boom;
        #[async_trait::async_trait]
        impl IdeaExtractor for Boom {
            async fn extract(
                &self,
                _t: &str,
                _c: &[String],
            ) -> Result<crate::extract::prompt::Extracted, LlmError> {
                unimplemented!()
            }
            async fn judge(&self, _p: &str, _s: serde_json::Value) -> Result<String, LlmError> {
                panic!("a session with nothing long enough must not cost a call");
            }
            fn model_id(&self) -> String {
                "test".into()
            }
        }
        assert!(run(&Boom, &[]).await.unwrap().is_empty());
    }
}
