import { useCallback, useEffect, useState } from "react";
import RuntimePanel from "./Runtime";
import { modelName } from "../lib/format";
import { IconDownload, IconPlay, IconStop } from "./Icons";
import { startup, type Detected, type ModelInfo } from "../lib/chat";
import {
  activeModels,
  chooseModel,
  clearAnthropicKey,
  clearOpenRouterKey,
  setOpenRouterKey,
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

const SOURCES: { id: Source; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "lmstudio", label: "LM Studio" },
  { id: "ollama", label: "Ollama" },
  { id: "cloud", label: "Cloud API" },
];

const ROLES: { role: Role; title: string; blurb: string }[] = [
  {
    role: "chat",
    title: "The model in the conversation",
    blurb: "Holds up the other end of the conversation.",
  },
  {
    role: "extraction",
    title: "The model that reads it back",
    blurb:
      "Records the ideas and judges repeats. A small fast model does fine; reasoning models are a poor fit.",
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
  /** Narrowing the cloud lists — OpenRouter alone exposes hundreds. */
  const [cloudQuery, setCloudQuery] = useState("");
  /** Which provider the pasted key belongs to, from its prefix. */
  const detectedProvider = (() => {
    const k = keyInput.trim();
    if (k.startsWith("sk-ant-")) {
      return {
        label: "Anthropic",
        blurb: "Anthropic key — checked against their API, then stored in the system keychain.",
        save: () => setAnthropicKey(k),
      };
    }
    if (k.startsWith("sk-or-")) {
      return {
        label: "OpenRouter",
        blurb:
          "OpenRouter key — one key for Claude, GPT, Gemini, Llama and the rest. Checked, then stored in the system keychain.",
        save: () => setOpenRouterKey(k),
      };
    }
    return null;
  })();

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
  /**
   * Only the servers the chosen tab is about.
   *
   * These were filtered by nothing at all, so the Ollama tab listed LM
   * Studio's models — and both listed the cloud providers, which have chat
   * models like anything else. A tab that shows another tab's contents is
   * not a tab; picking a source has to actually mean something.
   */
  const here = servers.filter((s) =>
    source === "lmstudio"
      ? s.kind === "lmstudio"
      : source === "ollama"
        ? s.kind === "ollama"
        : source === "local"
          ? s.kind === "embedded"
          : isRemote(s.kind),
  );
  const loadedCount = here.reduce((n, s) => n + loadedModels(s).length, 0);
  const usable = here.filter((s) => chatModels(s).length > 0);

  const serverName = (kind: string) =>
    ({
      lmstudio: "LM Studio",
      ollama: "Ollama",
      anthropic: "Anthropic",
      openrouter: "OpenRouter",
      claudecli: "Claude CLI (subscription)",
    })[kind] ?? kind;

  const isRemote = (kind: string) =>
    kind === "anthropic" || kind === "claudecli" || kind === "openrouter";

  /** Key-gated providers, detected only once usable — the cloud pickers. */
  const remote = servers.filter((s) => isRemote(s.kind) && chatModels(s).length > 0);

  /** One save path for whatever provider the pasted key belongs to. */
  async function saveDetectedKey() {
    if (!detectedProvider) return;
    setKeyBusy(true);
    setError(null);
    try {
      await detectedProvider.save();
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

      {source === "cloud" && (
        <>
          <section className="model-role">
            <h2 className="section">API key</h2>
            <p className="blurb">
              Paste a key — the provider is detected from it. Transcripts leave
              this machine.
            </p>
            {keys?.anthropic || keys?.openrouter || keys?.claude_cli ? (
              <div className="row">
                {keys?.anthropic && (
                  <>
                    <span className="tag ready">Anthropic key saved</span>
                    <button className="btn" onClick={() => clearAnthropicKey().then(refresh)}>
                      Remove
                    </button>
                  </>
                )}
                {keys?.openrouter && (
                  <>
                    <span className="tag ready">OpenRouter key saved</span>
                    <button className="btn" onClick={() => clearOpenRouterKey().then(refresh)}>
                      Remove
                    </button>
                  </>
                )}
                {keys?.claude_cli && <span className="tag ready">claude CLI found</span>}
              </div>
            ) : null}

            {!(keys?.anthropic && keys?.openrouter) && (
              <div className="row">
                <input
                  type="password"
                  className="field"
                  placeholder="Paste an API key — sk-ant-… or sk-or-…"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveDetectedKey()}
                />
                <button
                  className="btn"
                  disabled={keyBusy || !keyInput.trim()}
                  onClick={() => void saveDetectedKey()}
                >
                  {keyBusy
                    ? "Checking…"
                    : detectedProvider
                      ? `Save — ${detectedProvider.label}`
                      : "Save"}
                </button>
              </div>
            )}
            {keyInput.trim() && !detectedProvider && (
              <p className="blurb warn">
                Not a key this app recognises — it should start with{" "}
                <code>sk-ant-</code> (Anthropic) or <code>sk-or-</code> (OpenRouter).
              </p>
            )}
            {detectedProvider && (
              <p className="blurb">{detectedProvider.blurb}</p>
            )}
          </section>

          {/* Whatever the saved keys can reach, as pickers. The lists arrive
              from startup() the same way the local ones do — a provider is
              only detected once it is usable, so an empty list here means the
              key is missing or was rejected. */}
          {source === "cloud" && remote.length > 0 && (
            <>
              <div className="row filters">
                <input
                  className="field filter-input"
                  placeholder="Filter models — claude, gpt, llama…"
                  value={cloudQuery}
                  onChange={(e) => setCloudQuery(e.target.value)}
                />
              </div>
              {remote.map((s) =>
                ROLES.map(({ role, title }) => {
                  const chosen = role === "chat" ? active?.chat : active?.extraction;
                  // The API hands back duplicates; one row per model.
                  const all = [
                    ...new Map(chatModels(s).map((m) => [m.id, m])).values(),
                  ].sort((a, b) => a.id.localeCompare(b.id));
                  const q = cloudQuery.trim().toLowerCase();
                  // Bounded, or OpenRouter's three hundred models would be one
                  // unending wall. The filter is how the rest are reached.
                  const models = (
                    q ? all.filter((m) => m.id.toLowerCase().includes(q)) : all
                  ).slice(0, 40);
                  return (
                    <section key={`${s.kind}:${role}`} className="model-role">
                      <h3 className="section">
                        {title} · {serverName(s.kind)}
                        <span className="tag remote">leaves this machine</span>
                      </h3>
                      <p className="current">
                        {chosen && chosen.kind === s.kind ? (
                          <>Using <b>{chosen.model}</b></>
                        ) : (
                          "Nothing chosen yet"
                        )}
                      </p>
                      <ul className="model-list">
                        {models.map((m) => {
                          const isChosen = chosen?.kind === s.kind && chosen?.model === m.id;
                          return (
                            <li key={m.id}>
                              <button
                                className={isChosen ? "model chosen" : "model"}
                                disabled={busy !== null}
                                onClick={() => void pick(role, s, m)}
                              >
                                <span className="model-name">{modelName(m.id)}</span>
                                {isChosen && <span className="tag ready">in use</span>}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {all.length > models.length && (
                        <p className="blurb">
                          {all.length - models.length} more — narrow the filter above.
                        </p>
                      )}
                    </section>
                  );
                }),
              )}
            </>
          )}

          {source === "cloud" && remote.length === 0 && (
            <p className="empty">
              <strong>No cloud model connected.</strong>
              <span className="empty-hint">
                Save a key above — the models it can reach appear here, ready to pick.
              </span>
            </p>
          )}
        </>
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
          <strong>
            {source === "lmstudio" ? "LM Studio is not running." : "Ollama is not running."}
          </strong>
          {source === "lmstudio" ? (
            <>Start it and load a model.</>
          ) : (
            <>
              Run <code>ollama serve</code> after pulling one.
            </>
          )}
          <span className="empty-hint">
            Then come back — this page finds them automatically.
          </span>
        </p>
      ) : (
        ROLES.map(({ role, blurb }) => {
          const chosen = role === "chat" ? active?.chat : active?.extraction;
          return (
            <section key={role} className="model-role">
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
