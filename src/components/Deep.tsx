import { useEffect, useRef, useState, type CSSProperties } from "react";
import Markdown from "./Markdown";
import SpeakInto from "./SpeakInto";
import { useUndoable } from "../lib/undo";
import Sheet from "./Sheet";
import Resolve from "./Resolve";
import { IconChevron } from "./Icons";
import { dateTime, plainDate } from "../lib/format";
import { categoryColor } from "../lib/categories";
import { getSettings, onSettingsChanged, type ChatStance } from "../lib/settings";
import {
  answerDispute,
  conversationView,
  digestDisputeAnswer,
  ideaDeepDive,
  ideaView,
  revertRevision,
  type ConversationView,
  type DisputeAnswer,
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
 * The arrow from a challenge to the box that answers it.
 *
 * An arc rather than a straight line, and drawn rather than described: the
 * note and the box are two things a long way apart on the page, and without
 * something joining them the box reads as a general comment field that
 * happens to sit nearby. The curve is the sentence "this one — answer this
 * one", which is not a sentence worth writing out.
 *
 * Purely decorative, so it takes no pointer and no place in the reading
 * order, and it is laid over the row it belongs to rather than taking a
 * column of its own — a stretched SVG between two flex items would move every
 * time either of them wrapped.
 */
function ArcToAnswer() {
  return (
    <svg
      className="dispute-arc"
      viewBox="0 0 120 80"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Born at the note's baseline on the left, over the top, down into the
          box. `preserveAspectRatio="none"` lets it stretch to whatever the
          gap turns out to be. */}
      <path d="M4 12 C 40 -6, 86 6, 108 62" fill="none" />
      <path className="dispute-arc-head" d="M100 50 L108 64 L114 50" fill="none" />
    </svg>
  );
}

/**
 * One of the AI's notes, and the box that answers it.
 *
 * The notes were the end of the conversation: the app said "no measurement is
 * offered" and there was nothing to do about it — an observation you cannot
 * reply to is a verdict. This is the reply, in the person's own words, typed
 * or spoken.
 *
 * The answer is saved first and read back second. Reading back is a model
 * call; on a local model that is tens of seconds, and an answer lost because
 * the machine was busy would be the worst thing this could do to somebody who
 * had just written one.
 */
