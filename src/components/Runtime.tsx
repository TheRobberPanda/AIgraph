import { useEffect, useState } from "react";
import {
  embeddedStatus,
  getSettings,
  installLlamaServer,
  onServerDownload,
  saveSettings,
  type EmbeddedStatus,
  type Runtime as R,
  type Settings as S,
} from "../lib/settings";

/**
 * How the model the app runs itself is started.
 *
 * Lives beside the model rather than in Settings: everything about a model —
 * which one, where it runs, how much of the machine it gets — is one subject,
 * and splitting it across two tabs meant answering half a question in each.
 */

/** Slider stops rather than a free number. Context and batch move in powers of
 *  two, and a slider that has to land on 8192 exactly is worse than one that
 *  cannot miss. */
const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
const BATCHES = [64, 128, 256, 512, 1024, 2048, 4096];

function fmtTokens(n: number): string {
  return n >= 1024 ? `${n / 1024}K` : String(n);
}

/** One labelled slider with its value beside it. */
function Slider({
  label,
  hint,
  value,
  display,
  min,
  max,
  step,
  onInput,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="knob">
      <label className="knob-name">{label}</label>
      <input
        type="range"
        className="scale-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        // Moved live, saved on release: saving every frame of a drag writes the
        // settings file a hundred times for one decision.
        onChange={(e) => onInput(Number(e.target.value))}
        onMouseUp={onCommit}
        onKeyUp={onCommit}
        onTouchEnd={onCommit}
      />
      <span className="knob-value">{display}</span>
      {hint && <span className="knob-hint">{hint}</span>}
    </div>
  );
}

const SWITCHES: { key: keyof R; label: string; hint: string }[] = [
  { key: "kv_cache_on_gpu", label: "KV cache on the GPU", hint: "faster, at the cost of VRAM the model wants" },
  { key: "flash_attention", label: "Flash attention", hint: "fused kernels where the backend has them" },
  { key: "mlock", label: "Lock in RAM", hint: "stops the OS paging the weights out" },
  { key: "keep_in_memory", label: "Keep loaded", hint: "hold the weights between sessions instead of reloading" },
];

