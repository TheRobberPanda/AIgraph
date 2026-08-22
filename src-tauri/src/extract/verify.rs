//! Locating a model's quote in the real transcript.
//!
//! The rule the whole product rests on: **model-supplied offsets are never
//! trusted**. Models are unreliable at reporting character positions, so
//! [`RawIdea`] has no offset fields at all. Instead the model returns text it
//! claims is verbatim, and we find it ourselves.
//!
//! An idea whose quote cannot be located is dropped, not guessed at. A dot that
//! points at the wrong sentence is worse than a missing dot: it looks correct.

use crate::llm::types::{RawIdea, Role};

/// A turn as stored, with its position in the session transcript.
#[derive(Debug, Clone)]
pub struct Turn {
    pub id: i64,
    pub role: Role,
    pub text: String,
}

/// A quote successfully located in a specific user turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub turn_id: i64,
    /// Byte range within that turn's `text`. Always on UTF-8 char boundaries.
    pub start_byte: usize,
    pub end_byte: usize,
    /// The span as it actually reads in the transcript, which may differ from
    /// what the model returned (whitespace, curly quotes, casing).
    pub matched_text: String,
    /// The quote appears more than once, or in more than one turn. We took the
    /// first occurrence. Rare in practice; surfaced rather than hidden.
    pub ambiguous: bool,
    /// True when an exact match failed and the normalized fallback succeeded.
    /// Still a real span in real text — just a looser way of finding it.
    pub normalized_match: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The quote is not in the transcript in any recognizable form. Usually
    /// means the model paraphrased instead of quoting, or invented it.
    NotFound,
    /// Found, but only in something the assistant said. The graph maps the
    /// user's thinking, so this is a hard reject — and a useful distinct signal,
    /// because a spike in these means the extraction prompt is drifting.
    AttributedToAssistant,
    /// Model returned an empty or whitespace-only quote.
    EmptyQuote,
}

pub type VerifyResult = Result<Located, Rejection>;

/// Verify one idea against the session's turns.
pub fn verify(idea: &RawIdea, turns: &[Turn]) -> VerifyResult {
    let needle = idea.quote.trim();
    if needle.is_empty() {
        return Err(Rejection::EmptyQuote);
    }

    let mut hits: Vec<Located> = Vec::new();

    for turn in turns.iter().filter(|t| t.role == Role::User) {
        if let Some((s, e)) = turn.text.find(needle).map(|s| (s, s + needle.len())) {
            let more = turn.text[e..].contains(needle);
            hits.push(Located {
                turn_id: turn.id,
                start_byte: s,
                end_byte: e,
                matched_text: turn.text[s..e].to_string(),
                ambiguous: more,
                normalized_match: false,
            });
        }
    }

    // Exact matches win outright.
    if let Some(first) = hits.first() {
        let mut out = first.clone();
        out.ambiguous |= hits.len() > 1;
        return Ok(out);
    }

    // Fallback: match through a normalized view, then map the result back to
    // real byte offsets. This still yields a genuine span in genuine text — it
    // only widens how we *find* it, absorbing the cosmetic rewrites models make
    // (collapsed whitespace, smart quotes, changed casing). Without this the
    // drop rate on small local models is punishing for no gain in truth.
    for turn in turns.iter().filter(|t| t.role == Role::User) {
        if let Some(loc) = normalized_find(&turn.text, needle, turn.id) {
            hits.push(loc);
        }
    }

    if let Some(first) = hits.first() {
        let mut out = first.clone();
        out.ambiguous |= hits.len() > 1;
        return Ok(out);
    }

    // Not in any user turn. Distinguish "the model quoted the assistant" from
    // "the model made it up" — they call for different fixes.
    for turn in turns.iter().filter(|t| t.role == Role::Assistant) {
        if turn.text.contains(needle) || normalized_find(&turn.text, needle, turn.id).is_some() {
            return Err(Rejection::AttributedToAssistant);
        }
    }

    Err(Rejection::NotFound)
}

/// A normalized copy of `s`, plus byte-level maps back to the original.
struct Normalized {
    text: String,
    /// For each byte of `text`, the start byte of the original char it came from.
    starts: Vec<usize>,
    /// For each byte of `text`, the end byte of the original char it came from.
    ends: Vec<usize>,
}

/// Collapse whitespace runs, fold unicode punctuation to ASCII, lowercase.
///
/// Every emitted byte records where it came from, so a match in normalized space
/// maps back to an exact, char-boundary-safe range in the original.
fn normalize(s: &str) -> Normalized {
    let mut text = String::with_capacity(s.len());
    let mut starts = Vec::with_capacity(s.len());
    let mut ends = Vec::with_capacity(s.len());

    let mut in_ws_run = false;
    let mut run_start = 0usize;

    for (i, ch) in s.char_indices() {
        let ch_end = i + ch.len_utf8();

        if ch.is_whitespace() {
            if !in_ws_run {
                in_ws_run = true;
                run_start = i;
            }
            continue;
        }

        if in_ws_run {
            // The whole run becomes one space spanning the original run.
            text.push(' ');
            starts.push(run_start);
            ends.push(i);
            in_ws_run = false;
        }

        let folded = fold_char(ch);
        for out_ch in folded.chars() {
            let mut buf = [0u8; 4];
            let encoded = out_ch.encode_utf8(&mut buf);
            for _ in 0..encoded.len() {
                starts.push(i);
                ends.push(ch_end);
            }
            text.push_str(encoded);
        }
    }

    Normalized { text, starts, ends }
}

