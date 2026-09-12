import { invoke } from "@tauri-apps/api/core";

/** A run of transcript. Highlighted runs carry the idea they produced. */
export interface Segment {
  text: string;
  idea_id: number | null;
  claim: string | null;
  title: string | null;
  reasoning: string | null;
  category: string | null;
  /** This run opens a paragraph. Derived from stored offsets — the text itself
   *  is never edited, so highlights cannot drift. */
  paragraph_start: boolean;
}

export interface ViewTurn {
  id: number;
  role: "user" | "assistant";
  segments: Segment[];
  /** A short version of an answer. The answer itself is always in `segments`. */
  digest: string | null;
}

export interface ConversationView {
  session_id: number;
  started_at: string;
  title: string;
  model: string;
  turns: ViewTurn[];
  strong: string[];
  weak: string[];
  /** Replies to the AI's notes on this whole conversation. */
  answers: SessionDisputeAnswer[];
  /** The AI settings this conversation ran under. An open map on purpose:
   *  what the model is told will grow, and the screen can show whatever is
   *  in here without another change to the schema. */
  ai_profile: Record<string, string | undefined>;
}

/** A reply to one of the AI's notes on a whole conversation. */
export interface SessionDisputeAnswer {
  id: number;
  /** The note being answered, verbatim. */
  challenge: string;
  /** What was written or spoken. */
  answer: string;
  created_at: string;
}

export interface IdeaEvidence {
  id: number;
  session_id: number;
  turn_id: number;
  started_at: string;
  quote: string;
  reasoning: string;
  normalized: boolean;
  /** The conversation this was said in, by name. A date alone does not tell
   *  you which piece of thinking a quote came out of. */
  session_title: string;
  /** The words either side of the quote in the turn it came from, already
   *  cut to whole words and marked with an ellipsis where they were cut.
   *  Empty at the start or end of a turn. Sliced in Rust: these are byte
   *  offsets into UTF-8 and JavaScript indexes UTF-16. */
  before: string;
  after: string;
}

/** A reply to one of the AI's notes on an idea. */
export interface DisputeAnswer {
  id: number;
  /** The note being answered, verbatim. */
  challenge: string;
  /** What was written or spoken. */
  answer: string;
  /** The answer read back as one claim. Empty until it has been — which is
   *  also what "not yet a moon on the map" means. */
  claim: string;
  title: string;
  created_at: string;
}

export interface IdeaRevision {
  id: number;
  prev_claim: string;
  new_claim: string;
  confidence: number;
  created_at: string;
  reverted_at: string | null;
}

export interface IdeaView {
  id: number;
  claim: string;
  title: string;
  revision: number;
  strong: string[];
  weak: string[];
  evidence: IdeaEvidence[];
  revisions: IdeaRevision[];
  /** Replies to the AI's notes on this idea — the moons it has grown. */
  answers: DisputeAnswer[];
  /** What this idea is recorded as contradicting, and has not been settled. */
  contradictions: Contradiction[];
}

/** Another idea that cannot be true at the same time as this one. */
export interface Contradiction {
  relation_id: number;
  other_id: number;
  other_claim: string;
  other_title: string;
  reasoning: string | null;
  /** Already dealt with. Kept in the view so the decision can be taken back. */
  resolved: boolean;
  /** How both stand, in the person's words, when they said. */
  resolution: string | null;
}

export function conversationView(sessionId: number): Promise<ConversationView> {
  return invoke<ConversationView>("conversation_view", { sessionId });
}

export function ideaView(ideaId: number): Promise<IdeaView> {
  return invoke<IdeaView>("idea_view", { ideaId });
}

export function revertRevision(revisionId: number): Promise<void> {
  return invoke("revert_revision", { revisionId });
}

/**
 * The long-form argument about an idea.
 *
 * Generated on first open and cached — it costs a model call, so it is not
 * produced for every idea at extraction time.
 */
export function ideaDeepDive(
  ideaId: number,
  regenerate = false,
  cachedOnly = false,
): Promise<string> {
  return invoke<string>("idea_deep_dive", { ideaId, regenerate, cachedOnly });
}

/**
 * Record a reply to one of the AI's notes. Returns the new answer's id.
 *
 * Two calls rather than one, deliberately: this saves, `digestDisputeAnswer`
 * reads back. Reading back costs a model call — tens of seconds on a local
 * model — and an answer lost because the machine was busy would be the worst
 * thing this could do to somebody who had just written one.
 */
export function answerDispute(
  ideaId: number,
  challenge: string,
  answer: string,
): Promise<number> {
  return invoke<number>("answer_dispute", { ideaId, challenge, answer });
}

/** Read a saved answer back as one claim, which is what puts it on the map. */
export function digestDisputeAnswer(answerId: number): Promise<string> {
  return invoke<string>("digest_dispute_answer", { answerId });
}

/** Record a reply to one of the AI's notes on a whole conversation. */
export function answerSessionDispute(
  sessionId: number,
  challenge: string,
  answer: string,
): Promise<number> {
  return invoke<number>("answer_session_dispute", { sessionId, challenge, answer });
}

export function deleteDisputeAnswer(answerId: number): Promise<void> {
  return invoke("delete_dispute_answer", { answerId });
}

/** Take a settled contradiction back, so it can be settled differently. */
export function unresolveRelation(relationId: number): Promise<void> {
  return invoke("unresolve_relation", { relationId });
}
