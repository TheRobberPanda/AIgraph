import { useEffect, useRef, useState } from "react";
import { IconMic } from "./Icons";
import {
  onDictation,
  speechModelStatus,
  startDictation,
  stopDictation,
} from "../lib/dictation";

/**
 * A microphone that lives inside one text box.
 *
 * `Mic` is the composer's button: it carries a label, a silence-timeout menu
 * and a download offer, because that is the one place dictation is set up. A
 * box tucked beside an argument needs none of that furniture — it needs a
 * button the size of the box, and speech that lands in it.
 *
 * Without the speech model it is present and disabled, saying where to get
 * one. Not hidden: a control that is sometimes there and sometimes not reads
 * as a bug, and somebody who came here to say something out loud deserves an
 * answer rather than an absence. Not an offer to download half a gigabyte
 * either — that belongs on the composer and in Settings, not beside a
 * paragraph somebody is in the middle of writing.
 */
export default function SpeakInto({
  onPhrase,
  disabled,
}: {
  /** One phrase, whole, on a silence boundary. */
  onPhrase: (text: string) => void;
  disabled?: boolean;
}) {
  const [installed, setInstalled] = useState(false);
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "stopping">("idle");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = phase === "listening";

  // Held in a ref so the subscription never needs re-creating mid-phrase.
  const phraseRef = useRef(onPhrase);
  phraseRef.current = onPhrase;

  useEffect(() => {
    let alive = true;
    void speechModelStatus()
      .then((s) => alive && setInstalled(s.installed))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const p = onDictation({
      phrase: (text) => phraseRef.current(text),
      speaking: setSpeaking,
      error: (m) => {
        setError(m);
        setPhase("idle");
      },
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // Leaving the microphone open after the box has gone is the one bug worth
  // being careful about here: nothing on screen would say it was listening.
  useEffect(
    () => () => {
      void stopDictation().catch(() => {});
    },
    [],
  );

  async function toggle() {
    setError(null);
    if (active) {
      setPhase("stopping");
      await stopDictation().catch(() => {});
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

  return (
    <button
      type="button"
      className={`icon-btn speak-into${active ? " on" : ""}${speaking ? " live" : ""}`}
      disabled={!installed || disabled || phase === "starting" || phase === "stopping"}
      aria-pressed={installed ? active : undefined}
      data-tip={
        !installed
          ? "Dictation needs the speech model — Settings › Voice & dictation"
          : (error ??
            (active
              ? speaking
                ? "Hearing you — click to stop"
                : "Listening"
              : "Say it instead"))
      }
      aria-label={active ? "Stop dictating" : "Dictate"}
      onClick={() => void toggle()}
    >
      <IconMic />
    </button>
  );
}
