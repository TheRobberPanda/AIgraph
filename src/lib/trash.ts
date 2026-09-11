import { invoke } from "@tauri-apps/api/core";

export type TrashedKind = "session" | "idea" | "make_output";

export interface TrashedItem {
  id: number;
  kind: TrashedKind;
  label: string;
  /** What was in it — turns and ideas for a conversation, nothing for the rest. */
  detail: string;
  deleted_at: string;
}

/** What is sitting in the trash, newest first. */
export function listTrash(): Promise<TrashedItem[]> {
  return invoke<TrashedItem[]>("list_trash");
}

/** Put a binned thing back where it was. */
export function restoreTrashed(trashId: number): Promise<void> {
  return invoke("restore_trash_item", { trashId });
}

/** Drop a bin entry and its snapshot. The one delete that cannot be undone. */
export function purgeTrashed(trashId: number): Promise<void> {
  return invoke("purge_trash_item", { trashId });
}

/** Empty the bin. */
export function emptyTrash(): Promise<void> {
  return invoke("empty_trash");
}