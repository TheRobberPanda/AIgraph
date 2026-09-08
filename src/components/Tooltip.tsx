import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * One tooltip for the whole app, positioned against the viewport.
 *
 * It used to be a `::after` on the element itself, which worked until the
 * element sat inside something with `overflow: hidden` — every workspace panel,
 * every scrolling list — and then the hint was clipped at that box's edge and
 * looked like it was rendering behind the app. A pseudo-element cannot escape
 * an ancestor's overflow; only a separate element can.
 *
 * Driven by delegation rather than per-component wiring, so anything anywhere
 * gets a hint just by carrying `data-tip`.
 */
export default function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);

  // The anchor position only knows where the target is, not how wide the hint
  // ends up — so a hint on a button near the right edge opened past the screen.
  // Once it is in the DOM its real width is known, and it is slid back inside.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const max = window.innerWidth - 8;
    if (tip.x + el.offsetWidth > max) {
      setTip({ ...tip, x: Math.max(8, max - el.offsetWidth) });
    }
  }, [tip]);

  useEffect(() => {
    let timer: number | undefined;

    function show(target: HTMLElement) {
      const text = target.getAttribute("data-tip");
      if (!text) return;
      const r = target.getBoundingClientRect();
      // Below by default; above when there isn't room, so a hint on something
      // near the bottom of the window is still readable.
      const above = r.bottom + 44 > window.innerHeight;
      setTip({
        text,
        x: Math.min(Math.max(r.left, 8), window.innerWidth - 8),
        y: above ? r.top - 8 : r.bottom + 8,
        above,
      });
    }

    function onOver(e: MouseEvent) {
      const target = (e.target as HTMLElement | null)?.closest?.("[data-tip]");
      window.clearTimeout(timer);
      if (!(target instanceof HTMLElement)) {
        setTip(null);
        return;
      }
      // A short delay so sweeping the pointer across a toolbar doesn't strobe.
      timer = window.setTimeout(() => show(target), 260);
    }

    function hide() {
      window.clearTimeout(timer);
      setTip(null);
    }

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousedown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mousedown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;

  return (
    <div
      ref={ref}
      className="tip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: tip.above ? "translateY(-100%)" : undefined,
      }}
      role="tooltip"
    >
      {tip.text}
    </div>
  );
}
