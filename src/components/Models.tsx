import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RuntimePanel from "./Runtime";
import { modelName } from "../lib/format";
import { IconCheck, IconDownload, IconPlay, IconStop } from "./Icons";
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
  type ModelSort,
  type RemoteModel,
  type RemoteFile,
  testModel,
  openrouterCatalog,
  type ModelTest,
  type OpenRouterModel,
} from "../lib/settings";

/** Where a model comes from. One tab each, because the setup is different. */
/**
 * Where the model comes from.
 *
 * Flat, and named after the thing rather than the category. It was two levels
 * — Local, then "in the app" or "my own server" — which meant two clicks and a
 * taxonomy lesson to reach the four answers that actually exist.
 */
type Source = "local" | "lmstudio" | "ollama" | "cloud";

/**
 * Whether using this sends transcripts off the machine.
 *
 * Module scope, not the component body. It was declared below its first use —
 * `here`, which is built before it — and `const` bindings are in the temporal
 * dead zone until their line runs. Only the cloud branch of that ternary calls
 * it, so the Cloud API tab, and nothing else, threw
 * "Cannot access 'isRemote' before initialization" on every render.
 */
const isRemote = (kind: string) =>
  kind === "anthropic" || kind === "claudecli" || kind === "openrouter";

/** The hover on a model that cannot answer without reasoning first. */
const REASONING_ONLY_TIP =
  "Reasoning-only: this model always thinks before it answers and cannot be told not to. " +
  "It is asked to think as little as it allows, but replies and reads are still slow — " +
  "often minutes each. Pick one without this mark if speed matters.";

/** Why the tick matters, said once where the tick is. */
const STRUCTURED_TIP =
  "Structured output: the model is handed the exact JSON shape a read needs and held to it. " +
  "Without it the ideas come back as prose the app has to dig out, and more reads fail.";

/**
 * Whether a model can be held to a JSON schema. A tick where it can, a quiet
 * dash where it cannot, nothing where nobody said.
 */
function StructuredMark({ on }: { on: boolean | undefined }) {
  if (on === undefined) return <span className="model-json" />;
  return (
    <span
      className={on ? "model-json yes" : "model-json no"}
      data-tip={on ? STRUCTURED_TIP : "No structured output — reads rely on the model writing JSON unprompted."}
    >
      {on ? <IconCheck /> : "–"}
    </span>
  );
}

/** The hover on the second mark: no schema, so reads are more fragile. */
const NO_JSON_TIP =
  "No structured output: this model cannot be held to the JSON shape a read needs. " +
  "It is asked for JSON and usually gives it, but more reads fail or come back thin.";

/** Which cloud providers take a schema. OpenRouter says per model. */
const PROVIDER_STRUCTURED: Record<string, boolean | undefined> = {
  anthropic: true,
  claudecli: false,
};

const gb = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

