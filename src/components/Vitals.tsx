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
  /** When the writing phase began, so the wait can be counted in seconds.
   *  llama.cpp's own token counters only move when a request finishes, so
   *  there is nothing live to count instead. */
  const [writingSince, setWritingSince] = useState<number | null>(null);
  const [, tick] = useState(0);

  // Whether the model is up is worth knowing wherever you are — it is the
  // difference between "slow" and "not running", and hunting for it in a tab
  // is the wrong moment to be navigating.
  useEffect(() => {
    const check = () => void embeddedStatus().then(setEngine).catch(() => {});
    check();
    const id = setInterval(check, 4000);
    return () => clearInterval(id);
  }, []);

  // Advances the elapsed counter between polls.
  useEffect(() => {
    if (writingSince === null) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [writingSince]);

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
    const poll = () =>
      runtimeStatus()
        .then((r) => {
          if (!alive) return;
          setS(r);
          setWritingSince((was) =>
            r.phase === "writing" ? was ?? Date.now() : null,
          );
        })
        .catch(() => {});
    void poll();
    const id = setInterval(poll, 700);
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
        <button
          className="status-toggle"
          data-tip="Show what the model is doing right now — for working out why something is slow"
          onClick={() => setOpen(true)}
        >
          what it&apos;s doing
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
          reading what you said · {pct}% ({s.prompt_done} of {s.prompt_total} tokens)
          {s.prompt_cached > 0 && ` · ${s.prompt_cached} already cached`}
        </>
      ) : s.phase === "writing" ? (
        // Seconds, not tokens and not a percentage. The model stops when it
        // stops, so there is no fraction to show — and llama.cpp's token
        // counters only move once a request has finished, so there is nothing
        // live to count either. How long it has been going is true.
        <>
          writing the answer · {writingSince ? Math.round((Date.now() - writingSince) / 1000) : 0}s
        </>
      ) : (
        <>waiting · {s.context ? `${Math.round(s.context / 1024)}K of context` : "loaded"}</>
      )}
    </button>
    </>
  );
}
