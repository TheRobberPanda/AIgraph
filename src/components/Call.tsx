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
  onHangUp,
}: {
  /** The voice detector hears something right now. */
  speaking: boolean;
  /** A reply is being generated or read out. */
  thinking: boolean;
  status: string;
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
        <p className="call-status">{status}</p>
        <button className="btn call-end" onClick={onHangUp}>
          End
        </button>
      </div>
    </div>
  );
}
