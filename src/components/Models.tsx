import { useCallback, useEffect, useState } from "react";
import { startup, type Detected, type ModelInfo } from "../lib/chat";
import {
  activeModels,
  chooseModel,
  clearAnthropicKey,
  keyStatus,
  setAnthropicKey,
  type ActiveModels,
  type KeyStatus,
} from "../lib/settings";

type Role = "chat" | "extraction";

const ROLES: { role: Role; title: string; blurb: string }[] = [
  {
    role: "chat",
    title: "The model you talk to",
    blurb:
      "Answers you while you think out loud. It is never given instructions about this app — it behaves exactly as it would anywhere else.",
  },
  {
    role: "extraction",
    title: "The model that reads it back",
    blurb:
      "Pulls out your ideas afterwards and judges whether a new one is the same as an old one. A mechanical, structured job — a small fast model usually does fine, and reasoning models are a poor fit.",
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

  const refresh = useCallback(async () => {
    try {
      // Sequential, not concurrent: startup() is what selects a model when the
      // choice is unambiguous, so asking what is active before it finishes
      // reports nothing chosen.
      const s = await startup();
      setServers(s.servers);
      setActive(await activeModels());
      setKeys(await keyStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  const usable = servers.filter((s) => chatModels(s).length > 0);

  const serverName = (kind: string) =>
    ({
      lmstudio: "LM Studio",
      ollama: "Ollama",
      anthropic: "Anthropic",
      claudecli: "Claude CLI (your subscription)",
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
    <div className="panel">
      {error && <p className="error">{error}</p>}

      <section className="model-role">
        <h2 className="panel-title">Anthropic</h2>
        <p className="panel-blurb">
          Optional. Everything works without this — the app finds local models on
          its own. A key sends whatever you extract to Anthropic's servers rather
          than keeping it on this machine.
        </p>
        {keys?.anthropic ? (
          <div className="choice-row">
            <span className="tag ready">key saved</span>
            <button
              className="choice"
              onClick={() => clearAnthropicKey().then(refresh)}
            >
              Remove it
            </button>
          </div>
        ) : (
          <div className="key-row">
            <input
              type="password"
              className="key-input"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveKey()}
            />
            <button
              className="done"
              disabled={keyBusy || !keyInput.trim()}
              onClick={() => void saveKey()}
            >
              {keyBusy ? "Checking…" : "Save"}
            </button>
          </div>
        )}
        <p className="panel-blurb">
          Stored in your system keychain, never in the app's settings file. It is
          checked against the API before being saved.
        </p>
        {keys?.claude_cli && (
          <p className="panel-blurb">
            The <code>claude</code> command is installed, so your Claude
            subscription is also available without a key. It rides a plan meant
            for interactive use, so treat it as a convenience rather than
            something to depend on.
          </p>
        )}
      </section>

      {usable.length === 0 ? (
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
              <h2 className="panel-title">{title}</h2>
              <p className="panel-blurb">{blurb}</p>
              <p className="model-current">
                {chosen ? (
                  <>
                    Using <b>{chosen.model}</b> on {chosen.label}
                  </>
                ) : (
                  "Nothing chosen yet"
                )}
              </p>

              {usable.map((s) => (
                <div key={s.kind} className="model-server">
                  <h3 className="deep-section">
                    {serverName(s.kind)}
                    {isRemote(s.kind) && <span className="tag remote">leaves this machine</span>}
                  </h3>
                  <ul className="model-list">
                    {chatModels(s)
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
      )}
    </div>
  );
}
