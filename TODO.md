# Still to do

Things asked for and not yet built, in the order they'd most likely be picked
up. Each entry says what it is, what it depends on, and where the real decision
sits — so the next pass doesn't have to reconstruct that.

Done work isn't tracked here; that's what the git history is for.

---

## 1. `keep_in_memory` does nothing yet

The setting exists, persists, and has a control in the Models tab. What it
should do is decide whether `llama-server` stays up between sessions or is
stopped when one ends — a reload of several GB against holding the memory.

Right now the server is started and stopped by hand from the Models tab and the
setting is never read. Needs a hook where a session ends, and the honest
version also needs to know whether extraction is about to run: stopping the
server the instant Done is pressed would only make it start again.

## 2. Why two ideas relate

The map draws correlations in green and contradictions in red, and hovering one
names the two ideas and which it is. What it cannot say is **why** — the
`relations` table holds `idea_a`, `idea_b`, `kind` and `confidence`, and no
text.

Reconciliation is the only thing that ever knows the reason, and it is already
asking a model to adjudicate the pair. Capturing one sentence at that moment is
cheap; reconstructing it later means a second, worse-informed call. Same
argument as `evidence.reasoning`, which exists for exactly this reason.

Needs a column, a field on the verdict, and the hover card to show it.

## 3. Continuing an archived conversation

There's no way to add to a conversation once Done is pressed. The workaround —
say it in a new conversation, and let reconciliation link the two — works,
because reconciliation compares against every idea in the database. But it's
friction when you press Done a sentence too early.

Appending is safe for provenance specifically because it only adds at the end:
existing evidence offsets point into the transcript by byte position and stay
valid. Would be a "Continue" action on a conversation's right-click menu that
reloads it as the live conversation.

## 4. A better voice

Replies are read by the machine's own speech, which needs no download and
respects whatever voice and rate is already configured.

Add a neural option — Piper is the obvious candidate: MIT, small, CPU-only,
noticeably better. Same download-on-demand pattern as Parakeet and the model
weights. The system voice stays the default and the fallback.

## 5. Bundling `llama-server`

The embedded runtime works: the app downloads GGUF weights from Hugging Face,
starts `llama-server` as a child process, and drives it through the existing
OpenAI-compatible provider. What it does **not** do is supply the server —
`Embedded::server_binary` looks in the app's own directory and then on PATH,
and if neither has one it says so.

So "nothing to install" is true of the weights and not yet true of the engine.
Finishing it means fetching a `llama-server` build per platform on first run,
which drags in the GPU backend matrix (CUDA / ROCm / Vulkan / Metal) that the
licensing report identified as the real cost of embedding a model at all. A
CPU-only build is one file and sidesteps most of it.

## 6. The map's zoom-in animation

Expanding the map grows its grid column, which keeps the simulation and
positions intact. What was asked for was a zoom *into* the map that then renders
over the chat.

The current behaviour is arguably better — nothing is rebuilt, and the map never
covers what you're typing. Worth looking at together before building the
alternative.

## 7. Idea lookup during chat

From the original plan's backlog. Hand the model the titles of existing ideas so
it can connect what's being said now to what was said before — not "these are
the same" but a reasoned *if this is true, then it follows that…* bridge.

Two things to settle first. It modifies the chat, which is a product decision
rather than a refactor — though the house-voice system prompt already retired
the zero-injection rule, so the objection is weaker than it was. And titles
scale linearly: past a few hundred it becomes a retrieval problem, the same
embedding-shortlist machinery reconciliation already uses.

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
