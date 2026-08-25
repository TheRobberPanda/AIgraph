//! Reading a conversation that happened somewhere else.
//!
//! Exports from other assistants are all roughly the same shape — alternating
//! turns with a speaker label — but the labels differ, and which one is the
//! human is not always obvious. This detects both, and the caller can override
//! the answer because a wrong guess would attribute someone else's words to the
//! person using the app, which is precisely what the rest of the design exists
//! to prevent.

use crate::llm::types::{Message, Role};

/// Labels that name the machine.
const ASSISTANT_LABELS: &[&str] = &[
    "assistant",
    "ai",
    "bot",
    "model",
    "chatgpt",
    "gpt",
    "claude",
    "gemini",
    "bard",
    "copilot",
    "llama",
    "mistral",
    "grok",
    "perplexity",
    "answer",
    "a",
];

/// Labels that name the person.
const HUMAN_LABELS: &[&str] = &["user", "human", "me", "you", "prompt", "question", "q", "self"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ImportedTurn {
    pub role: Role,
    pub text: String,
    /// The label this turn was found under, so the UI can show what was matched.
    pub label: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Import {
    pub turns: Vec<ImportedTurn>,
    /// The two labels found, in the order they first appeared.
    pub labels: Vec<String>,
    /// How the roles were decided — worth showing, because a guess should look
    /// like a guess.
    pub basis: Basis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// A label named the speaker outright ("Human:", "ChatGPT:").
    Recognised,
    /// Neither label was recognised, so the longer-winded speaker was taken to
    /// be the assistant. Frequently right, and worth confirming.
    LengthHeuristic,
    /// No labels at all — the whole text was taken as one human turn.
    Unlabelled,
}

/// Strip the decoration people paste around a label: `**User**`, `### User`.
fn clean_label(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('#')
        .trim()
        .trim_matches('*')
        .trim_matches('_')
        .trim()
        .trim_end_matches(':')
        .trim()
        .to_lowercase()
}

/// Does this line open a new turn? Returns the label and any text after it.
fn split_label(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    // A label is short and ends at the first colon. Anything longer is prose
    // that happens to contain one.
    let colon = trimmed.find(':')?;
    if colon == 0 || colon > 30 {
        return None;
    }
    let (head, rest) = trimmed.split_at(colon);
    let label = clean_label(head);
    if label.is_empty() || label.len() > 24 {
        return None;
    }
    // Labels are names, not clauses. Two words at most — otherwise a sentence
    // like "the point is: it compounds" reads as a speaker called "the point is".
    if label.split_whitespace().count() > 2 {
        return None;
    }
    if !label.chars().next()?.is_alphabetic() {
        return None;
    }
    Some((label, rest[1..].trim_start().to_string()))
}

pub fn parse(text: &str) -> Import {
    let mut blocks: Vec<(String, String)> = Vec::new();

    for line in text.lines() {
        match split_label(line) {
            Some((label, rest)) => blocks.push((label, rest)),
            None => {
                if let Some(last) = blocks.last_mut() {
                    last.1.push('\n');
                    last.1.push_str(line);
                }
                // Text before any label is dropped: it is usually an export
                // header rather than something someone said.
            }
        }
    }

    let mut labels: Vec<String> = Vec::new();
    for (label, _) in &blocks {
        if !labels.contains(label) {
            labels.push(label.clone());
        }
    }

    // Drop stray labels — a single "Note:" among the turns is not a speaker.
    // Only when there are more than two candidates, though: a short exchange
    // genuinely has one side appearing once, and filtering on recurrence alone
    // threw those away.
    if labels.len() > 2 {
        labels.retain(|l| blocks.iter().filter(|(b, _)| b == l).count() >= 2);
    }

    if labels.len() != 2 {
        let body = text.trim().to_string();
        return Import {
            turns: if body.is_empty() {
                Vec::new()
            } else {
                vec![ImportedTurn { role: Role::User, text: body, label: String::new() }]
            },
            labels: Vec::new(),
            basis: Basis::Unlabelled,
        };
    }

    let (a, b) = (&labels[0], &labels[1]);
    // Exact match, or containment only for labels long enough to be meaningful.
    // Substring matching on short entries misfires badly: "a" is a real label in
    // Q&A transcripts, and it also sits inside "human".
    let known =
        |l: &str, set: &[&str]| set.iter().any(|k| l == *k || (k.len() >= 4 && l.contains(k)));

    let (assistant, basis) = if known(a, ASSISTANT_LABELS) || known(b, HUMAN_LABELS) {
        (a.clone(), Basis::Recognised)
    } else if known(b, ASSISTANT_LABELS) || known(a, HUMAN_LABELS) {
        (b.clone(), Basis::Recognised)
    } else {
        // Assistants write more. Not always true, hence the override.
        let total = |label: &String| -> usize {
            blocks.iter().filter(|(l, _)| l == label).map(|(_, t)| t.len()).sum()
        };
        let winner = if total(a) >= total(b) { a.clone() } else { b.clone() };
        (winner, Basis::LengthHeuristic)
    };

    let turns = blocks
        .into_iter()
        .filter(|(_, text)| !text.trim().is_empty())
        .map(|(label, text)| ImportedTurn {
            role: if label == assistant { Role::Assistant } else { Role::User },
            text: text.trim().to_string(),
            label,
        })
        .collect();

    Import { turns, labels, basis }
}

/// Flip the roles, for when the guess was wrong.
pub fn swap(import: &Import) -> Import {
    Import {
        turns: import
            .turns
            .iter()
            .map(|t| ImportedTurn {
                role: match t.role {
                    Role::User => Role::Assistant,
                    Role::Assistant => Role::User,
                },
                text: t.text.clone(),
                label: t.label.clone(),
            })
            .collect(),
        labels: import.labels.clone(),
        basis: import.basis,
    }
}

pub fn to_messages(turns: &[ImportedTurn]) -> Vec<Message> {
    turns.iter().map(|t| Message { role: t.role, content: t.text.clone() }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_chatgpt_style_export() {
        let out = parse(
            "You: what is latency\n\nChatGPT: The delay between\ncause and effect.\n\nYou: right",
        );
        assert_eq!(out.basis, Basis::Recognised);
        assert_eq!(out.turns.len(), 3);
        assert_eq!(out.turns[0].role, Role::User);
        assert_eq!(out.turns[1].role, Role::Assistant);
        assert!(out.turns[1].text.contains("cause and effect"));
    }

    #[test]
    fn reads_markdown_decorated_labels() {
        let out = parse(
            "**Human**: first thought\n\n**Assistant**: a reply\n\n**Human**: second thought",
        );
        assert_eq!(out.basis, Basis::Recognised);
        assert_eq!(out.turns[0].role, Role::User);
        assert_eq!(out.turns[1].role, Role::Assistant);
    }

    #[test]
    fn unknown_labels_fall_back_to_who_talks_more() {
        let out = parse(
            "Bob: hi\n\nAlice: a much longer reply that goes on and on and on about many things\n\nBob: ok",
        );
        assert_eq!(out.basis, Basis::LengthHeuristic);
        assert_eq!(out.turns[0].role, Role::User, "the terser speaker is taken as the human");
        assert_eq!(out.turns[1].role, Role::Assistant);
    }

    #[test]
    fn prose_containing_a_colon_is_not_a_speaker() {
        let out = parse("Me: I was thinking about this\nthe point is: it compounds\n\nAI: I see");
        assert_eq!(out.turns.len(), 2);
        assert!(
            out.turns[0].text.contains("the point is: it compounds"),
            "a mid-sentence colon must stay in the turn it belongs to"
        );
    }

    #[test]
    fn unlabelled_text_becomes_one_human_turn() {
        // Nothing was said by a machine, so nothing is attributed to one.
        let out = parse("just a paragraph of thinking with no speakers at all");
        assert_eq!(out.basis, Basis::Unlabelled);
        assert_eq!(out.turns.len(), 1);
        assert_eq!(out.turns[0].role, Role::User);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(parse("   \n  ").turns.is_empty());
    }

    #[test]
    fn swapping_reverses_every_role() {
        let out = swap(&parse("You: a\n\nClaude: b"));
        assert_eq!(out.turns[0].role, Role::Assistant);
        assert_eq!(out.turns[1].role, Role::User);
    }

    #[test]
    fn a_stray_label_is_not_treated_as_a_speaker() {
        // "Note:" appears once; only recurring labels are speakers.
        let out = parse("Me: thinking\n\nAI: replying\n\nMe: more\n\nAI: more back");
        assert_eq!(out.labels.len(), 2);
    }
}
