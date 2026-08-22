//! Guards the product's central promise: the AI answers exactly as it would
//! without this app.
//!
//! If you are here because this test failed, the chat payload gained something
//! that is not the user's own words. That may be intentional — the backlogged
//! idea-lookup feature would require it — but it is a product decision that
//! retires a stated promise, not a refactor. Change the README and the pitch
//! before you change this test.

use idea_graph_lib::chat::Conversation;

const FORBIDDEN: &[&str] = &[
    "system",
    "tools",
    "tool_choice",
    "instructions",
    "context",
    "prompt",
    "persona",
    "extract",
    "idea",
];

#[test]
fn outgoing_payload_carries_nothing_but_the_conversation() {
    let mut c = Conversation::new("llama3.2");
    c.push_user("Trump is a bad man");
    c.push_assistant("Say more about what you mean by that?");
    c.push_user("well, he acts badly in certain circumstances");

    let json = serde_json::to_value(c.to_request()).unwrap();
    let obj = json.as_object().expect("request is an object");

    let mut keys: Vec<_> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["messages", "model"]);

    for key in obj.keys() {
        assert!(
            !FORBIDDEN.contains(&key.as_str()),
            "chat payload gained a `{key}` field"
        );
    }
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
fn a_fresh_conversation_sends_nothing() {
    // No hidden preamble on the first request — a primed conversation is a
    // steered one.
    let c = Conversation::new("m");
    let json = serde_json::to_value(c.to_request()).unwrap();
    assert!(json["messages"].as_array().unwrap().is_empty());
}
