# Changelog

## 0.4.0

### A trash bin, so a delete can be taken back

Deleting a conversation, an idea or an output used to destroy it outright —
which is how a click in the wrong list took real thinking with it. Every
delete now moves the whole record into a bin instead: the conversation with
its turns, its evidence and every idea it was the only supporter of, an idea
with its quotes and its links, an output with its text. The bin sits beside
the archive toggle in the Ideas tab; each entry can be put back exactly where
it was — under its own id where that is still free, re-pointed where new work
has taken it — and emptying the bin is the only delete that cannot be undone,
so it is the only one that asks twice.

### Deleting from the archive deleted the current conversations

The Ideas list only carries ideas kept alive by a conversation that is not
archived — archiving a conversation puts what came out of it out of view — so
a row that gave an idea whose conversation had not reached the list a home
still had to exist. But it ran in both views and knew nothing of the archive:
in the archive view it handed the whole current list a home, the archive
filled with conversations that were not archived, and deleting from the
archive deleted those. The fallback row belongs to the current view only, and
an idea whose first saying was archived now hangs under the conversation that
still keeps it rather than dragging the archived one back into view. The
archive view lists the archived conversations themselves, so what it shows is
what deleting from it deletes.

### The digest button works after stopping a digest

Pressing Stop asked the reading to end between conversations, and the drain
did stop — but the snapshot that told the screen a stop was pending was
cleared without anything saying so. The button read `stopping` off that last
snapshot and stayed disabled for the life of the app: every press after a
stopped digest did nothing, and the queue sat there unread, which is where
"the ideas never showed up" ended too — the conversations were never read at
all. The screen is told now, at the moment the flags actually clear, and the
button only holds itself disabled while a read is genuinely in flight.

### Ideas arrive as they are read

A digest of several conversations said nothing to the Ideas tab and the map
until the whole queue was done. Each conversation's ideas are announced the
moment they are folded in, so an hour-long digest fills in as it goes instead
of arriving all at once at the end.

### The app remembers which folder it was in

The folder being worked in lived only in memory, so every restart opened
Root — and because everything on screen is scoped to one folder, the ideas,
the map, the Make picker and the digest all looked like they had vanished
until the folder was picked again. The folder is remembered now, in the
settings file, and the app opens where it was left.

### A check that answers, in the model settings

A model list says what a server *has*; only an answer says a model works.
Every provider section — cloud and local — now has "Test it" beside the
current pick: one tiny request, through that provider, to that model, and the
result with the round trip in seconds beside it. An OpenRouter id that key
cannot route, a listed-but-not-loaded LM Studio model, a name the CLI does
not recognise — all of them now say so here instead of three screens later.

### The OpenRouter picker can be chosen by

OpenRouter's plain listing carries ids and nothing else, which made three
hundred models a wall to scroll. The tab now reads the catalogue, which has
the facts, and puts the choosing in front of the list: a provider dropdown
(anthropic, openai, google, and the rest), a sort (newest, cheapest, biggest
window, name), and filters for free-only, a price ceiling and a minimum
context. Each row shows what it costs per million tokens and how much it can
hold. The whole Cloud API section is drawn tighter to match — the key row and
the saved keys on one line, the rows at a list's height rather than a page's.

### The Make tab's chat has its own column, on the right

The thread and its composer sat at the bottom of the instructions' container.
They have a container of their own now, last in the row: instructions on the
left, the material beside them, and the asking at the right edge, scrolling
itself so a long answer never pushes the composer away.

### The Make tab's model can export files

One command, deliberately. The Make tab now tells the model it may end a
reply with `::export <format> <file name>` — format one of pdf, docx (Word /
LibreOffice Writer), pptx (slides) or md — and the app executes that line
itself, with the same exporters the Save button uses, into the app's `made`
folder. Nothing the model says is ever executed; the command is one line,
parsed off the end of a reply, and it runs only here. The files are named
under the answer that asked for them, and open with whatever the system opens
PDFs and decks with. The document chat on the outputs page has the same
command.

### Outputs look like their documents

The outputs page is a wall of titles and summaries, which is the one thing it
could not be: a list of what something says, when the question is "which one
was it?". It is a grid of miniatures now — a document as its opening page, a
deck as its first slides — with the name, the kind and the date under each,
the way a folder of pictures is laid out. The archive card in the Make thread
carries the same miniature.

### Settling a contradiction, tightened

The two claims stand next to each other, neither in the default's seat. Each
carries a pencil and a bin at its foot: the pencil rewords one of them, saved
as a revision; hover the bin and that claim crosses itself out while it is
still a hover, and the press that follows drops it. The clash is one message
now, with the answer written into a small box under it — or spoken into it,
by way of the mic at the box's edge.

