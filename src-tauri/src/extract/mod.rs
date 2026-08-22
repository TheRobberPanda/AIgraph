//! Session extraction: transcript in, verified ideas out.

pub mod deepen;
pub mod prompt;
pub mod replies;
pub mod style;
pub mod verify;

use crate::llm::types::RawIdea;
use crate::llm::{IdeaExtractor, LlmError};
use verify::{Located, Rejection, Turn};

#[derive(Debug, Clone)]
pub struct VerifiedIdea {
    pub raw: RawIdea,
    pub located: Located,
}

#[derive(Debug, Clone)]
pub struct Rejected {
    pub raw: RawIdea,
    pub reason: Rejection,
}

/// Where an in-flight extraction has got to.
///
/// Worth reporting rather than showing an undifferentiated spinner: on a local
/// model the first phase can take minutes, and `Retrying` in particular means
/// the work is about to take roughly twice as long as expected. A user watching
/// a silent spinner has no way to tell that from a hang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Waiting on the model. Nearly all of the wall time.
    Asking,
    /// Locating each quote in the real transcript. Fast.
    Verifying,
    /// Some quotes could not be traced; asking again with those named.
    Retrying,
    Saving,
}

/// The outcome of extracting one session.
#[derive(Debug, Clone, Default)]
pub struct Extraction {
    pub ideas: Vec<VerifiedIdea>,
    pub rejected: Vec<Rejected>,
    pub retried: bool,
    /// What the model made of the whole conversation. Becomes the nudges on the
    /// conversation's node.
    pub conversation: crate::llm::types::ConversationNotes,
}

impl Extraction {
    /// Share of proposed ideas that could not be traced to real text.
    ///
    /// This is the number the Diagnostics panel shows. It is the earliest and
    /// most honest signal that a provider or a prompt has gone bad, which is
    /// exactly why it is displayed rather than quietly logged.
    pub fn drop_rate(&self) -> f32 {
        let total = self.ideas.len() + self.rejected.len();
        if total == 0 {
            return 0.0;
        }
        self.rejected.len() as f32 / total as f32
    }
}

/// Run extraction over one archived session.
///
/// If anything fails verification, the session is retried once with the failed
/// quotes named. Models are noticeably better on the second pass when told
/// specifically which quotes did not appear in the source.
pub async fn run(
    extractor: &dyn IdeaExtractor,
    transcript: &str,
    turns: &[Turn],
) -> Result<Extraction, LlmError> {
    run_with_progress(extractor, transcript, turns, &[], &|_| {}).await
}

/// As [`run`], reporting each phase as it starts.
pub async fn run_with_progress(
    extractor: &dyn IdeaExtractor,
    transcript: &str,
    turns: &[Turn],
    known_categories: &[String],
    on_phase: &(dyn Fn(Phase) + Send + Sync),
) -> Result<Extraction, LlmError> {
    on_phase(Phase::Asking);
    let extracted = extractor.extract(transcript, known_categories).await?;
    let notes = extracted.conversation.clone();

    on_phase(Phase::Verifying);
    let mut first = sort_out(extracted.ideas, turns);
    first.conversation = notes;

    if first.rejected.is_empty() {
        return Ok(first);
    }

    on_phase(Phase::Retrying);

    let corrective = format!(
        "{}\n\nA previous attempt failed because these quotes did not appear \
         verbatim in the transcript:\n{}\n\nCopy quotes character for character \
         from lines marked USER. Omit any idea you cannot quote exactly.",
        prompt::build(transcript),
        first
            .rejected
            .iter()
            .map(|r| format!("- {:?}: {:?}", r.reason, prompt_snippet(&r.raw.quote)))
            .collect::<Vec<_>>()
            .join("\n"),
    );

    match extractor.extract(&corrective, known_categories).await {
        Ok(extracted) => {
            let mut second = sort_out(extracted.ideas, turns);
            second.retried = true;
            // Keep the first pass's notes if the retry returned none — the
            // retry prompt is focused on quotes, not on the whole conversation.
            second.conversation = if extracted.conversation.notes.is_empty() {
                first.conversation.clone()
            } else {
                extracted.conversation
            };
            // Keep whichever attempt traced more ideas to real text. A retry
            // that does worse is discarded rather than trusted for being newer.
            if second.ideas.len() >= first.ideas.len() {
                Ok(second)
            } else {
                Ok(Extraction { retried: true, ..first })
            }
        }
        // A failed retry must not lose the ideas the first pass got right.
        Err(_) => Ok(Extraction { retried: true, ..first }),
    }
}

fn sort_out(raws: Vec<RawIdea>, turns: &[Turn]) -> Extraction {
    let mut out = Extraction::default();
    for raw in raws {
        match verify::verify(&raw, turns) {
            Ok(located) => out.ideas.push(VerifiedIdea { raw, located }),
            Err(reason) => out.rejected.push(Rejected { raw, reason }),
        }
    }
    out
}

fn prompt_snippet(s: &str) -> String {
    s.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::Role;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scripted {
        passes: Vec<Vec<RawIdea>>,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl IdeaExtractor for Scripted {
        async fn extract(
            &self,
            _t: &str,
            _c: &[String],
        ) -> Result<crate::extract::prompt::Extracted, LlmError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(crate::extract::prompt::Extracted {
                ideas: self.passes.get(n).cloned().unwrap_or_default(),
                conversation: Default::default(),
            })
        }
        async fn judge(
            &self,
            _prompt: &str,
            _schema: serde_json::Value,
        ) -> Result<String, LlmError> {
            unimplemented!("extraction tests never adjudicate")
        }
        fn model_id(&self) -> String {
            "test".into()
        }
    }

    fn idea(quote: &str) -> RawIdea {
        RawIdea {
            claim: "c".into(),
            quote: quote.into(),
            reasoning: String::new(),
            category: String::new(),
            notes: vec![],
        }
    }

    fn turns() -> Vec<Turn> {
        vec![Turn { id: 1, role: Role::User, text: "latency is the real problem here".into() }]
    }

    #[tokio::test]
    async fn clean_pass_does_not_retry() {
        let ex = Scripted {
            passes: vec![vec![idea("latency is the real problem")]],
            calls: AtomicUsize::new(0),
        };
        let out = run(&ex, "t", &turns()).await.unwrap();
        assert_eq!(out.ideas.len(), 1);
        assert!(!out.retried);
        assert_eq!(ex.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn bad_quotes_trigger_one_retry() {
        let ex = Scripted {
            passes: vec![
                vec![idea("something never said")],
                vec![idea("latency is the real problem")],
            ],
            calls: AtomicUsize::new(0),
        };
        let out = run(&ex, "t", &turns()).await.unwrap();
        assert!(out.retried);
        assert_eq!(out.ideas.len(), 1);
        assert_eq!(out.drop_rate(), 0.0);
    }

    #[tokio::test]
    async fn worse_retry_is_discarded() {
        let ex = Scripted {
            passes: vec![
                vec![idea("latency is the real problem"), idea("nope")],
                vec![],
            ],
            calls: AtomicUsize::new(0),
        };
        let out = run(&ex, "t", &turns()).await.unwrap();
        assert_eq!(out.ideas.len(), 1, "kept the better first pass");
        assert!(out.retried);
    }

    #[test]
    fn drop_rate_of_nothing_is_zero_not_nan() {
        assert_eq!(Extraction::default().drop_rate(), 0.0);
    }
}
