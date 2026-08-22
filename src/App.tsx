import { useEffect, useRef, useState } from "react";
import Chats from "./components/Chats";
import { ConversationFile, IdeaFile } from "./components/Deep";
import Graph from "./components/Graph";
import Ideas from "./components/Ideas";
import Models from "./components/Models";
import SettingsPanel from "./components/Settings";
import { applyTheme, getSettings } from "./lib/settings";
import Markdown from "./components/Markdown";
import { thinkingMessage } from "./lib/waiting";
import { extractionProgress, onExtractionProgress, type ExtractionProgress } from "./lib/ideas";
import Mic from "./components/Mic";
import {
  endSession,
  onArchived,
  selectProvider,
  sendMessage,
  startup,
  type Archived,
  type Detected,
  type ModelInfo,
  type Selected,
  type Turn,
} from "./lib/chat";

type Tab = "chat" | "map" | "ideas" | "chats" | "models" | "settings";
const TABS: Tab[] = ["chat", "map", "ideas", "chats", "models", "settings"];

/** What each place is called. One map, so the rail and the URL agree. */
const TAB_NAMES: Record<Tab, string> = {
  chat: "Think",
  map: "Map",
  ideas: "Ideas",
  chats: "Conversations",
  models: "Models",
  settings: "Settings",
};

const MAIN: Tab[] = ["chat", "map", "ideas", "chats"];
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
  if (raw === "conversation") return "chats";
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

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Apply the saved theme before anything is looked at.
  useEffect(() => {
    void getSettings().then((s) => applyTheme(s.theme));
  }, []);

  useEffect(() => {
    startup()
      .then((s) => {
        setServers(s.servers);
        setProvider(s.selected);
      })
      .catch((e) => setError(String(e)));
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

  // Extraction runs in the background after Done, so the notice has to live
  // outside the Ideas tab — otherwise the work is invisible from where you are.
  useEffect(() => {
    void extractionProgress().then(setDigesting);
    const p = onExtractionProgress(setDigesting);
    return () => {
      void p.then((un) => un());
    };
  }, []);

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

  // Let the confirmation fade rather than sit there forever.
  useEffect(() => {
    if (!justArchived) return;
    const t = setTimeout(() => setJustArchived(null), 6000);
    return () => clearTimeout(t);
  }, [justArchived]);

  async function send() {
    const text = draft.trim();
    if (!text || streaming || !provider) return;

    setDraft("");
    setError(null);
    setStreaming(true);
    setThinking(false);
    setThoughtChars(0);
    setTurns((t) => [...t, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      await sendMessage(
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
    } catch (e) {
      setError(String(e));
      setTurns((t) => t.slice(0, -1));
    } finally {
      setStreaming(false);
      setThinking(false);
      inputRef.current?.focus();
    }
  }

  async function done() {
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

  if (servers && !provider) {
    return (
      <main className="app centered">
        <div className="setup">
          <h1>Pick a model</h1>
          {usable.length === 0 ? (
            <p className="muted">
              No local model server found. Start <strong>LM Studio</strong> (and
              load a model) or run <code>ollama serve</code> after pulling one
              with <code>ollama pull llama3.2</code>, then reopen this app.
              {servers.some((s) => s.models.length === 0) && (
                <>
                  {" "}A server is running but has no model loaded.
                </>
              )}
            </p>
          ) : (
            usable.map((s) => (
              <section key={s.kind}>
                <h2>{s.kind === "lmstudio" ? "LM Studio" : "Ollama"}</h2>
                <ul>
                  {chatModels(s)
                    // Ready models first — those start answering immediately.
                    .sort((a, b) => Number(b.loaded ?? true) - Number(a.loaded ?? true))
                    .map((m) => (
                      <li key={m.id}>
                        <button
                          onClick={() =>
                            selectProvider(s.kind, s.host, m.id)
                              .then(setProvider)
                              .catch((e) => setError(String(e)))
                          }
                        >
                          <span>{m.id}</span>
                          {m.loaded === false && (
                            <span className="tag">needs loading</span>
                          )}
                          {m.loaded === true && <span className="tag ready">ready</span>}
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ))
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </main>
    );
  }

  return (
    <main className="app">
      <aside className="rail">
        <div className="rail-title">Idea Graph</div>

        {MAIN.map((t) => (
          <button
            key={t}
            className={view === t && !deep ? "nav on" : "nav"}
            onClick={() => {
              setDeep(null);
              setView(t);
            }}
          >
            <span className="nav-dot" />
            {TAB_NAMES[t]}
          </button>
        ))}

        <div className="rail-group">Setup</div>
        {SETUP.map((t) => (
          <button
            key={t}
            className={view === t && !deep ? "nav on" : "nav"}
            onClick={() => {
              setDeep(null);
              setView(t);
            }}
          >
            <span className="nav-dot" />
            {TAB_NAMES[t]}
          </button>
        ))}
      </aside>

      <div className="pane">
      {deep ? (
        deep.kind === "idea" ? (
          <IdeaFile
            ideaId={deep.id}
            onOpenConversation={(id) => setDeep({ kind: "conversation", id })}
            onClose={() => setDeep(null)}
          />
        ) : (
          <ConversationFile
            sessionId={deep.id}
            onOpenIdea={(id) => setDeep({ kind: "idea", id })}
            onClose={() => setDeep(null)}
          />
        )
      ) : view === "map" ? (
        <Graph
          onOpenIdea={(id) => setDeep({ kind: "idea", id })}
          onOpenConversation={(id) => setDeep({ kind: "conversation", id })}
        />
      ) : view === "ideas" ? (
        <Ideas onOpen={(id) => setDeep({ kind: "idea", id })} />
      ) : view === "chats" ? (
        <Chats onOpen={(id) => setDeep({ kind: "conversation", id })} />
      ) : view === "models" ? (
        <Models />
      ) : view === "settings" ? (
        <SettingsPanel />
      ) : (
      <div className={turns.length === 0 && !justArchived ? "think opening" : "think"}>
      <div className="stream">
        {turns.length === 0 && !justArchived && (
          <p className="empty">
            <strong>Think out loud.</strong>
            Nothing is organised while the conversation runs — that happens
            after.
            <span className="empty-hint">
              Press <b>Done</b> to close a session and let it be read back.
            </span>
          </p>
        )}

        {turns.length === 0 && justArchived && (
          <p className="empty">
            {justArchived.reason === "idle"
              ? "That session went quiet and has been filed."
              : "Filed."}{" "}
            {justArchived.turn_count} turns kept.
            <br />
            <span className="muted">Start again whenever.</span>
          </p>
        )}

        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
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

        {error && <div className="error">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
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
          <Mic
            onPhrase={(text) =>
              // Dictation fills the box; it never sends. The user edits before
              // anything becomes a turn, which keeps a misheard word from
              // becoming a quote that looks authoritative.
              setDraft((d) => (d ? `${d.trimEnd()} ${text}` : text))
            }
            disabled={streaming}
          />
          <span className="spacer" />
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
      )}
      </div>

      <div className="statusbar">
        {provider ? `${provider.label} · ${provider.model}` : "no model"}
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
