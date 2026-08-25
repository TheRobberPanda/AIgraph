# Changelog

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
