# Still to do

Things asked for and not yet built, in the order they'd most likely be picked
up. Each entry says what it is, what it depends on, and where the real decision
sits — so the next pass doesn't have to reconstruct that.

Done work isn't tracked here; that's what the git history is for.

---

## 1. The embedded model runtime

Run [Bonsai 27B](https://huggingface.co/prism-ml/Bonsai-27B-gguf) inside the app
rather than requiring LM Studio or Ollama.

- **Model:** `prism-ml/Bonsai-27B-gguf`, file `Bonsai-27B-Q1_0.gguf`, 3.8 GB at
  1-bit, Apache 2.0, 262K context, derived from Qwen3.6-27B. A ternary build
  exists at higher fidelity, and a `DSpark` drafter (1.79 GB) enables
  speculative decoding.
- **Download on first run**, not bundled. The machinery already exists — the app
  downloads Parakeet (~488 MB) for dictation with a progress UI, so this is an
  extension of a pattern rather than a new one.
- **Already built:** the settings it needs (context length, GPU offload, KV
  cache placement, keep-loaded) persist and have UI.
- **Not built:** the inference engine. This is the real work.

**The decision that's still open:** which Rust binding. `llama-cpp-2` means
building llama.cpp from source with cmake and a C++ toolchain, and it brings the
GPU backend matrix (CUDA / ROCm / Metal / Vulkan) with it — the cost the
licensing report identified as the actual price of embedding. Starting CPU-only
sidesteps most of it and is enough to make the app work on first launch.

## 2. A better voice

Replies are currently read by the machine's own speech, which needs no download
and respects whatever voice and rate is already configured.

Add a neural option — Piper is the obvious candidate: MIT, small, CPU-only,
noticeably better. Same download-on-demand pattern as Parakeet and Bonsai. The
system voice stays the default and the fallback.

## 3. Continuing an archived conversation

There's currently no way to add to a conversation once Done is pressed. The
workaround — say it in a new conversation, and reconciliation links it — works,
because reconciliation compares against every idea in the database. But it's
friction when you press Done a sentence too early.

Appending is safe for provenance specifically because it only adds at the end:
existing evidence offsets point into the transcript by byte position and stay
valid. Would be a "Continue" action on a conversation's right-click menu that
reloads it as the live conversation.

## 4. The map's zoom-in animation

Expanding the map currently grows its grid column, which keeps the simulation
and position intact. What was asked for was a zoom *into* the map that then
renders over the chat.

The current behaviour is arguably better — nothing is rebuilt, and the map never
covers what you're typing. Worth looking at together before building the
alternative.

---

## From the original plan's own backlog

These predate the current round of work and are recorded in
`~/.claude/plans/before-we-begin-i-structured-pizza.md`.

### Contradiction edges

Reconciliation already produces and stores a `contradicts` verdict, so the data
is there. What's missing is drawing it: a red line and a marker between two
ideas that disagree, hover to see the conflict.

### Idea lookup during chat

Hand the model the titles of existing ideas so it can connect what's being said
now to what was said before. Two things to settle first: it modifies the chat,
which is a product decision rather than a refactor; and titles scale linearly,
so past a few hundred it becomes a retrieval problem — the same
embedding-shortlist machinery reconciliation already uses.
