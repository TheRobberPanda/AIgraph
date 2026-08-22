# Idea Graph

Think out loud. Get a map back.

You talk to a local AI. It answers **exactly as it normally would** — no injected
prompts, no persona, no steering. When you're done, the chat clears, the
transcript is archived, and your ideas appear as dots in a diagram you can
explore. Click a dot to jump to the moment you said it, highlighted in place.

The diagram is the product. The chat is just what gets it out of your head.

Free, open source, local-first.

## Status

Early. Milestone 9 of 11, plus Settings and Models.

Working: chat with a local model; sessions that archive to SQLite plus plain
markdown on Done, idle, or app close; automatic idea extraction with quote
verification, live progress, and a manual trigger; an Ideas view with each
idea's nudges and drop rate; and click-to-source — click a quote to see the
conversation it came from with those exact words highlighted in place; and voice
dictation.

Also working: reconciliation — the same idea expressed twice becomes one bubble,
rewritten to the more nuanced claim and carrying both quotes; and the **Map**, a
bipartite graph of conversations and the ideas that came out of them, where an
idea you returned to is shared between conversations and joins them together.

Also working: the deep-dive files — click a conversation to read it with the
words that produced ideas highlighted in place, hovering each to see *why* the
model read them that way; click an idea to see every quote supporting it, the
reasoning behind each, and how the claim has been rewritten (with one-click
restore). Hovering any node on the map dims the rest and animates out the AI's
strong and weak points.

There is a **Models** tab for choosing what you talk to and — separately — what
reads your sessions back afterwards, and a **Settings** tab for appearance,
session timeout, where transcripts are written, dictation, and re-reading every
conversation after a change to the prompts.

Not built yet: cloud providers (Anthropic API, `claude` CLI), and packaging.

## Design

Warm ink ground, cool machine accents — the inverse of the usual dark UI, because
this gets used alone and late, on things that matter. The palette carries the
product's ethic: **warm is you** (ivory text, gold for ideas you return to),
**cool is the machine** (dusty blue, sage and brick for its opinions).

Type carries the same split. **Your words are set in a reading serif**, because
they are the document and are preserved verbatim; everything the app and the
model say is set in a compact sans, because it is apparatus; numbers and
diagnostics are mono, because they are instrument readings. You can tell whose
voice you are looking at without reading a word.

## Dictation

Press **Speak** and talk. Phrases land in the composer on each pause; you edit
before sending. Deliberately: speech that sends itself would turn every
transcription error into a quote attributed to you that you never said — the one
failure mode the quote verifier cannot catch.

The speech model (~488MB) downloads on first use.

**Model: NVIDIA Parakeet TDT 0.6B v3** (CC-BY-4.0) via sherpa-onnx, chosen over
Whisper because it runs fast on **CPU** — the chat model already contends for the
GPU. Measured here at 28–48× real time, correctly transcribing English, Spanish
and German with no language setting. Silero VAD segments on silence.

### Choosing an extraction model

Use a **non-reasoning** model, or one whose reasoning can be disabled. Extraction
is a mechanical structured task, and a reasoning model will otherwise spend its
whole token budget thinking and return nothing — an empty answer after several
minutes. The app sends `reasoning_effort: "none"` (and Ollama's `think: false`)
to prevent this, and falls back gracefully on servers that reject it. On
gemma-4-12b-qat this was the difference between a ten-minute failure and a
52-second extraction.

## Requirements

- Linux (macOS, Windows, then mobile to follow)
- Rust 1.77+, Node 18+
- A local model server: **LM Studio** or **Ollama**. Either works; the app
  detects whichever is running.

Tauri system dependencies on Debian/Ubuntu/Mint:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config \
  libasound2-dev clang libclang-dev
```

The last three are for dictation: ALSA headers for microphone capture, and
libclang for the speech library's bindgen step. Neither failure message mentions
audio or speech, so leaving them out produces a confusing wall.

## Running

```bash
npm install
npm run tauri dev
```

## Local model setup

The app finds your server automatically. If both are running, it asks which to
use rather than guessing — the model shapes what ends up in your diagram, so
that choice is yours.

### Fitting a model on a small GPU

Two settings decide whether a model loads and whether extraction works. Both
caused real failures during development on a 12GB RTX 3060:

- **GPU offload.** Full offload (`--gpu max`) crashes partway through loading
  when the model plus its KV cache exceeds VRAM. The error — `Engine protocol
  runtime llama-server exited before becoming healthy` — does not mention
  memory. Lower the ratio until it loads.
- **Parallel slots.** LM Studio divides the context window across slots, so
  `--parallel 4` with a 4864-token context leaves only ~1200 tokens per request.
  Extraction over a real conversation exceeds that and fails with a bare
  `400 {"error":"terminated"}`, which also does not mention context. Use
  `--parallel 1` unless you need concurrency.

A configuration that works on 12GB:

```bash
lms load google/gemma-4-12b-qat --gpu 0.5 --context-length 8192 --parallel 1
```

## Transparency about AI

This project uses LLMs deliberately and says so plainly:

- **Your ideas are extracted by a model**, not by you. It can misread you. Every
  idea therefore links back to your exact words, so you can always check the map
  against the territory.
- **Ideas that cannot be traced are discarded.** The model must quote you
  verbatim; if we cannot find that quote in what you actually wrote, the idea is
  dropped rather than shown. The drop rate is displayed in the app rather than
  hidden, because it is the honest measure of how well this is working.
- **Nudges are the model's opinion**, not yours. They are visually marked as AI
  and never enter the graph as ideas.
- **The chat is not steered.** No system prompt, no retrieved context, no tools.
  This is enforced by a test (`src-tauri/tests/chat_purity.rs`), not by good
  intentions. If that ever changes, it will be a documented product decision.
- **Reasoning models' chain-of-thought is shown but never stored** and never
  extracted from.
- **This code was written with AI assistance.**

## Testing

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests that need a running model server are `#[ignore]` by default:

```bash
IDEA_GRAPH_MODEL=google/gemma-4-12b-qat \
  cargo test --manifest-path src-tauri/Cargo.toml --test lmstudio_live -- --ignored --nocapture
```

## License

AGPL-3.0-or-later.
