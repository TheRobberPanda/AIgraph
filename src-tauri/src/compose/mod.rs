//! Talking to a model with a folder's conversations in front of it.
//!
//! Everything else in this app reads the transcripts *down* — into ideas, into
//! quotes, into a map. This reads them across: the whole folder handed to a
//! model as context, so it can be asked to make something out of it. A book, a
//! script, an essay, or whatever is typed into the box.
//!
//! Deliberately the conversations and not the ideas. Extraction throws away
//! the phrasing, the digressions, and the order things arrived in, which is
//! exactly the material a script or a chapter is made of. The ideas are a
//! reading; this is the record.
//!
//! Nothing here is written back. What comes out is an answer on screen and, if
//! you want it, a file — never an idea, never a quote, never anything that
//! joins the map. The provenance rule the rest of the app runs on is that
//! every recorded thing is traceable to something said; a model asked to write
//! a TikTok script is not producing that kind of thing, so it does not get to
//! put anything into the record.

use crate::store::Recorded;

/// How much of the folder is handed over, in characters.
///
/// Not tokens: counting those properly means the model's own tokeniser, and
/// this only has to be roughly right. Four characters to a token is close
/// enough for English and pessimistic for Polish, which is the safe direction.
/// 480k characters is around 120k tokens — comfortable for a cloud model, and
/// more than a local one will take, which is why what gets cut is chosen
/// rather than left to whatever the server truncates.
const BUDGET: usize = 480_000;

/// Longest assistant reply kept whole before it is cut down.
///
/// The answers are context, not the material. Someone thinking out loud for an
/// hour against a model that writes three-thousand-character replies has a
/// transcript that is eighty per cent machine — and handing that back is
/// asking it to make a script out of its own voice.
const REPLY_LIMIT: usize = 900;

/// What went into the context, so the screen can say so rather than implying
/// the whole folder always fits.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Packed {
    pub text: String,
    /// Conversations included in full or in part.
    pub conversations: usize,
    /// Conversations left out entirely, oldest first, because the budget ran
    /// out before they were reached.
    pub dropped: usize,
    /// Replies shortened to their first part.
    pub shortened: usize,
    pub characters: usize,
    /// Titles of the conversations actually included, newest first — the
    /// screen shows what the model will be reading, not just how much of it.
    pub titles: Vec<String>,
}

/// Lay a folder's conversations out for a model to read.
///
/// Newest first. If something has to be left out it should be the oldest
/// thinking, not the most recent — and a person asking for a script today is
/// usually asking about what they have been saying lately.
pub fn pack(conversations: &[Recorded]) -> Packed {
    let mut out = Packed::default();
    let mut text = String::new();

    for talk in conversations.iter().rev() {
        let mut block = String::new();
        block.push_str("\n\n===== ");
        block.push_str(if talk.title.trim().is_empty() {
            "Untitled conversation"
        } else {
            talk.title.trim()
        });
        block.push_str(" · ");
        block.push_str(talk.started_at.split('T').next().unwrap_or(&talk.started_at));
        block.push_str(" =====\n");

        let mut shortened = 0;
        for (role, said) in &talk.turns {
            let said = said.trim();
            if said.is_empty() {
                continue;
            }
            if role == "user" {
                block.push_str("\nTHEM: ");
                block.push_str(said);
            } else {
                block.push_str("\nMODEL: ");
                if said.chars().count() > REPLY_LIMIT {
                    let cut: String = said.chars().take(REPLY_LIMIT).collect();
                    block.push_str(&cut);
                    block.push_str(" […]");
                    shortened += 1;
                } else {
                    block.push_str(said);
                }
            }
            block.push('\n');
        }

        // Whole conversations rather than half of one: a transcript cut in the
        // middle reads as a thought that was never finished, and the model
        // will treat it as one.
        if text.len() + block.len() > BUDGET && !text.is_empty() {
            out.dropped += 1;
            continue;
        }
        text.push_str(&block);
        out.conversations += 1;
        out.shortened += shortened;
        out.titles.push(
            if talk.title.trim().is_empty() { "Untitled conversation" } else { talk.title.trim() }
                .to_string(),
        );
    }

    out.characters = text.len();
    out.text = text;
    out
}

