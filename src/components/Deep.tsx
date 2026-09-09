import { useEffect, useRef, useState, type CSSProperties } from "react";
import Markdown from "./Markdown";
import Sheet from "./Sheet";
import Resolve from "./Resolve";
import { IconChevron } from "./Icons";
import { dateTime, plainDate } from "../lib/format";
import { categoryColor } from "../lib/categories";
import { getSettings, onSettingsChanged } from "../lib/settings";
import {
  conversationView,
  ideaDeepDive,
  ideaView,
  revertRevision,
  type ConversationView,
  type Segment,
  type IdeaView,
} from "../lib/views";

/**
 * Group a turn's runs into paragraphs.
 *
 * A long turn was one block with newlines preserved by CSS, which is to say a
 * wall — and a wall is not reread. The breaks come from the record rather than
 * from the text, so grouping is the only thing left to do here: everything
 * that decided *where* they go has already happened, and was verified against
 * the words themselves.
 */
function paragraphs(segments: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  for (const seg of segments) {
    if (out.length === 0 || seg.paragraph_start) out.push([]);
    out[out.length - 1].push(seg);
  }
  return out;
}

/**
 * Notes taken alongside an idea.
 *
 * Split under two headings rather than run together, and often absent entirely —
 * an idea with nothing left open is finished, and recording that is the right
 * outcome rather than a gap to fill.
 */
function Nudges({
  strong,
  weak,
  about,
}: {
  strong: string[];
  weak: string[];
  /** What the question should be about — the idea's own claim. */
  about?: string;
}) {
  const [askWhy, setAskWhy] = useState(true);
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => alive && setAskWhy(s.ask_why));
    const un = onSettingsChanged((s) => alive && setAskWhy(s.ask_why));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  if (!strong.length && !weak.length) return null;
  return (
    <div className="notes-panel">
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
      {/* A question, not another note — and deliberately not in the AI's
          voice. The notes above say what the model observed; this asks the
          one thing an observation cannot answer for you. Styled apart from
          them because it is addressed to the reader, and switched off in
          Settings by anyone who finds it presumptuous. */}
      {askWhy && (strong.length > 0 || weak.length > 0) && (
        <p className="ask-why">
          Why would {about ? shortenClaim(about) : "this"} be so?
        </p>
      )}
    </div>
  );
}

