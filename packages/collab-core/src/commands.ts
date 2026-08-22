import type { CollabModuleName } from "./controlEvents.js";

const MODULES: ReadonlySet<CollabModuleName> = new Set(["docs", "table", "canvas", "slide", "video"]);

export interface CollabDomainOp<TPayload = unknown> {
  type: string;
  payload: TPayload;
}

export interface CollabApplyOpsRequest<TOp extends CollabDomainOp = CollabDomainOp> {
  module: CollabModuleName;
  documentName: string;
  opId: string;
  ops: TOp[];
}

export interface CollabApplyOpsResult {
  status: "ok" | "error";
  code?: string;
  message?: string;
}

export function validateCollabApplyOpsRequest(
  request: Partial<CollabApplyOpsRequest>,
): { ok: true } | { ok: false; message: string } {
  if (!request.module || !MODULES.has(request.module)) {
    return { ok: false, message: "module must be one of docs/table/canvas/slide/video" };
  }
  if (!request.documentName) return { ok: false, message: "documentName is required" };
  if (!request.opId) return { ok: false, message: "opId is required" };
  if (!Array.isArray(request.ops) || request.ops.length === 0) {
    return { ok: false, message: "ops must be a non-empty array" };
  }
  return { ok: true };
}
