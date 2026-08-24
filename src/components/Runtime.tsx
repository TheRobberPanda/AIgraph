import { useEffect, useState } from "react";
import { useNoWheel } from "../lib/noWheel";
import {
  embeddedStatus,
  getSettings,
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
  const ref = useNoWheel<HTMLInputElement>();
  return (
    <div className="knob">
      <label className="knob-name">{label}</label>
      <input
        ref={ref}
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
  { key: "kv_cache_on_gpu", label: "KV cache on the GPU", hint: "several GB at a large context — left in system memory, every token of it crosses the bus" },
  { key: "kv_unified", label: "Unified KV cache", hint: "one cache shared across slots instead of one each" },
  { key: "flash_attention", label: "Flash attention", hint: "fused kernels where the backend has them" },
  { key: "mlock", label: "Lock in RAM", hint: "stops the OS paging the weights out" },
  { key: "keep_in_memory", label: "Keep loaded", hint: "hold the weights between sessions instead of reloading" },
];

export default function RuntimePanel() {
  const [s, setS] = useState<S | null>(null);
  const [status, setStatus] = useState<EmbeddedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    void getSettings().then(setS);
    void embeddedStatus().then(setStatus).catch(() => {});
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


  /**
   * The settings LM Studio uses for a model this size on a card this size,
   * which is a well-tested answer to a question this app should not make
   * anyone research. Everything except how many layers fit, which depends on
   * the card and is left where it is.
   */
  function tune() {
    set({
      kv_cache_on_gpu: true,
      keep_in_memory: true,
      kv_unified: true,
      flash_attention: true,
      batch_size: 2048,
      ubatch_size: 512,
      parallel: 4,
    });
  }

  if (!s) return null;
  const r = s.runtime;
  const tuned =
    r.kv_cache_on_gpu &&
    r.kv_unified &&
    r.flash_attention &&
    r.batch_size >= 2048 &&
    r.parallel >= 4;

  return (
    <section className="model-role">
      {error && <p className="error">{error}</p>}
      {!status?.server_ready && (
        <p className="blurb warn">
          Nothing to run a model with yet. Install an engine in{" "}
          <b>Settings → The engine</b>.
        </p>
      )}

      {/* The trap: the CPU build ignores `-ngl` entirely, so the offload
          slider reads as if the card is being used when nothing is. Prompt
          processing at CPU speed is the symptom, and there is no way to tell
          from the slider. */}
      {status?.server_build?.includes("cpu") && r.gpu_layers > 0 && (
        <p className="blurb warn">
          This is the CPU build, so GPU offload does nothing — the slider says
          {" "}{r.gpu_layers} layers and none of them are on the card. Install
          the GPU build to use it.
        </p>
      )}

      {!tuned && (
        <>
          <p className="blurb">
            These are not set for speed. Where the key/value cache lives and how
            big a batch is read at once are, together, usually the difference
            between a model that answers and one you wait for.
          </p>
          <button className="btn on" onClick={tune}>
            Set them for speed
          </button>
        </>
      )}

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
              hint="prompt tokens read at once — the one that decides how fast a long prompt is read"
              min={0}
              max={BATCHES.length - 1}
              step={1}
              value={Math.max(0, BATCHES.indexOf(r.batch_size))}
              display={String(r.batch_size)}
              onInput={(i) => set({ batch_size: BATCHES[i] }, false)}
              onCommit={commit}
            />
            <Slider
              label="Micro-batch"
              hint="how many of those are computed in one pass; bounded by memory, rarely worth raising"
              min={0}
              max={BATCHES.length - 1}
              step={1}
              value={Math.max(0, BATCHES.indexOf(r.ubatch_size))}
              display={String(r.ubatch_size)}
              onInput={(i) => set({ ubatch_size: BATCHES[i] }, false)}
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