function Dispute({
  ideaId,
  challenge,
  answers,
  startOpen,
  asked,
  onAnswered,
}: {
  ideaId: number;
  challenge: string;
  /** Replies already recorded against this exact note. */
  answers: DisputeAnswer[];
  /** Open with the box already waiting — this is the doubt that was clicked
   *  on the map to get here. */
  startOpen?: boolean;
  /** A question put to the reader rather than a doubt the model raised, so
   *  it is not dressed as one and carries no "AI" badge. */
  asked?: boolean;
  onAnswered: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(startOpen ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = useUndoable(draft, setDraft);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Opened from the map, on a doubt several screens down a long file. Being
  // taken to the right page and left at the top of it is the same as not
  // being taken anywhere. Keyed on `open` as well, because the box does not
  // exist to be scrolled to until the render that opens it has happened.
  useEffect(() => {
    if (!startOpen) return;
    setOpen(true);
  }, [startOpen]);
  useEffect(() => {
    if (!startOpen || !open) return;
    boxRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [startOpen, open]);

  async function save() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await answerDispute(ideaId, challenge, text);
      setDraft("");
      setOpen(false);
      onAnswered();
      // Reading it back is what makes it a moon. It can fail — no extraction
      // model, a model that returns nothing usable — and the answer is
      // already safe by then, so the failure is worth saying and not worth
      // undoing anything for.
      try {
        await digestDisputeAnswer(id);
      } catch (e) {
        setError(`Saved, but not read back yet: ${e}`);
      }
      onAnswered();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`dispute${open ? " open" : ""}${asked ? " asked" : ""}`}>
      {asked ? (
        <p className="ask-why">{challenge}</p>
      ) : (
        <p className="note weak">
          <span className="badge">AI</span>
          {challenge}
        </p>
      )}

      {answers.map((a) => (
        <p key={a.id} className="dispute-answered">
          <span className="badge you">You</span>
          {a.answer}
          {!a.claim && <span className="tag">not read back yet</span>}
        </p>
      ))}

      {open ? (
        <div className="dispute-reply">
          <ArcToAnswer />
          <div className="dispute-box">
            <textarea
              ref={boxRef}
              className="field dispute-field"
              rows={3}
              autoFocus
              placeholder={asked ? "answer this" : "answer this dispute"}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                undo(e);
                if (e.key === "Escape" && !draft.trim()) setOpen(false);
                // Enter sends, as it does in the composer. A dispute is
                // answered in a sentence or two; a paragraph needs shift.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            {/* Spoken rather than typed is the point of this box as much as
                the box is: an argument you make out loud comes out in your
                own words, and typing it invites editing it into something
                tidier than you think. */}
            <SpeakInto
              disabled={busy}
              onPhrase={(text) =>
                setDraft((d) => (d ? `${d.replace(/\s+$/, "")} ${text}` : text))
              }
            />
          </div>
          <div className="row dispute-actions">
            <button className={busy ? "btn busy" : "btn"} disabled={busy || !draft.trim()} onClick={() => void save()}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Reading it back…" : "Answer"}
            </button>
            <button className="btn subtle" disabled={busy} onClick={() => { setDraft(""); setOpen(false); }}>
              Not now
            </button>
          </div>
        </div>
      ) : (
        <button className="dispute-open" onClick={() => setOpen(true)}>
          {answers.length > 0 ? "Say more" : asked ? "Answer this" : "Answer this dispute"}
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Notes taken alongside an idea.
 *
 * Split under two headings rather than run together, and often absent entirely —
 * an idea with nothing left open is finished, and recording that is the right
 * outcome rather than a gap to fill.
 *
 * Which of the two you get follows the stance the conversation is set to,
 * because they are the same choice asked twice. Someone who set the chat to
 * push back is not asking for a summary of what held up; someone who set it
 * to lay things out is not asking to be argued with in the margin either.
 * The default shows both, which is what "default" has to mean.
 */
function Nudges({
  strong,
  weak,
  about,
  ideaId,
  answers,
  openChallenge,
  onAnswered,
}: {
  strong: string[];
  weak: string[];
  /** What the question should be about — the idea's own claim. */
  about?: string;
  /** Set only in an idea's own file. On a conversation's file the notes are
   *  about the whole session, and there is no single idea to hang a moon
   *  from — so they stay observations there. */
  ideaId?: number;
  answers?: DisputeAnswer[];
  /** The one doubt to open ready to be answered. */
  openChallenge?: string | null;
  onAnswered?: () => void;
}) {
  const [askWhy, setAskWhy] = useState(true);
  const [stance, setStance] = useState<ChatStance>("neutral");
  useEffect(() => {
    let alive = true;
    const take = (s: { ask_why: boolean; chat_stance: ChatStance }) => {
      if (!alive) return;
      setAskWhy(s.ask_why);
      setStance(s.chat_stance);
    };
    void getSettings().then(take);
    const un = onSettingsChanged(take);
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  // "Push back" wants the doubts; "lay it out" wants what held up, quietly.
  const showStrong = stance !== "challenge";
  const showWeak = stance !== "organize";
  const strongShown = showStrong ? strong : [];
  const weakShown = showWeak ? weak : [];

  if (!strongShown.length && !weakShown.length) return null;
  return (
    <div className="notes-panel">
      {strongShown.length > 0 && (
        <section>
          <h3 className="section">Noted alongside</h3>
          {/* Greyed back when it is the only thing here. Laying a thought out
              is not the same as endorsing it, and a lone column of green
              ticks reads as a verdict rather than as a summary. */}
          <div className={showWeak ? "notes" : "notes summary-only"}>
            {strongShown.map((t, i) => (
              <p key={i} className="note strong">
                <span className="badge">AI</span>
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
      {weakShown.length > 0 && (
        <section>
          <div className="notes">
            {weakShown.map((t, i) =>
              // A doubt you can answer, where there is an idea for the answer
              // to belong to. Elsewhere — a whole conversation's notes — it
              // stays what it was, an observation with nowhere to hang a
              // reply.
              ideaId !== undefined && onAnswered ? (
                <Dispute
                  key={i}
                  ideaId={ideaId}
                  challenge={t}
                  answers={(answers ?? []).filter((a) => a.challenge === t)}
                  startOpen={openChallenge === t}
                  onAnswered={onAnswered}
                />
              ) : (
                <p key={i} className="note weak">
                  <span className="badge">AI</span>
                  {t}
                </p>
              ),
            )}
          </div>
        </section>
      )}
      {/* A question, not another note — and deliberately not in the AI's
          voice. The notes above say what the model observed; this asks the
          one thing an observation cannot answer for you. Switched off in
          Settings by anyone who finds it presumptuous.
          
          And answerable, like the doubts are. It was the one thing on the
          page addressed directly to the reader with nowhere to reply: a
          question that cannot be answered is a rhetorical question, which
          is not what this was for. */}
      {askWhy && (strongShown.length > 0 || weakShown.length > 0) && (
        ideaId !== undefined && onAnswered ? (
          <Dispute
            asked
            ideaId={ideaId}
            challenge={askWhyText(about)}
            answers={(answers ?? []).filter((a) => a.challenge === askWhyText(about))}
            startOpen={openChallenge === askWhyText(about)}
            onAnswered={onAnswered}
          />
        ) : (
          <p className="ask-why">{askWhyText(about)}</p>
        )
      )}
    </div>
  );
}

/** The question put to the reader, worded once so the answer recorded against
 *  it still matches after a re-render. */
function askWhyText(about?: string): string {
  return `Why would ${about ? shortenClaim(about) : "this"} be so?`;
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
  highlightIdea,
  onTrace,
  onClose,
}: {
  sessionId: number;
  /** An idea whose words to go straight to and flash — set when this file was
   *  opened by clicking that idea's quote somewhere else. A citation that
   *  drops you at the top of a transcript has not taken you anywhere. */
  highlightIdea?: number | null;
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
  function show(ideaId: number): HTMLElement | null {
    const box = transcriptRef.current;
    const mark = box?.querySelector<HTMLElement>(`mark[data-idea="${ideaId}"]`);
    if (!box || !mark) return null;
    // The transcript's own column is the scroller, not the whole file. It used
    // to be the pane: running the pointer down the list of extracted ideas
    // scrolled the entire page, so the list you were reading slid out from
    // under the pointer as each row answered it.
    const scroller = box.closest<HTMLElement>(".deep-main");
    if (!scroller) return mark;
    const top =
      mark.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return mark;
  }

  /**
   * Go to an idea's words and flash them.
   *
   * Arriving from a citation, the highlight is already one of several on the
   * page and looks like all the others — so it pulses a few times, which is
   * the only thing on a page of static text that the eye goes to on its own.
   * The class is removed afterwards rather than left on: a permanent marker
   * would still be there the next time this file is opened for another
   * reason, pointing at something nobody asked about.
   */
  useEffect(() => {
    if (!view || highlightIdea === null || highlightIdea === undefined) return;
    // After paint: the marks do not exist until the transcript has rendered.
    const id = requestAnimationFrame(() => {
      const mark = show(highlightIdea);
      if (!mark) return;
      setTrace(highlightIdea);
      mark.classList.add("flashing");
      window.setTimeout(() => mark.classList.remove("flashing"), 2600);
    });
    return () => cancelAnimationFrame(id);
    // `show` closes over refs only, and re-running on every render would
    // restart the flash for as long as the file is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, highlightIdea]);

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
    // Its own scroll regions rather than one for the whole file: the
    // transcript and the list of what came out of it are two things read
    // against each other, and moving one must not move the other.
    <div className="pane-inner deep-file">
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
                              the crystallisation is the part that does. Two
                              blocks, not two inline spans: run together on one
                              line the words that were said read as the tail of
                              the sentence explaining them. */}
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
            // Already reading the conversation this quote came from: going
            // "to" it means closing the idea and flashing the words, not
            // opening a second copy of the file underneath.
            onOpenConversation={(_id, ideaId) => {
              setOpenIdea(null);
              if (ideaId !== undefined) {
                const mark = show(ideaId);
                if (mark) {
                  setTrace(ideaId);
                  mark.classList.add("flashing");
                  window.setTimeout(() => mark.classList.remove("flashing"), 2600);
                }
              }
            }}
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
  organize: "laid out",
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
  openChallenge,
  onOpenConversation,
  onClose,
}: {
  ideaId: number;
  /** One of the AI's doubts to open ready to be answered — set when the file
   *  was opened by clicking that doubt on the map, so the reader lands on the
   *  thing they clicked rather than at the top of the page. */
  openChallenge?: string | null;
  /** Go to the conversation a quote came from. The idea comes with it so the
   *  transcript can go straight to those words and flash them, rather than
   *  opening at the top and leaving them to be found. */
  onOpenConversation: (id: number, ideaId?: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<IdeaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dive, setDive] = useState<string | null>(null);
  /** A contradiction being settled, opened over this file. */
  const [settling, setSettling] = useState<{
    relationId: number;
    a: { idea_id: number; claim: string };
    b: { idea_id: number; claim: string };
    reasoning?: string;
  } | null>(null);

  const load = () => ideaView(ideaId).then(setView).catch((e) => setError(String(e)));

  // The cached copy only. Nothing here asks a model for one: the button that
  // used to is gone, and an open that quietly spent a model call would be a
  // worse version of the same thing.
  useEffect(() => {
    setDive(null);
    ideaDeepDive(ideaId, false, true).then(setDive).catch(() => {});
  }, [ideaId]);
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
          {/* The title, and nothing under it. The claim used to sit here as a
              second line, and it is the same sentence said at greater length —
              two headings for one idea, the second of which reads like a
              quotation and is not one. The claim is still what the notes and
              the question below are written about; it just no longer opens
              the page by repeating its own name. */}
          <h2 className="deep-claim">{view.title}</h2>

          {/* The words this rests on, first. They used to be at the very
              bottom, under the notes and the reading — which put the model's
              opinion of the idea above the person's own sentence, on the one
              page where the sentence is the evidence for everything else on
              it. Each is the whole citation: what was said, when, and in
              which conversation, and clicking it goes there. */}
          {view.evidence.map((e) => (
            <div key={e.id} className="quote-source">
              {/* Only the quote goes anywhere. The whole card used to be one
                  button, so reading the date — or moving the pointer across
                  on the way to something else — lit up as though the words
                  were about to be left behind. */}
              <blockquote
                role="link"
                tabIndex={0}
                data-tip="Go to this in the conversation"
                onClick={() => onOpenConversation(e.session_id, view.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onOpenConversation(e.session_id, view.id);
                  }
                }}
              >
                {/* The words either side, smaller and dimmer. A quote on its
                    own is the one sentence the model chose, which is exactly
                    the sentence you cannot check it against — whether it
                    means what the claim says depends on what surrounded it.
                    Set back rather than beside: the quote has to stay the
                    thing being read. */}
                {e.before && <span className="quote-context">{e.before}</span>}
                <span className="quote-said">“{e.quote}”</span>
                {e.after && <span className="quote-context">{e.after}</span>}
              </blockquote>
              {/* The footing of the citation: when on the left, where on the
                  right. The conversation's name was the one thing a citation
                  needs and did not have — a date alone does not tell you
                  which piece of thinking this came out of. The loose-match
                  mark sits here too rather than inside the quotation, where
                  it read as a word somebody had said. */}
              <div className="quote-foot">
                <span className="quote-date">{plainDate(e.started_at)}</span>
                {e.normalized && (
                  <span className="tag" data-tip="The words were found with small differences — punctuation or a substituted word.">
                    loose match
                  </span>
                )}
                {e.session_title && <span className="quote-where">{e.session_title}</span>}
              </div>
            </div>
          ))}

          <Nudges
            strong={view.strong}
            weak={view.weak}
            about={view.claim}
            ideaId={view.id}
            answers={view.answers}
            openChallenge={openChallenge}
            onAnswered={load}
          />

          {view.evidence.map((e) => (
            <div key={e.id} className="evidence">
              {e.reasoning && <p className="why-inline">{e.reasoning}</p>}
            </div>
          ))}

          {/* A reading already made for this idea, if there is one. There is
              no button to make one any more: it sat under every idea offering
              the model's opinion of a claim whose own words are three lines
              above, and pressing it was a model call spent on being told what
              you had just read. What is shown here now is only what was
              generated before that button went. */}
          {worthShowing(dive, view.claim) && (
            <section className="dive">
              {/* Through the markdown renderer, not raw paragraphs — the model
                  writes emphasis, lists and occasional headings, and showing
                  its asterisks verbatim reads as broken. */}
              <div className="dive-text">
                <Markdown>{dive!}</Markdown>
              </div>
            </section>
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
