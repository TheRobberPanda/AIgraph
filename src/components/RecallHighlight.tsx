import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ideaView } from "../lib/views";
import { longDate } from "../lib/format";

/** What the card shows: the quote the idea was taken from, and its surroundings. */
interface Source {
  title: string;
  when: string;
  before: string;
  quote: string;
  after: string;
}

/** Where the card goes, in window coordinates. */
interface Place {
  left: number;
  top?: number;
  bottom?: number;
}

const CARD_WIDTH = 416;

/**
 * One sentence of a reply that drew on something recorded earlier, with a
 * hover card showing where.
 *
 * The card is built to look like a cropped screenshot of the conversation it
 * came from: the words that produced the idea are in focus, the words either
 * side are dimmed and cut off at the edge of the frame.
 *
 * It shows the idea's own evidence — the quote as it was verified against the
 * transcript, and the text either side of it. It used to find the turn and
 * look for segments tagged with this idea, and an idea merged into another, or
 * re-read since, had none: the card opened with everything blurred and
 * nothing in focus.
 *
 * Drawn in a portal with fixed coordinates, so the chat's scroll region can
 * never cut it off.
 */
export default function RecallHighlight({
  ideaId,
  children,
}: {
  ideaId: number;
  children: React.ReactNode;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const [source, setSource] = useState<Source | "error" | null>(null);
  const loadedFor = useRef<number | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  // React reuses this instance while a reply is still streaming and the text
  // re-renders, so the idea it points at can change under it.
  useEffect(() => {
    loadedFor.current = null;
    setSource(null);
  }, [ideaId]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Fetched on first hover — most highlights are never hovered.
  async function load() {
    if (loadedFor.current === ideaId) return;
    loadedFor.current = ideaId;
    try {
      const idea = await ideaView(ideaId);
      const ev = idea.evidence[0];
      if (!ev) {
        setSource("error");
        return;
      }
      setSource({
        title: idea.title || idea.claim,
        when: ev.started_at,
        before: ev.before,
        quote: ev.quote,
        after: ev.after,
      });
    } catch {
      setSource("error");
    }
  }

  function open(e: React.MouseEvent<HTMLElement>) {
    window.clearTimeout(closeTimer.current);
    const r = e.currentTarget.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, window.innerWidth * 0.8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    // Near the top of the window a card opening upwards has nowhere to go.
    setPlace(
      r.top < 220
        ? { left, top: r.bottom + 6 }
        : { left, bottom: window.innerHeight - r.top + 6 },
    );
    void load();
  }

  // A beat before closing, so the pointer can cross the gap onto the card.
  function close() {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPlace(null), 140);
  }

  return (
    <>
      <span className="recall-hit" onMouseEnter={open} onMouseLeave={close}>
        {children}
      </span>
      {place &&
        createPortal(
          <div
            className="recall-card"
            style={{ left: place.left, top: place.top, bottom: place.bottom }}
            onMouseEnter={() => window.clearTimeout(closeTimer.current)}
            onMouseLeave={close}
          >
            <div className="recall-card-head">
              {source && source !== "error"
                ? `You said this ${longDate(source.when)}`
                : "Finding where this was said…"}
            </div>
            {source && source !== "error" && (
              <div className="recall-card-title">{source.title}</div>
            )}
            <div className="recall-card-frame">
              {source === null ? (
                <div className="recall-card-loading" />
              ) : source === "error" ? (
                <div className="recall-card-miss">Can't find it — it may have been edited since.</div>
              ) : (
                <>
                  {source.before && <span className="recall-blur">{source.before} </span>}
                  <span className="recall-focus">{source.quote}</span>
                  {source.after && <span className="recall-blur"> {source.after}</span>}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