### A doubt is a conversation now

The AI's note on an idea was a verdict with a button under it. Each doubt is
its own small chat instead: the note, the replies made under it, and a box
that is simply there — "answer this" greyed out in it, the way a typebox says
what it is for. The notes and their chats sit at the foot of the idea's page,
after the claim, the quotes, the reading and the tensions, rather than crowded
in among them. The "Answer this dispute" button on the map has gone with the
old shape.

### Settled contradictions can be unsettled

Settling a contradiction was a permanent act. It still is a decision — but
the decisions get revised, so a settled one is now listed on the idea's file,
quieter, with "Settle it again" underneath.

The settling window says why the two clash — asking the model, once, when
the link was drawn without a reason — and asks how both can stand, in a box
that is the default answer. What is written there is kept on the link and
shown on the idea's file under the settled pair. "Both stand" still closes
one without a word, for the pair that was never really in tension.

### An output looks like what it will be

A PDF or Word output opens as pages in a small viewer of its own, a deck as
its slides — the same slides the saved file will have — and markdown as its
text, readable or editable by hand. Beside it is a chat that changes it.
Select any passage and add it to the chat, as many as you like, and the
instruction goes with all of them attached.

### Also

- The galaxy stops turning while anything on it is pointed at. Holding only
  the one under the pointer still pulled it off its ring, and nodes came away
  snagged and bunched.
- "Use everything again" is gone from the Make tab; "Select all" does the same.
- Opening or closing the model picker no longer throws the conversation
  away. It restarted the conversation every time, even with the same model
  still chosen, while the screen went on showing it — so the next reply was
  filed on its own, with nothing of what was said to take an idea from. A
  real change of model files the conversation first, and a reply that lands
  after that is not added to a conversation that never asked for it.
- A model that will not answer with reasoning off says so plainly, with a
  button beside the error that switches reasoning on and sends the message
  again — in the chat and on the Make tab — instead of a trip to Settings.
- An idea node answers a click at any zoom. A door that opened only when its
  label happened to be drawn was a door that mostly did not open.
- The node being pointed at holds still: highlighted, it used to keep moving
  in the background while the highlight sat where it had been.
- A setting to lock the map's nodes, so an arrangement stays exactly as
  drawn. It is on the map's own arrangement panel, and in Settings.
- Right-click menus render through a portal and are placed from their own
  measured size, so one opened near an edge no longer lands cropped outside
  the app.
- An Obsidian vault can be read: pick a folder, and each markdown note
  becomes a conversation, its frontmatter left behind.
- An output opens as a spread now — the document on the left, the editing of
  it on the right.
- The forest's taproots are one clean tapering shape, not two wandering
  forks; they read as roots again.
- A reply shown in part ends at its own paragraph or sentence instead of
  cutting into the next one, and a quote's context stops at the blank line
  that ends the quote's paragraph rather than trailing the next paragraph's
  opening words.
- A `[[open:…]]` marker that arrived at the start of a later paragraph, not
  the start of the reply, is acted on and removed instead of typing itself
  out mid-answer.
- The advanced layout's Make panel reads in order again: what the model
  reads, then what it is made from, then the asking — the picker had been
  pinned underneath the composer at the bottom of the panel.
- "This is what will be sent" is gone from the Make instruction preview.

## 0.3.0

### The margin notes can be answered

An idea's notes were a verdict: the model said "no measurement is offered"
and there was nothing to do about it. Every doubt now carries a box with a
microphone beside it, and so does the question in your own voice underneath
them — "why would this be so" was the one thing on the page addressed to
the reader with nowhere to reply.

An answer is not filed as an idea. Every idea in this app owes its existence
to words it can quote from a transcript, and a paragraph typed into a box has
none, so it becomes a **moon** instead: a smaller node held by the claim it
defends, which is held by the conversation that produced it. Answering works
from the map as well as from the idea's own file — clicking a doubt on the
map opens the file with that box already waiting.

### Make can ask for a shape

An instruction on the Make tab now carries a format — Markdown, PDF, Word or
slides — chosen beside its wording in Settings and shown on the button that
sends it. The format reaches the model, not just the file writer: a deck and
an essay are not the same text in two wrappers, and asking for one and
wrapping the other gets you an essay cut into slides.

Pressing an instruction opens its wording first, editable, before anything is
sent. What a button asks for is the thing most worth arguing with, and the
only way to read it used to be opening Settings in another tab.

