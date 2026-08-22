import type * as Y from "yjs";
import type { RouteContext } from "../routes/types.js";

export const APPLY_OPS_RESOURCE_TYPES = new Set(["docs", "table", "slide", "video", "canvas"]);
export const MAX_BINARY_BYTES = 5 * 1024 * 1024;
export const MULTI_INSTANCE_WARNING =
  "concurrent_editors 仅反映当前节点的连接，多实例部署下可能漏报其他节点的人类编辑者";

export interface CollabApplyOpsBody {
  resource_type?: string;
  resource_id?: string;
  document_name?: string;
  op_id?: string;
  ops?: unknown[];
  origin_id?: string;
  editor_type?: string;
  editor_id?: string;
  editor_name?: string;
  agent_run_id?: string;
  system_policy?: string;
  require_store_success?: boolean;
  record_lifecycle_revalidation_ids?: string[];
}

export type CollabPrimitiveOp =
  | { op: "y.update.apply"; update_b64: string }
  | { op: "xml.fragment.replace"; fragment: string; update_b64: string }
  | { op: "map.set"; path: string[]; key: string; value: unknown }
  | { op: "map.patch"; path: string[]; values: Record<string, unknown> }
  | { op: "map.delete"; path: string[]; key: string }
  | { op: "map.clear"; path: string[] }
  | { op: "map.delete_where"; path: string[]; equals: Record<string, unknown> }
  | { op: "array.replace"; path: string[]; values: unknown[] }
  | { op: "order.set"; path: string[]; positions: Record<string, number | string> }
  | { op: "order.after"; path: string[]; key: string; after_key?: string | null }
  | { op: "stateless.broadcast"; event: string; payload: unknown };

export interface PrimitiveExecutorInput {
  ydoc: Y.Doc;
  documentName: string;
  /** Validated request resource type; direct callers may rely on documentName. */
  resourceType?: string;
  routeContext: RouteContext;
  ops: unknown[];
}

export type ApplyOpsHandlerResult = Record<string, unknown>;

export function isResourceType(value: unknown): value is string {
  return typeof value === "string" && APPLY_OPS_RESOURCE_TYPES.has(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
