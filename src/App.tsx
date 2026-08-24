import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  IconThink,
  IconMap,
  IconIdeas,
  IconModels,
  IconSettings,
  IconSend,
  IconMinimize,
  IconMaximize,
  IconClose,
  IconCall,
  IconSpeaker,
  IconClock,
} from "./components/Icons";
import { ConversationFile, IdeaFile } from "./components/Deep";
import Confirm from "./components/Confirm";
import Sheet from "./components/Sheet";
import Select from "./components/Select";
import Call from "./components/Call";
import Queue from "./components/Queue";
import FolderMark from "./components/FolderMark";
import ContextMenu from "./components/ContextMenu";
import Tooltip from "./components/Tooltip";
import FolderPicker from "./components/FolderPicker";
import Graph from "./components/Graph";
import Ideas from "./components/Ideas";
import Models from "./components/Models";
import SettingsPanel from "./components/Settings";
import { applyTheme, applyUiScale, getSettings, saveSettings } from "./lib/settings";
import Markdown from "./components/Markdown";
import { thinkingMessage } from "./lib/waiting";
import {
  extractionProgress,
  extractNow,
  onExtractionProgress,
  type ExtractionProgress,
} from "./lib/ideas";
import Mic from "./components/Mic";
import {
  currentFolder,
  folderColor,
  listFolders,
  setCurrentFolder,
  ROOT_FOLDER,
} from "./lib/folders";
import { parseReply, speak, stopSpeaking } from "./lib/voice";
import { modelName } from "./lib/format";
import { sessionTurns } from "./lib/sessions";
import { startDictation, stopDictation } from "./lib/dictation";
import {
  continueSession,
  deleteTurn,
  endSession,
  onArchived,
  rewindConversation,
  selectProvider,
  sendMessage,
  startup,
  type Archived,
  type Detected,
  type ModelInfo,
  type Selected,
  type Turn,
} from "./lib/chat";

/**
 * Where you can be.
 *
 * There is no separate Conversations tab. A conversation and the ideas taken
 * from it are the same thing seen from two ends, and keeping them apart meant
 * the same list twice — once with the ideas hidden and once with the
 * conversations reduced to headings.
 */
type Tab = "chat" | "map" | "ideas" | "models" | "settings";
const TABS: Tab[] = ["chat", "map", "ideas", "models", "settings"];

/** What each place is called. One map, so the rail and the URL agree. */
const TAB_NAMES: Record<Tab, string> = {
  chat: "Think",
  map: "Map",
  ideas: "Ideas",
  models: "Models",
  settings: "Settings",
};

/** One icon per tab, so a place can be told apart at a glance rather than by
 *  reading its label — the label stays too, since an icon alone is ambiguous
 *  until it's memorised. */
const TAB_ICONS: Record<Tab, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  chat: IconThink,
  map: IconMap,
  ideas: IconIdeas,
  models: IconModels,
  settings: IconSettings,
};

const MAIN: Tab[] = ["chat", "map", "ideas"];
const SETUP: Tab[] = ["models", "settings"];

type Deep = { kind: "idea"; id: number } | { kind: "conversation"; id: number } | null;

/**
 * Where you are lives in the URL hash — a tab, or an open file.
 *
 * Reloading, or closing and reopening, puts you back where you were rather than
 * always on Think. It also means a specific idea has an address you can come
 * back to, which matters once there are more of them than you can scan.
 */
function tabFromHash(): Tab {
  const raw = window.location.hash.replace(/^#\/?/, "").split("/")[0];
  if (raw === "idea") return "ideas";
  if (raw === "conversation") return "ideas";
  return (TABS as string[]).includes(raw) ? (raw as Tab) : "chat";
}

function deepFromHash(): Deep {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts.length !== 2) return null;
  const id = Number(parts[1]);
  if (!Number.isFinite(id)) return null;
  if (parts[0] === "idea") return { kind: "idea", id };
  if (parts[0] === "conversation") return { kind: "conversation", id };
  return null;
}

