import { useEffect, useState } from "react";
import { getSettings, onSettingsChanged } from "../lib/settings";

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

  // Until the setting is known, show nothing rather than the wrong one — a
  // paragraph that appears and then vanishes is worse than a beat of nothing.
  if (inline === null) return null;
  if (inline) return <p className="blurb">{children}</p>;

  return (
    <span className="hint">
      <span className="hint-mark" tabIndex={0} role="note" aria-label="What this means">
        ?
      </span>
      <span className="hint-body">{children}</span>
    </span>
  );
}
