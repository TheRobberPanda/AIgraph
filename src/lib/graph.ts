import { invoke } from "@tauri-apps/api/core";

export interface GraphNode {
  id: string;
  kind: "conversation" | "idea";
  label: string;
  weight: number;
  session_id: number | null;
  idea_id: number | null;
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
  source: string;
  target: string;
  kind: "from" | "related" | "contradicts" | "category";
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