export default function RuntimePanel({ onChanged }: { onChanged?: () => void }) {
  const [s, setS] = useState<S | null>(null);
  const [status, setStatus] = useState<EmbeddedStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetching, setFetching] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    void getSettings().then(setS);
    void embeddedStatus().then(setStatus).catch(() => {});
    const p = onServerDownload(setFetching);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  function set(patch: Partial<R>, save = true) {
    if (!s) return;
    const next = { ...s, runtime: { ...s.runtime, ...patch } };
    setS(next);
    if (save) void saveSettings(next).catch((e) => setError(String(e)));
  }
  const commit = () => {
    if (s) void saveSettings(s).catch((e) => setError(String(e)));
  };

  function install(flavour: string) {
    setBusy(flavour);
    setError(null);
    installLlamaServer(flavour)
      .then(() => embeddedStatus().then(setStatus))
      .then(() => onChanged?.())
      .catch((e) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        setFetching(null);
      });
  }

  if (!s) return null;
  const r = s.runtime;

  return (
    <section className="model-role">
      <h3 className="section">The engine</h3>
      {error && <p className="error">{error}</p>}

      {status?.server_ready ? (
        <div className="row">
          <span className="tag ready">{status.server_build ?? "found on PATH"}</span>
          <span className="row-meta">{status.server_path}</span>
        </div>
      ) : busy ? (
        <p className="blurb">
          <span className="spinner" aria-hidden="true" /> Installing…
          {fetching && ` ${Math.round((fetching.received / (fetching.total || 1)) * 100)}%`}
        </p>
      ) : (
        <p className="blurb">
          Nothing to run a model with yet. The CPU build works everywhere; the
          Vulkan build uses whatever graphics card is here, whoever made it.
        </p>
      )}

      <div className="row wrap">
        <button
          className={busy === "cpu" ? "btn busy" : "btn"}
          disabled={busy !== null}
          onClick={() => install("cpu")}
        >
          {busy === "cpu" && <span className="spinner" aria-hidden="true" />}
          {status?.server_ready ? "Reinstall · CPU" : "Install · CPU"}
        </button>
        {status?.vulkan_available && (
          <button
            className={busy === "vulkan" ? "btn busy" : "btn"}
            disabled={busy !== null}
            onClick={() => install("vulkan")}
          >
            {busy === "vulkan" && <span className="spinner" aria-hidden="true" />}
            {status?.server_ready ? "Reinstall · GPU" : "Install · GPU (Vulkan)"}
          </button>
        )}
      </div>
      <p className="blurb">
        Always the current build, resolved when you press it rather than fixed
        when this was written — quantisations move faster than releases, and a
        build pinned a year ago cannot read a model published last month.
      </p>

      <h3 className="section sub">How much of the machine it gets</h3>
      <div className="knobs">
        <Slider
          label="GPU offload"
          hint="0 keeps everything on the CPU"
          min={0}
          max={128}
          step={1}
          value={r.gpu_layers}
          display={r.gpu_layers === 0 ? "CPU only" : `${r.gpu_layers} layers`}
          onInput={(v) => set({ gpu_layers: v }, false)}
          onCommit={commit}
        />
        <Slider
          label="Context"
          hint="how much it holds at once — costs memory"
          min={0}
          max={CONTEXTS.length - 1}
          step={1}
          value={Math.max(0, CONTEXTS.indexOf(r.context_length))}
          display={fmtTokens(r.context_length)}
          onInput={(i) => set({ context_length: CONTEXTS[i] }, false)}
          onCommit={commit}
        />
        <Slider
          label="CPU threads"
          hint="0 lets it decide from the machine"
          min={0}
          max={64}
          step={1}
          value={r.threads}
          display={r.threads === 0 ? "auto" : String(r.threads)}
          onInput={(v) => set({ threads: v }, false)}
          onCommit={commit}
        />
      </div>

      <button className="link" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "Fewer settings" : "More settings"}
      </button>

      {advanced && (
        <>
          <div className="knobs">
            <Slider
              label="Batch"
              hint="tokens per pass; larger fills a GPU better"
              min={0}
              max={BATCHES.length - 1}
              step={1}
              value={Math.max(0, BATCHES.indexOf(r.batch_size))}
              display={String(r.batch_size)}
              onInput={(i) => set({ batch_size: BATCHES[i] }, false)}
              onCommit={commit}
            />
            <Slider
              label="Parallel"
              hint="answers at once; each takes a slice of the context"
              min={1}
              max={8}
              step={1}
              value={r.parallel}
              display={String(r.parallel)}
              onInput={(v) => set({ parallel: v }, false)}
              onCommit={commit}
            />
          </div>

          <h3 className="section sub">How it sounds</h3>
          <p className="blurb">
            Left at llama.cpp's own defaults. Anything else would be this app
            quietly having an opinion about how every model should sound.
          </p>
          <div className="knobs">
            <Slider
              label="Temperature"
              hint="how adventurous the wording is"
              min={0}
              max={2}
              step={0.05}
              value={r.temperature}
              display={r.temperature.toFixed(2)}
              onInput={(v) => set({ temperature: v }, false)}
              onCommit={commit}
            />
            <Slider
              label="Top P"
              hint="share of the probability mass considered"
              min={0.05}
              max={1}
              step={0.01}
              value={r.top_p}
              display={r.top_p.toFixed(2)}
              onInput={(v) => set({ top_p: v }, false)}
              onCommit={commit}
            />
            <Slider
              label="Top K"
              hint="how many candidates are considered at all"
              min={0}
              max={200}
              step={1}
              value={r.top_k}
              display={r.top_k === 0 ? "off" : String(r.top_k)}
              onInput={(v) => set({ top_k: v }, false)}
              onCommit={commit}
            />
            <Slider
              label="Repeat penalty"
              hint="pressure against repeating itself; 1 is off"
              min={1}
              max={2}
              step={0.01}
              value={r.repeat_penalty}
              display={r.repeat_penalty.toFixed(2)}
              onInput={(v) => set({ repeat_penalty: v }, false)}
              onCommit={commit}
            />
          </div>

          <div className="row wrap">
            {SWITCHES.map((f) => (
              <button
                key={f.key}
                className={r[f.key] ? "btn on" : "btn"}
                data-tip={f.hint}
                onClick={() => set({ [f.key]: !r[f.key] } as Partial<R>)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="blurb">
        Read when the model starts, so stop and start it to apply a change.
      </p>
    </section>
  );
}
