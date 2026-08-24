import { useEffect, useRef } from "react";

/**
 * Stop a slider from being changed by a scroll that was aimed past it.
 *
 * A range input under the pointer takes the wheel, so scrolling down a panel
 * of settings silently rewrites every one the cursor crosses. That is a bad
 * way to find out what a slider does, and a worse way to find out what it did.
 *
 * The listener has to be attached natively and non-passive: React registers
 * `onWheel` at the root as passive, where `preventDefault` is ignored.
 */
export function useNoWheel<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const block = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, []);
  return ref;
}
