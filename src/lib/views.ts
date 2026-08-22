import { invoke } from "@tauri-apps/api/core";

/** A run of transcript. Highlighted runs carry the idea they produced. */
export interface Segment {
  text: string;
  idea_id: number | null;
  claim: string | null;
  reasoning: string | null;
}

export interface ViewTurn {
  id: number;
  role: "user" | "assistant";
  segments: Segment[];
}

export interface ConversationView {
  session_id: number;
  started_at: string;
  model: string;
  turns: ViewTurn[];
  strong: string[];
  weak: string[];
}

export interface IdeaEvidence {
  id: number;
  session_id: number;
  started_at: string;
  quote: string;
  reasoning: string;
  normalized: boolean;
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
  revision: number;
  strong: string[];
  weak: string[];
  evidence: IdeaEvidence[];
  revisions: IdeaRevision[];
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
export function ideaDeepDive(ideaId: number, regenerate = false): Promise<string> {
  return invoke<string>("idea_deep_dive", { ideaId, regenerate });
}
