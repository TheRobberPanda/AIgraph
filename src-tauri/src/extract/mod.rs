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
    /// A short, glanceable name for the conversation, e.g. "American Economic
    /// Empire". Empty if the model returned nothing usable.
    pub title: String,
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
    // Abridged, not the whole thing — see `for_extraction`. Verification below
    // still runs against the real turns, so this cannot widen what counts as a
    // quote, only narrow what the model is tempted to reach for.
    let for_model = for_extraction(turns);
    let extracted = extractor.extract(&for_model, known_categories).await?;
    let notes = extracted.conversation.clone();
    let title = extracted.title.trim().to_string();

    on_phase(Phase::Verifying);
    let mut first = sort_out(extracted.ideas, turns);
    first.conversation = notes;
    first.title = title;

    if first.rejected.is_empty() {
        return Ok(first);
    }

    on_phase(Phase::Retrying);

    let corrective = format!(
        "{}\n\nA previous attempt failed. These quotes could not be found in \
         the USER lines:\n{}\n\nEach was either copied from an ASSISTANT line, \
         which does not count, or written from memory rather than copied. Find \
         each quote in a USER line and copy it across character for character. \
         Omit any idea you cannot quote exactly — fewer ideas that are real is \
         the right outcome.",
        prompt::build(&for_model),
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
            second.title = if extracted.title.trim().is_empty() {
                first.title.clone()
            } else {
                extracted.title.trim().to_string()
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
                title: String::new(),
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
            title: String::new(),
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

/// The transcript as the extractor should see it.
///
/// The assistant's replies are abridged. In a real session they are most of
/// the text — 10,138 characters against 1,745 of the person's own, in the
/// session that prompted this — and handing a model all of it while asking it
/// to ignore eighty-five per cent of what it is reading is a rule it will
/// break. It did: every quote in a failed Polish session came from the
/// assistant's words rather than the person's.
///
/// Enough of each reply is kept to follow the thread, and what is kept is
/// marked as not quotable. Verification is unaffected — quotes are still
/// located in the real transcript, so abridging cannot let a bad quote
/// through. It only stops the model reaching for words that were never the
/// user's, and shrinks the prompt to a fraction of its size on the way.
pub fn for_extraction(turns: &[Turn]) -> String {
    use crate::llm::Role;
    /// Characters of each reply kept. Enough to know what was answered,
    /// nowhere near enough to mine for a claim.
    const LEAD: usize = 160;

    let mut out = String::new();
    for turn in turns {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        match turn.role {
            Role::User => {
                out.push_str(crate::session::transcript::USER_MARKER);
                out.push_str(&turn.text);
            }
            Role::Assistant => {
                out.push_str(crate::session::transcript::ASSISTANT_MARKER);
                let trimmed = turn.text.trim();
                let lead: String = trimmed.chars().take(LEAD).collect();
                out.push_str(&lead);
                if trimmed.chars().count() > LEAD {
                    // Said in the transcript itself, not only in the rules
                    // above it. A model reading this line knows there is
                    // nothing here to quote without having to remember an
                    // instruction from two thousand tokens ago.
                    out.push_str("… [reply abridged — nothing here is quotable]");
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod abridge_tests {
    use super::*;
    use crate::llm::Role;

    fn turn(id: i64, role: Role, text: &str) -> Turn {
        Turn { id, role, text: text.into() }
    }

    #[test]
    fn the_persons_own_words_are_kept_whole() {
        let said = "jestem muzykiem z Polski i chciałabym założyć własną działalność";
        let turns = vec![
            turn(1, Role::User, said),
            turn(2, Role::Assistant, &"a long answer about taxes ".repeat(40)),
        ];
        let out = for_extraction(&turns);
        assert!(out.contains(said), "a quote has to still be findable here");
        assert!(out.len() < 700, "the reply is abridged, not carried whole");
        assert!(out.contains("nothing here is quotable"));
    }

    #[test]
    fn a_short_reply_is_left_alone() {
        let turns = vec![turn(1, Role::Assistant, "Say more?")];
        let out = for_extraction(&turns);
        assert_eq!(out, "ASSISTANT: Say more?");
    }
}
