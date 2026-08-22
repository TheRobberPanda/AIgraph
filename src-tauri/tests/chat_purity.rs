//! Guards what's left of the product's promise after the chat gained a house
//! voice: the AI still carries nothing built from the user's own words or from
//! extraction — only one fixed, unconditional system prompt, identical for
//! every conversation and every provider.
//!
//! If you are here because this test failed, the chat payload gained something
//! beyond the user's words and that one constant string. That may be
//! intentional, but it is a product decision, not a refactor — change the
//! README and the pitch before you change this test.

use idea_graph_lib::chat::style::SYSTEM_PROMPT;
use idea_graph_lib::chat::Conversation;

const FORBIDDEN: &[&str] = &[
    "tools",
    "tool_choice",
    "instructions",
    "context",
    "persona",
    "extract",
    "idea",
];

#[test]
fn outgoing_payload_carries_only_the_conversation_and_the_fixed_house_voice() {
    let mut c = Conversation::new("llama3.2");
    c.push_user("Trump is a bad man");
    c.push_assistant("Say more about what you mean by that?");
    c.push_user("well, he acts badly in certain circumstances");

    let json = serde_json::to_value(c.to_request()).unwrap();
    let obj = json.as_object().expect("request is an object");

    let mut keys: Vec<_> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["messages", "model", "system"]);

    assert_eq!(
        json["system"], SYSTEM_PROMPT,
        "the system prompt must be the one fixed house voice, not anything built per-request"
    );

    for key in obj.keys() {
        assert!(
            !FORBIDDEN.contains(&key.as_str()),
            "chat payload gained a `{key}` field"
        );
    }
}

#[test]
fn the_house_voice_is_the_same_regardless_of_what_was_said() {
    let mut a = Conversation::new("m");
    a.push_user("one thing");
    let mut b = Conversation::new("m");
    b.push_user("a completely different thing");

    assert_eq!(
        serde_json::to_value(a.to_request()).unwrap()["system"],
        serde_json::to_value(b.to_request()).unwrap()["system"],
        "the system prompt must never vary with the conversation's content"
    );
}

#[test]
fn no_message_is_authored_by_the_app() {
    let mut c = Conversation::new("m");
    c.push_user("only this");

    let json = serde_json::to_value(c.to_request()).unwrap();
    let messages = json["messages"].as_array().unwrap();

    assert_eq!(messages.len(), 1, "the app added a turn of its own");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "only this");
}

#[test]
fn a_fresh_conversation_sends_no_turns() {
    // No hidden preamble of *turns* on the first request — a primed
    // conversation is a steered one. The system prompt is not a turn.
    let c = Conversation::new("m");
    let json = serde_json::to_value(c.to_request()).unwrap();
    assert!(json["messages"].as_array().unwrap().is_empty());
}
