/**
 * Database Extension 共用工具
 *
 * 供 5 个 database extension（docs、table、slide、video、canvas）
 * 共享的重复模式：document name 解析、编辑者信息提取、store 错误处理。
 */

import type { Hocuspocus } from "@hocuspocus/server";
import { metrics } from "../extensions/metrics.js";
import {
  forceCloseDocument,
  ForceCloseReason,
  CloseCode,
} from "../extensions/force-close.js";
import { extractHttpStatusCode } from "./retry.js";

function scheduleForceCloseAfterStore(params: {
  instance: Hocuspocus;
  documentName: string;
  reason: ForceCloseReason;
  code: CloseCode;
  moduleLabel: string;
}): void {
  const { instance, documentName, reason, code, moduleLabel } = params;

  // forceCloseDocument waits for this document's pending stores before unload.
  // Starting it from inside the rejecting store would make it wait for itself.
  setTimeout(() => {
    Promise.resolve(
      forceCloseDocument(instance, documentName, reason, code),
    ).catch((forceCloseError) => {
      console.error(
        `[${moduleLabel}] Failed to force-close ${documentName}:`,
        forceCloseError,
      );
    });
  }, 0);
}

/**
 * 从 Hocuspocus document name 中解析资源 ID。
 *
 * @param documentName 完整的 document name（如 "docs:uuid-xxx"）
 * @param prefix 模块前缀（如 "docs:"、"table:"）
 * @returns 纯资源 ID，或 null（前缀不匹配）
 */
export function parseResourceId(
  documentName: string,
  prefix: string,
): string | null {
  if (documentName.startsWith(prefix)) {
    return documentName.slice(prefix.length);
  }
  return null;
}

/**
 * 允许的 editor_type 值白名单，供所有 push 路由共用。
 * 请求体传入的 editor_type 不在此集合内时，回退为 "agent"（向后兼容）。
 */
export const ALLOWED_EDITOR_TYPES = new Set(["agent", "user", "system"]);

/**
 * 校验 editor_type 并回退为 "agent"（向后兼容）。
 * "human" 归一化为 "user"，与 extractEditorInfo 保持一致。
 */
export function safeEditorType(raw: unknown): string {
  if (typeof raw !== "string") return "agent";
  if (raw === "human") return "user";
  if (ALLOWED_EDITOR_TYPES.has(raw)) return raw;
  return "agent";
}

/**
 * 从 Hocuspocus context 中提取编辑者信息。
 *
 * onAuthenticate 设置 context.editorType / context.editorId / context.userId，
 * 此函数统一读取并提供默认值。
 * editor_type 已统一为 "user"（原 "human"），此处对 "human" 做归一化以保证兼容。
 */
export function extractEditorInfo(context: unknown): {
  editorType: string;
  editorId: string;
  editorName: string;
  agentRunId: string;
  systemPolicy: string;
} {
  const ctx = context as Record<string, unknown> | null | undefined;
  let editorType = (ctx?.editorType as string) || "user";
  if (editorType === "human") editorType = "user"; // 归一化：与 Django CO-4 保持一致
  return {
    editorType,
    editorId: (ctx?.editorId as string) || (ctx?.userId as string) || "",
    editorName: (ctx?.editorName as string) || "",
    agentRunId: (ctx?.agentRunId as string) || "",
    systemPolicy: (ctx?.systemPolicy as string) || "",
  };
}

type EditorContext = ReturnType<typeof extractEditorInfo>;

function isUsableEditor(info: EditorContext): boolean {
  if (info.editorType === "system") return Boolean(info.systemPolicy);
  if (info.editorType === "agent") return Boolean(info.editorId || info.agentRunId);
  return Boolean(info.editorId);
}

function canUseConnectionForStore(connection: {
  readOnly?: boolean | Boolean;
  context?: Record<string, unknown>;
}): boolean {
  const ctx = connection.context || {};
  if (Boolean(connection.readOnly) === true || ctx.readOnly === true) return false;
  if (ctx.permissionRevoked === true) return false;
  return true;
}

/**
 * Extract editor metadata for store operations.
 *
 * Hocuspocus store callbacks may receive an empty callback-level context even
 * when the room has authenticated connections. Fall back to the active
 * connection contexts so internal persist calls never send `editor_id=""`.
 */
