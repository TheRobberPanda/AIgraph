import { useEffect, useState } from "react";
import {
  embeddedStatus,
  installLlamaServer,
  onServerDownload,
  type EmbeddedStatus,
} from "../lib/settings";

/**
 * The thing that runs a model, as opposed to the model itself.
 *
 * Here rather than beside the model: which build of llama.cpp is installed is
 * a question you answer once, and having it in front of someone choosing a
 * model every time made a two-line decision look like a ten-line one.
 */
export default function Engine({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<EmbeddedStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetching, setFetching] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void embeddedStatus().then(setStatus).catch(() => {});
    const p = onServerDownload(setFetching);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  function install(flavour: string) {
    setBusy(flavour);
    setFetching(null);
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

  const pct =
    fetching && fetching.total > 0
      ? Math.min(100, Math.round((fetching.received / fetching.total) * 100))
      : null;

  return (
    <>
      {error && <p className="error">{error}</p>}
    <h3 className="section">The engine</h3>
    {error && <p className="error">{error}</p>}

    {/* Shown whether or not one is installed already. It used to be an
        alternative to the "ready" line, so pressing Reinstall — which is only
        ever pressed when one *is* installed — showed nothing at all, and a
        twenty-second download looked like a dead button. */}
    {busy ? (
      <div className="installing">
        <div className="row">
        <span className="spinner" aria-hidden="true" />
        <span>
          Fetching the {busy === "vulkan" ? "GPU" : "CPU"} build
          {pct !== null ? ` — ${pct}%` : "…"}
        </span>
        <span className="row-meta">
          {fetching ? `${(fetching.received / 1e6).toFixed(0)} MB` : "starting"}
        </span>
        </div>
        <div className="bar-track">
        <div
          className={pct === null ? "bar-fill idle" : "bar-fill"}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
        </div>
      </div>
    ) : status?.server_ready ? (
      <div className="row">
        <span className="tag ready">{status.server_build ?? "found on PATH"}</span>
        <span className="row-meta">{status.server_path}</span>
      </div>
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

    </>
  );
}
