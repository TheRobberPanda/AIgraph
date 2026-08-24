/**
 * One settings section, closed until asked for.
 *
 * A settings screen is read by looking for one thing, not by reading it. Laid
 * out flat, every knob competes with every other and the page becomes a wall
 * you scroll past. Closed, the page is a list of the questions it can answer,
 * and the heading carries the current answer so most of the time opening it is
 * unnecessary.
 */
export default function Fold({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  /** The current setting, in a few words. What you came to check. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={open ? "fold open" : "fold"}>
      <button className="fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="fold-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="fold-title">{title}</span>
        {summary && <span className="fold-summary">{summary}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
