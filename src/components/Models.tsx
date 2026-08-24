import { useCallback, useEffect, useState } from "react";
import RuntimePanel from "./Runtime";
import { modelName } from "../lib/format";
import { IconDownload, IconPlay, IconStop } from "./Icons";
import { startup, type Detected, type ModelInfo } from "../lib/chat";
import {
  activeModels,
  chooseModel,
  clearAnthropicKey,
  keyStatus,
  setAnthropicKey,
  type ActiveModels,
  type KeyStatus,
  downloadEmbeddedModel,
  embeddedStatus,
  startEmbedded,
  stopEmbedded,
  onModelDownload,
  searchModels,
  modelFiles,
  downloadModelFile,
  type EmbeddedStatus,
  type RemoteModel,
  type RemoteFile,
} from "../lib/settings";

type Role = "chat" | "extraction";

/** Where a model comes from. One tab each, because the setup is different. */
/**
 * Where the model comes from.
 *
 * Flat, and named after the thing rather than the category. It was two levels
 * — Local, then "in the app" or "my own server" — which meant two clicks and a
 * taxonomy lesson to reach the four answers that actually exist.
 */
type Source = "local" | "lmstudio" | "ollama" | "cloud";

const SOURCES: { id: Source; label: string; blurb: string }[] = [
  {
    id: "local",
    label: "Local",
    blurb:
      "The app downloads a model and an engine and runs them itself. Nothing else to install, and nothing said to it leaves this machine.",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    blurb: "Running alongside the app. Whatever it has loaded is used automatically.",
  },
  {
    id: "ollama",
    label: "Ollama",
    blurb: "Running alongside the app. Whatever it has pulled is offered here.",
  },
  {
    id: "cloud",
    label: "Cloud API",
    blurb:
      "Claude, and anything else that speaks the same API. Transcripts leave this machine.",
  },
];

const ROLES: { role: Role; title: string; blurb: string }[] = [
  {
    role: "chat",
    title: "The model in the conversation",
    blurb:
      "Holds up the other end of the conversation. It is never given instructions about this app — it behaves exactly as it would anywhere else.",
  },
  {
    role: "extraction",
    title: "The model that reads it back",
    blurb:
      "Reads the session back afterwards, records the ideas in it, and judges whether a new one repeats an older one. A mechanical, structured job — a small fast model usually does fine, and reasoning models are a poor fit.",
  },
];