/** A claim, cut to something that fits inside a sentence. */
function shortenClaim(claim: string): string {
  const one = claim.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const lower = one.charAt(0).toLowerCase() + one.slice(1);
  return lower.length > 70 ? `${lower.slice(0, 70).trimEnd()}…` : lower;
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
                <div key={turn.id} className="turn user">
                  {paragraphs(turn.segments).map((para, p, all) => (
                  <p key={p} className="turn-para">
                    {/* Numbered only where there is more than one: a lone "1"
                        beside a single paragraph is a label for nothing. They
                        exist so a long turn can be pointed at — "the third
                        paragraph" — which is otherwise impossible in a wall
                        of text with no landmarks. */}
                    {all.length > 1 && <span className="para-n">{p + 1}</span>}
                  {para.map((seg, i) =>
                    seg.idea_id === null ? (
                      <span key={i}>{seg.text}</span>
                    ) : (
                      <mark
                        key={i}
                        className={seg.idea_id === trace ? "extracted lit" : "extracted"}
                        data-idea={seg.idea_id ?? undefined}
                        style={
                          {
                            "--tag-color": categoryColor(seg.category ?? ""),
                          } as CSSProperties
                        }
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
                  ))}
                </div>
              ) : (
                <Reply
                  key={turn.id}
                  text={turn.segments.map((s) => s.text).join("")}
                  digest={turn.digest}
                  stance={STANCE_WORD[view.ai_profile.stance ?? ""]}
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
function Reply({
  text,
  digest,
  stance,
}: {
  text: string;
  digest: string | null;
  stance?: string;
}) {
  const [full, setFull] = useState(false);
  const long = text.length > 420;

  if (digest && !full) {
    return (
      <div className="turn assistant">
        {/* Which settings this answer was given under. Two conversations
            that read very differently otherwise look like the same thing
            happening twice, and by the time you are reading the short
            version there is nothing left to tell them apart. */}
        {stance && <span className="stance-tag">{stance}</span>}
        <div className="digest">{digest}</div>
        <button className="icon-btn expand-toggle" data-tip="Read the answer in full" onClick={() => setFull(true)}>
          <IconChevron />
        </button>
      </div>
    );
  }

  return (
    <div className={`turn assistant${!digest && long && !full ? " clipped" : ""}`}>
      <Markdown>{!digest && long && !full ? `${text.slice(0, 420)}…` : text}</Markdown>
      {(digest || long) && (
        <button
          className={`icon-btn expand-toggle${digest || full ? " flip" : ""}`}
          data-tip={digest ? "Show the short version" : full ? "Show less" : `Show all ${text.length} characters`}
          onClick={() => setFull(!full && !digest ? true : false)}
        >
          <IconChevron />
        </button>
      )}
    </div>
  );
}

/**
 * How a recorded AI setting reads on screen.
 *
 * Keyed off whatever the profile happens to hold rather than a fixed set, so
 * a setting added later shows up as soon as it is written — the record is an
 * open map for exactly that reason. An unknown value is simply not named,
 * which is better than inventing a label for it.
 */
const STANCE_WORD: Record<string, string | undefined> = {
  neutral: "default",
  challenge: "pushed back",
  organize: "organised",
};

/** An idea's file: everything supporting it, and how it has changed. */

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
  /** A contradiction being settled, opened over this file. */
  const [settling, setSettling] = useState<{
    relationId: number;
    a: { idea_id: number; claim: string };
    b: { idea_id: number; claim: string };
    reasoning?: string;
  } | null>(null);

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
          <Nudges strong={view.strong} weak={view.weak} about={view.claim} />

          {view.evidence.map((e) => (
            <div key={e.id} className="evidence">
              {e.reasoning && <p className="why-inline">{e.reasoning}</p>}
            </div>
          ))}

          {/* Below the evidence, not above it: the model's reading of an idea
              is worth less than the words the idea came from, and putting it
              first pushed those off the screen. */}
          {worthShowing(dive, view.claim) ? (
            <section className="dive">
              {/* Through the markdown renderer, not raw paragraphs — the model
                  writes emphasis, lists and occasional headings, and showing
                  its asterisks verbatim reads as broken. */}
              <div className="dive-text">
                <Markdown>{dive!}</Markdown>
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
                {diving ? "Reading…" : "Read it back"}
              </button>
            </div>
          )}

          {/* Reconciliation has recorded these since it started judging pairs,
              and the map has drawn them — but the idea's own file, the one
              place somebody reads the idea properly, never mentioned them.
              Here, and actionable, because a tension you cannot act on is
              just a complaint. */}
          {view.contradictions.map((c) => (
            <div key={c.relation_id} className="at-odds">
              <p className="at-odds-head">This sits badly with</p>
              <p className="at-odds-claim">{c.other_claim}</p>
              {c.reasoning && <p className="blurb">{c.reasoning}</p>}
              <button
                className="btn subtle"
                onClick={() =>
                  setSettling({
                    relationId: c.relation_id,
                    a: { idea_id: view.id, claim: view.claim },
                    b: { idea_id: c.other_id, claim: c.other_claim },
                    reasoning: c.reasoning ?? undefined,
                  })
                }
              >
                Settle it
              </button>
            </div>
          ))}

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

          {/* The words this rests on, at the very bottom — this is where a
              quote belongs, not floating in the middle of the reading. Each
              is the whole citation: what was said and when, and opens the
              conversation it was said in, the way a citation would. */}
          {view.evidence.map((e) => (
            <div key={e.id} className="quote-source">
              {/* Only the quote goes anywhere. The whole card used to be one
                  button, so reading the date — or moving the pointer across
                  on the way to something else — lit up as though the words
                  were about to be left behind. */}
              <blockquote
                role="link"
                tabIndex={0}
                onClick={() => onOpenConversation(e.session_id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onOpenConversation(e.session_id);
                  }
                }}
              >
                “{e.quote}”
                {e.normalized && <span className="tag">loose match</span>}
              </blockquote>
              <span className="quote-date">{plainDate(e.started_at)}</span>
            </div>
          ))}
        </>
      )}

      {settling && (
        <Resolve
          a={settling.a}
          b={settling.b}
          relationId={settling.relationId}
          reasoning={settling.reasoning}
          onClose={() => setSettling(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
