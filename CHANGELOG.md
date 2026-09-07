# Changelog

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
