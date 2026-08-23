import { useEffect, useRef, useState } from "react";

export interface Option {
  value: string;
  label: string;
  /** Shown to the right, quieter — a count, a date. */
  meta?: string;
  /** A dot in the app's own subject colour. */
  color?: string;
}

/**
 * A dropdown drawn by the app.
 *
 * A native `<select>` opens the operating system's own list, which on Linux
 * arrives with a different typeface, corner radius and highlight colour than
 * everything around it. This one is styled like the rest of the app and can
 * carry a colour swatch, which a native option cannot.
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder,
  tip,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  tip?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chosen = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="pick" ref={ref}>
      <button
        className={open ? "pick-head open" : "pick-head"}
        onClick={() => setOpen((o) => !o)}
        data-tip={tip}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {chosen?.color && (
          <i
            className="tag-swatch"
            style={{ "--tag-color": chosen.color } as React.CSSProperties}
            aria-hidden="true"
          />
        )}
        <span className="pick-label">{chosen?.label ?? placeholder ?? "Choose"}</span>
        <span className="pick-caret" aria-hidden="true" />
      </button>

      {open && (
        <ul className="pick-list" role="listbox">
          {options.map((o) => (
            <li key={o.value}>
              <button
                className={o.value === value ? "pick-option on" : "pick-option"}
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.color && (
                  <i
                    className="tag-swatch"
                    style={{ "--tag-color": o.color } as React.CSSProperties}
                    aria-hidden="true"
                  />
                )}
                <span className="pick-label">{o.label}</span>
                {o.meta && <span className="row-meta">{o.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