export function extractEditorInfoForStore(
  context: unknown,
  instance: HocuspocusLike | null | undefined,
  documentName: string,
): EditorContext {
  const direct = extractEditorInfo(context);
  if (isUsableEditor(direct)) return direct;

  const doc = instance?.documents.get(documentName);
  if (!doc) return direct;

  for (const connection of doc.getConnections()) {
    if (!canUseConnectionForStore(connection)) continue;
    const candidate = extractEditorInfo(connection.context || {});
    if (isUsableEditor(candidate)) return candidate;
  }

  return direct;
}

// ────────────────────────────────────────────
// 并发编辑者检测（从 Server.detectConcurrentEditors 提取）
// ────────────────────────────────────────────

export type EditorInfo = { editor_type: string; editor_id: string };

/** duck-typing 接口，兼容 Hocuspocus 实例与测试 mock */
export interface HocuspocusLike {
  documents: Map<
    string,
    { getConnections(): Array<{ readOnly?: boolean | Boolean; context: Record<string, unknown> }> }
  >;
}

/**
 * 检测指定文档当前是否有其他非 Agent 编辑者在编辑。
 *
 * 遍历所有 Hocuspocus 实例，收集连接中 editorType !== "agent"
 * 且 editorId !== excludeEditorId 的编辑者信息。
 */
export function detectConcurrentEditors(
  instances: ReadonlyArray<HocuspocusLike | null | undefined>,
  documentName: string,
  excludeEditorId: string,
): EditorInfo[] {
  const editors: EditorInfo[] = [];

  for (const instance of instances) {
    if (!instance) continue;
    const doc = instance.documents.get(documentName);
    if (!doc) continue;

    for (const connection of doc.getConnections()) {
      const ctx = connection.context || {};
      let editorType = (ctx.editorType as string) || "user";
      if (editorType === "human") editorType = "user";
      const editorId = (ctx.editorId as string) || "";

      if (editorType === "agent") continue;
      if (editorId && editorId === excludeEditorId) continue;

      editors.push({ editor_type: editorType, editor_id: editorId });
    }
  }

  return editors;
}

/**
 * 合并两次 detectConcurrentEditors 的结果（按 editor_type:editor_id 去重），
 * 用于 TOCTOU 防御：取 pre-transact 与 post-transact 的并集。
 */
export function mergeEditors(a: EditorInfo[], b: EditorInfo[]): EditorInfo[] {
  const seen = new Set(a.map((e) => `${e.editor_type}:${e.editor_id}`));
  const result = [...a];
  for (const e of b) {
    const key = `${e.editor_type}:${e.editor_id}`;
    if (!seen.has(key)) {
      result.push(e);
      seen.add(key);
    }
  }
  return result;
}

/**
 * 处理 database store 阶段的错误。
 *
 * - 记录延迟和错误计数
 * - 413 时在当前 store settled 后 forceClose 文档并 throw
 * - 其他错误重新 throw
 */
export async function handleStoreError(params: {
  error: unknown;
  resourceId: string;
  documentName: string;
  instance: Hocuspocus | null;
  moduleLabel: string;
  startTime: number;
}): Promise<void> {
  const { error, resourceId, documentName, instance, moduleLabel, startTime } =
    params;
  const latency = Date.now() - startTime;
  metrics.recordStoreLatency(latency);
  metrics.storeErrors++;

  const errMsg =
    error instanceof Error ? error.message : String(error);

  if (extractHttpStatusCode(errMsg) === 413) {
    console.error(
      `[${moduleLabel}] ${resourceId} too large, force closing`,
    );
    if (instance) {
      scheduleForceCloseAfterStore({
        instance,
        documentName,
        reason: ForceCloseReason.DOCUMENT_TOO_LARGE,
        code: CloseCode.DOCUMENT_TOO_LARGE,
        moduleLabel,
      });
    }
    throw error instanceof Error
      ? error
      : new Error(errMsg);
  }

  console.error(
    `[${moduleLabel}] Store failed for ${resourceId}:`,
    error,
  );
  throw error;
}
