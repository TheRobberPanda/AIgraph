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

## 5. Two loose ends from the folders work — done

**Per-folder re-reading.** Settings now offers "Re-read {folder}" alongside
"Re-read every folder", and passes the folder through to `reextract_all`.

**Folder colours.** The colour and mark now reach the banner above the composer,
the folder chip, and — when nothing is scoped — the conversation rows, so a
folder is recognisable from outside its own dialog.

## 6. `keep_in_memory` does nothing yet

The setting exists, persists, and has a control. What it should do is decide
whether `llama-server` stays up between sessions or is stopped when one ends —
a reload of 3.8 GB against holding the memory.

Right now the server is started and stopped by hand from the Models tab and the
setting is never consulted. Needs a hook where a session ends.

## 7. Why two ideas relate

The map draws correlations in green and contradictions in red, and hovering one
names the two ideas and which it is. What it cannot say is **why** — the
`relations` table holds `idea_a`, `idea_b`, `kind` and `confidence`, and no text.

Reconciliation is the only thing that ever knows the reason, and it is already
asking a model to adjudicate the pair. Capturing one sentence at that moment is
cheap; reconstructing it later means a second, worse-informed call. Same
argument as `evidence.reasoning`, which exists for exactly this reason.

Needs a column, a field on the verdict, and the hover card to show it.

---

## Decided against, so they stop coming back

- **Ideas moving between folders on their own.** A folder holds conversations;
  ideas follow the conversation they came from. An idea can be supported by
  several conversations, so "which folder is it in" has no single answer.
- **Ideas appearing live during a conversation.** Extraction runs once over the
  whole session, which is what lets it see the arc of a thought rather than a
  turn at a time, and costs one call per session instead of one per message.
  Live would mean per-turn extraction: a different pipeline and a different
  cost model, for a worse reading of the material.
- **Intercepting "show me the map" before it is sent.** Swallowing the message
  would mean the thought was never recorded. The model emits a marker instead,
  so the app responds *and* the turn is kept.

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
