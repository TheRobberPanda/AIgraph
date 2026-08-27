import { useRef, useState } from "react";
import { conversationView, ideaView, type Segment } from "../lib/views";
import { longDate } from "../lib/format";

/**
 * One paragraph of a reply that drew on something recorded earlier, with a
 * hover card showing where.
 *
 * The card is built to look like a cropped screenshot of the conversation it
 * came from: the whole turn is there for context, but only the words that
 * actually produced the idea are in focus — everything else is blurred and
 * runs off the edge of the frame, the way a screenshot someone sent you would
 * blur what they didn't mean to show and crop what didn't fit.
 */
export default function RecallHighlight({
  ideaId,
  children,
}: {
  ideaId: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState<Segment[] | "error" | null>(null);
  const [when, setWhen] = useState<string | null>(null);
  const loaded = useRef(false);

  // Fetched once, on first hover — most paragraphs are never hovered, and a
  // reply that recalled several ideas would otherwise cost several idea and
  // conversation fetches nobody asked to see.
  async function load() {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const idea = await ideaView(ideaId);
      const first = idea.evidence[0];
      if (!first) {
        setSegments("error");
        return;
      }
      setWhen(first.started_at);
      const convo = await conversationView(first.session_id);
      const turn = convo.turns.find((t) => t.id === first.turn_id);
      setSegments(turn?.segments ?? "error");
    } catch {
      setSegments("error");
    }
  }

  return (
    // A div, not a span: this wraps a rendered markdown paragraph, which is
    // block content — nesting that inside an inline element is invalid HTML
    // and browsers reparent it unpredictably, which would break the popup
    // right when it's supposed to appear.
    <div
      className="recall-hit"
      onMouseEnter={() => {
        setOpen(true);
        void load();
      }}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <div className="recall-card">
          <div className="recall-card-head">
            {when ? `Said ${longDate(when)}` : "Finding where this was said…"}
          </div>
          <div className="recall-card-frame">
            {segments === null ? (
              <div className="recall-card-loading" />
            ) : segments === "error" ? (
              <div className="recall-card-miss">Can't find it — it may have been edited since.</div>
            ) : (
              segments.map((seg, i) => (
                <span key={i} className={seg.idea_id === ideaId ? "recall-focus" : "recall-blur"}>
                  {seg.text}
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