/// Fold the cosmetic substitutions models routinely make.
fn fold_char(ch: char) -> String {
    let base = match ch {
        '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201F}' | '\u{2033}' => '"',
        '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        '\u{2026}' => return "...".to_string(),
        '\u{00A0}' | '\u{202F}' | '\u{2009}' => ' ',
        other => other,
    };
    base.to_lowercase().to_string()
}

fn normalized_find(haystack: &str, needle: &str, turn_id: i64) -> Option<Located> {
    let hay = normalize(haystack);
    let ned = normalize(needle);
    let ned_trimmed = ned.text.trim();
    if ned_trimmed.is_empty() {
        return None;
    }

    let at = hay.text.find(ned_trimmed)?;
    let end_norm = at + ned_trimmed.len();
    let more = hay.text[end_norm..].contains(ned_trimmed);

    let start_byte = *hay.starts.get(at)?;
    let end_byte = *hay.ends.get(end_norm.saturating_sub(1))?;

    // Paranoia: the maps should always land on char boundaries, but a bad span
    // here would panic on slicing, so refuse rather than risk it.
    if start_byte >= end_byte
        || !haystack.is_char_boundary(start_byte)
        || !haystack.is_char_boundary(end_byte)
    {
        return None;
    }

    Some(Located {
        turn_id,
        start_byte,
        end_byte,
        matched_text: haystack[start_byte..end_byte].to_string(),
        ambiguous: more,
        normalized_match: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idea(quote: &str) -> RawIdea {
        RawIdea {
            claim: "c".into(),
            quote: quote.into(),
            reasoning: String::new(),
            category: String::new(),
            notes: vec![],
        }
    }

    fn user(id: i64, text: &str) -> Turn {
        Turn { id, role: Role::User, text: text.into() }
    }

    fn asst(id: i64, text: &str) -> Turn {
        Turn { id, role: Role::Assistant, text: text.into() }
    }

    #[test]
    fn exact_match_returns_real_span() {
        let turns = vec![user(1, "I think rust is good for this.")];
        let got = verify(&idea("rust is good"), &turns).unwrap();
        assert_eq!(got.turn_id, 1);
        assert_eq!(&turns[0].text[got.start_byte..got.end_byte], "rust is good");
        assert!(!got.normalized_match);
        assert!(!got.ambiguous);
    }

    #[test]
    fn invented_quote_is_dropped_not_guessed() {
        let turns = vec![user(1, "I think rust is good.")];
        assert_eq!(verify(&idea("go is better"), &turns), Err(Rejection::NotFound));
    }

    #[test]
    fn quoting_the_assistant_is_its_own_rejection() {
        let turns = vec![
            user(1, "what should I use?"),
            asst(2, "You should consider Tauri for this."),
        ];
        assert_eq!(
            verify(&idea("consider Tauri"), &turns),
            Err(Rejection::AttributedToAssistant)
        );
    }

    #[test]
    fn empty_quote_rejected() {
        let turns = vec![user(1, "anything")];
        assert_eq!(verify(&idea("   "), &turns), Err(Rejection::EmptyQuote));
    }

    #[test]
    fn collapsed_whitespace_still_maps_to_true_span() {
        let turns = vec![user(1, "I think\n\n  rust   is good.")];
        let got = verify(&idea("rust is good"), &turns).unwrap();
        assert!(got.normalized_match);
        assert_eq!(&turns[0].text[got.start_byte..got.end_byte], "rust   is good");
    }

    #[test]
    fn smart_quotes_and_case_are_folded() {
        let turns = vec![user(1, "He said \u{201C}Trump is a Bad Man\u{201D} loudly.")];
        let got = verify(&idea("\"trump is a bad man\""), &turns).unwrap();
        assert!(got.normalized_match);
        assert_eq!(
            &turns[0].text[got.start_byte..got.end_byte],
            "\u{201C}Trump is a Bad Man\u{201D}"
        );
    }

    #[test]
    fn offsets_survive_emoji_and_accents() {
        // The classic silent-corruption case: multibyte text before the match.
        let text = "caf\u{e9} \u{1F600} \u{1F680} my real point is latency";
        let turns = vec![user(1, text)];
        let got = verify(&idea("my real point is latency"), &turns).unwrap();
        assert_eq!(&text[got.start_byte..got.end_byte], "my real point is latency");
        assert!(text.is_char_boundary(got.start_byte));
        assert!(text.is_char_boundary(got.end_byte));
    }

    #[test]
    fn repeated_quote_is_flagged_ambiguous() {
        let turns = vec![user(1, "cost matters. also cost matters.")];
        let got = verify(&idea("cost matters"), &turns).unwrap();
        assert!(got.ambiguous);
        assert_eq!(got.start_byte, 0);
    }

    #[test]
    fn same_quote_in_two_turns_is_ambiguous_first_wins() {
        let turns = vec![user(1, "latency is key"), user(2, "latency is key")];
        let got = verify(&idea("latency is key"), &turns).unwrap();
        assert_eq!(got.turn_id, 1);
        assert!(got.ambiguous);
    }

    #[test]
    fn exact_match_preferred_over_normalized_elsewhere() {
        // Turn 2 holds the exact text; turn 1 only matches loosely. Exact wins,
        // even though turn 1 comes first.
        let turns = vec![user(1, "Rust   Is Good"), user(2, "rust is good")];
        let got = verify(&idea("rust is good"), &turns).unwrap();
        assert_eq!(got.turn_id, 2);
        assert!(!got.normalized_match);
    }
}
