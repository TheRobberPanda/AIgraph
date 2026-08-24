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

## 2. CUDA on Linux, for the last twenty per cent

Measured on an RTX 3060, Bonsai 27B Q1_0, 2351-token prompt:

| build | prompt | generation |
|---|---|---|
| CPU | 12 tok/s | 8.8 tok/s |
| Vulkan | 268 tok/s | 22.1 tok/s |
| LM Studio (CUDA) | — | ~28 tok/s |

Vulkan gets most of the way there and is one archive for AMD, Nvidia and Intel.
The remaining gap is CUDA, and llama.cpp **publishes no prebuilt CUDA tarball
for Linux** — Windows gets `win-cuda-x64`, Linux gets CPU, Vulkan, ROCm, SYCL
and OpenVINO. So CUDA on Linux means building from source, with the toolchain
that implies.

Worth doing only if the gap starts mattering. Two cheaper things first: offer
the Windows CUDA build on Windows, where it costs nothing but a filename, and
say in the app that Vulkan is the general answer and CUDA is faster on Nvidia
if you have your own build on PATH.

## 3. Recall past a few hundred ideas

The chat is handed up to 200 idea titles from the current folder. Past that it
stops being a prompt and starts being a retrieval problem — an embedding
shortlist over titles, which is the same machinery reconciliation already uses.

Not urgent: 200 titles is a long time at one person's pace, and the cap fails
safely by dropping the oldest.

---

# To try

Not "build this" — "find out what this looks like". Worth a throwaway branch and
a real folder of thinking before any of it becomes a feature.

## T1. Deductive mode: one node everything hangs from

Right now the map is flat: every idea is a peer, and structure comes from
conversations and shared subjects. This is the opposite arrangement — a folder
gets a **root claim**, and every other idea is somewhere on a chain beneath it.

The shape being tested:

1. Each recorded idea generates its own *why* — not "what does this mean" but
   "why would this be true".
2. The model answers that why in one claim.
3. That answer gets asked why in turn, and so on, and chains that arrive at the
   same answer merge.
4. Whatever the chains converge on is the root: the most general thing that,
   if true, would account for the rest.

The bet is that the root gets sharper the more you put in — that it starts as a
platitude and, after fifty conversations, is a sentence that actually says what
you think. That is the whole thing worth finding out, and it cannot be reasoned
about in advance: it either happens or the root stays a fortune cookie.

What to build for the test, and no more:

- A one-off command that walks a folder's ideas and produces the chains. Not
  wired into extraction — it can take minutes and cost a hundred calls.
- A second map layout that draws the tree: root at the centre, chains radiating
  out, ideas as leaves.
- Nothing written to `ideas` or `relations`. A separate table, or a JSON file,
  so a bad run is deleted rather than migrated away from.

Known problems to watch for rather than solve up front:

- **The model will happily invent a root.** A convergence that comes from the
  model's own priors rather than from what was said is the failure mode, and it
  will look exactly like success. The check is whether the intermediate claims
  can still be traced to something in a transcript — the same provenance rule
  the rest of the app runs on, applied one level up.
- **Why-chains do not terminate on their own.** They bottom out in "because
  people are like that" unless something stops them. A depth cap is the crude
  answer; a better one might be stopping when the answer stops being about
  anything the person actually said.
- **One root per folder may be wrong.** Two or three attractors would be a more
  honest result than one, and forcing a single root would hide that. Let the
  chains converge where they converge and draw however many roots come out.

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
