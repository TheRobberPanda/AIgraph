//! Condensing what the assistant said.
//!
//! The assistant answers at whatever length it likes — nothing is injected into
//! the conversation to make it terser, so it behaves exactly as it would
//! anywhere else. The tidying happens afterwards, on the record, where it costs
//! nothing and destroys nothing: each reply gets a short version to read, and
//! the reply itself stays underneath, untouched.
//!
//! Two or three thousand characters of answer against a sentence of thinking is
//! otherwise a page where the machine does all the talking.

use serde::Deserialize;

use crate::llm::{IdeaExtractor, LlmError};

pub fn json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["replies"],
        "properties": {
            "replies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["turn", "digest"],
                    "properties": {
                        "turn": { "type": "integer" },
                        "digest": { "type": "string" }
                    }
                }
            }
        }
    })
}

pub fn build(replies: &[(i64, String)]) -> String {
    let style = crate::extract::style::RULES;
    let body = replies
        .iter()
        .map(|(ord, text)| format!("### turn {ord}\n{text}"))
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"Below are answers given during a conversation, each marked with a turn
number.

Condense each one to what is worth keeping.

- Two or three sentences. Never more than four. If one sentence covers it, write
  one.
- Keep the substance: the actual answer, the distinctions drawn, the specific
  claims. Drop the framing, the restatement of the question, the summary at the
  end, the offers of further help, and anything hedged to the point of saying
  nothing.
- Where an answer lays out several positions, name them and say what separates
  them. Do not reproduce the explanation of each.
- Plain sentences. No headings, no bullets, no bold.
- Write it as a note to be read later, not as a reply to anyone.
- Never write "the user's view" or "the user asked" or similar. State the
  content directly: not "The user's view moves from X to Y" but "Moves from
  X to Y."

{style}

Return JSON: {{"replies": [{{"turn": <number>, "digest": "..."}}]}} with one entry
per turn given.

{body}"#
    )
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    replies: Vec<Digest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Digest {
    pub turn: i64,
    pub digest: String,
}

pub fn parse(raw: &str) -> Result<Vec<Digest>, LlmError> {
    let text = raw.trim();
    if let Ok(env) = serde_json::from_str::<Envelope>(text) {
        return Ok(env.replies);
    }
    if let (Some(s), Some(e)) = (text.find('{'), text.rfind('}')) {
        if e > s {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text[s..=e]) {
                return Ok(env.replies);
            }
        }
    }
    Err(LlmError::BadOutput(text.chars().take(300).collect()))
}

/// Condense every reply in a session. One call, not one per turn.
pub async fn run(
    model: &dyn IdeaExtractor,
    replies: &[(i64, String)],
) -> Result<Vec<Digest>, LlmError> {
    if replies.is_empty() {
        return Ok(Vec::new());
    }
    let raw = model.judge(&build(replies), json_schema()).await?;
    parse(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_turn_is_offered_with_its_number() {
        let p = build(&[(2, "first answer".into()), (5, "second answer".into())]);
        assert!(p.contains("### turn 2"));
        assert!(p.contains("### turn 5"));
        assert!(p.contains("first answer"));
    }

    #[test]
    fn parses_digests() {
        let out = parse(r#"{"replies":[{"turn":2,"digest":"short"}]}"#).unwrap();
        assert_eq!(out[0].turn, 2);
        assert_eq!(out[0].digest, "short");
    }

    #[test]
    fn salvages_a_chatty_wrapper() {
        let out = parse("Sure:\n```json\n{\"replies\":[{\"turn\":1,\"digest\":\"x\"}]}\n```").unwrap();
        assert_eq!(out.len(), 1);
    }

    #[tokio::test]
    async fn nothing_to_condense_makes_no_call() {
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
                panic!("a session with no replies must not cost a call");
            }
            fn model_id(&self) -> String {
                "test".into()
            }
        }
        assert!(run(&Boom, &[]).await.unwrap().is_empty());
    }
}
