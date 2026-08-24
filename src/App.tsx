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
  IconClock,
} from "./components/Icons";
import { ConversationFile, IdeaFile } from "./components/Deep";
import Confirm from "./components/Confirm";
import Sheet from "./components/Sheet";
import Call from "./components/Call";
import Queue from "./components/Queue";
import Drawer from "./components/Drawer";
import Vitals from "./components/Vitals";
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
import {
  onSpeakingChange,
  parseReply,
  speak,
  speakNext,
  stopSpeaking,
  takeSentences,
} from "./lib/voice";
import { modelName } from "./lib/format";
import { runtimeStatus } from "./lib/settings";
import { sessionTurns } from "./lib/sessions";
import { startDictation, stopDictation } from "./lib/dictation";
import {
  continueSession,
  deleteTurn,
  endSession,
  onArchived,
  rewindConversation,
  sendMessage,
  startup,
  type Archived,
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
type Tab = "chat" | "map" | "ideas" | "settings";
const TABS: Tab[] = ["chat", "map", "ideas", "settings"];

/** What each place is called. One map, so the rail and the URL agree. */
const TAB_NAMES: Record<Tab, string> = {
  chat: "Think",
  map: "Map",
  ideas: "Ideas",
  settings: "Settings",
};

/** One icon per tab, so a place can be told apart at a glance rather than by
 *  reading its label — the label stays too, since an icon alone is ambiguous
 *  until it's memorised. */
const TAB_ICONS: Record<Tab, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  chat: IconThink,
  map: IconMap,
  ideas: IconIdeas,
  settings: IconSettings,
};

const MAIN: Tab[] = ["chat", "map", "ideas"];
/**
 * Settings only.
 *
 * Models had a tab of its own until the model became a chip on the
 * conversation — two doors to one room, one of them next to the window
 * controls where nothing else about the conversation lives.
 */
