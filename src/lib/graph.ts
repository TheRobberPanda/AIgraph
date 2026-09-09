import { invoke } from "@tauri-apps/api/core";

export interface GraphNode {
  id: string;
  /**
   * A conversation is a sun, an idea a planet, and a moon an answer to one of
   * the AI's doubts about that planet — the person's own reply, hanging from
   * the idea it defends.
   */
  kind: "conversation" | "idea" | "moon";
  label: string;
  weight: number;
  session_id: number | null;
  /** For a moon, the idea it hangs from — clicking one opens that idea's
   *  file, where its dispute is. */
  idea_id: number | null;
  /** Moons only: which recorded answer this is. */
  answer_id: number | null;
  /** What the idea is about. Empty for conversations. */
  category: string;
  /** When a conversation happened. Empty for ideas. */
  date: string;
  /** Supported by more than one conversation — these connect the map. */
  shared: boolean;
  /** Rewritten in the last few minutes. */
  just_revised: boolean;
  /** Carried on the node so hover can animate immediately, with no round trip. */
  strong: string[];
  weak: string[];
}

export interface GraphEdge {
  /** The stored link this came from, where there is one. Structural edges —
   *  a conversation to its ideas, a subject chain — are computed rather than
   *  stored, so they have none and nothing can be done to them. */
  id?: number;
  source: string;
  target: string;
  kind: "from" | "related" | "contradicts" | "category" | "answers";
  weight: number;
  /** Why the two relate, where reconciliation said so. Absent on structural
   *  edges and on links drawn from a similarity score alone. */
  reasoning?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The map for one folder, or every folder when null. */
export function loadGraph(folder?: number | null): Promise<GraphData> {
  return invoke<GraphData>("graph", { folder: folder ?? null });
}
