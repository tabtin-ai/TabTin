export type CollabModuleName = "docs" | "table" | "canvas" | "slide" | "video";

export type CollabControlEventType =
  | `${CollabModuleName}.control.progress`
  | `${CollabModuleName}.control.collab_status`
  | `${CollabModuleName}.${string}.invalidate`;

export interface CollabControlEvent<TPayload = unknown> {
  type: CollabControlEventType;
  payload: TPayload;
  opId?: string;
  timestamp?: string;
}

export interface InvalidationPayload {
  resource_id: string;
  reason: string;
  ids?: string[];
  cursor?: string;
}

export function isInvalidationEvent(type: string): boolean {
  return type.endsWith(".invalidate");
}

export function isControlEvent(type: string): boolean {
  return type.includes(".control.") || isInvalidationEvent(type);
}
