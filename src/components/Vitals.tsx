import { useEffect, useState } from "react";
import {
  embeddedStatus,
  runtimeStatus,
  startEmbedded,
  stopEmbedded,
  type EmbeddedStatus,
  type RuntimeStatus,
} from "../lib/settings";
import { IconPlay, IconStop } from "./Icons";

/**
 * What the model is doing, for anyone who wants to know.
 *
 * A local model can spend a minute reading a long prompt before it writes a
 * word, and with nothing on screen that is indistinguishable from being hung.
 * This is the difference between "it is slow" and "it is broken", which are
 * the same picture without it.
 *
 * Off by default and out of the way. Every number here comes from
 * `llama-server`'s own `/slots` rather than from anything the app infers, so
 * it is worth trusting when something is wrong.
 */
export default function Vitals({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<RuntimeStatus | null>(null);
  const [engine, setEngine] = useState<EmbeddedStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Whether the model is up is worth knowing wherever you are — it is the
  // difference between "slow" and "not running", and hunting for it in a tab
  // is the wrong moment to be navigating.
  useEffect(() => {
    const tick = () => void embeddedStatus().then(setEngine).catch(() => {});
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      if (engine?.running) await stopEmbedded();
      else await startEmbedded();
      setEngine(await embeddedStatus());
      onChanged?.();
    } catch {
      /* the panel that owns this says why */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    // Only while it is being looked at. A poll nobody reads is a request per
    // second against a server that is busy doing the actual work.
    let alive = true;
    const tick = () =>
      runtimeStatus()
        .then((r) => alive && setS(r))
        .catch(() => {});
    void tick();
    const id = setInterval(tick, 700);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open]);

  const run = (
    <button
      className={busy ? "status-toggle busy" : engine?.running ? "status-toggle on" : "status-toggle"}
      disabled={busy || !engine?.model_ready}
      data-tip={engine?.running ? "Stop the model and free the memory" : "Start the model"}
      onClick={() => void toggle()}
    >
      {busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : engine?.running ? (
        <IconStop />
      ) : (
        <IconPlay />
      )}
      {busy ? "…" : engine?.running ? "running" : "stopped"}
    </button>
  );

  if (!open) {
    return (
      <>
        {run}
        <button className="status-toggle" data-tip="What the model is doing" onClick={() => setOpen(true)}>
          details
        </button>
      </>
    );
  }

  const pct =
    s && s.prompt_total > 0 ? Math.round((s.prompt_done / s.prompt_total) * 100) : null;

  return (
    <>
      {run}
    <button className="status-toggle on vitals" onClick={() => setOpen(false)}>
      {!s?.reachable ? (
        "no local server"
      ) : s.phase === "reading" ? (
        <>
          reading the prompt {pct}% · {s.prompt_done}/{s.prompt_total} tokens
          {s.prompt_cached > 0 && ` · ${s.prompt_cached} cached`}
        </>
      ) : s.phase === "writing" ? (
        <>writing · {s.prompt_total} tokens of prompt read</>
      ) : (
        <>idle · {s.context ? `${Math.round(s.context / 1024)}K context` : "loaded"}</>
      )}
    </button>
    </>
  );
}
