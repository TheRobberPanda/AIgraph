# Contributing

## Getting set up

See the README for system dependencies. Then:

```bash
npm install
npm run tauri dev
```

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests that need a running model or a microphone are `#[ignore]` by default and
listed in the README.

## Things worth knowing before you change them

A few rules in this codebase are load-bearing rather than stylistic. Each is
guarded by a test, and each is written down because breaking it silently would
be worse than breaking it loudly.

- **The chat is never steered.** No system prompt, no retrieved context, no tool
  definitions. `ChatRequest` has nowhere to put one, and `tests/chat_purity.rs`
  asserts it. If a feature needs to inject context, that is a product decision
  that retires a stated promise — not a refactor.
- **Model-supplied offsets are never trusted.** The model returns a quote; Rust
  finds it by string search. An idea whose quote cannot be located is dropped,
  and the drop rate is shown in the app.
- **Over-merging is worse than under-merging.** A wrongly merged idea quietly
  misrepresents what someone thinks; a duplicate is merely untidy and visible.
  Reconciliation thresholds lean conservative, and a failed adjudication always
  leaves ideas separate.
- **Byte offsets never cross into JavaScript.** Rust counts UTF-8 bytes and JS
  indexes UTF-16 code units; text is sliced on the Rust side and whole strings
  are passed across.
