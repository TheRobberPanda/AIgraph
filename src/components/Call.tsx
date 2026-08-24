import { useEffect, useRef } from "react";

/**
 * Call mode: the screen becomes a waveform and the keyboard goes away.
 *
 * A call is not a screen you read, so there is nothing on it to read. What it
 * has to show is that it is hearing you — which is the one thing a person
 * cannot tell about a microphone without being told, and the reason a silent
 * listening state feels broken.
 *
 * The wave is drawn rather than animated in CSS so it can respond to whether
 * anything is being said: three sine bands that flatten to a line in silence
 * and swell while you talk. No audio is analysed here — the backend's voice
 * detector already knows, and asking the browser for a second microphone
 * stream to draw a picture would be an unnecessary second open device.
 */
export default function Call({
  speaking,
  thinking,
  status,
  heard,
  sendingIn,
  silence,
  progress,
  talking,
  onStopTalking,
  onHold,
  onSendNow,
  onHangUp,
}: {
  /** The voice detector hears something right now. */
  speaking: boolean;
  /** A reply is being generated or read out. */
  thinking: boolean;
  status: string;
  /** What has been transcribed and is waiting to go. */
  heard: string;
  /** Seconds left before it sends, or null when nothing is pending. */
  sendingIn: number | null;
  /** The full wait, so the ring knows what a full circle means. */
  silence: number;
  /** How far the model has got, 0–1, or null when it cannot say. */
  progress: number | null;
  /** A reply is being read out right now. */
  talking: boolean;
  onStopTalking: () => void;
  /** Stop the countdown and keep listening. */
  onHold: () => void;
  onSendNow: () => void;
  onHangUp: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read inside the animation loop, which is started once. Without the refs
  // the loop would close over the first render's values forever.
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let frame = 0;
    // Eased rather than switched, so the wave grows and settles instead of
    // snapping between two shapes on every pause between words.
    let level = 0;
    const start = performance.now();

    const loop = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const target = speakingRef.current ? 1 : thinkingRef.current ? 0.45 : 0.08;
      level += (target - level) * 0.08;

      const t = (performance.now() - start) / 1000;
      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue("--accent").trim() || "#e08659";
      const mid = h / 2;
      const amplitude = h * 0.17 * level;

      for (let band = 0; band < 3; band++) {
        ctx.beginPath();
        const speed = 1.1 + band * 0.35;
        const phase = band * 1.9;
        const scale = 1 - band * 0.28;
        for (let x = 0; x <= w; x += 4) {
          const p = x / w;
          // Tapered at both ends so the wave begins and ends at the centre
          // line rather than being cut off against the edge of the window.
          const envelope = Math.sin(Math.PI * p);
          const y =
            mid +
            Math.sin(p * 9 + t * speed + phase) *
              amplitude *
              scale *
              envelope *
              (1 + 0.4 * Math.sin(p * 3.3 - t * 0.7));
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.75 - band * 0.22;
        ctx.lineWidth = 2.5 - band * 0.6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onHangUp();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onHangUp]);

  return (
    <div className="call">
      <canvas ref={canvasRef} className="call-wave" />
      <div className="call-body">
        {/* What was heard, so a misheard sentence is visible before it is sent
            rather than after it is answered. */}
        {heard && <p className="call-heard">{heard}</p>}

        {sendingIn !== null ? (
          // The wait is the one thing here with an end you can see coming, so
          // it gets a shape rather than a number counting down alone.
          <div className="call-countdown">
            <Ring seconds={sendingIn} total={silence} />
            <div className="row">
              <button className="btn" onClick={onHold}>
                Wait — still thinking
              </button>
              <button className="btn on" onClick={onSendNow}>
                Send now
              </button>
            </div>
          </div>
        ) : (
          <p className="call-status">{status}</p>
        )}

        {thinking && progress !== null && (
          <div className="call-progress">
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="row-meta">reading what you said · {Math.round(progress * 100)}%</span>
          </div>
        )}

        <div className="row call-actions">
          {/* Only while there is something to stop. A dead button for the
              other ninety per cent of a call is worse than no button. */}
          {talking && (
            <button className="btn" onClick={onStopTalking}>
              Stop talking
            </button>
          )}
          <button className="btn call-end" onClick={onHangUp}>
            End
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * The seconds left before what you said is sent, drawn as a closing ring.
 *
 * A number counting down reads as a deadline; a ring closing reads as a pause
 * running out, which is what it is. The number is there too, because "how long
 * exactly" is a fair question when the answer decides whether you get cut off.
 */
function Ring({ seconds, total }: { seconds: number; total: number }) {
  const size = 62;
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="ring" role="timer" aria-label={`Sending in ${Math.ceil(seconds)} seconds`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth="3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(0, seconds) / Math.max(1, total))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-count">{Math.ceil(seconds)}</span>
    </div>
  );
}