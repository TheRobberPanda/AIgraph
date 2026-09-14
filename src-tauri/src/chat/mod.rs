//! The live conversation.
//!
//! # The purity rule
//!
//! The chat carries no persona, no tool definitions, no retrieved context, and
//! no extraction instructions — nothing built from what the user said or from
//! what the app knows. The one exception is the system prompt: a fixed house
//! voice, identical for every conversation and every provider that shares its
//! stance. There are two of them — [`style::SYSTEM_PROMPT`], which argues, and
//! [`style::ORGANIZE_SYSTEM_PROMPT`], which doesn't — and which one is sent is
//! a setting the person chose, not something built from what they said. It is
//! a product decision, not a quiet addition — see `style.rs`.
//!
//! This is enforced two ways:
//!
//! 1. [`Conversation`] only ever grows by real user and assistant turns; the
//!    system prompt is carried separately and is always one of the two fixed
//!    constants.
//! 2. `tests/chat_purity.rs` asserts the serialized request body carries
//!    nothing but the user's own words and one of those two fixed strings.

pub mod style;

use crate::llm::types::{ChatRequest, Message, Role};

/// Remove `[[recall:N]]` markers from a reply.
///
/// The marker earns its keep for exactly as long as the reply is fresh on
/// screen and there's a UI on the other end to turn it into a highlight — a
/// stored turn, a future prompt, or a transcript file has no such UI, so it
/// gets a plain sentence instead of a bracketed number nobody there can use.
pub fn strip_recall_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    // Case-insensitively: models write `[[Recall:3]]` often enough. ASCII
    // lowering keeps every byte offset where it was.
    while let Some(start) = rest.to_ascii_lowercase().find("[[recall:") {
        out.push_str(&rest[..start]);
        match rest[start..].find("]]") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                // Unterminated — a truncated stream, most likely. Drop the
                // dangling fragment rather than show it.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The navigation markers a reply may open with, longest first so a prefix
/// test cannot match the short one and leave the rest of a longer marker
/// behind. Kept beside the stripper rather than beside the prompt: the prompt
/// asks for them, this is the only place that has to know their exact shape.
const OPEN_MARKERS: [&str; 3] = ["[[open:conversations]]", "[[open:ideas]]", "[[open:map]]"];

/// Remove a leading `[[open:…]]` marker from a reply.
///
/// The marker asks the app to open a tab. It means nothing to a future
/// request, to extraction, or to a transcript file — and a stored turn that
/// begins with it teaches the model that this is a normal way to answer, so
/// it starts arriving where nobody asked to see anything.
pub fn strip_open_marker(text: &str) -> String {
    let lead = text.trim_start();
    for marker in OPEN_MARKERS {
        if lead.len() >= marker.len() && lead[..marker.len()].eq_ignore_ascii_case(marker) {
            return lead[marker.len()..].trim_start().to_string();
        }
    }
    text.to_string()
}

/// Everything the app writes into a reply, taken back out again before the
/// reply is stored.
pub fn strip_markers(text: &str) -> String {
    strip_open_marker(&strip_recall_markers(text))
}

#[derive(Debug, Clone)]
pub struct Conversation {
    model: String,
    messages: Vec<Message>,
    /// Short answers, because they are being spoken rather than read.
    call_mode: bool,
    /// Recall, when the setting asks for it: the titles of the earlier ideas
    /// closest to the latest message, by id.
    ///
    /// `None` is recall off. `Some` adds the fixed [`style::RECALL`]
    /// instructions to the system prompt and attaches these titles to the
    /// latest message only. Never stored: the next request carries the next
    /// message's titles, and the transcript carries none. The id travels with
    /// the title so a reply can mark exactly which idea it drew on.
    recall: Option<Vec<(i64, String)>>,
    /// Extra ways of answering the person chose — see [`style::answer_style`].
    styles: Vec<crate::settings::AnswerStyle>,
    /// Whether the model may think out loud before answering.
    reasoning: bool,
    /// Argue the substance, or just help lay it out. See
    /// [`crate::settings::ChatStance`].
    stance: crate::settings::ChatStance,
}

impl Conversation {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            messages: Vec::new(),
            call_mode: false,
            recall: None,
            styles: Vec::new(),
            reasoning: false,
            stance: crate::settings::ChatStance::default(),
        }
    }

    pub fn push_user(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::User, content: content.into() });
    }

    pub fn push_assistant(&mut self, content: impl Into<String>) {
        self.messages.push(Message { role: Role::Assistant, content: content.into() });
    }

    /// Point the conversation at a different model without losing it.
    pub fn set_model(&mut self, model: impl Into<String>) {
        self.model = model.into();
    }

    /// Whether this conversation is still waiting on an answer to `text`.
    ///
    /// A reply takes seconds to minutes to arrive, and the conversation it was
    /// asked from can be replaced in that time. Adding it to whatever is live
    /// when it lands put an answer into a conversation that never asked the
    /// question — which was then filed as a session holding nothing but that
    /// answer, with no words of the person's in it to find an idea in.
    pub fn awaits_reply_to(&self, text: &str) -> bool {
        self.messages.last().map(|m| m.role == Role::User && m.content == text).unwrap_or(false)
    }

    pub fn set_call_mode(&mut self, on: bool) {
        self.call_mode = on;
    }

    pub fn set_stance(&mut self, stance: crate::settings::ChatStance) {
        self.stance = stance;
    }

    /// Turn recall on with the titles for the next message, or off with `None`.
    ///
    /// Chosen for every message, not once per conversation. Decided once from
    /// the opening line, the list was whatever sat closest to "hi" — and after
    /// a restart every conversation starts from an opening line — so the model
    /// was handed ideas unrelated to anything said after it.
    ///
    /// The titles go on the latest message rather than in the system prompt,
    /// which stays one constant from the first turn to the last. A server keeps
    /// the work it did on a prefix it has already seen, and a system prompt
    /// that changed every turn would throw that away from the first token.
    pub fn set_recall(&mut self, titles: Option<Vec<(i64, String)>>) {
        self.recall = titles;
    }

    /// How many titles go out with the next message.
    pub fn recall_len(&self) -> usize {
        self.recall.as_ref().map(Vec::len).unwrap_or(0)
    }

    pub fn set_answer_styles(&mut self, styles: Vec<crate::settings::AnswerStyle>) {
        self.styles = styles;
    }

    /// The conversation as sent: the stored turns, with this message's recall
    /// titles attached to the last one when there are any.
    fn outgoing_messages(&self) -> Vec<Message> {
        let mut messages = self.messages.clone();
        let titles = self.recall.as_deref().unwrap_or_default();
        if titles.is_empty() {
            return messages;
        }
        if let Some(last) = messages.last_mut().filter(|m| m.role == Role::User) {
            last.content.push_str(style::RECALL_ATTACHED);
            for (id, title) in titles {
                last.content.push_str(&format!("\n- [{id}] {title}"));
            }
        }
        messages
    }

    pub fn set_reasoning(&mut self, on: bool) {
        self.reasoning = on;
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Remove one turn, leaving everything else in place.
    ///
    /// Out-of-range is a no-op rather than a panic: by the time this runs the
    /// index came from a UI snapshot that may already be stale (a reply
    /// finished streaming, another turn was deleted), and losing nothing is
    /// the safe direction when that happens.
    pub fn remove(&mut self, index: usize) {
        if index < self.messages.len() {
            self.messages.remove(index);
        }
    }

    /// Take back the last thing said, when it never reached the model.
    ///
    /// Only ever removes a trailing user turn, so it cannot silently swallow
    /// an exchange that did happen.
    pub fn drop_last_user(&mut self) {
        if self.messages.last().map(|m| m.role == Role::User).unwrap_or(false) {
            self.messages.pop();
        }
    }

    /// Rewind to before a turn, dropping it and everything said after it.
    ///
    /// Chat is sequential — a later reply can only be understood in light of
    /// what came before it, so "go back" has to mean the conversation from
    /// that point on, not one arbitrary turn plucked out of the middle.
    pub fn rewind(&mut self, index: usize) {
        if index < self.messages.len() {
            self.messages.truncate(index);
        }
    }

    /// Build the outgoing request. The only additions are a `clone` and the
    /// one fixed house-style system prompt — see the module doc.
    pub fn to_request(&self) -> ChatRequest {
        ChatRequest {
            model: self.model.clone(),
            messages: self.outgoing_messages(),
            reasoning: self.reasoning,
            system: Some({
                // Neutral adds nothing: no voice, no instructions about how to
                // answer. What follows — the navigation marker, the language
                // line, call mode, recall — is plumbing the app needs whatever
                // stance is chosen, and is not a character.
                let mut sys = String::from(match self.stance {
                    crate::settings::ChatStance::Neutral => "",
                    crate::settings::ChatStance::Challenge => style::SYSTEM_PROMPT,
                    crate::settings::ChatStance::Organize => style::ORGANIZE_SYSTEM_PROMPT,
                });
                sys.push_str(style::NAVIGATION);
                sys.push_str(&crate::settings::language_instruction());
                if self.call_mode {
                    sys.push_str(style::CALL_MODE);
                }
                for s in &self.styles {
                    // Numbered steps are a list, and a call is spoken.
                    if self.call_mode && *s == crate::settings::AnswerStyle::Steps {
                        continue;
                    }
                    sys.push_str(style::answer_style(*s));
                }
                if self.recall.is_some() {
                    sys.push_str(style::RECALL);
                }
                sys
            }),
        }
    }

    /// Render the session for archiving and extraction.
    ///
    /// Delegates to [`crate::session::transcript::render`], which is the single
    /// place transcripts are formatted — text and turn offsets have to be
    /// produced together or they drift.
    pub fn render(&self) -> crate::session::transcript::Rendered {
        crate::session::transcript::render(&self.messages)
    }

    pub fn to_transcript(&self) -> String {
        self.render().text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_one_marker_and_leaves_the_sentence() {
        assert_eq!(
            strip_recall_markers("Debt cuts both ways.[[recall:12]] So does trust."),
            "Debt cuts both ways. So does trust."
        );
    }

    #[test]
    fn strips_several_markers_in_one_reply() {
        assert_eq!(
            strip_recall_markers("First point.[[recall:1]]\n\nSecond point.[[recall:2]]"),
            "First point.\n\nSecond point."
        );
    }

    #[test]
    fn a_reply_with_no_marker_is_untouched() {
        assert_eq!(strip_recall_markers("Nothing recalled here."), "Nothing recalled here.");
    }

    #[test]
    fn a_marker_cut_off_mid_stream_is_dropped_rather_than_shown_raw() {
        assert_eq!(strip_recall_markers("Debt cuts both ways.[[recall:1"), "Debt cuts both ways.");
    }

    #[test]
    fn the_open_marker_never_reaches_the_record() {
        assert_eq!(strip_open_marker("[[open:map]]\nOpening the map."), "Opening the map.");
        // The longest marker wins: matching "[[open:map]]" first would leave
        // "conversations]]" sitting at the front of the stored turn.
        assert_eq!(strip_open_marker("[[open:conversations]] Here they are."), "Here they are.");
        assert_eq!(strip_open_marker("[[OPEN:IDEAS]] Right."), "Right.");
    }

    #[test]
    fn a_reply_that_only_mentions_a_marker_later_keeps_its_words() {
        // Only the front of a reply is the app's plumbing. Anywhere else the
        // brackets are something that was said, and saying it is allowed.
        let said = "I would write [[open:map]] to do that.";
        assert_eq!(strip_open_marker(said), said);
    }

    #[test]
    fn both_kinds_of_marker_come_out_together() {
        assert_eq!(
            strip_markers("[[open:ideas]] Debt cuts both ways.[[recall:12]]"),
            "Debt cuts both ways."
        );
    }

    #[test]
    fn organize_stance_replaces_the_argumentative_prompt() {
        let mut c = Conversation::new("m");
        c.push_user("something");
        c.set_stance(crate::settings::ChatStance::Organize);
        let sys = c.to_request().system.unwrap();
        assert!(sys.starts_with(style::ORGANIZE_SYSTEM_PROMPT));
        assert!(!sys.starts_with(style::SYSTEM_PROMPT));
    }

    #[test]
    fn the_default_stance_adds_no_voice_of_its_own() {
        let c = Conversation::new("m");
        let sys = c.to_request().system.unwrap();
        // Neutral is the default now. The model answers as it would anywhere
        // else; a house voice is a preference, and this one was nobody's
        // choice until they made it.
        assert!(!sys.contains(style::SYSTEM_PROMPT));
        assert!(!sys.contains(style::ORGANIZE_SYSTEM_PROMPT));
        // The navigation marker still goes: it is how the app is asked to open
        // a tab, which is plumbing rather than character.
        assert!(sys.contains(style::NAVIGATION));
    }

    #[test]
    fn asking_to_be_challenged_gets_the_voice_that_challenges() {
        let mut c = Conversation::new("m");
        c.set_stance(crate::settings::ChatStance::Challenge);
        assert!(c.to_request().system.unwrap().starts_with(style::SYSTEM_PROMPT));
    }

    #[test]
    fn request_contains_only_the_conversation_and_the_fixed_house_voice() {
        let mut c = Conversation::new("llama3.2");
        c.push_user("I think latency is the real problem");
        c.push_assistant("What makes you say that?");

        let req = c.to_request();
        let json = serde_json::to_value(&req).unwrap();

        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        // `reasoning` is a switch the person set, carrying nothing of theirs
        // and saying nothing about the subject — it decides whether the model
        // deliberates before answering, not what it answers. Anything beyond
        // these four is a field steering the model per-request, which is what
        // the promise is about.
        assert_eq!(
            keys,
            vec!["messages", "model", "reasoning", "system"],
            "the chat payload grew a field beyond the conversation, the one \
             fixed system prompt, and the reasoning switch — if that field \
             steers the model per-request, the purity promise is broken"
        );
        assert_eq!(req.messages.len(), 2);
        // Composed from compile-time constants only — never from anything the
        // person said. That is the part worth guarding.
        let sys = req.system.as_deref().unwrap();
        assert!(sys.contains(style::NAVIGATION));
        assert!(!sys.contains("latency"), "the system prompt drew on the conversation");
    }

    #[test]
    fn recall_titles_ride_on_the_latest_message_and_are_never_stored() {
        let mut c = Conversation::new("m");
        c.push_user("first");
        c.push_assistant("reply");
        c.push_user("debt is a promise");
        c.set_recall(Some(vec![(7, "Debt binds the future".into())]));
        let req = c.to_request();
        assert!(req.messages[2].content.starts_with("debt is a promise"));
        assert!(req.messages[2].content.contains("[7] Debt binds the future"));
        assert_eq!(req.messages[0].content, "first", "earlier turns go out as they were");
        let sys = req.system.unwrap();
        assert!(sys.contains(style::RECALL));
        assert!(!sys.contains("Debt binds"), "the system prompt stays constant");
        assert_eq!(c.messages()[2].content, "debt is a promise", "nothing attached is stored");
    }

    #[test]
    fn answer_styles_add_their_fixed_lines() {
        let mut c = Conversation::new("m");
        c.set_answer_styles(vec![crate::settings::AnswerStyle::Brief]);
        assert!(c
            .to_request()
            .system
            .unwrap()
            .contains(style::answer_style(crate::settings::AnswerStyle::Brief)));
    }

    #[test]
    fn call_mode_only_adds_the_brevity_rule() {
        let mut plain = Conversation::new("m");
        plain.push_user("x");
        let mut brief = Conversation::new("m");
        brief.push_user("x");
        brief.set_call_mode(true);

        let a = plain.to_request().system.unwrap();
        let b = brief.to_request().system.unwrap();
        assert!(!a.contains(style::CALL_MODE));
        assert!(b.contains(style::CALL_MODE));
        assert!(b.starts_with(&a), "call mode should append, not rewrite the voice");
    }

    #[test]
    fn transcript_marks_speakers_for_the_extractor() {
        let mut c = Conversation::new("m");
        c.push_user("hello");
        c.push_assistant("hi");
        assert_eq!(c.to_transcript(), "USER: hello\n\nASSISTANT: hi");
    }

    #[test]
    fn removing_a_turn_leaves_the_rest_in_order() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.push_assistant("two");
        c.push_user("three");
        c.remove(1);
        let texts: Vec<_> = c.messages().iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, vec!["one", "three"]);
    }

    #[test]
    fn removing_out_of_range_does_nothing() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.remove(5);
        assert_eq!(c.messages().len(), 1);
    }

    #[test]
    fn rewinding_drops_a_turn_and_everything_after_it() {
        let mut c = Conversation::new("m");
        c.push_user("one");
        c.push_assistant("two");
        c.push_user("three");
        c.push_assistant("four");
        c.rewind(1);
        let texts: Vec<_> = c.messages().iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, vec!["one"], "everything from the rewind point on should be gone");
    }

    /// The session that filed no ideas: its reply landed in a conversation
    /// that had been replaced while the reply was being written.
    #[test]
    fn a_reply_only_belongs_to_the_conversation_that_asked_for_it() {
        let mut c = Conversation::new("m");
        c.push_user("is exit a discipline?");
        assert!(c.awaits_reply_to("is exit a discipline?"));
        assert!(!c.awaits_reply_to("something else"));

        let fresh = Conversation::new("m");
        assert!(!fresh.awaits_reply_to("is exit a discipline?"), "nothing was asked here");

        c.push_assistant("yes");
        assert!(!c.awaits_reply_to("is exit a discipline?"), "already answered");
    }
}
