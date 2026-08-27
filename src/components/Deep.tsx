import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import Sheet from "./Sheet";
import { dateTime, plainDate } from "../lib/format";
import {
  conversationView,
  ideaDeepDive,
  ideaView,
  revertRevision,
  type ConversationView,
  type IdeaView,
} from "../lib/views";

/**
 * Notes taken alongside an idea.
 *
 * Split under two headings rather than run together, and often absent entirely —
 * an idea with nothing left open is finished, and recording that is the right
 * outcome rather than a gap to fill.
 */
function Nudges({ strong, weak }: { strong: string[]; weak: string[] }) {
  if (!strong.length && !weak.length) return null;
  return (
    <div className="notes">
      {strong.length > 0 && (
        <section>
          <h3 className="section">Noted alongside</h3>
          <div className="notes">
            {strong.map((t, i) => (
              <p key={i} className="note strong">
                <span className="badge">AI</span>
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
      {weak.length > 0 && (
        <section>
          <div className="notes">
            {weak.map((t, i) => (
              <p key={i} className="note weak">
                <span className="badge">AI</span>
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * A conversation's file.
 *
 * The transcript as it happened, with the words that produced ideas highlighted
 * in place — only ever the human's words. Hovering a highlight shows *why* the
 * model read those words as that claim, which is what makes the extraction
 * inspectable rather than something you have to take on faith.
 */
export function ConversationFile({
  sessionId,
  onTrace,
  onClose,
}: {
  sessionId: number;
  /** Pointing at one of these picks it out on the map behind the panel. */
  onTrace?: (ideaId: number | null) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which recorded idea is being pointed at, so its source can be shown. */
  const [trace, setTrace] = useState<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  /**
   * An idea opened over this file rather than instead of it.
   *
   * Reading an idea and reading the conversation it came from is one act, and
   * swapping the panel's contents made it two — you lost your place in the
   * transcript to look at something that was meant to sit beside it.
   */
  const [openIdea, setOpenIdea] = useState<number | null>(null);

  // One entry per idea, with the words it came from.
  const taken = (view?.turns ?? [])
    .flatMap((t) => t.segments)
    .filter((s) => s.idea_id !== null)
    .reduce<{ ideaId: number; title: string; quote: string; reasoning: string }[]>((acc, s) => {
      if (acc.some((a) => a.ideaId === s.idea_id)) return acc;
      acc.push({
        ideaId: s.idea_id!,
        title: s.title || s.claim || "",
        quote: s.text,
        reasoning: s.reasoning ?? "",
      });
      return acc;
    }, []);

  /**
   * Bring the words an idea came from into view, in the middle of the pane.
   *
   * Pointing at an entry is asking "where did this come from"; answering with
   * a highlight somewhere off-screen is not an answer. Centred rather than
   * merely scrolled into view, because a span that lands hard against the top
   * edge has no surrounding sentence to read it against — and the surrounding
   * sentence is the point.
   */
  function show(ideaId: number) {
    const box = transcriptRef.current;
    const mark = box?.querySelector<HTMLElement>(`mark[data-idea="${ideaId}"]`);
    if (!box || !mark) return;
    // The nearest scrolling ancestor is the pane, not the transcript, so the
    // offset is worked out by hand rather than left to scrollIntoView — which
    // would scroll the whole file and take the list off screen with it.
    const scroller = box.closest<HTMLElement>(".pane-inner");
    if (!scroller) return;
    const top =
      mark.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  useEffect(() => {
    setView(null);
    conversationView(sessionId).then(setView).catch((e) => setError(String(e)));
  }, [sessionId]);

  // Closing the file must not leave a node lit on the map behind it. Held in a
  // ref because the caller passes an inline function: depending on it directly
  // would re-run this cleanup on every render and clear the highlight the
  // moment it was set.
  const traceRef = useRef(onTrace);
  traceRef.current = onTrace;
  useEffect(() => () => traceRef.current?.(null), []);

  return (
    <div className="pane-inner">
      <header className="head">
        <button className="btn" onClick={onClose}>← Back</button>
        {view && (
          <span className="muted">{view.title || dateTime(view.started_at)}</span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!view ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {/* The conversation first, as it happened. What was taken from it sits
              underneath — the record is the thing, and the notes are notes on
              it, not a replacement for it. */}
          <div className="deep-split">
          <div className="deep-main">
          <div className="deep-transcript" ref={transcriptRef}>
            {view.turns.map((turn) =>
              turn.role === "user" ? (
                <p key={turn.id} className="turn user">
                  {turn.segments.map((seg, i) =>
                    seg.idea_id === null ? (
                      <span key={i}>{seg.text}</span>
                    ) : (
                      <mark
                        key={i}
                        className={seg.idea_id === trace ? "extracted lit" : "extracted"}
                        data-idea={seg.idea_id ?? undefined}
                        onClick={() => seg.idea_id && setOpenIdea(seg.idea_id)}
                      >
                        {seg.text}
                        {seg.reasoning && (
                          <span className="why">
                            <em>{seg.reasoning}</em>
                          </span>
                        )}
                      </mark>
                    ),
                  )}
                </p>
              ) : (
                <Reply
                  key={turn.id}
                  text={turn.segments.map((s) => s.text).join("")}
                  digest={turn.digest}
                />
              ),
            )}
          </div>

          </div>

          <aside className="deep-aside">
          <h2 className="taken-head">Extracted ideas</h2>
          {taken.length === 0 ? (
            <p className="blurb">Nothing was recorded from this one.</p>
          ) : (
            <ul className="list" onMouseLeave={() => onTrace?.(null)}>
              {taken.map((t) => (
                <li key={t.ideaId}>
                  <button
                    className="row-btn"
                    onClick={() => setOpenIdea(t.ideaId)}
                    onMouseEnter={() => {
                      setTrace(t.ideaId);
                      onTrace?.(t.ideaId);
                      show(t.ideaId);
                    }}
                    onMouseLeave={() => {
                      setTrace(null);
                      onTrace?.(null);
                    }}
                  >
                    <span className="dot" />
                    <span className="row-main">
                      {t.title}
                      {trace === t.ideaId && (
                        <span className="trace">
                          {/* The quote alone rarely says why it was recorded —
                              the crystallisation is the part that does. */}
                          {t.reasoning && <em className="trace-why">{t.reasoning}</em>}
                          <span className="trace-quote">“{t.quote}”</span>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Nudges strong={view.strong} weak={view.weak} />
          </aside>
          </div>
        </>
      )}

      {openIdea !== null && (
        // Stacked over this file, not in place of it — closing it puts you back
        // exactly where you were reading.
        <Sheet depth={1} onClose={() => setOpenIdea(null)}>
          <IdeaFile
            ideaId={openIdea}
            onOpenConversation={() => setOpenIdea(null)}
            onClose={() => setOpenIdea(null)}
          />
        </Sheet>
      )}
    </div>
  );
}

/**
 * One answer, shown short.
 *
 * Nothing is injected into the conversation to make the assistant terser — it
 * answers at whatever length it likes. The condensing happens afterwards, on the
 * record, and the answer itself is always one click below. Left in full, two or
 * three thousand characters of reply against a sentence of thinking turns the
 * page into somewhere the machine does all the talking.
 */
function Reply({ text, digest }: { text: string; digest: string | null }) {
  const [full, setFull] = useState(false);
  const long = text.length > 420;

  if (digest && !full) {
    return (
      <div className="turn assistant">
        <div className="digest">{digest}</div>
        <button className="link" onClick={() => setFull(true)}>
          read the answer in full
        </button>
      </div>
    );
  }

  return (
    <div className={`turn assistant${!digest && long && !full ? " clipped" : ""}`}>
      <Markdown>{!digest && long && !full ? `${text.slice(0, 420)}…` : text}</Markdown>
      {(digest || long) && (
        <button className="link" onClick={() => setFull(!full && !digest ? true : false)}>
          {digest ? "show the short version" : full ? "show less" : `show all ${text.length} characters`}
        </button>
      )}
    </div>
  );
}

/** An idea's file: everything supporting it, and how it has changed. */
/** One entry per conversation, oldest first, however many quotes it holds. */
function conversations(evidence: IdeaView["evidence"]) {
  const seen = new Map<number, IdeaView["evidence"][number]>();
  for (const e of evidence) {
    if (!seen.has(e.session_id)) seen.set(e.session_id, e);
  }
  return [...seen.values()];
}

/**
 * Whether a margin note says anything the claim does not.
 *
 * A local model asked to read an idea back will sometimes hand back the idea,
 * and a section headed "In the margin" containing the sentence directly above
 * it is worse than no section at all.
 */
function worthShowing(dive: string | null, claim: string): boolean {
  if (!dive || !dive.trim()) return false;
  const flatten = (t: string) =>
    t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const [d, c] = [flatten(dive), flatten(claim)];
  return !(d === c || d.startsWith(c) || c.startsWith(d));
}

export function IdeaFile({
  ideaId,
  onOpenConversation,
  onClose,
}: {
  ideaId: number;
  onOpenConversation: (id: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<IdeaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dive, setDive] = useState<string | null>(null);
  const [diving, setDiving] = useState(false);

  const load = () => ideaView(ideaId).then(setView).catch((e) => setError(String(e)));

  // Only the cached copy on open; generating costs a model call, so that waits
  // for you to ask.
  useEffect(() => {
    setDive(null);
    ideaDeepDive(ideaId).then(setDive).catch(() => {});
  }, [ideaId]);

  async function think(regenerate = false) {
    setDiving(true);
    setError(null);
    try {
      setDive(await ideaDeepDive(ideaId, regenerate));
    } catch (e) {
      setError(String(e));
    } finally {
      setDiving(false);
    }
  }
  useEffect(() => {
    setView(null);
    void load();
  }, [ideaId]);

  return (
    <div className="pane-inner">
      <header className="head">
        <button className="btn" onClick={onClose}>← Back</button>
        {view && view.evidence.length > 1 && (
          <span className="muted">
            across {new Set(view.evidence.map((e) => e.session_id)).size} conversations
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!view ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h2 className="deep-claim">{view.title}</h2>
          {view.title !== view.claim && <p className="deep-subclaim">{view.claim}</p>}
          <Nudges strong={view.strong} weak={view.weak} />

          <h3 className="section">Why</h3>
          {view.evidence.map((e) => (
            <div key={e.id} className="evidence">
              {e.reasoning && <p className="why-inline">{e.reasoning}</p>}
              <blockquote className="context-quote">
                “{e.quote}”
                {e.normalized && <span className="tag">loose match</span>}
              </blockquote>
            </div>
          ))}

          {/* One button per conversation, at the bottom. It used to sit under
              every quote, so a single conversation that said something three
              times offered the same button three times. */}
          <div className="sources">
            {conversations(view.evidence).map((c) => (
              <button key={c.session_id} className="btn" onClick={() => onOpenConversation(c.session_id)}>
                Open the conversation — {plainDate(c.started_at)}
              </button>
            ))}
          </div>

          {/* Below the evidence, not above it: the model's reading of an idea
              is worth less than the words the idea came from, and putting it
              first pushed those off the screen. */}
          {worthShowing(dive, view.claim) ? (
            <section className="dive">
              <h3 className="section">In the margin</h3>
              <div className="dive-text">
                {dive!.split(/\n\s*\n/).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </section>
          ) : (
            <div className="sources">
              <button
                className={diving ? "btn busy" : "btn"}
                disabled={diving}
                onClick={() => void think(true)}
              >
                {diving && <span className="spinner" aria-hidden="true" />}
                {diving ? "Reading…" : "Read it back — what this would need, and where it breaks"}
              </button>
            </div>
          )}

          {/* One quiet line. The wording, the date and the confidence were
              three lines of furniture around one fact; what actually has to
              survive is the undo, because rewriting is the only thing here
              that can destroy something you wrote. */}
          {view.revisions.filter((r) => !r.reverted_at).map((r) => (
            <p key={r.id} className="revision-line muted">
              rewritten {plainDate(r.created_at)} ·{" "}
              <button
                className="link"
                onClick={() => revertRevision(r.id).then(load).catch((e) => setError(String(e)))}
              >
                undo
              </button>
            </p>
          ))}
        </>
      )}
    </div>
  );
}