const SETUP: Tab[] = ["settings"];

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
  const [showModels, setShowModels] = useState(false);
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
  /**
   * Whether replies are read out because the setting says so.
   *
   * Off unless someone asked for it. A call turns speech on for as long as the
   * call lasts — there is nothing to read in a call — and hanging up leaves
   * this exactly where it was, rather than a preference silently changed by a
   * button that was about something else.
   */
  const [voiceSetting, setVoiceSetting] = useState(false);
  /** Which voice reads replies, chosen in Settings. */
  const [voiceKind, setVoiceKind] = useState<"system" | "neural">("system");
  /** Whether the microphone is hearing anything, for the waveform. */
  const [hearing, setHearing] = useState(false);
  /** Words dictated since the last silence, waiting to be sent. */
  const heardRef = useRef("");
  const quietRef = useRef<number | undefined>(undefined);
  /** What has been transcribed and not yet sent, on screen. */
  const [heardText, setHeardText] = useState("");
  /** Seconds left before it sends, or null when nothing is pending. */
  const [sendingIn, setSendingIn] = useState<number | null>(null);
  /** Held open because the pause was a thinking pause, not a finished one. */
  const [held, setHeld] = useState(false);
  /** How far the model has got reading the prompt, when it can say. */
  const [readProgress, setReadProgress] = useState<number | null>(null);
  /** Whether a reply is being read out right now. */
  const [talking, setTalking] = useState(false);
  /** Reply text that has arrived but has not yet completed a sentence. */
  const pendingSpeech = useRef("");
  /**
   * Whether a reply is being generated, readable from a timer.
   *
   * The countdown fires from a `setTimeout` closed over an old render, where
   * `streaming` is whatever it was when the timer was set — so a phrase spoken
   * while the model was still answering saw `streaming: false`, sent anyway,
   * and produced a second answer on top of the first.
   */
  const streamingRef = useRef(false);
  /** Something was said while the model was answering, and is still waiting. */
  const queuedRef = useRef(false);
  const [callMode, setCallMode] = useState(false);
  const voiceOn = voiceSetting || callMode;
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [idleOpen, setIdleOpen] = useState(false);
  /** Which workspace panel is filling the pane, if any. */
  const [expanded, setExpanded] = useState<"map" | "ideas" | "conversations" | null>(null);
  /** Simple visits one place at a time; advanced puts them all on screen. */
  const [layout, setLayout] = useState<"simple" | "advanced">("simple");
  // The no-model screen can drop into the Models tab rather than being a dead
  // end — someone with an API key or the claude CLI had no way through it.
  /** Seconds of quiet before a call sends. Mirrored from settings so the
   *  timer does not have to read them on every phrase. */
  const [callSilence, setCallSilence] = useState(5);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Apply the saved theme before anything is looked at.
  useEffect(() => {
    void getSettings().then((s) => {
      applyTheme(s.theme);
      applyUiScale(s.ui_scale);
      setVoiceSetting(s.voice !== "off");
      if (s.voice === "neural") setVoiceKind("neural");
      setCallMode(s.call_mode);
      setIdleMinutes(s.idle_minutes);
      setLayout(s.layout);
    });
    const un = listen<{ voice?: string; call_mode?: boolean; layout?: "simple" | "advanced" }>(
      "settings:changed",
      (e) => {
        // Only the setting. Whether a call is in progress is this window's
        // business, not something a saved settings file should turn on.
        if (e.payload.voice !== undefined) setVoiceSetting(e.payload.voice !== "off");
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
        setProvider(s.selected);
      })
      .catch((e) => setError(String(e)));
    void getSettings()
      .then((s) => setCallSilence(s.call_silence_seconds))
      .catch(() => {});
  }, []);


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

  /**
   * Starting to talk again takes the countdown back.
   *
   * The pause was a pause, not the end. Waiting for the next transcribed
   * phrase to arrive would have let it send in the gap between opening your
   * mouth and the words being recognised — so this hangs on the voice
   * detector, which knows as soon as there is sound.
   */
  useEffect(() => {
    if (!hearing) return;
    window.clearTimeout(quietRef.current);
    setSendingIn(null);
    setHeld(false);
  }, [hearing]);

  // The countdown on screen. Its own timer rather than a value derived from
  // the send timeout, because the send has to stay exact whatever the display
  // is doing.
  // Stopped again, with something waiting: start the countdown over. Not done
  // when the phrase arrives, because a phrase can land while still talking.
  useEffect(() => {
    if (hearing || !callMode || streaming) return;
    if (!heardRef.current.trim() || held) return;
    armSend();
  }, [hearing, callMode, streaming]);

  useEffect(() => {
    if (sendingIn === null) return;
    const id = setInterval(() => {
      setSendingIn((s) => (s === null ? null : Math.max(0, s - 0.1)));
    }, 100);
    return () => clearInterval(id);
  }, [sendingIn === null]);

  // How far the model has got reading, while a call waits on it. Polled only
  // during a call, and only while it is working.
  useEffect(() => {
    if (!callMode || !streaming) {
      setReadProgress(null);
      return;
    }
    const tick = () =>
      runtimeStatus()
        .then((r) =>
          setReadProgress(
            r.phase === "reading" && r.prompt_total > 0
              ? r.prompt_done / r.prompt_total
              : r.phase === "writing"
                ? 1
                : null,
          ),
        )
        .catch(() => {});
    void tick();
    const id = setInterval(tick, 600);
    return () => clearInterval(id);
  }, [callMode, streaming]);

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
  useEffect(() => onSpeakingChange(setTalking), []);

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
    void patchSetting({ call_mode: on });
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
      setHeardText("");
      setSendingIn(null);
      setHeld(false);
      queuedRef.current = false;
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
    setHeardText(heardRef.current);
    setHeld(false);
    armSend();
  }

  /** Start (or restart) the countdown to sending what has been heard. */
  function armSend() {
    window.clearTimeout(quietRef.current);
    const total = Math.max(1, callSilence);
    setSendingIn(total);
    quietRef.current = window.setTimeout(() => flushCall(), total * 1000);
  }

  function flushCall() {
    window.clearTimeout(quietRef.current);
    setSendingIn(null);
    // Interrupting the model with a second question is not the same as asking
    // two — the first answer is still coming. Held until it lands, then sent,
    // so nothing said is lost and nothing is answered twice.
    if (streamingRef.current) {
      queuedRef.current = true;
      return;
    }
    const said = heardRef.current.trim();
    heardRef.current = "";
    setHeardText("");
    if (said) void sendText(said);
  }

  async function send() {
    await sendText(draft.trim());
  }

  async function sendText(text: string) {
    if (!text || streaming) return;
    // Said rather than swallowed. Without this, pressing Send with no model
    // did nothing at all — the same thing a broken button does.
    if (!provider) {
      setError("No model is loaded. Pick one and the message will send.");
      setShowModels(true);
      return;
    }

    setDraft("");
    setError(null);
    pendingSpeech.current = "";
    streamingRef.current = true;
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
          // Spoken a sentence at a time as it arrives, rather than after the
          // whole answer. At twenty tokens a second, waiting for the end is
          // several seconds of silence at exactly the moment a call feels
          // broken; this way the wait is the first sentence.
          if (!voiceOn) return;
          pendingSpeech.current += chunk;
          const { spoken, rest } = takeSentences(pendingSpeech.current);
          pendingSpeech.current = rest;
          // The navigation marker is on the front of the first sentence and
          // must not be read out. `speakNext` strips it, but only if it is
          // still at the start of the piece it is given.
          for (const piece of spoken) speakNext(piece, voiceKind === "neural");
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
      // Whatever did not end in a full stop — the last clause of the answer.
      if (voiceOn) {
        const tail = pendingSpeech.current.trim();
        pendingSpeech.current = "";
        if (tail) speakNext(tail, voiceKind === "neural");
      }
    } catch (e) {
      setError(String(e));
      setTurns((t) => t.slice(0, -1));
    } finally {
      streamingRef.current = false;
      setStreaming(false);
      // Whatever was said while it was answering goes now.
      if (queuedRef.current) {
        queuedRef.current = false;
        if (heardRef.current.trim()) flushCall();
      }
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
  const awayFromMain = !!deep || !!expanded || view === "settings";

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
    setError(null);
    try {
      const s = await startup();
      setProvider(s.selected);
      return s.selected;
    } catch (e) {
      setError(String(e));
      return null;
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

  // No gate. The app opens on the conversation and the model chip asks for
  // attention if there is nothing to talk to — a setup screen in front of
  // someone who came to think is the app's problem being made theirs, and the
  // answer is one click away from where they already are.

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
      {view === "settings" ? (
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
      {/* Which model is answering, at the edge of the conversation it is
          answering in. Changing it is a thing you do *while* thinking — after
          a bad answer, usually — and sending someone to a settings tab for it
          means leaving the thing that prompted the question. */}
      <button
        className={`model-chip${showModels ? " on" : provider ? "" : " missing"}`}
        data-tip={provider ? "Which model is answering" : "Nothing to talk to yet — pick a model"}
        onClick={() => setShowModels((v) => !v)}
      >
        <IconModels className="nav-icon" />
        <span>{provider ? modelName(provider.model) : "No model — pick one"}</span>
      </button>

      {showModels && (
        <Drawer
          title="Which model is answering"
          onClose={() => {
            setShowModels(false);
            // Whatever was chosen in there is the answer now.
            void recheck();
          }}
        >
          <Models />
        </Drawer>
      )}
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
                // Useful for a long answer half-heard in a call, and the only
                // way to hear one again at all.
                label: "Read it aloud",
                onSelect: () => speak(turnMenu.text, voiceKind === "neural"),
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
          heard={heardText}
          sendingIn={streaming || held ? null : sendingIn}
          silence={Math.max(1, callSilence)}
          progress={readProgress}
          talking={talking}
          onStopTalking={stopSpeaking}
          status={
            streaming
              ? "Thinking…"
              : held
                ? "Waiting for you — say more, or send"
                : hearing
                  ? "Listening"
                  : "Say something — it sends when you stop"
          }
          onHold={() => {
            // Cancels the send without dropping what was heard: the pause was
            // a thinking pause, and the words are still wanted.
            window.clearTimeout(quietRef.current);
            setSendingIn(null);
            setHeld(true);
          }}
          onSendNow={flushCall}
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
        {provider?.kind === "embedded" && <Vitals onChanged={() => void recheck()} />}
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