export default function Models() {
  const [servers, setServers] = useState<Detected[]>([]);
  const [active, setActive] = useState<ActiveModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [source, setSource] = useState<Source>("local");

  const [showAll, setShowAll] = useState(false);
  const [embedded, setEmbedded] = useState<EmbeddedStatus | null>(null);
  const [pulling, setPulling] = useState<{ received: number; total: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<RemoteModel[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<RemoteFile[] | null>(null);
  const [chosenFile, setChosenFile] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Sequential, not concurrent: startup() is what selects a model when the
      // choice is unambiguous, so asking what is active before it finishes
      // reports nothing chosen.
      const s = await startup();
      setServers(s.servers);
      setActive(await activeModels());
      setKeys(await keyStatus());
      setEmbedded(await embeddedStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const p = onModelDownload((x) => setPulling({ received: x.received, total: x.total }));
    return () => {
      void p.then((un) => un());
    };
  }, []);

  async function pullModel() {
    setError(null);
    // Set before awaiting: the first progress event is a long way off on a
    // 3.8 GB file, and until now the button simply sat there looking ignored.
    setPulling({ received: 0, total: 0 });
    try {
      await downloadEmbeddedModel();
      setEmbedded(await embeddedStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setPulling(null);
    }
  }

  async function runSearch() {
    setSearching(true);
    setError(null);
    setOpenRepo(null);
    setRepoFiles(null);
    try {
      setFound(await searchModels(query));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function openFiles(repo: string) {
    if (openRepo === repo) {
      setOpenRepo(null);
      return;
    }
    setOpenRepo(repo);
    setRepoFiles(null);
    try {
      setRepoFiles(await modelFiles(repo));
    } catch (e) {
      setError(String(e));
    }
  }

  async function pullFile(repo: string, f: RemoteFile) {
    setError(null);
    setPulling({ received: 0, total: f.size });
    try {
      await downloadModelFile(repo, f.path, f.size);
      setEmbedded(await embeddedStatus());
      setBrowse(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setPulling(null);
    }
  }

  async function runEmbedded(file?: string) {
    setStarting(true);
    setError(null);
    try {
      if (embedded?.running) await stopEmbedded();
      else await startEmbedded(file ?? chosenFile);
      setEmbedded(await embeddedStatus());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function pick(role: Role, s: Detected, m: ModelInfo) {
    setBusy(`${role}:${m.id}`);
    setError(null);
    try {
      await chooseModel(role, s.kind, s.host, m.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const chatModels = (s: Detected) => s.models.filter((m) => m.kind === "chat");
  /** What a server actually has in memory right now. */
  const loadedModels = (s: Detected) => chatModels(s).filter((m) => m.loaded === true);
  const loadedCount = servers.reduce((n, s) => n + loadedModels(s).length, 0);
  const usable = servers.filter((s) => chatModels(s).length > 0);

  const serverName = (kind: string) =>
    ({
      lmstudio: "LM Studio",
      ollama: "Ollama",
      anthropic: "Anthropic",
      claudecli: "Claude CLI (subscription)",
    })[kind] ?? kind;

  const isRemote = (kind: string) => kind === "anthropic" || kind === "claudecli";

  async function saveKey() {
    setKeyBusy(true);
    setError(null);
    try {
      await setAnthropicKey(keyInput);
      setKeyInput("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <div className="pane-inner">
      {error && <p className="error">{error}</p>}

      <div className="row source-tabs">
        {SOURCES.map((t) => (
          <button
            key={t.id}
            className={source === t.id ? "btn on" : "btn"}
            onClick={() => setSource(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="blurb">{SOURCES.find((t) => t.id === source)!.blurb}</p>



      {source === "cloud" && (
      <section className="model-role">
        <h2 className="section">Anthropic</h2>
        <p className="blurb">
          Optional. Everything works without this — local models are found
          automatically. A key sends transcripts to Anthropic's servers rather
          than keeping them on this machine.
        </p>
        {keys?.anthropic ? (
          <div className="row">
            <span className="tag ready">key saved</span>
            <button
              className="btn"
              onClick={() => clearAnthropicKey().then(refresh)}
            >
              Remove it
            </button>
          </div>
        ) : (
          <div className="row">
            <input
              type="password"
              className="field"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveKey()}
            />
            <button
              className="btn"
              disabled={keyBusy || !keyInput.trim()}
              onClick={() => void saveKey()}
            >
              {keyBusy ? "Checking…" : "Save"}
            </button>
          </div>
        )}
        <p className="blurb">
          Stored in the system keychain, never in the settings file, and checked
          against the API before it is saved.
        </p>
        {keys?.claude_cli && (
          <p className="blurb">
            The <code>claude</code> command is installed, so a Claude
            subscription can be used without a key. It rides a plan meant for
            interactive use — a convenience rather than something to depend on.
          </p>
        )}
      </section>
      )}

      {(source === "lmstudio" || source === "ollama") && loadedCount > 0 && (
        <div className="row">
          <button className={showAll ? "btn on" : "btn"} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Showing every model" : "Show models that aren't loaded"}
          </button>
          <button className="btn" onClick={() => void refresh()}>
            Look again
          </button>
        </div>
      )}

      {(source === "lmstudio" || source === "ollama") && (usable.length === 0 ? (
        <p className="empty">
          <strong>No model server found.</strong>
          Start <b>LM Studio</b> and load a model, or run <code>ollama serve</code>{" "}
          after pulling one.
          <span className="empty-hint">
            Then come back — this page finds them automatically.
          </span>
        </p>
      ) : (
        ROLES.map(({ role, title, blurb }) => {
          const chosen = role === "chat" ? active?.chat : active?.extraction;
          return (
            <section key={role} className="model-role">
              <h2 className="section">{title}</h2>
              <p className="blurb">{blurb}</p>
              <p className="current">
                {chosen ? (
                  <>
                    Using <b>{chosen.model}</b> on {chosen.label}
                    {loadedCount === 1 && " — the only one loaded, so it was picked for you"}
                  </>
                ) : (
                  "Nothing chosen yet"
                )}
              </p>

              {usable.map((s) => (
                <div key={s.kind} className="model-server">
                  <h3 className="section">
                    {serverName(s.kind)}
                    {isRemote(s.kind) && <span className="tag remote">leaves this machine</span>}
                  </h3>
                  <ul className="model-list">
                    {/* What is loaded comes first, and when only one thing is
                        loaded anywhere it has already been adopted — there is
                        nothing to choose. The rest stay listed, marked, since
                        LM Studio will load one on demand. */}
                    {(showAll ? chatModels(s) : loadedModels(s).length ? loadedModels(s) : chatModels(s))
                      .slice()
                      .sort(
                        (a, b) =>
                          Number(b.loaded ?? true) - Number(a.loaded ?? true) ||
                          a.id.localeCompare(b.id),
                      )
                      .map((m) => {
                        const isChosen = chosen?.model === m.id;
                        return (
                          <li key={m.id}>
                            <button
                              className={isChosen ? "model chosen" : "model"}
                              disabled={busy !== null}
                              onClick={() => void pick(role, s, m)}
                            >
                              <span className="model-name">{modelName(m.id)}</span>
                              {m.loaded === true && <span className="tag ready">loaded</span>}
                              {m.loaded === false && (
                                <span className="tag">needs loading</span>
                              )}
                              {isChosen && <span className="tag ready">in use</span>}
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              ))}
            </section>
          );
        })
      ))}

      {source === "local" && (
        <>
          <section className="model-role">
            {/* No heading: the only thing under it now is a download button
                that appears when there is nothing downloaded, and a heading
                over an empty space is a heading over nothing. */}
            {pulling ? (
              <div className="pulling">
                <div className="pulling-head">
                  <span className="spinner" aria-hidden="true" />
                  {pulling.received === 0
                    ? "Starting the download…"
                    : `${(pulling.received / 1e9).toFixed(2)} GB${
                        pulling.total > 0 ? ` of ${(pulling.total / 1e9).toFixed(2)} GB` : ""
                      }`}
                </div>
                {pulling.total > 0 && (
                  <div className="pulling-bar">
                    <div
                      className="pulling-fill"
                      style={{ width: `${Math.min(100, (pulling.received / pulling.total) * 100)}%` }}
                    />
                  </div>
                )}
                <p className="blurb">
                  Keep the app open. It carries on if you go elsewhere in it.
                </p>
              </div>
            ) : (
              <div className="row">
                {!embedded?.model_ready && (
                  <button className="btn on" onClick={() => void pullModel()}>
                    Download Bonsai ({embedded?.download_gb.toFixed(1) ?? "3.8"} GB)
                  </button>
                )}
              </div>
            )}

            {browse && (
              <div className="hf">
                {/* Searched live rather than a list baked into the app: a
                    hardcoded catalogue is stale the week after it ships. */}
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSearch();
                  }}
                >
                  <input
                    className="field"
                    placeholder="Search GGUF models — qwen, gemma, phi…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button className="btn" type="submit" disabled={searching || !query.trim()}>
                    {searching ? "Searching…" : "Search"}
                  </button>
                </form>

                {found && found.length === 0 && <p className="blurb">Nothing matched that.</p>}

                <ul className="hf-list">
                  {found?.map((m) => (
                    <li key={m.id}>
                      <button className="hf-repo" onClick={() => void openFiles(m.id)}>
                        <span className="hf-id">{m.id}</span>
                        <span className="row-meta">
                          {m.downloads > 1e6
                            ? `${(m.downloads / 1e6).toFixed(1)}M`
                            : `${Math.round(m.downloads / 1000)}k`}{" "}
                          downloads
                        </span>
                      </button>

                      {openRepo === m.id && (
                        <div className="hf-files">
                          {!repoFiles ? (
                            <p className="blurb">Reading the files…</p>
                          ) : repoFiles.length === 0 ? (
                            <p className="blurb">No GGUF files in that one.</p>
                          ) : (
                            repoFiles.map((f) => (
                              <button
                                key={f.path}
                                className="hf-file"
                                onClick={() => void pullFile(m.id, f)}
                              >
                                <span className="hf-quant">{f.path}</span>
                                <span className="row-meta">
                                  {f.size > 0 ? `${(f.size / 1e9).toFixed(2)} GB` : "—"}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* One control per model: which one, and whether it is running.
                They were two sections and two buttons, which made "start" look
                like a separate thing you had to know to do rather than what
                picking a model means. */}
            {embedded && embedded.downloaded.length > 0 && (
              <div className="downloaded">

                <ul className="list model-list">
                  {embedded.downloaded.map((f) => {
                    const isRunning = embedded.running && (chosenFile === null || chosenFile === f);
                    return (
                      <li key={f}>
                        <button
                          className={isRunning ? "model-run on" : "model-run"}
                          disabled={starting || !embedded.server_ready}
                          data-tip={
                            !embedded.server_ready
                              ? "No engine yet — install one in Settings"
                              : isRunning
                                ? "Stop it and free the memory"
                                : "Start it"
                          }
                          onClick={() => {
                            setChosenFile(f);
                            void runEmbedded(f);
                          }}
                        >
                          <span className="model-run-icon" aria-hidden="true">
                            {starting && chosenFile === f ? (
                              <span className="spinner" />
                            ) : isRunning ? (
                              <IconStop />
                            ) : (
                              <IconPlay />
                            )}
                          </span>
                          <span className="row-main">{modelName(f)}</span>
                          <span className="row-meta">
                            {starting && chosenFile === f
                              ? "starting…"
                              : isRunning
                                ? "running"
                                : "stopped"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {/* On the end of the list, at the same size as the models in
                      it: another model is another row here, not an errand. */}
                  <li>
                    <button
                      className={browse ? "model-run add on" : "model-run add"}
                      data-tip={browse ? "Close the browser" : "Find another model on Hugging Face"}
                      onClick={() => setBrowse((b) => !b)}
                    >
                      <span className="model-run-icon" aria-hidden="true">
                        <IconDownload />
                      </span>
                      <span className="row-main">
                        {browse ? "Close the browser" : "Another model…"}
                      </span>
                    </button>
                  </li>
                </ul>
                {embedded.running && <p className="blurb">{embedded.host}</p>}
              </div>
            )}

            {embedded?.model_ready && !embedded.server_ready && (
              <p className="blurb warn">
                <span className="tag ready">weights ready</span> Nothing to run
                them with yet — install an engine in <b>Settings → The engine</b>.
              </p>
            )}
          </section>

          <RuntimePanel />
        </>
      )}
    </div>
  );
}