### Also

- An idea's file leads with the words it rests on, shown with the sentences
  either side of them, and says which conversation they were said in. Clicking
  a quote goes there and pulses it rather than opening a transcript at the top.
- Which notes an idea shows follows the stance the chat is set to: pushing back
  keeps the doubts, laying it out keeps the summary, and the default keeps both.
  "Just organize" is now "Lay it out".
- Opening an idea no longer spends a model call. "Read it back" generated a
  reading whenever none was cached, including on every open.
- A conversation's file scrolls in two columns, so pointing at an extracted
  idea moves the transcript without moving the list you are pointing at.
- The map's Fit button was underneath the arrangement chip, invisible and
  unclickable. It is an icon now, with zoom in and out beside it, down the
  right edge.
- A hovered node's title is set wide enough to read instead of being wrapped
  into four short lines and then cut off.
- Pulled back past the zoom where anything is legible, hovering stops raising
  cards about nodes you cannot see. Clicking still works.
- The `[[open:…]]` marker that lets a reply open a tab no longer appears on
  screen while an answer streams, and no longer reaches the stored transcript.
- Ticking a conversation on the Make tab now shows its ideas as ticked, which
  they always were. Deselecting everything says so instead of claiming the
  whole folder.
- Explanations in Settings sit in the heading they explain rather than under
  the group of controls below it.

## 0.2.0

The first release with a Linux download. There was never one before: the
prebuilt onnxruntime the speech model pulls in is compiled against glibc 2.38,
the release ran on Ubuntu 22.04 with glibc 2.35, and the build failed at the
linker every time — with an exit code that read like a failing test. Building
on 24.04 fixes it. Linux needs glibc 2.38 or newer (Ubuntu 24.04, Debian 13,
Fedora 39 and later); that floor was always set by onnxruntime rather than by
the choice of builder.

### A folder can become a book

There is a Conversations tab now, showing everything said in the folder you
are in and nothing from any other. From it, **Turn this into…** sets the whole
folder as a book: a contents page listing every idea under its subject, the
ideas themselves with the reasoning and the words they came from set as dated
quotations, and a conclusion. As a typeset PDF, or as Markdown.

The opening and the conclusion are written by the model from the ideas. They
are the only prose in the app that is not something you said or a reading of
something you said, and both say so on the page. Without a model loaded the
book still exports, without those two sections.

Noto Serif is bundled for it, so a Polish or Spanish book keeps its diacritics
on any machine.

### Also

- The language setting reaches the app's own tabs and buttons, not just the
  model — partly; screens not yet translated stay in English.
- Talking over the model in a call interrupts it: reading stops, the reply is
  discarded, and what you said joins the message that prompted it.
- Closing the window stops the local model before the window goes, and says so
  if it cannot, instead of leaving it holding memory.
- Ideas are titled with a statement of the idea rather than a label for its
  topic.
- A quote that verifies except for one substituted word keeps the idea, using
  the longest run that really was said, rather than discarding the thought.

## 0.1.0 — first public release

The app was called Idea Graph while it was being built. It is AIgraph now.
Data from an existing install is carried across on first run; the old copy is
left where it was rather than moved, so going back is possible.

### What it does

- Talk to a model, press Done, and the ideas in what you said become a map.
- Every idea carries a verbatim quote, located by exact search in your own
  words. An idea whose quote cannot be found is discarded rather than shown,
  and the drop rate is on screen.
- The same thought said twice becomes one idea, rewritten to the more nuanced
  wording, keeping both quotes and a one-click undo.
- Folders scope the map, the ideas, the conversations, and what the chat may
  recall.
- Runs a model itself — weights and engine downloaded on request — or uses LM
  Studio, Ollama, or a cloud API.
- Dictation into the composer, and a call mode that answers as you speak.
- Writes in the language you think in.

### Known limits

- **macOS is untested.** It should build; nobody has run it.
- **CUDA is not offered on Linux.** The GPU build is Vulkan, which works across
  AMD, Nvidia and Intel and is about twenty per cent slower than CUDA on an
  Nvidia card. llama.cpp publishes no prebuilt CUDA archive for Linux, so
  offering it would mean building from source. A CUDA `llama-server` already on
  your PATH is preferred over the bundled one.
- **Extraction is slow on a local model.** Reading a long conversation back is
  a few thousand tokens of generation; on a 12 GB card that is a couple of
  minutes. It runs in the background and you can keep working.
- **Quantised models write imperfect prose in some languages.** The 1-bit
  build used by default gets Polish grammar wrong here and there. A
  higher-fidelity model fixes it.
