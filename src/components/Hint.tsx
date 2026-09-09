import { useEffect, useState } from "react";
import { getSettings, onSettingsChanged } from "../lib/settings";

/**
 * Whether explanations belong on the page or under a mark.
 *
 * Null until the setting is known: showing a paragraph and then taking it
 * away is worse than a beat of nothing.
 */
function useInlineExplanations(): boolean | null {
  const [inline, setInline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => alive && setInline(s.show_explanations));
    const un = onSettingsChanged((s) => alive && setInline(s.show_explanations));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  return inline;
}

/**
 * An explanation, on the page or one hover away.
 *
 * The app explained itself in paragraphs beside almost every control. Read
 * once they stop being help and become furniture — and a settings page that
 * argues its own case at length is mostly the app talking about itself
 * instead of showing you your own work.
 *
 * So by default the words move under a small mark, and the page is the
 * controls. Nothing is deleted: turning "Explain things on the page" back on
 * in Settings puts every one of them back exactly where it was, which is why
 * this is one component rather than a hundred deletions.
 */
export default function Hint({ children }: { children: React.ReactNode }) {
  const inline = useInlineExplanations();

  if (inline === null) return null;
  if (inline) return <p className="blurb">{children}</p>;
  return <Mark>{children}</Mark>;
}

/** The mark itself, with its explanation folded under it. */
function Mark({ children }: { children: React.ReactNode }) {
  return (
    <span className="hint">
      <span className="hint-mark" tabIndex={0} role="note" aria-label="What this means">
        ?
      </span>
      <span className="hint-body">{children}</span>
    </span>
  );
}

/**
 * A settings heading, and the explanation that belongs to it.
 *
 * The mark goes *inside* the heading, beside the name it explains. Left as a
 * sibling it landed under the whole group of controls, where it reads as a
 * note on the last button rather than on the section — and a CSS nudge
 * lifting it back onto the heading line only worked while the two elements
 * happened to be adjacent.
 *
 * With explanations turned back on the heading cannot hold the paragraph —
 * a `<p>` inside an `<h3>` is not a heading any more — so it goes back to a
 * blurb underneath, which is where it was to begin with.
 */
export function Section({
  children,
  hint,
}: {
  /** The heading itself. */
  children: React.ReactNode;
  /** What it means. Omitted where the name is the whole explanation. */
  hint?: React.ReactNode;
}) {
  const inline = useInlineExplanations();

  return (
    <>
      <h3 className="section">
        {children}
        {hint && inline === false && <Mark>{hint}</Mark>}
      </h3>
      {hint && inline === true && <p className="blurb">{hint}</p>}
    </>
  );
}