/** Minimise, maximise, close. The window has no frame of its own. */
function WindowControls() {
  return (
    <div className="window-controls">
      <button className="window-btn" data-tip="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <IconMinimize />
      </button>
      <button
        className="window-btn"
        data-tip="Maximize"
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <IconMaximize />
      </button>
      <button
        className="window-btn close"
        data-tip="Close"
        onClick={() => void getCurrentWindow().close()}
      >
        <IconClose />
      </button>
    </div>
  );
}

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  // Reasoning models can think for a long time before emitting a single word of
  // reply. Counting the scratchpad gives the UI something honest to show, so a
  // slow model reads as working rather than frozen.
  const [thoughtChars, setThoughtChars] = useState(0);
  const [provider, setProvider] = useState<Selected | null>(null);
  const [servers, setServers] = useState<Detected[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justArchived, setJustArchived] = useState<Archived | null>(null);
  const [view, setView] = useState<Tab>(tabFromHash());
  const [ending, setEnding] = useState(false);
  // Which file is open, if any. Deep dives sit above whatever tab you were on,
  // so going back returns you where you were rather than to a default.
  const [deep, setDeep] = useState<Deep>(deepFromHash());
  // Rotates the waiting message. Slow on purpose — faster reads as jittery.
  const [waitTick, setWaitTick] = useState(0);
  const [digesting, setDigesting] = useState<ExtractionProgress | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  // A pending delete or rewind, waiting on confirmation — losing a message is
  // not something a stray click should be able to do.
  const [turnAction, setTurnAction] = useState<{ index: number; kind: "delete" | "rewind" } | null>(
    null,
  );
  const [turnMenu, setTurnMenu] = useState<{
    x: number;
    y: number;
    index: number;
    text: string;
  } | null>(null);
  // Where this stretch of thinking gets filed. The backend is the source of
  // truth, since an idle timeout can archive without the UI involved.
  const [folderId, setFolderId] = useState<number>(ROOT_FOLDER);
  const [folderName, setFolderName] = useState("Root");
  const [pickingFolder, setPickingFolder] = useState(false);
  /** Read replies out as they finish. Always on in call mode. */
  const [voiceOn, setVoiceOn] = useState(false);
  /** Which voice reads replies, so the setting chosen in Settings is honoured
   *  by the button in the composer too. */
  const [voiceKind, setVoiceKind] = useState<"system" | "neural">("system");
  /** Whether the microphone is hearing anything, for the waveform. */
  const [hearing, setHearing] = useState(false);
  /** Words dictated since the last silence, waiting to be sent. */
  const heardRef = useRef("");
  const quietRef = useRef<number | undefined>(undefined);
  const [callMode, setCallMode] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [idleOpen, setIdleOpen] = useState(false);
  /** Which workspace panel is filling the pane, if any. */
  const [expanded, setExpanded] = useState<"map" | "ideas" | "conversations" | null>(null);
  /** Simple visits one place at a time; advanced puts them all on screen. */
  const [layout, setLayout] = useState<"simple" | "advanced">("simple");
  // The no-model screen can drop into the Models tab rather than being a dead
  // end — someone with an API key or the claude CLI had no way through it.
  const [setupModels, setSetupModels] = useState(false);
  /**
   * Whether the picker is standing in the way, and whether it should be next
   * time.
   *
   * `null` until settings load, so the app does not flash the picker on its
   * way to skipping it.
   */
  const [asking, setAsking] = useState<boolean | null>(null);
  const [remember, setRemember] = useState(false);
  /** Seconds of quiet before a call sends. Mirrored from settings so the
   *  timer does not have to read them on every phrase. */
  const [callSilence, setCallSilence] = useState(5);
  const [rechecking, setRechecking] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Apply the saved theme before anything is looked at.
  useEffect(() => {
    void getSettings().then((s) => {
      applyTheme(s.theme);
      applyUiScale(s.ui_scale);
      setVoiceOn(s.voice !== "off" || s.call_mode);
      if (s.voice === "neural") setVoiceKind("neural");
      setCallMode(s.call_mode);
      setIdleMinutes(s.idle_minutes);
      setLayout(s.layout);
    });
    const un = listen<{ voice?: string; call_mode?: boolean; layout?: "simple" | "advanced" }>(
      "settings:changed",
      (e) => {
        setVoiceOn(e.payload.voice === "system" || !!e.payload.call_mode);
        if (e.payload.layout) setLayout(e.payload.layout);
      },
    );
    return () => {
      void un.then((f: () => void) => f());
    };
  }, []);

  // No native context menu anywhere in the app by default — only the places
  // that build their own (a message, a conversation, an idea) show one, and
  // those already call preventDefault themselves before this ever runs.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    void currentFolder().then(setFolderId).catch(() => {});
  }, []);

  useEffect(() => {
    void listFolders()
      .then((fs) => setFolderName(fs.find((f) => f.id === folderId)?.name ?? "Root"))
      .catch(() => {});
  }, [folderId, pickingFolder]);

  useEffect(() => {
    startup()
      .then((s) => {
        setServers(s.servers);
        setProvider(s.selected);
      })
      .catch((e) => setError(String(e)));
    void getSettings()
      .then((s) => {
        setAsking(s.ask_provider);
        setCallSilence(s.call_silence_seconds);
      })
      .catch(() => setAsking(false));
  }, []);

  /**
   * Get past the picker, remembering the answer if asked to.
   *
   * The tick is what turns the question off, not the choosing — someone can
   * pick a model today and still want to be asked tomorrow, and the two are
   * different decisions.
   */
  function settle() {
    setAsking(false);
    if (remember) void patchSetting({ ask_provider: false });
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, streaming]);

  // Keep the hash in step, and follow it when the user goes back.
  useEffect(() => {
    const want = deep ? `${deep.kind}/${deep.id}` : view;
    if (window.location.hash.replace(/^#\/?/, "") !== want) {
      window.location.hash = want;
    }
  }, [view, deep]);

  useEffect(() => {
    const onHash = () => {
      setDeep(deepFromHash());
      setView(tabFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setWaitTick((n) => n + 1), 3500);
    return () => clearInterval(id);
  }, [streaming]);

  // Extraction runs in the background after Done, so the notice has to live
  // outside the Ideas tab — otherwise the work is invisible from where you are.
  useEffect(() => {
    void extractionProgress().then(setDigesting);
    const p = onExtractionProgress(setDigesting);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  /**
   * Pick an archived conversation back up.
   *
   * The backend files whatever is being said now and loads the old turns into
   * the live conversation; the front has to catch up by showing them and
   * getting out of whatever it was looking at.
   */
  async function resume(sessionId: number) {
    try {
      await continueSession(sessionId);
      const turns = await sessionTurns(sessionId);
      setTurns(turns.map((t) => ({ role: t.role as Turn["role"], content: t.text })));
      setJustArchived(null);
      setDeep(null);
      setExpanded(null);
      setView("chat");
    } catch (e) {
      setError(String(e));
    }
  }

  // Sessions can also end without the user doing anything — an idle timeout, or
  // the app closing. The stream has to clear in those cases too, or the UI would
  // keep showing a conversation the backend has already filed away.
  useEffect(() => {
    const p = onArchived((a) => {
      setTurns([]);
      setJustArchived(a);
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // Deliberately not auto-dismissed. It used to vanish after six seconds,
  // which is roughly when extraction is still running and the result the
  // person is waiting for has not arrived yet. It clears when they start
  // talking again instead.

  /**
   * Turn call mode on, and everything it needs with it.
   *
   * One press rather than three. Call mode without the microphone open is a
   * setting nobody asked for, and a microphone open without a voice reading
   * the answer back is half a phone call — so pressing the button does all of
   * it, and pressing it again undoes all of it.
   */
  async function toggleCall(on: boolean) {
    setCallMode(on);
    setVoiceOn(on || voiceOn);
    void patchSetting({ call_mode: on, voice: on ? voiceKind : undefined });
    try {
      if (on) await startDictation();
      else await stopDictation();
    } catch (e) {
      setError(String(e));
      if (on) setCallMode(false);
    }
    if (!on) {
      window.clearTimeout(quietRef.current);
      heardRef.current = "";
      setHearing(false);
      stopSpeaking();
    }
  }

  /**
   * In a call, finishing a sentence sends it.
   *
   * There is no keyboard in a call, so waiting for one would be waiting
   * forever. Held for a few seconds after the last phrase rather than sent on
   * it: a pause mid-thought is not the end of a thought, and cutting someone
   * off at the first comma is worse than waiting. How long is a setting,
   * because how long anyone pauses is not something to guess at.
   */
  function heard(text: string) {
    if (!callMode) {
      setDraft((d) => (d ? `${d.trimEnd()} ${text}` : text));
      return;
    }
    heardRef.current = heardRef.current ? `${heardRef.current} ${text}` : text;
    window.clearTimeout(quietRef.current);
    quietRef.current = window.setTimeout(() => {
      const said = heardRef.current.trim();
      heardRef.current = "";
      if (said) void sendText(said);
    }, Math.max(1, callSilence) * 1000);
  }

  async function send() {
    await sendText(draft.trim());
  }

  async function sendText(text: string) {
    if (!text || streaming || !provider) return;

    setDraft("");
    setError(null);
    setStreaming(true);
    setThinking(false);
    setThoughtChars(0);
    setTurns((t) => [...t, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      const reply = await sendMessage(
        text,
        (chunk) => {
          setThinking(false);
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1];
            next[next.length - 1] = { role: "assistant", content: last.content + chunk };
            return next;
          });
        },
        // The scratchpad itself is never rendered — putting the model's thinking
        // in front of the user's own is exactly backwards for this app. Only the
        // fact that it is thinking, and roughly how long, is surfaced.
        (chunk) => {
          setThinking(true);
          setThoughtChars((n) => n + chunk.length);
        },
      );

      // The marker is the app's own plumbing, not something that was said —
      // strip it before it is shown or archived, then act on it.
      const { open, text: clean } = parseReply(reply);
      if (clean !== reply) {
        setTurns((t) => {
          const next = [...t];
          next[next.length - 1] = { role: "assistant", content: clean };
          return next;
        });
      }
      if (open) {
        // In simple mode there is nothing to expand — it is a different page.
        // "conversations" and "ideas" are one place now.
        if (layout === "simple") setView(open === "conversations" ? "ideas" : open);
        else setExpanded(open);
      }
      if (voiceOn) speak(clean, voiceKind === "neural");
    } catch (e) {
      setError(String(e));
      setTurns((t) => t.slice(0, -1));
    } finally {
      setStreaming(false);
      setThinking(false);
      inputRef.current?.focus();
    }
  }

  function toggleExpand(which: "map" | "ideas" | "conversations") {
    setExpanded((e) => (e === which ? null : which));
  }

  /**
   * Somewhere else to come back from.
   *
   * In the all-at-once layout the tabs are gone, so expanding a panel left no
   * way back at all. The app's own name is the one thing always on screen.
   */
  const awayFromMain = !!deep || !!expanded || view === "models" || view === "settings";

  function backToMain() {
    if (deep) setDeep(null);
    else if (expanded) setExpanded(null);
    else setView("chat");
  }

  /** Flip one setting from the composer, without leaving the conversation. */
  async function patchSetting(patch: Record<string, unknown>) {
    try {
      const current = await getSettings();
      // Undefined entries are dropped rather than spread: `{ voice: undefined }`
      // overwrites the saved voice with nothing, which is not what "leave this
      // one alone" should do.
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await saveSettings({ ...current, ...set });
    } catch (e) {
      setError(String(e));
    }
  }

  async function setLayoutMode(next: "simple" | "advanced") {
    setLayout(next);
    setExpanded(null);
    try {
      const current = await getSettings();
      await saveSettings({ ...current, layout: next });
    } catch (e) {
      setError(String(e));
    }
  }

  /** Ask the backend to look for models again, so nothing needs restarting. */
  async function recheck(): Promise<Selected | null> {
    setRechecking(true);
    setError(null);
    try {
      const s = await startup();
      setServers(s.servers);
      setProvider(s.selected);
      return s.selected;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setRechecking(false);
    }
  }

  async function confirmTurnAction() {
    if (!turnAction) return;
    const { index, kind } = turnAction;
    setTurnAction(null);
    if (kind === "delete") {
      await deleteTurn(index).catch((e) => setError(String(e)));
      setTurns((t) => t.filter((_, i) => i !== index));
    } else {
      await rewindConversation(index).catch((e) => setError(String(e)));
      setTurns((t) => t.slice(0, index));
    }
  }

  async function done() {
    stopSpeaking();
    if (streaming || ending) return;
    setError(null);
    // Visible before the await: archiving writes to disk and can stall briefly.
    setEnding(true);
    try {
      const archived = await endSession("done");
      // A null result means nothing was said — no empty sessions in the archive.
      if (archived) {
        setTurns([]);
        setJustArchived(archived);
      }
    } catch (e) {
      // The backend clears the stream only after a successful write, so on
      // failure the conversation is still here and still recoverable.
      setError(`Could not archive this session: ${e}`);
    } finally {
      setEnding(false);
    }
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. This is a thinking tool — the cost
    // of a stray send is low, the friction of reaching for a button is not.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Embedding models can't chat, so they're never offered. Models that aren't
  // loaded are offered but marked — LM Studio will load one on demand, which
  // can take a while or fail outright on a large model.
  const chatModels = (s: Detected): ModelInfo[] =>
    s.models.filter((m) => m.kind === "chat");
  const usable = (servers ?? []).filter((s) => chatModels(s).length > 0);

  // Shown when there is nothing to talk to, and — unless told not to — on
  // every launch even when there is. Which model answers shapes what ends up
  // in the map; reusing last week's choice without saying so is the app
  // deciding that.
  if (servers && (!provider || asking === true)) {
    const idle = servers.some((s) => s.models.length === 0);
    return (
      <main className="app">
        <nav className="topbar" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>Idea Graph</div>
          <div className="topbar-spacer" data-tauri-drag-region />
          <WindowControls />
        </nav>

        <div className="pane">
          {setupModels ? (
            <>
              {/* Outside the pane-inner on purpose: Models brings its own, and
                  nesting them would double the padding and stack two scroll
                  containers. */}
              <div className="row setup-bar bordered">
                <button className="btn" onClick={() => setSetupModels(false)}>
                  ← Back
                </button>
                <button
                  className="btn on"
                  disabled={rechecking}
                  // Only gets out of the way if something was actually found;
                  // otherwise it would dismiss the picker onto a chat with
                  // nothing to talk to.
                  onClick={() => void recheck().then((p) => p && settle())}
                >
                  {rechecking ? "Checking…" : "Done — start thinking"}
                </button>
              </div>
              {/* The Models tab already knows how to find local servers, hold an
                  API key, and detect the claude CLI. No reason to build a
                  second, worse version of it here. */}
              <Models />
            </>
          ) : (
            <div className="pane-inner">
              <div className="setup">
                <h1>Pick a model</h1>

                {/* One question with one recommended answer, rather than a
                    list of things to go and install. Running it here is the
                    only option that works with nothing else on the machine, so
                    it is the button; everything else is the dropdown beside
                    it. */}
                <p className="blurb">
                  Idea Graph needs a model to talk to. It can run one itself —
                  nothing else to install, and nothing said to it leaves this
                  machine.
                </p>

                <div className="row setup-choice">
                  <button className="btn on big" onClick={() => setSetupModels(true)}>
                    Run a model in the app
                  </button>
                  <Select
                    value=""
                    placeholder="I have my own"
                    options={[
                      { value: "lmstudio", label: "LM Studio" },
                      { value: "ollama", label: "Ollama" },
                      { value: "cloud", label: "An API key or Claude" },
                    ]}
                    onChange={() => setSetupModels(true)}
                  />
                </div>

                {usable.length > 0 && (
                  <>
                    <h2 className="section">Already running</h2>
                    {usable.map((srv) => (
                      <section key={srv.kind}>
                        <ul className="list">
                          {chatModels(srv)
                            // Ready models first — those start answering immediately.
                            .sort((a, b) => Number(b.loaded ?? true) - Number(a.loaded ?? true))
                            .map((m) => (
                              <li key={m.id}>
                                <button
                                  className="row-btn"
                                  onClick={() =>
                                    selectProvider(srv.kind, srv.host, m.id)
                                      .then((p) => {
                                        setProvider(p);
                                        settle();
                                      })
                                      .catch((e) => setError(String(e)))
                                  }
                                >
                                  <span className="row-main">{modelName(m.id)}</span>
                                  <span className="row-meta">
                                    {srv.kind === "lmstudio"
                                      ? "LM Studio"
                                      : srv.kind === "embedded"
                                        ? "In the app"
                                        : "Ollama"}
                                  </span>
                                  {m.loaded === false && <span className="tag">needs loading</span>}
                                  {m.loaded === true && <span className="tag ready">ready</span>}
                                </button>
                              </li>
                            ))}
                        </ul>
                      </section>
                    ))}
                  </>
                )}

                {usable.length === 0 && idle && (
                  <p className="blurb">
                    A model server is running, but nothing is loaded in it.
                  </p>
                )}

                <div className="row setup-bar">
                  {provider && (
                    <button className="btn on" onClick={settle}>
                      Continue with {modelName(provider.model)}
                    </button>
                  )}
                  <button className="btn" disabled={rechecking} onClick={() => void recheck()}>
                    {rechecking ? "Looking…" : "Look again"}
                  </button>
                  <button className="btn" onClick={() => setSetupModels(true)}>
                    Models and API keys
                  </button>
                </div>

                {/* Ticking this is the decision, not choosing a model — someone
                    can pick one today and still want to be asked tomorrow. */}
                <label className="remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  Don&apos;t ask again — use whatever was chosen last
                </label>

                {error && <p className="error">{error}</p>}
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  const pending = digesting?.pending ?? 0;

  return (
    <main className="app">
      <nav className="topbar" data-tauri-drag-region>
        {awayFromMain ? (
          <button className="brand back" onClick={backToMain} data-tip="Back to the conversation">
            Idea Graph
          </button>
        ) : (
          <div className="brand" data-tauri-drag-region>
            Idea Graph
          </div>
        )}

        {/* Tabs only in simple mode. In advanced there is nothing for them to
            switch between — it is all on screen at once. */}
        {layout === "simple" && (
          <div className="topbar-tabs">
            {MAIN.map((t) => {
              const Icon = TAB_ICONS[t];
              return (
                <button
                  key={t}
                  className={view === t && !deep ? "nav on" : "nav"}
                  onClick={() => {
                    setDeep(null);
                    setView(t);
                  }}
                >
                  <Icon className="nav-icon" />
                  {TAB_NAMES[t]}
                </button>
              );
            })}
          </div>
        )}
        <div className="topbar-spacer" />

        {pending > 0 && (
          <span className="row digest-group">
            <button
              className="digest-btn"
              disabled={digestBusy || !!digesting?.running}
              onClick={() => {
                setDigestBusy(true);
                void extractNow().finally(() => setDigestBusy(false));
              }}
            >
              {digesting?.running ? "Digesting…" : `Digest (${pending})`}
            </button>
            {/* The count says how many; this says which, and lets one be
                thrown away before it costs a reading. */}
            <button
              className="digest-btn queue-btn"
              data-tip="What is waiting to be read"
              onClick={() => setShowQueue(true)}
            >
              ⋯
            </button>
          </span>
        )}

        <div className="topbar-tabs topbar-setup">
          {SETUP.map((t) => {
            const Icon = TAB_ICONS[t];
            return (
              <button
                key={t}
                className={view === t && !deep ? "nav on" : "nav"}
                onClick={() => {
                  setDeep(null);
                  setView(t);
                }}
                data-tip={TAB_NAMES[t]}
              >
                <Icon className="nav-icon" />
              </button>
            );
          })}
        </div>

        <WindowControls />
      </nav>

      <div className="pane">
      {view === "models" ? (
        <Models />
      ) : view === "settings" ? (
        <SettingsPanel />
      ) : (
      // Everything at once rather than one tab at a time: the map and the
      // conversations to the left, the ideas they produced to the right, and
      // the talking in the middle where the attention is.
      <div
        className={
          layout === "simple"
            ? `workspace expanded expanded-${
                view === "map" ? "map" : view === "ideas" ? "ideas" : "chat"
              }`
            : `workspace${expanded ? ` expanded expanded-${expanded}` : ""}`
        }
      >

        <div className="ws-left">
          <section className="ws-panel ws-map">
            <button className="ws-head" onClick={() => toggleExpand("map")} hidden={layout === "simple"}>
              <IconMap className="nav-icon" />
              Map
              <span className="ws-grow" aria-hidden="true">
                {expanded === "map" ? "Close" : "Open"}
              </span>
            </button>
            <div className="ws-body">
              <Graph folder={folderId} />
            </div>
          </section>

        </div>

        <div className="ws-center">
      <div className={turns.length === 0 && !justArchived ? "think opening" : "think"}>
      <div className="stream">
        {turns.length === 0 && !justArchived && (
          <p className="empty">
            <strong>Think out loud.</strong>
          </p>
        )}

        {turns.length === 0 && justArchived && (
          // Pressing Done used to end here, with nothing to do and nothing
          // visibly happening — so the reading-back is now shown as it runs,
          // and the map is offered the moment there is one to look at.
          <div className="filed">
            <p className="filed-head">
              {justArchived.reason === "idle"
                ? "That went quiet, so it has been filed."
                : "Filed."}{" "}
              <span className="muted">{justArchived.turn_count} turns kept in {folderName}.</span>
            </p>

            {digesting?.running?.session_id === justArchived.session_id ? (
              <p className="filed-status">
                <span className="spinner" aria-hidden="true" />
                Reading it back for ideas. This can take a minute on a local model.
              </p>
            ) : digesting?.last?.session_id === justArchived.session_id &&
              !digesting.last.error ? (
              <>
                <p className="filed-status">
                  {digesting.last.ideas > 0
                    ? `${digesting.last.ideas} idea${digesting.last.ideas === 1 ? "" : "s"} found.`
                    : "Nothing substantive came out of that one."}
                </p>
                {digesting.last.ideas > 0 && (
                  <div className="row">
                    <button
                      className="btn on"
                      onClick={() => (layout === "simple" ? setView("map") : setExpanded("map"))}
                    >
                      See it on the map
                    </button>
                    <button
                      className="btn"
                      onClick={() => (layout === "simple" ? setView("ideas") : setExpanded("ideas"))}
                    >
                      Read the ideas
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="filed-status muted">Queued to be read back.</p>
            )}
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={`turn ${t.role}`}
            onContextMenu={(e) => {
              if (streaming) return;
              e.preventDefault();
              setTurnMenu({ x: e.clientX, y: e.clientY, index: i, text: t.content });
            }}
          >
            {/* The user's own words stay verbatim — they are what quotes get
                matched against, and markdown would render some of them away. */}
            {t.role === "assistant" && t.content ? (
              <Markdown>{t.content}</Markdown>
            ) : (
              t.content
            )}
            {t.role === "assistant" && !t.content && streaming && (
              <span className="thinking">
                {thinking ? "thinking" : thinkingMessage(waitTick)}
                <span className="dots" />
                {thinking && thoughtChars > 0 && (
                  <span className="thought-size"> · {thoughtChars} chars</span>
                )}
              </span>
            )}
          </div>
        ))}

        {turnMenu && (
          <ContextMenu
            x={turnMenu.x}
            y={turnMenu.y}
            onClose={() => setTurnMenu(null)}
            items={[
              {
                // First, and without a confirmation: it is the one thing here
                // that changes nothing.
                label: "Copy",
                onSelect: () => void navigator.clipboard.writeText(turnMenu.text),
              },
              {
                label: "Delete this message",
                danger: true,
                onSelect: () => setTurnAction({ index: turnMenu.index, kind: "delete" }),
              },
              ...(turnMenu.index < turns.length - 1
                ? [
                    {
                      label: "Go back to before this message",
                      onSelect: () =>
                        setTurnAction({ index: turnMenu.index, kind: "rewind" as const }),
                    },
                  ]
                : []),
            ]}
          />
        )}

        {turnAction && (
          <Confirm
            title={
              turnAction.kind === "delete"
                ? "Delete this message?"
                : "Go back to before this message? Everything said after it goes too."
            }
            danger
            onConfirm={() => void confirmTurnAction()}
            onCancel={() => setTurnAction(null)}
          />
        )}

        {error && <div className="error">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        {turns.length === 0 && (
          // Before anything is said, the folder is the decision — shown large,
          // above the box. Once the conversation is under way it steps aside
          // to the bar below, next to Speak.
          <button
            className="folder-banner"
            style={{ "--folder-color": folderColor(folderName) } as React.CSSProperties}
            onClick={() => setPickingFolder(true)}
          >
            <FolderMark name={folderName} id={folderId} size={20} />
            <span className="folder-banner-text">
              <span className="folder-banner-label">This conversation goes in</span>
              <span className="folder-banner-name">{folderName}</span>
            </span>
            <span className="folder-banner-change">Change</span>
          </button>
        )}
        <div className="composer-box">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={provider ? "Start anywhere" : "Connecting…"}
          disabled={!provider}
          rows={1}
          autoFocus
        />
        <div className="bar">
          {/* Outside a call, dictation fills the box and never sends: the user
              edits before anything becomes a turn, which keeps a misheard word
              from becoming a quote that looks authoritative. In a call there is
              nowhere to edit, so `heard` sends after a pause instead. */}
          <Mic onPhrase={heard} onSpeaking={setHearing} disabled={streaming} />
          <button
            className={callMode ? "icon-btn on" : "icon-btn"}
            data-tip={
              callMode
                ? "Call mode on — short answers, read aloud"
                : "Call mode — short answers, read aloud"
            }
            onClick={() => void toggleCall(!callMode)}
          >
            <IconCall />
          </button>

          <button
            className={voiceOn ? "icon-btn on" : "icon-btn"}
            data-tip={voiceOn ? "Reading replies aloud" : "Read replies aloud"}
            onClick={() => {
              const next = !voiceOn;
              setVoiceOn(next);
              if (!next) stopSpeaking();
              void patchSetting({ voice: next ? voiceKind : "off" });
            }}
          >
            <IconSpeaker />
          </button>

          {turns.length > 0 && (
            <button
              className="btn folder-btn"
              style={{ "--folder-color": folderColor(folderName) } as React.CSSProperties}
              onClick={() => setPickingFolder(true)}
              data-tip="Where this conversation is filed"
            >
              <FolderMark name={folderName} id={folderId} />
              {folderName}
            </button>
          )}
          <span className="spacer" />

          {/* Opens upward: it lives at the bottom of the window, and a menu
              that drops off the screen is no menu at all. */}
          <div className="idle-pick">
            <button
              className="icon-btn"
              data-tip={`Filed after ${idleMinutes} minutes of quiet`}
              onClick={() => setIdleOpen((o) => !o)}
            >
              <IconClock />
            </button>
            {idleOpen && (
              <ul className="idle-list">
                {[10, 30, 60, 120].map((m) => (
                  <li key={m}>
                    <button
                      className={idleMinutes === m ? "pick-option on" : "pick-option"}
                      onClick={() => {
                        setIdleMinutes(m);
                        setIdleOpen(false);
                        void patchSetting({ idle_minutes: m });
                      }}
                    >
                      {m < 60 ? `${m} min` : `${m / 60} hr`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            className="btn btn-send"
            onClick={() => void send()}
            disabled={!draft.trim() || streaming || !provider}
            data-tip="Send (Enter)"
          >
            <IconSend />
            Send
          </button>
          {turns.length > 0 && (
            <button
              className={ending ? "btn busy" : "btn"}
              onClick={done}
              disabled={streaming || ending}
              aria-busy={ending}
            >
              {ending && <span className="spinner" aria-hidden="true" />}
              {ending ? "Saving…" : "Done"}
            </button>
          )}
        </div>
        </div>
      </div>
      </div>

        </div>

        <aside className="ws-panel ws-right">
          <button className="ws-head" onClick={() => toggleExpand("ideas")} hidden={layout === "simple"}>
            <IconIdeas className="nav-icon" />
            Ideas
            <span className="ws-grow" aria-hidden="true">
              {expanded === "ideas" ? "Close" : "Open"}
            </span>
          </button>
          <div className="ws-body">
            <Ideas folder={folderId} onContinue={(id) => void resume(id)} />
          </div>
        </aside>
      </div>
      )}
      </div>

      {pickingFolder && (
        <FolderPicker
          current={folderId}
          onPick={(id) => {
            setFolderId(id);
            void setCurrentFolder(id);
          }}
          onClose={() => setPickingFolder(false)}
        />
      )}

      {showQueue && (
        <Queue
          onClose={() => setShowQueue(false)}
          onChanged={() => void extractionProgress().then(setDigesting)}
        />
      )}

      {callMode && (
        <Call
          speaking={hearing}
          thinking={streaming}
          status={
            streaming
              ? "Thinking…"
              : hearing
                ? "Listening"
                : "Say something — it sends when you stop"
          }
          onHangUp={() => void toggleCall(false)}
        />
      )}

      {deep && (
        <Sheet onClose={() => setDeep(null)}>
          {deep.kind === "idea" ? (
            <IdeaFile
              ideaId={deep.id}
              onOpenConversation={(id) => setDeep({ kind: "conversation", id })}
              onClose={() => setDeep(null)}
            />
          ) : (
            <ConversationFile sessionId={deep.id} onClose={() => setDeep(null)} />
          )}
        </Sheet>
      )}

      <Tooltip />

      <div className="statusbar">
        {provider ? `${provider.label} · ${modelName(provider.model)}` : "no model"}
        <button
          className="status-toggle"
          onClick={() => void setLayoutMode(layout === "simple" ? "advanced" : "simple")}
          data-tip={
            layout === "simple"
              ? "One place at a time. Switch to everything at once."
              : "Everything at once. Switch to one place at a time."
          }
        >
          {layout === "simple" ? "Simplified" : "Advanced"}
        </button>
        {digesting?.running && (
          <span className="busy-item">
            reading back session {digesting.running.session_id}
          </span>
        )}
        {!digesting?.running && (digesting?.pending ?? 0) > 0 && (
          <span>{digesting?.pending} waiting to be read</span>
        )}
        <span className="spacer" />
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </div>
    </main>
  );
}
