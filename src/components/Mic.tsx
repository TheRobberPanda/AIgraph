import { useEffect, useRef, useState } from "react";
import {
  downloadSpeechModel,
  onDictation,
  onDownloadProgress,
  speechModelStatus,
  startDictation,
  stopDictation,
  type DownloadProgress,
} from "../lib/dictation";

/**
 * Push-to-think dictation.
 *
 * Speech goes into the composer, not into the conversation. Whisper-style
 * "speak and it sends" would make every transcription error an evidence error —
 * a quote attributed to you that you never said. Editing first is cheap and
 * removes the whole class of problem.
 */
export default function Mic({
  onPhrase,
  onSpeaking,
  disabled,
}: {
  onPhrase: (text: string) => void;
  /** Whether anything is being said right now, for whoever is drawing it. */
  onSpeaking?: (on: boolean) => void;
  disabled?: boolean;
}) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [downloadMb, setDownloadMb] = useState(0);
  const [downloading, setDownloading] = useState<DownloadProgress | null>(null);
  // Four states, not two. Opening the microphone and loading the recognizer
  // takes well over a second, and a button that shows nothing during that reads
  // as broken — you click again, which is worse than waiting.
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "stopping">(
    "idle",
  );
  const [speaking, setSpeaking] = useState(false);
  const active = phase === "listening";
  const busy = phase === "starting" || phase === "stopping";
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the event subscription never needs re-creating mid-session.
  const phraseRef = useRef(onPhrase);
  phraseRef.current = onPhrase;
  const speakingRef = useRef(onSpeaking);
  speakingRef.current = onSpeaking;

  useEffect(() => {
    speechModelStatus()
      .then((s) => {
        setInstalled(s.installed);
        setDownloadMb(s.download_mb);
      })
      .catch(() => setInstalled(false));
  }, []);

  useEffect(() => {
    const p = onDictation({
      phrase: (t) => phraseRef.current(t),
      speaking: (on) => {
        setSpeaking(on);
        speakingRef.current?.(on);
      },
      error: (e) => {
        setError(e);
        setPhase("idle");
      },
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  useEffect(() => {
    const p = onDownloadProgress(setDownloading);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // Never leave the microphone open behind a closing window.
  useEffect(() => () => void stopDictation().catch(() => {}), []);

  async function toggle() {
    if (busy) return;
    setError(null);

    // Set the visible state *before* awaiting, so the label and spinner change
    // on the click rather than when the backend gets round to answering.
    if (active) {
      setPhase("stopping");
      try {
        await stopDictation();
      } catch (e) {
        setError(String(e));
      }
      setSpeaking(false);
      setPhase("idle");
      return;
    }

    setPhase("starting");
    try {
      await startDictation();
      setPhase("listening");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  async function getModel() {
    setError(null);
    // Shown immediately at 0%, before the first progress event arrives — the
    // first chunk can be seconds away on a slow connection.
    setDownloading({ what: "speech model", received: 0, total: downloadMb * 1e6 });
    try {
      await downloadSpeechModel();
      setInstalled(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(null);
    }
  }

  if (installed === null) return null;

  if (downloading) {
    const pct = downloading.total
      ? Math.min(100, Math.round((downloading.received / downloading.total) * 100))
      : 0;
    return (
      <span className="mic-status">
        Downloading {downloading.what}… {pct}%
      </span>
    );
  }

  if (!installed) {
    return (
      <button
        className="btn"
        onClick={getModel}
        data-tip={`Downloads the speech model (about ${downloadMb}MB), once`}
      >
        Enable dictation
      </button>
    );
  }

  // The button says what the app is doing; the dot says what it is hearing
  // right now. Saying "Paused" during a silence read as "the mic stopped",
  // when dictation was still very much on and still recording.
  const label = {
    idle: "Speak",
    starting: "Starting…",
    stopping: "Stopping…",
    listening: "Listening",
  }[phase];

  return (
    <>
      {error && <span className="mic-status error">{error}</span>}
      <button
        className={`btn mic${active ? " on" : ""}${busy ? " busy" : ""}`}
        onClick={toggle}
        disabled={disabled}
        data-tip={
          active
            ? speaking
              ? "Hearing you — click to stop"
              : "Listening. Speak, or click to stop"
            : "Dictate"
        }
        aria-pressed={active}
        aria-busy={busy}
      >
        {busy ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <span className={speaking ? "mic-dot live" : "mic-dot"} aria-hidden="true" />
        )}
        {label}
      </button>
    </>
  );
}
