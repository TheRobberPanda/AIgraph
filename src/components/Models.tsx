import { useCallback, useEffect, useState } from "react";
import { startup, type Detected, type ModelInfo } from "../lib/chat";
import {
  activeModels,
  chooseModel,
  clearAnthropicKey,
  getSettings,
  keyStatus,
  saveSettings,
  setAnthropicKey,
  type ActiveModels,
  type KeyStatus,
  type Settings,
  downloadEmbeddedModel,
  embeddedStatus,
  startEmbedded,
  stopEmbedded,
  type EmbeddedStatus,
} from "../lib/settings";
import { onDownloadProgress, type DownloadProgress } from "../lib/dictation";

type Role = "chat" | "extraction";

/** Where a model comes from. One tab each, because the setup is different. */
type Source = "local" | "cloud" | "inapp";

const SOURCES: { id: Source; label: string; blurb: string }[] = [
  {
    id: "local",
    label: "On this machine",
    blurb:
      "LM Studio or Ollama, running alongside the app. Whatever they have loaded is used automatically; nothing leaves this machine.",
  },
  {
    id: "cloud",
    label: "Cloud",
    blurb:
      "Anthropic's API, or a Claude subscription through the claude command. Transcripts leave this machine.",
  },
  {
    id: "inapp",
    label: "In the app",
    blurb:
      "A model the app downloads and runs itself, with nothing else to install.",
  },
];

/** The model the app will run itself. Apache 2.0, so it can be built on. */
/** The context sizes offered, as slider stops. */
const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