/** 32768 is "32k" to everyone who has typed it; 200000 is "200k". */
const windowLabel = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 10000) / 100}M`
    : `${Math.round(tokens / (tokens % 1024 === 0 ? 1024 : 1000))}k`;

/** 12834876 is "12.8M"; 1016 is "1k". */
const countLabel = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;

/** How long ago, in the one unit that matters at that distance. */
function agoLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const days = (Date.now() - t) / 864e5;
  if (days < 1) return "today";
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** A repository's size in billions: the GGUF header's count, else its name. */
function billionsOf(m: RemoteModel): number | null {
  if (m.params) return m.params / 1e9;
  const named = fileFacts(m.id).params;
  return named ? parseFloat(named) : null;
}

const billionsLabel = (b: number | null) =>
  b === null ? "" : `${b >= 10 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, "")}B`;

/** What a GGUF file name gives away: its size class and quantisation. */
function fileFacts(name: string): { params: string | null; quant: string | null } {
  const params = name.match(/(?:^|[-_.])(\d+(?:\.\d+)?[bB])(?=[-_.]|$)/)?.[1]?.toUpperCase() ?? null;
  const quant =
    name.match(/(?:^|[-_.])(I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i)?.[1]?.toUpperCase() ?? null;
  return { params, quant };
}

/** The facts column shared by every local row. */
function LocalFacts({
  params,
  quant,
  size,
  context,
  extra,
}: {
  params?: string | null;
  quant?: string | null;
  size?: number | null;
  context?: number | null;
  extra?: string | null;
}) {
  return (
    <span className="model-facts">
      {extra && <span className="model-kind">{extra}</span>}
      <span className="model-params" data-tip="Parameters">{params ?? ""}</span>
      <span className="model-quant" data-tip="Quantisation — lower bits, smaller and rougher">
        {quant ?? ""}
      </span>
      <span className="model-size" data-tip="On disk">{size ? gb(size) : ""}</span>
      <span className="model-window" data-tip="Longest context it supports">
        {context ? windowLabel(context) : ""}
      </span>
      {/* llama.cpp, LM Studio and Ollama all hold a reply to a schema. */}
      <StructuredMark on={true} />
    </span>
  );
}

/** Column names over a facts column, so the numbers say what they are. */
function FactsHead({ cols }: { cols: string[] }) {
  return (
    <div className="model-facts-head" aria-hidden="true">
      <span className="model-name" />
      <span className="model-facts">
        {cols.map((c) => (
          <span key={c} className={`model-${c}`}>
            {c === "json" ? "JSON" : c === "window" ? "ctx" : c === "dl" ? "downloads" : c}
          </span>
        ))}
      </span>
    </div>
  );
}

const SOURCES: { id: Source; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "lmstudio", label: "LM Studio" },
  { id: "ollama", label: "Ollama" },
  { id: "cloud", label: "Cloud API" },
];

/**
 * One model, for everything.
 *
 * There were two pickers — the model in the conversation, and the model that
 * reads it back — because a small fast model does fine at extraction and a
 * larger one may be wanted for talking. They are still separate objects
 * underneath, since extraction must never borrow the chat's context; but
 * asking the question twice on screen was asking almost nobody's question,
 * and answering it once is what people were doing anyway.
 */
export default function Models({ initialSource }: { initialSource?: Source } = {}) {
  const [servers, setServers] = useState<Detected[]>([]);
  const [active, setActive] = useState<ActiveModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [source, setSource] = useState<Source>(initialSource ?? "local");
  /** Narrowing the cloud lists — OpenRouter alone exposes hundreds. */
  const [cloudQuery, setCloudQuery] = useState("");
  /** The connection test: which model is being asked, and what it said. */
  const [testing, setTesting] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, ModelTest>>({});
  /** OpenRouter's catalogue with prices and windows, when it answers. */
  const [catalog, setCatalog] = useState<OpenRouterModel[] | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  /** Narrowing the OpenRouter catalogue: provider, sort, price, window. */
  const [routerProvider, setRouterProvider] = useState("all");
  const [routerSort, setRouterSort] = useState<"newest" | "price" | "context" | "name">("newest");
  const [routerFree, setRouterFree] = useState(false);
  const [routerMaxPrice, setRouterMaxPrice] = useState<number | null>(null);
  const [routerMinContext, setRouterMinContext] = useState<number | null>(null);
  /** Only models that can be held to a schema — what reads work best with. */
  const [routerStructured, setRouterStructured] = useState(false);
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
  /** How the Hugging Face results are ordered, and how big a model may be. */
  const [hfSort, setHfSort] = useState<ModelSort>("downloads");
  const [hfMaxParams, setHfMaxParams] = useState<number | null>(null);
  /** Only the newest search may land: typing fires one per pause. */
  const searchSeq = useRef(0);
  /** A key is saved, but another one is being pasted anyway. */
  const [addingKey, setAddingKey] = useState(false);
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

  async function runSearch(q: string, sort: ModelSort) {
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    try {
      const got = await searchModels(q.trim(), sort);
      if (seq !== searchSeq.current) return;
      setFound(got);
    } catch (e) {
      if (seq === searchSeq.current) setError(String(e));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  // Searched as it is typed, the way the cloud list filters — and with
  // nothing typed, the most wanted GGUFs, so the browser never opens on an
  // empty box waiting for a word someone may not know yet.
  useEffect(() => {
    if (!browse) return;
    const id = window.setTimeout(() => void runSearch(query, hfSort), query.trim() ? 350 : 0);
    return () => window.clearTimeout(id);
  }, [browse, query, hfSort]);

  const hfRows = (found ?? []).filter((m) => {
    if (hfMaxParams === null) return true;
    const b = billionsOf(m);
    return b !== null && b <= hfMaxParams;
  });

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

  /**
   * Choose the model, for everything.
   *
   * There were two pickers: one for the conversation, one for reading it back
   * afterwards. They are still separate underneath — extraction must never
   * borrow the chat's context, and it gets its own object — but choosing them
   * apart was a question almost nobody wanted asked. One list, one answer,
   * both roles set from it.
   */
  async function pick(s: Detected, m: ModelInfo) {
    setBusy(m.id);
    setError(null);
    try {
      await chooseModel("chat", s.kind, s.host, m.id);
      await chooseModel("extraction", s.kind, s.host, m.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // `?? []` because a provider that answered without a usable list should
  // show as empty, not throw on the way to being drawn.
  const chatModels = (s: Detected) => (s.models ?? []).filter((m) => m.kind === "chat");
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
      setAddingKey(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setKeyBusy(false);
    }
  }

  /** Ask the chosen model, through its own provider, for one word. */
  async function runTest(s: Detected, model: string) {
    if (!model) return;
    const key = `${s.kind}/${model}`;
    setTesting(key);
    setError(null);
    try {
      const t = await testModel(s.kind, s.host, model);
      setTested((prev) => ({ ...prev, [key]: t }));
    } catch (e) {
      setTested((prev) => ({
        ...prev,
        [key]: { ok: false, ms: 0, reply: "", error: String(e) },
      }));
    } finally {
      setTesting(null);
    }
  }

  /** The catalogue is fetched once the OpenRouter picker is actually on screen. */
  const wantsCatalog = source === "cloud" && remote.some((s) => s.kind === "openrouter");
  useEffect(() => {
    if (!wantsCatalog || catalog !== null || catalogBusy) return;
    setCatalogBusy(true);
    openrouterCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]))
      .finally(() => setCatalogBusy(false));
  }, [wantsCatalog, catalog, catalogBusy]);

  /** The one control that answers "does this actually work". */
  const testRow = (s: Detected, model: string | undefined) => {
    if (!model) return null;
    const key = `${s.kind}/${model}`;
    const t = tested[key];
    return (
      <div className="model-test">
        <button
          className="btn subtle"
          disabled={testing !== null}
          data-tip="One tiny request to this model, through this provider"
          onClick={() => void runTest(s, model)}
        >
          {testing === key ? <span className="spinner" aria-hidden="true" /> : "Test it"}
        </button>
        {t && (
          <span className={t.ok ? "model-test-out ok" : "model-test-out failed"}>
            {t.ok ? (
              <>
                <IconCheck /> Answers — {(t.ms / 1000).toFixed(1)}s
                {t.reply && t.reply.toLowerCase() !== "ok" && (
                  <span className="muted"> · said “{t.reply}”</span>
                )}
              </>
            ) : (
              <>
                Will not answer · {t.error}
              </>
            )}
          </span>
        )}
      </div>
    );
  };

  /**
   * The OpenRouter list, as the catalogue says it, when it can be read.
   *
   * Prices and windows come with the catalogue; the ids-only listing the
   * provider probe carries is the fallback, so a failed fetch costs the
   * filters but not the picker.
   */
  const routerModels = useMemo(() => {
    const s = remote.find((x) => x.kind === "openrouter");
    if (!s) return null;
    const chosen = active?.chat;
    const ids = [...new Map(chatModels(s).map((m) => [m.id, m])).values()].map((m) => m.id);
    const all: (OpenRouterModel | { id: string; name?: string })[] =
      catalog && catalog.length > 0
        ? catalog
        : ids.map((id) => ({ id }));
    const q = cloudQuery.trim().toLowerCase();
    let rows = all.filter(
      (m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q),
    );
    if (routerProvider !== "all") {
      rows = rows.filter((m) => m.id.split("/")[0] === routerProvider);
    }
    if (routerFree) {
      rows = rows.filter(
        (m) => "prompt_price" in m && m.prompt_price === 0 && m.completion_price === 0,
      );
    }
    if (routerMaxPrice !== null) {
      rows = rows.filter((m) => "prompt_price" in m && m.prompt_price <= routerMaxPrice);
    }
    if (routerMinContext !== null) {
      rows = rows.filter((m) => "context" in m && m.context >= routerMinContext!);
    }
    if (routerStructured) {
      rows = rows.filter((m) => "structured" in m && m.structured);
    }
    const bySort = (
      a: (OpenRouterModel | { id: string; name?: string }),
      b: (OpenRouterModel | { id: string; name?: string }),
    ): number => {
      switch (routerSort) {
        case "price": {
          const pa = "prompt_price" in a ? a.prompt_price : Number.MAX_VALUE;
          const pb = "prompt_price" in b ? b.prompt_price : Number.MAX_VALUE;
          return pa - pb || a.id.localeCompare(b.id);
        }
        case "context": {
          const ca = "context" in a ? a.context : 0;
          const cb = "context" in b ? b.context : 0;
          return cb - ca || a.id.localeCompare(b.id);
        }
        case "name":
          return a.id.localeCompare(b.id);
        default:
          return ("created" in b ? b.created : 0) - ("created" in a ? a.created : 0) || a.id.localeCompare(b.id);
      }
    };
    rows = [...rows].sort(bySort);
    return { rows, chosen, all: all.length };
  }, [remote, catalog, active, cloudQuery, routerProvider, routerSort, routerFree, routerMaxPrice, routerMinContext, routerStructured]);

  const routerPrefixes = useMemo(() => {
    if (!catalog) return [];
    return [...new Set(catalog.map((m) => m.id.split("/")[0]))].sort((a, b) =>
      a.localeCompare(b),
    );
  }, [catalog]);

  const priceLabel = (n: number): string =>
    n === 0 ? "free" : n < 1 ? `$${n.toFixed(2)}/M` : `$${n.toFixed(n < 10 ? 2 : 0)}/M`;

  return (
    <div className="pane-inner">
      {error && <p className="error">{error}</p>}

      <div className="row source-tabs">
        {SOURCES.map((t) => (
          <button
            key={t.id}
            // Set apart from the three that run here: it is the one whose
            // transcripts leave the machine.
            className={`${source === t.id ? "btn on" : "btn"}${t.id === "cloud" ? " source-cloud" : ""}`}
            onClick={() => setSource(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {source === "cloud" && (
        <>
          <section className="model-role cloud-keys">
            <p className="blurb">Transcripts leave this machine.</p>
            {/* Once a key is in, the paste box is only in the way; it comes
                back on request, for a second provider. */}
            {(!(keys?.anthropic || keys?.openrouter) || addingKey) && (
            <div className="row key-row">
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
              {addingKey && (
                <button
                  className="btn subtle"
                  onClick={() => {
                    setAddingKey(false);
                    setKeyInput("");
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
            )}
            <div className="row key-status">
              {keys?.anthropic && (
                <>
                  <span className="tag ready">Anthropic key saved</span>
                  <button className="btn subtle" onClick={() => clearAnthropicKey().then(refresh)}>
                    Remove
                  </button>
                </>
              )}
              {keys?.openrouter && (
                <>
                  <span className="tag ready">OpenRouter key saved</span>
                  <button className="btn subtle" onClick={() => clearOpenRouterKey().then(refresh)}>
                    Remove
                  </button>
                </>
              )}
              {keys?.claude_cli && <span className="tag ready">claude CLI found</span>}
              {(keys?.anthropic || keys?.openrouter) && !addingKey && (
                <button className="btn subtle" onClick={() => setAddingKey(true)}>
                  Add another key
                </button>
              )}
            </div>
            {keyInput.trim() && !detectedProvider && (
              <p className="blurb warn">
                Not a key this app recognises — it should start with{" "}
                <code>sk-ant-</code> (Anthropic) or <code>sk-or-</code> (OpenRouter).
              </p>
            )}
            {detectedProvider && <p className="blurb">{detectedProvider.blurb}</p>}
          </section>

          {/* Whatever the saved keys can reach, as pickers. The lists arrive
              from startup() the same way the local ones do — a provider is
              only detected once it is usable, so an empty list here means the
              key is missing or was rejected. */}
          {remote.length > 0 && (
            <>
              {remote.map((s) => {
                const chosen = active?.chat;
                // OpenRouter gets the catalogue treatment; the rest keep the
                // plain listing, which is all their APIs offer.
                if (s.kind === "openrouter" && routerModels) {
                  const { rows } = routerModels;
                  const shown = rows.slice(0, 60);
                  return (
                    <section key={s.kind} className="model-role cloud">
                      <div className="cloud-head">
                        <h3 className="section">
                          {serverName(s.kind)}
                          <span className="tag remote">leaves this machine</span>
                        </h3>
                        <p className="current">
                          {chosen && chosen.kind === s.kind ? (
                            <>Using <b>{chosen.model}</b></>
                          ) : (
                            "Nothing chosen yet"
                          )}
                        </p>
                        {testRow(s, chosen?.kind === s.kind ? chosen.model : undefined)}
                      </div>
                      <div className="router-filters">
                        <input
                          className="field filter-input"
                          placeholder="Filter models — claude, gpt, llama…"
                          value={cloudQuery}
                          onChange={(e) => setCloudQuery(e.target.value)}
                        />
                        <select
                          className="field"
                          value={routerProvider}
                          onChange={(e) => setRouterProvider(e.target.value)}
                          aria-label="Provider"
                          data-tip="Which of OpenRouter's providers to list"
                        >
                          <option value="all">All providers</option>
                          {routerPrefixes.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                        <select
                          className="field"
                          value={routerSort}
                          onChange={(e) => setRouterSort(e.target.value as typeof routerSort)}
                          aria-label="Sort"
                        >
                          <option value="newest">Newest first</option>
                          <option value="price">Cheapest first</option>
                          <option value="context">Biggest window</option>
                          <option value="name">Name A–Z</option>
                        </select>
                        <button
                          className={routerFree ? "btn on" : "btn"}
                          data-tip="Only models that cost nothing per token"
                          onClick={() => setRouterFree((v) => !v)}
                        >
                          Free
                        </button>
                        <select
                          className="field"
                          value={routerMaxPrice ?? ""}
                          onChange={(e) =>
                            setRouterMaxPrice(e.target.value === "" ? null : Number(e.target.value))
                          }
                          aria-label="Highest price"
                          data-tip="Keep only models up to this price per million prompt tokens"
                        >
                          <option value="">Any price</option>
                          <option value="0.25">≤ $0.25/M</option>
                          <option value="1">≤ $1/M</option>
                          <option value="3">≤ $3/M</option>
                          <option value="10">≤ $10/M</option>
                        </select>
                        <select
                          className="field"
                          value={routerMinContext ?? ""}
                          onChange={(e) =>
                            setRouterMinContext(e.target.value === "" ? null : Number(e.target.value))
                          }
                          aria-label="Smallest window"
                          data-tip="Keep only models that can hold this much"
                        >
                          <option value="">Any window</option>
                          <option value="32768">≥ 32k</option>
                          <option value="131072">≥ 128k</option>
                          <option value="1000000">≥ 1M</option>
                        </select>
                        <button
                          className={routerStructured ? "btn on" : "btn"}
                          data-tip={STRUCTURED_TIP}
                          onClick={() => setRouterStructured((v) => !v)}
                        >
                          <IconCheck /> Structured
                        </button>
                      </div>
                      {catalog && catalog.length > 0 && <FactsHead cols={["price", "window", "json"]} />}
                      <ul className="model-list compact">
                        {shown.map((m) => {
                          const id = m.id;
                          const isChosen = chosen?.kind === s.kind && chosen?.model === id;
                          return (
                            <li key={id}>
                              <button
                                className={isChosen ? "model chosen" : "model"}
                                disabled={busy !== null}
                                onClick={() =>
                                  void pick(s, { id, loaded: null, kind: "chat" })
                                }
                              >
                                <span className="model-name">{m.id}</span>
                                <span className="model-facts">
                                  {"reasoning_mandatory" in m && m.reasoning_mandatory && (
                                    <span className="model-slow" data-tip={REASONING_ONLY_TIP}>
                                      !
                                    </span>
                                  )}
                                  {"created" in m && !m.structured && (
                                    <span className="model-nojson" data-tip={NO_JSON_TIP}>
                                      !
                                    </span>
                                  )}
                                  {"prompt_price" in m && (
                                    <span
                                      className="model-price"
                                      data-tip={`$${m.prompt_price.toFixed(2)} per million in · $${m.completion_price.toFixed(2)} per million out`}
                                    >
                                      {priceLabel(m.prompt_price)}
                                    </span>
                                  )}
                                  {"context" in m && (
                                    <span className="model-window">
                                      {m.context > 0 ? windowLabel(m.context) : ""}
                                    </span>
                                  )}
                                  {"created" in m && <StructuredMark on={!!m.structured} />}
                                  {isChosen && <span className="tag ready">in use</span>}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {rows.length > shown.length && (
                        <p className="blurb">
                          {rows.length - shown.length} more — narrow it with the filters above.
                        </p>
                      )}
                      {catalogBusy && <p className="blurb">Reading the catalogue…</p>}
                    </section>
                  );
                }
                // Any other cloud provider: the plain list.
                const all = [
                  ...new Map(chatModels(s).map((m) => [m.id, m])).values(),
                ].sort((a, b) => a.id.localeCompare(b.id));
                const q = cloudQuery.trim().toLowerCase();
                const models = (
                  q ? all.filter((m) => m.id.toLowerCase().includes(q)) : all
                ).slice(0, 40);
                return (
                  <section key={s.kind} className="model-role cloud">
                    <div className="cloud-head">
                      <h3 className="section">
                        {serverName(s.kind)}
                        <span className="tag remote">leaves this machine</span>
                      </h3>
                      <p className="current">
                        {chosen && chosen.kind === s.kind ? (
                          <>Using <b>{chosen.model}</b></>
                        ) : (
                          "Nothing chosen yet"
                        )}
                      </p>
                      {testRow(s, chosen?.kind === s.kind ? chosen?.model : undefined)}
                    </div>
                    <input
                      className="field filter-input"
                      placeholder="Filter models"
                      value={cloudQuery}
                      onChange={(e) => setCloudQuery(e.target.value)}
                    />
                    <ul className="model-list compact">
                      {models.map((m) => {
                        const isChosen = chosen?.kind === s.kind && chosen?.model === m.id;
                        return (
                          <li key={m.id}>
                            <button
                              className={isChosen ? "model chosen" : "model"}
                              disabled={busy !== null}
                              onClick={() => void pick(s, m)}
                            >
                              <span className="model-name">{m.id}</span>
                              <span className="model-facts">
                                {PROVIDER_STRUCTURED[s.kind] === false && (
                                  <span className="model-nojson" data-tip={NO_JSON_TIP}>
                                    !
                                  </span>
                                )}
                                <StructuredMark on={PROVIDER_STRUCTURED[s.kind]} />
                                {isChosen && <span className="tag ready">in use</span>}
                              </span>
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
              })}
            </>
          )}

          {remote.length === 0 && (
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
        (() => {
          const chosen = active?.chat;
          const picked = servers.find((x) => x.kind === chosen?.kind);
          return (
            <section className="model-role">
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
              {/* The same check the cloud pickers get: a list is what the
                  server *has*, and only an answer says the model works. */}
              {testRow(
                picked ?? ({ kind: chosen?.kind, host: "", models: [] } as Detected),
                chosen?.model,
              )}

              {usable.map((s) => (
                <div key={s.kind} className="model-server">
                  <h3 className="section">
                    {serverName(s.kind)}
                    {isRemote(s.kind) && <span className="tag remote">leaves this machine</span>}
                  </h3>
                  <FactsHead cols={["params", "quant", "size", "window", "json"]} />
                  <ul className="model-list compact">
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
                              onClick={() => void pick(s, m)}
                            >
                              <span className="model-name">{modelName(m.id)}</span>
                              {m.loaded === true && <span className="tag ready">loaded</span>}
                              {m.loaded === false && (
                                <span className="tag">needs loading</span>
                              )}
                              {m.details?.vision && <span className="tag">sees images</span>}
                              {isChosen && <span className="tag ready">in use</span>}
                              <LocalFacts
                                params={m.details?.params ?? fileFacts(m.id).params}
                                quant={m.details?.quant ?? fileFacts(m.id).quant}
                                size={m.details?.size}
                                context={m.details?.context}
                                extra={m.details?.family ?? m.details?.format}
                              />
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              ))}
            </section>
          );
        })()
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
                    hardcoded catalogue is stale the week after it ships. The
                    same shape as the cloud picker — filter as you type, sort,
                    narrow, and the facts that decide a pick in columns. */}
                <div className="router-filters">
                  <input
                    className="field filter-input"
                    placeholder="Search GGUF models — qwen, gemma, phi…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <select
                    className="field"
                    value={hfSort}
                    onChange={(e) => setHfSort(e.target.value as ModelSort)}
                    aria-label="Sort"
                  >
                    <option value="downloads">Most downloaded</option>
                    <option value="trending">Trending</option>
                    <option value="likes">Most liked</option>
                    <option value="updated">Recently updated</option>
                  </select>
                  <select
                    className="field"
                    value={hfMaxParams ?? ""}
                    onChange={(e) =>
                      setHfMaxParams(e.target.value === "" ? null : Number(e.target.value))
                    }
                    aria-label="Largest model"
                    data-tip="Keep only models up to this many parameters — roughly what the machine can hold"
                  >
                    <option value="">Any size</option>
                    <option value="4">≤ 4B</option>
                    <option value="9">≤ 9B</option>
                    <option value="14">≤ 14B</option>
                    <option value="32">≤ 32B</option>
                  </select>
                  {searching && <span className="spinner" aria-hidden="true" />}
                </div>

                {found && hfRows.length === 0 && !searching && (
                  <p className="blurb">Nothing matched that.</p>
                )}

                {hfRows.length > 0 && <FactsHead cols={["params", "window", "dl", "likes", "updated"]} />}
                <ul className="model-list compact hf-list">
                  {hfRows.map((m) => (
                    <li key={m.id}>
                      <button
                        className={openRepo === m.id ? "model chosen" : "model"}
                        data-tip={openRepo === m.id ? "Fold the files away" : "Show its files — one per quantisation"}
                        onClick={() => void openFiles(m.id)}
                      >
                        <span className="model-name">{m.id}</span>
                        <span className="model-facts">
                          <span className="model-params">{billionsLabel(billionsOf(m))}</span>
                          <span className="model-window">
                            {m.context ? windowLabel(m.context) : ""}
                          </span>
                          <span className="model-dl">{countLabel(m.downloads)}</span>
                          <span className="model-likes">{countLabel(m.likes)}</span>
                          <span className="model-updated">{agoLabel(m.last_modified)}</span>
                        </span>
                      </button>

                      {openRepo === m.id && (
                        <div className="hf-files">
                          {!repoFiles ? (
                            <p className="blurb">Reading the files…</p>
                          ) : repoFiles.length === 0 ? (
                            <p className="blurb">No GGUF files in that one.</p>
                          ) : (
                            repoFiles.map((f) => {
                              const quant = fileFacts(f.path).quant;
                              return (
                                <button
                                  key={f.path}
                                  className="hf-file"
                                  onClick={() => void pullFile(m.id, f)}
                                >
                                  <span className="hf-quant">{f.path}</span>
                                  {quant === "Q4_K_M" && (
                                    <span
                                      className="tag ready"
                                      data-tip="The usual pick: a quarter the size, and hard to tell from the full model"
                                    >
                                      good default
                                    </span>
                                  )}
                                  <span className="row-meta">
                                    {f.size > 0 ? `${(f.size / 1e9).toFixed(2)} GB` : "—"}
                                  </span>
                                </button>
                              );
                            })
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

                <FactsHead cols={["params", "quant", "size", "json"]} />
                <ul className="list model-list">
                  {embedded.downloaded.map((f, fi) => {
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
                          <span className="model-facts">
                            <span className="model-params">{fileFacts(f).params ?? ""}</span>
                            <span className="model-quant">{fileFacts(f).quant ?? ""}</span>
                            <span className="model-size">
                              {embedded.downloaded_bytes?.[fi] ? gb(embedded.downloaded_bytes[fi]) : ""}
                            </span>
                            <StructuredMark on={true} />
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