/// Ideas chosen on their own, without the conversation around them.
///
/// A conversation ticked whole goes in as its transcript. An idea ticked by
/// itself goes in as what was recorded of it — the statement, and the words it
/// was drawn from. Both are that person's material; they differ in how much of
/// the road to it comes along.
pub fn pack_ideas(ideas: &[(String, String, Vec<String>)]) -> String {
    if ideas.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n\n===== Ideas chosen on their own =====\n");
    for (title, claim, quotes) in ideas {
        out.push_str("\n- ");
        out.push_str(title);
        if claim.trim() != title.trim() {
            out.push_str("\n  ");
            out.push_str(claim);
        }
        for q in quotes {
            out.push_str("\n  THEM: ");
            out.push_str(q);
        }
        out.push('\n');
    }
    out
}

/// The standing instruction the model reads before anything else.
///
/// Deliberately short. The material is the point, the preset or the typed
/// instruction is the task, and a long preamble here would compete with both.
pub fn system_prompt(folder: &str, packed: &Packed) -> String {
    format!(
        r#"Below are {n} conversation{s} from one person's notebook, filed under "{folder}".
They are the raw record: THEM is the person thinking out loud, MODEL is whatever
was answering at the time.

You are being asked to make something out of this material.

- The thinking is theirs. Work from what is actually in the transcripts and do
  not add positions they did not take.
- Their words are usually better than a paraphrase. Quote directly where the
  original phrasing is sharper than anything you would write.
- MODEL lines are context, not source. They are what was said back, not what
  the person thinks, and some are shortened. Do not build on them and do not
  quote them as though they were the person's own.
- Where the material genuinely will not support what was asked for, say so and
  make what it does support, rather than padding it out.

{text}"#,
        n = packed.conversations,
        s = if packed.conversations == 1 { "" } else { "s" },
        folder = folder,
        text = packed.text,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn talk(id: i64, title: &str, turns: Vec<(&str, &str)>) -> Recorded {
        Recorded {
            session_id: id,
            title: title.into(),
            started_at: format!("2026-08-{id:02}T10:00:00+00:00"),
            turns: turns.into_iter().map(|(r, t)| (r.to_string(), t.to_string())).collect(),
        }
    }

    #[test]
    fn both_sides_are_there_and_told_apart() {
        let p = pack(&[talk(
            1,
            "Work",
            vec![("user", "teaching does not scale"), ("assistant", "why not")],
        )]);
        assert!(p.text.contains("THEM: teaching does not scale"));
        assert!(p.text.contains("MODEL: why not"));
        assert_eq!(p.conversations, 1);
    }

    /// The record is what this is for; the reading is elsewhere.
    #[test]
    fn the_newest_thinking_survives_the_budget() {
        let long = "x".repeat(BUDGET);
        let packed = pack(&[
            talk(1, "Oldest", vec![("user", &long)]),
            talk(2, "Newest", vec![("user", "the recent thought")]),
        ]);
        assert!(packed.text.contains("the recent thought"));
        assert_eq!(packed.dropped, 1, "the older one is what gave way");
        assert_eq!(packed.conversations, 1);
    }

    #[test]
    fn a_long_reply_is_cut_and_counted() {
        let p = pack(&[talk(1, "Work", vec![("assistant", &"y".repeat(REPLY_LIMIT + 50))])]);
        assert_eq!(p.shortened, 1);
        assert!(p.text.contains("[…]"));
    }

    /// A single conversation over budget is still the whole context — dropping
    /// it would leave nothing at all to work from.
    #[test]
    fn one_enormous_conversation_is_kept_rather_than_leaving_nothing() {
        let p = pack(&[talk(1, "Only", vec![("user", &"z".repeat(BUDGET * 2))])]);
        assert_eq!(p.conversations, 1);
        assert_eq!(p.dropped, 0);
    }

    #[test]
    fn the_instruction_says_whose_thinking_it_is() {
        let p = pack(&[talk(1, "Work", vec![("user", "a thought")])]);
        let s = system_prompt("Root", &p);
        assert!(s.contains("Root"));
        assert!(s.contains("The thinking is theirs"));
        assert!(s.contains("a thought"));
    }
}