const BUNDLED = {
  name: "Bonsai 27B",
  repo: "prism-ml/Bonsai-27B-gguf",
  file: "Bonsai-27B-Q1_0.gguf",
  size: "3.8 GB",
  licence: "Apache 2.0",
  context: "262K tokens",
  note: "A 1-bit build of Qwen3.6-27B. Reasoning and coding at 27B class, in under four gigabytes.",
};

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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [embedded, setEmbedded] = useState<EmbeddedStatus | null>(null);
  const [pulling, setPulling] = useState<DownloadProgress | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Sequential, not concurrent: startup() is what selects a model when the
      // choice is unambiguous, so asking what is active before it finishes
      // reports nothing chosen.
      const s = await startup();
      setServers(s.servers);
      setActive(await activeModels());
      setKeys(await keyStatus());
      setSettings(await getSettings());
      setEmbedded(await embeddedStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The weights come down on the same channel the speech model uses.
  useEffect(() => {
    const p = onDownloadProgress(setPulling);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  async function pullModel() {
    setError(null);
    try {
      await downloadEmbeddedModel();
      setEmbedded(await embeddedStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setPulling(null);
    }
  }

  async function runEmbedded() {
    setStarting(true);
    setError(null);
    try {
      if (embedded?.running) await stopEmbedded();
      else await startEmbedded();
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

  /** Runtime knobs for the bundled model. Saved as they are changed. */
  async function patchRuntime(patch: Partial<Settings["runtime"]>) {
    if (!settings) return;
    const next = { ...settings, runtime: { ...settings.runtime, ...patch } };
    setSettings(next);
    try {
      await saveSettings(next);
    } catch (e) {
      setError(String(e));
    }
  }

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

      {source === "local" && loadedCount > 0 && (
        <div className="row">
          <button className={showAll ? "btn on" : "btn"} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Showing every model" : "Show models that aren't loaded"}
          </button>
          <button className="btn" onClick={() => void refresh()}>
            Look again
          </button>
        </div>
      )}

      {source === "local" && (usable.length === 0 ? (
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
                              <span className="model-name">{m.id}</span>
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

      {source === "inapp" && (
        <>
          <section className="model-role">
            <h2 className="section">{BUNDLED.name}</h2>
            <p className="blurb">{BUNDLED.note}</p>
            <ul className="plain-list bundled-facts">
              <li>
                <b>{BUNDLED.size}</b> — downloaded once, on first use
              </li>
              <li>
                <b>{BUNDLED.licence}</b> — open weights, free to build on
              </li>
              <li>
                <b>{BUNDLED.context}</b> of context
              </li>
              <li>
                <code>
                  {BUNDLED.repo}/{BUNDLED.file}
                </code>
              </li>
            </ul>
            {pulling ? (
              <p className="blurb">
                Downloading — {(pulling.received / 1e9).toFixed(2)} GB
                {pulling.total > 0 && ` of ${(pulling.total / 1e9).toFixed(2)} GB`}
              </p>
            ) : !embedded?.model_ready ? (
              <div className="row">
                <button className="btn on" onClick={() => void pullModel()}>
                  Download the model ({embedded?.download_gb.toFixed(1) ?? "3.8"} GB)
                </button>
              </div>
            ) : !embedded.server_ready ? (
              <>
                <p className="blurb">
                  <span className="tag ready">weights ready</span> Still needs
                  llama.cpp&apos;s <code>llama-server</code> to run them.
                </p>
                <p className="blurb">
                  Put <code>llama-server</code> on your PATH, or drop the binary in{" "}
                  <code>llm/</code> beside the model. It is run as a separate
                  process on purpose — a model that fails to load takes itself
                  down rather than the app, and the GPU builds already exist
                  prebuilt upstream.
                </p>
              </>
            ) : (
              <div className="row">
                <button
                  className={embedded.running ? "btn on" : "btn"}
                  disabled={starting}
                  onClick={() => void runEmbedded()}
                >
                  {starting
                    ? "Starting…"
                    : embedded.running
                      ? "Running — stop it"
                      : "Start it"}
                </button>
                <span className="row-meta">{embedded.host}</span>
              </div>
            )}
          </section>

          {settings && (
            <section className="model-role">
              <h2 className="section">How it runs</h2>
              <p className="blurb">
                These decide whether a 27B model is pleasant or painful on a
                given machine. They are read when the model is started, so
                change them before starting it rather than during.
              </p>

              <div className="row runtime-row">
                <label htmlFor="ctx">Context length</label>
                <input
                  id="ctx"
                  type="range"
                  className="scale-slider"
                  min={0}
                  max={CONTEXTS.length - 1}
                  step={1}
                  value={Math.max(0, CONTEXTS.indexOf(settings.runtime.context_length))}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      runtime: {
                        ...settings.runtime,
                        context_length: CONTEXTS[Number(e.target.value)],
                      },
                    })
                  }
                  onMouseUp={() => void patchRuntime({})}
                  onKeyUp={() => void patchRuntime({})}
                />
                <span className="scale-value">
                  {settings.runtime.context_length >= 1024
                    ? `${settings.runtime.context_length / 1024}K`
                    : settings.runtime.context_length}
                </span>
              </div>

              <div className="row runtime-row">
                <label htmlFor="gpu">GPU offload</label>
                <input
                  id="gpu"
                  type="range"
                  className="scale-slider"
                  min={0}
                  max={64}
                  step={1}
                  value={settings.runtime.gpu_layers}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      runtime: { ...settings.runtime, gpu_layers: Number(e.target.value) },
                    })
                  }
                  onMouseUp={() => void patchRuntime({})}
                  onKeyUp={() => void patchRuntime({})}
                />
                <span className="scale-value">
                  {settings.runtime.gpu_layers === 0
                    ? "CPU only"
                    : `${settings.runtime.gpu_layers} layers`}
                </span>
              </div>

              <div className="row">
                <button
                  className={settings.runtime.kv_cache_on_gpu ? "btn on" : "btn"}
                  onClick={() =>
                    void patchRuntime({ kv_cache_on_gpu: !settings.runtime.kv_cache_on_gpu })
                  }
                >
                  KV cache in GPU memory
                </button>
                <button
                  className={settings.runtime.keep_in_memory ? "btn on" : "btn"}
                  onClick={() =>
                    void patchRuntime({ keep_in_memory: !settings.runtime.keep_in_memory })
                  }
                >
                  Keep model loaded
                </button>
              </div>
              <p className="blurb">
                The KV cache is faster on the GPU but takes memory the conversation
                model may want. Keeping the model loaded avoids a reload each
                session and holds the memory meanwhile.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
