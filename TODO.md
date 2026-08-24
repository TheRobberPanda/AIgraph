# Still to do

Things asked for and not yet built. Each entry says what it is, what it depends
on, and where the real decision sits — so the next pass doesn't have to
reconstruct that.

Done work isn't tracked here; that's what the git history is for.

---

## 1. The map's zoom-in animation

Expanding the map grows its grid column, which keeps the simulation and
positions intact. What was asked for was a zoom *into* the map that then renders
over the chat.

This is a fork rather than a task. The current behaviour is arguably better —
nothing is rebuilt, and the map never covers what you're typing. Worth deciding
together before building the alternative.

## 2. GPU builds of llama-server

Settings installs the CPU build. The GPU ones are per-vendor — CUDA, ROCm,
Vulkan, Metal — and picking between them from inside the app means owning the
whole matrix, which the licensing report identified as the real cost of
embedding a model at all.

For now a `llama-server` on PATH is preferred over the one we fetch, so anyone
who has built their own gets their GPU build without a setting. Detecting the
vendor and fetching the matching archive is the version of this worth building,
if it is built at all.

## 3. Recall past a few hundred ideas

The chat is handed up to 200 idea titles from the current folder. Past that it
stops being a prompt and starts being a retrieval problem — an embedding
shortlist over titles, which is the same machinery reconciliation already uses.

Not urgent: 200 titles is a long time at one person's pace, and the cap fails
safely by dropping the oldest.

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
- **Dragging conversations between folders.** The only drop target lived inside
  a modal, and right-click already moves them.
- **Editing a past turn.** Continuing a conversation only appends, which is
  what makes it safe: every byte offset already recorded points into the part
  that has not moved. Editing earlier would silently invalidate quotes.
