/**
 * Hocuspocus Database Extension
 *
 * - onFetchDocument: 从 Django API 获取 Y.js binary
 * - onStoreDocument: 将 Y.js state 持久化到 Django（附带格式转换）
 *
 * 参照 Plane apps/live/src/extensions/database.ts
 */

import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { Database as HocuspocusDatabase } from "@hocuspocus/extension-database";
import { DOC_SCHEMA_VERSION } from "@tabtin/doc-editor";
import {
  fetchDocumentBinary,
  storeDocumentUpdate,
} from "../services/django-api.js";
import {
  binaryToAllFormats,
  markdownToUpdateBinary,
  pmJsonToUpdateBinary,
} from "../lib/converters.js";
import { metrics } from "./metrics.js";
import { withRetry } from "../lib/retry.js";
import { parseResourceId, extractEditorInfoForStore, handleStoreError } from "../lib/collab-utils.js";
import { storeSemaphore } from "./base-collab-database.js";
import { replaceXmlFragment } from "../apply-ops/executor.js";
import { RESYNC_ORIGIN } from "../lib/resync.js";
import type { ResyncResult } from "../lib/resync.js";
import { recordCollabStore } from "./runtime-snapshot.js";

const DOCS_PREFIX = "docs:";

/** CL-006: 超过此阈值时触发 Y.js binary compaction（512 KB） */
const COMPACTION_THRESHOLD_BYTES = 512 * 1024;

const UNLOAD_TIMEOUT_MS = 15_000;
const SEMAPHORE_ACQUIRE_TIMEOUT_MS = 30_000;
const STORE_SLOW_THRESHOLD_MS = parseInt(process.env.COLLAB_STORE_SLOW_THRESHOLD_MS || "2000", 10);

type ProseMirrorDocJson = Record<string, unknown> & {
  content: unknown[];
};

function getNonEmptyProseMirrorDocJson(value: unknown): ProseMirrorDocJson | null {
  if (!value || typeof value !== "object") return null;

  const doc = value as Record<string, unknown>;
  const content = doc.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  return { ...doc, content };
}

/**
 * CL-006: 对超大 Y.js binary 执行 compaction。
 *
 * 通过创建新的 gc=true 的 Y.Doc 并重新编码，
 * 消除 CRDT struct 碎片化和无效 delete set 条目。
 */
function compactBinary(binary: Uint8Array, documentId: string): Uint8Array {
  if (binary.byteLength < COMPACTION_THRESHOLD_BYTES) return binary;

  const compactDoc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(compactDoc, binary);
    const compacted = Y.encodeStateAsUpdate(compactDoc);

    const saved = binary.byteLength - compacted.byteLength;
    if (saved > 0) {
      console.log(
        `[Database] Compacted Y.js binary for ${documentId}: ` +
        `${binary.byteLength} → ${compacted.byteLength} bytes (saved ${saved})`,
      );
    }
    return compacted;
  } finally {
    compactDoc.destroy();
  }
}

/**
 * 文档 schema 迁移钩子（预留）。
 * 当文档的 schema_version 低于当前服务端版本时调用。
 * 未来 schema 增减节点/mark/属性时在此添加迁移逻辑。
 */
function migrateDocument(
  _ydoc: Y.Doc,
  _fromVersion: number,
  _toVersion: number,
): void {
  // 预留：暂无需迁移
}

/**
 * 确保 Y.js 二进制中包含当前 schema 版本号。
 *
 * - 版本缺失或低于当前：写入新版本号并返回更新后的二进制
 * - 版本高于当前（客户端更新）：仅 warn，原样返回
 * - 版本匹配：原样返回
 */
export function ensureSchemaVersion(binary: Uint8Array, documentId: string): Uint8Array {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, binary);
    const meta = ydoc.getMap("meta");
    const stored = meta.get("schema_version") as number | undefined;

    if (stored === DOC_SCHEMA_VERSION) return binary;

    if (stored != null && stored > DOC_SCHEMA_VERSION) {
      console.warn(
        `[Database] Document ${documentId} schema_version=${stored} > server=${DOC_SCHEMA_VERSION} — client may be newer`,
      );
      return binary;
    }

    if (stored != null && stored < DOC_SCHEMA_VERSION) {
      console.log(
        `[Database] Document ${documentId} schema_version=${stored} → ${DOC_SCHEMA_VERSION}, running migration`,
      );
      migrateDocument(ydoc, stored, DOC_SCHEMA_VERSION);
    } else {
      console.log(
        `[Database] Document ${documentId} has no schema_version, stamping v${DOC_SCHEMA_VERSION}`,
      );
    }

    meta.set("schema_version", DOC_SCHEMA_VERSION);
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
}

export function buildPmJsonMigrationBinary(
  pmJson: ProseMirrorDocJson,
  documentId: string,
): Uint8Array {
  const scrubPrivateImageSources = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(scrubPrivateImageSources);
    }
    if (!value || typeof value !== "object") {
      return value;
    }

    const node = value as Record<string, unknown>;
    const normalized = Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, scrubPrivateImageSources(child)]),
    );
    if (node.type !== "image" || !node.attrs || typeof node.attrs !== "object") {
      return normalized;
    }

    const attrs = node.attrs as Record<string, unknown>;
    if (typeof attrs.fileId !== "string" || attrs.fileId.trim() === "") {
      return normalized;
    }

    return {
      ...normalized,
      attrs: {
        ...(normalized.attrs as Record<string, unknown>),
        src: "",
      },
    };
  };

  const normalizedPmJson = scrubPrivateImageSources(pmJson) as ProseMirrorDocJson;
  return ensureSchemaVersion(pmJsonToUpdateBinary(normalizedPmJson), documentId);
}

function parseDocumentId(documentName: string): string | null {
  return parseResourceId(documentName, DOCS_PREFIX);
}

/** : concurrent fetches for the same source await one migration promise. */
const pendingMigrations = new Map<string, Promise<Uint8Array>>();
/**
 * Completed read-only migrations keyed by document and source content. Reusing the
 * same binary preserves its Yjs client identity, so repeated reads are idempotent.
 *
 * collab-live is long-lived, so this cache must not retain every document ever
 * opened. The map is maintained as an LRU with a hard entry limit; a document
 * that falls out of the cache is safely rebuilt on its next read.
 */
export const COMPLETED_MIGRATION_CACHE_MAX_ENTRIES = 128;
const completedMigrations = new Map<string, { fingerprint: string; binary: Uint8Array }>();
/** Diagnostic: how many times a document entered the no-binary migration path. */
const migrationAttemptCounts = new Map<string, number>();

function getMigrationFingerprint(
  source: "pm_json" | "markdown",
  pmJson: ProseMirrorDocJson | null,
  markdownContent: string,
): string {
  return `${source}:${pmJson ? JSON.stringify(pmJson) : markdownContent}`;
}

function getCompletedMigration(
  documentId: string,
  fingerprint: string,
): Uint8Array | null {
  const completed = completedMigrations.get(documentId);
  if (!completed || completed.fingerprint !== fingerprint) return null;

  // Refresh recency on a cache hit so frequently opened documents survive eviction.
  completedMigrations.delete(documentId);
  completedMigrations.set(documentId, completed);
  return completed.binary;
}

function setCompletedMigration(
  documentId: string,
  fingerprint: string,
  binary: Uint8Array,
): void {
  completedMigrations.delete(documentId);
  completedMigrations.set(documentId, { fingerprint, binary });
  while (completedMigrations.size > COMPLETED_MIGRATION_CACHE_MAX_ENTRIES) {
    const oldestDocumentId = completedMigrations.keys().next().value;
    if (oldestDocumentId == null) break;
    completedMigrations.delete(oldestDocumentId);
  }
}

/**
 * Generate a transient Yjs binary from PM JSON / markdown for a read.
 *
 * The normal onStore path persists it only after a real edit.
 */
async function buildMissingBinary(params: {
  documentId: string;
  source: "pm_json" | "markdown";
  contentLen: number;
  pmJson: ProseMirrorDocJson | null;
  markdownContent: string;
}): Promise<Uint8Array> {
  const { documentId, source, contentLen, pmJson, markdownContent } = params;
  const fingerprint = getMigrationFingerprint(source, pmJson, markdownContent);
  const migrationKey = `${documentId}:${fingerprint}`;

  const completed = getCompletedMigration(documentId, fingerprint);
  if (completed) return completed;

  const inflight = pendingMigrations.get(migrationKey);
  if (inflight) {
    return inflight;
  }

  const migrationPromise = (async (): Promise<Uint8Array> => {
    const migrated = pmJson
      ? buildPmJsonMigrationBinary(pmJson, documentId)
      : ensureSchemaVersion(
          await markdownToUpdateBinary(markdownContent),
          documentId,
        );
    console.log(
      `[Database] ${source}→binary migration built for ${documentId}: ` +
      `${migrated.byteLength} bytes (content_len=${contentLen})`,
    );

    setCompletedMigration(documentId, fingerprint, migrated);
    return migrated;
  })();

  pendingMigrations.set(migrationKey, migrationPromise);
  try {
    return await migrationPromise;
  } finally {
    pendingMigrations.delete(migrationKey);
  }
}

/**
 * P0-06: TabDoc pending store 注册表。
 * key = documentName, value = 当前 store 链的 settled Promise。
 * 供外部（如 force-close / 版本恢复）等待 in-flight store 完成。
 */
const _tabDocPendingStoreRegistry = new Map<string, Promise<void>>();

export async function waitForTabDocStores(
  documentName: string,
  timeoutMs: number = UNLOAD_TIMEOUT_MS,
): Promise<boolean> {
  const pending = _tabDocPendingStoreRegistry.get(documentName);
  if (!pending) return true;

  let timer: ReturnType<typeof setTimeout>;
  const didTimeout = await Promise.race([
    pending.then(() => false, () => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer!);

  if (didTimeout) {
    console.warn(
      `[Database] waitForTabDocStores timed out after ${timeoutMs}ms for ${documentName}`,
    );
  }
  return !didTimeout;
}

/**
 * 从 Django 获取文档初始 Y.js state
 *
 * DOC-002: 使用 CR-022 安全合并模式——在 fetch 前捕获 ydoc 状态快照，
 * 在临时 mergeDoc 中合并 DB 数据与 fetch 期间的并发编辑，
 * 只返回增量 delta，避免并发编辑丢失。
 */
const fetchDocument = async ({
  documentName,
  document: ydoc,
}: {
  documentName: string;
  document: Y.Doc;
  context: Record<string, unknown>;
}) => {
  const documentId = parseDocumentId(documentName);
  if (!documentId) {
    console.warn(`[Database] Invalid document name: ${documentName}`);
    return null;
  }

  // CR-022: 在 fetch 前捕获 ydoc 状态快照，用于后续安全合并
  const preFetchState = Y.encodeStateAsUpdate(ydoc);
  const preFetchSV = Y.encodeStateVector(ydoc);

  try {
    console.log(`[Database] Fetching document: ${documentId}`);

    const {
      binary_b64,
      has_binary,
      description_markdown,
      description_json,
    } = await withRetry(
      () => fetchDocumentBinary(documentId),
      { label: "TabDoc-Fetch", maxRetries: 2 },
    );

    let fetchedBinary: Uint8Array | null = null;

    if (!has_binary || !binary_b64) {
      // Prefer PM JSON over markdown: import drafts keep marks in description_json,
      // while description_markdown is often already lossy (no color/underline).
      const pmJson = getNonEmptyProseMirrorDocJson(description_json);
      const markdownContent = (description_markdown || "").trim();

      if (pmJson || markdownContent) {
        const source = pmJson ? "pm_json" : "markdown";
        const contentLen = pmJson
          ? pmJson.content.length
          : markdownContent.length;
        const attempt = (migrationAttemptCounts.get(documentId) ?? 0) + 1;
        migrationAttemptCounts.set(documentId, attempt);
        console.log(
          `[Database] No binary for ${documentId}, migrating from ${source} ` +
            `(${contentLen} ${pmJson ? "blocks" : "chars"}; attempt=${attempt})`,
        );
        try {
          fetchedBinary = await buildMissingBinary({
            documentId,
            source,
            contentLen,
            pmJson,
            markdownContent,
          });
        } catch (migrationErr: unknown) {
          console.error(
            `[Database] ${source}→binary migration FAILED for ${documentId} ` +
              `(content_length=${contentLen}):`,
            migrationErr,
          );
          // : abort the load so the client can retry/recover if the transient
          // compatibility binary cannot be built.
          throw migrationErr instanceof Error
            ? migrationErr
            : new Error(String(migrationErr));
        }
      } else {
        console.warn(`[Database] No binary / pm_json / markdown for ${documentId}, starting empty`);
        return null;
      }
    } else {
      const buffer = Buffer.from(binary_b64, "base64");
      fetchedBinary = ensureSchemaVersion(new Uint8Array(buffer), documentId);
    }

    if (!fetchedBinary) return null;

    // CR-022: 在临时 mergeDoc 中安全合并，避免活跃 ydoc 出现中间状态
    const initDoc = new Y.Doc();
    Y.applyUpdate(initDoc, fetchedBinary);

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    const delta = Y.encodeStateAsUpdate(mergeDoc, preFetchSV);

    initDoc.destroy();
    mergeDoc.destroy();

    return delta;
  } catch (error: unknown) {
    metrics.fetchErrors++;
    console.error(`[Database] Error fetching document ${documentId}:`, error);

    throw error;
  }
};

/**
 * P1-07: Store 失败时向所有连接的客户端发送 stateless 消息，
 * 让 UI 提示用户编辑尚未持久化。
 */
function notifyStoreFailure(
  instance: Hocuspocus | null,
  documentName: string,
): void {
  if (!instance) return;
  try {
    const doc = instance.documents.get(documentName);
    if (!doc) return;
    const payload = JSON.stringify({
      type: "store_failed",
      message: "Document save failed. Your edits are preserved locally but not yet saved to server.",
      documentName,
      timestamp: Date.now(),
    });
    for (const connection of doc.getConnections()) {
      try { connection.sendStateless(payload); } catch {}
    }
  } catch (notifyError) {
    console.error("[Database] Failed to notify clients about store failure:", notifyError);
  }
}

/**
 * 将文档当前 Y.js state 存储到 Django
 *
 * 流程：Y.js binary → 转换为所有格式 → 发送到 Django
 */
const storeDocument = async ({
  documentName,
  document: ydoc,
  state,
  context,
  instance,
}: {
  documentName: string;
  document: Y.Doc;
  state: Uint8Array;
  context: Record<string, unknown>;
  instance: Hocuspocus | null;
}) => {
  const documentId = parseDocumentId(documentName);
  if (!documentId) return;

  // DOC-003: 对 state binary 执行 ensureSchemaVersion，而非写入 ydoc。
  // 直接写入 ydoc 产生的 update 不包含在已捕获的 state 中，导致写入无效。
  // schema_version 由 fetchDocument 的 ensureSchemaVersion 在 fetch 阶段写入 ydoc，
  // 此处补漏：确保持久化的 binary 也包含版本号。
  const stateWithSchema = ensureSchemaVersion(state, documentId);

  // CL-006: 对超大 binary 执行 compaction，减缓 CRDT struct 膨胀
  const processedState = compactBinary(stateWithSchema, documentId);

  const startTime = Date.now();

  try {
    const formats = await binaryToAllFormats(processedState);
    const binaryB64 = Buffer.from(processedState).toString("base64");
    const { editorType, editorId, editorName, agentRunId, systemPolicy } =
      extractEditorInfoForStore(context, instance, documentName);

    const opId = `doc_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // P1-14: 受 storeSemaphore 并发控制；冲突重试也在同一 acquire 内完成，避免二次 acquire
    await storeSemaphore.acquire(SEMAPHORE_ACQUIRE_TIMEOUT_MS);
    try {
      let result: unknown = await withRetry(
        () => storeDocumentUpdate(documentId, binaryB64, editorType, editorId, {
          description_html: formats.html,
          description_json: formats.json,
        }, agentRunId || undefined, editorName || undefined, opId, systemPolicy || undefined),
        { label: "TabDoc-Store", maxRetries: 3 },
      );

      // P0-03: 检查 Django 返回的版本冲突标志
      let resultObj = result as Record<string, unknown> | undefined;
      if (resultObj?.conflict) {
        console.warn(
          `[Database] Persist conflict for ${documentId}: ` +
          `current_version=${resultObj.current_revn ?? resultObj.current_version}`,
        );

        // 从当前 Y.Doc 重新获取最新 state（可能包含冲突期间的新编辑）
        const retryState = Y.encodeStateAsUpdate(ydoc);
        const retryStateWithSchema = ensureSchemaVersion(retryState, documentId);
        const retryProcessed = compactBinary(retryStateWithSchema, documentId);
        const retryFormats = await binaryToAllFormats(retryProcessed);
        const retryBinaryB64 = Buffer.from(retryProcessed).toString("base64");
        const retryOpId = `doc_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        result = await withRetry(
          () => storeDocumentUpdate(documentId, retryBinaryB64, editorType, editorId, {
            description_html: retryFormats.html,
            description_json: retryFormats.json,
          }, agentRunId || undefined, editorName || undefined, retryOpId, systemPolicy || undefined),
          { label: "TabDoc-Store-ConflictRetry", maxRetries: 2 },
        );
        resultObj = result as Record<string, unknown> | undefined;
        if (resultObj?.conflict) {
          console.error(`[Database] Persist conflict retry still failed for ${documentId}`);
          metrics.recordStoreLatency(Date.now() - startTime);
          throw new Error(`[Database] Persist conflict not resolved after retry for ${documentId}`);
        }

        const latencyRetry = Date.now() - startTime;
        metrics.recordStoreLatency(latencyRetry);
        await recordCollabStore(
          documentName,
          latencyRetry >= STORE_SLOW_THRESHOLD_MS ? "store_slow" : "store_success",
          { latencyMs: latencyRetry },
        );
        console.log(`[Database] Stored update for ${documentId} after conflict retry (${latencyRetry}ms)`);
        return;
      }

      const latency = Date.now() - startTime;
      metrics.recordStoreLatency(latency);
      await recordCollabStore(
        documentName,
        latency >= STORE_SLOW_THRESHOLD_MS ? "store_slow" : "store_success",
        { latencyMs: latency },
      );

      if (processedState.byteLength > COMPACTION_THRESHOLD_BYTES) {
        console.warn(
          `[Database] Large binary persisted for ${documentId}: ${processedState.byteLength} bytes`,
        );
      }

      console.log(
        `[Database] Stored update for ${documentId} (${latency}ms, ${processedState.byteLength} bytes)`,
      );
    } finally {
      storeSemaphore.release();
    }
  } catch (error: unknown) {
    await recordCollabStore(documentName, "store_failed", { error });
    // P1-07: Store 失败时通知所有连接的客户端
    notifyStoreFailure(instance, documentName);
    await handleStoreError({
      error,
      resourceId: documentId,
      documentName,
      instance,
      moduleLabel: "Database",
      startTime,
    });
  }
};

export class Database extends HocuspocusDatabase {
  private readonly _storeQueues = new Map<string, Promise<void>>();

  constructor() {
    const self = { serializedStore: null as any };
    super({
      fetch: fetchDocument,
      store: (params: any) => self.serializedStore(params),
    });
    self.serializedStore = this._serializedStore.bind(this);
  }

  private _serializedStore(params: {
    documentName: string;
    document: Y.Doc;
    state: Uint8Array;
    context: Record<string, unknown>;
    instance: Hocuspocus | null;
  }): Promise<void> {
    const { documentName } = params;
    const prev = this._storeQueues.get(documentName) ?? Promise.resolve();
    const next = prev.then(
      () => storeDocument(params),
      () => storeDocument(params),
    );
    this._storeQueues.set(documentName, next);

    // P0-06: 注册到全局 pending store 表，供 force-close / 版本恢复等待
    _tabDocPendingStoreRegistry.set(documentName, next.then(() => {}, () => {}));

    const cleanup = () => {
      if (this._storeQueues.get(documentName) === next) {
        this._storeQueues.set(documentName, Promise.resolve());
        _tabDocPendingStoreRegistry.delete(documentName);
      }
    };
    next.then(cleanup, cleanup);

    return next;
  }

  /**
   * : TabDoc 版本还原服务端重同步。
   *
   * 拉取还原后的权威 Y.js binary，用克隆式 xml.fragment.replace 覆盖在线 default
   * fragment——Hocuspocus 经既有协作链路广播给所有在线客户端，无需 force-close 断线
   * 重连。: 不用 computeResyncDelta，因 VH binary 与在线文档同源（因果子集），
   * 该算法会退化为纯删除 delta 导致空白。
   *
   * 文档不在本节点内存时返回 loaded=false，调用方回退 force-close。
   */
  async resyncLoadedDocument(
    instance: Hocuspocus,
    documentName: string,
  ): Promise<ResyncResult> {
    const documentId = parseDocumentId(documentName);
    if (!documentId) return { loaded: false };
    const hocusDoc = instance.documents.get(documentName);
    if (!hocusDoc) return { loaded: false };

    // : 等待 in-flight store 完成，避免 pending persist 覆盖还原后的 DB binary。
    await waitForTabDocStores(documentName);

    const { binary_b64, has_binary, description_markdown, description_json } = await withRetry(
      () => fetchDocumentBinary(documentId),
      { label: "TabDoc-Resync", maxRetries: 2 },
    );

    let targetBinary: Uint8Array | null = null;
    if (has_binary && binary_b64) {
      targetBinary = ensureSchemaVersion(
        new Uint8Array(Buffer.from(binary_b64, "base64")),
        documentId,
      );
    } else {
      const pmJson = getNonEmptyProseMirrorDocJson(description_json);
      if (pmJson) {
        targetBinary = ensureSchemaVersion(pmJsonToUpdateBinary(pmJson), documentId);
      } else {
        const markdownContent = (description_markdown || "").trim();
        if (markdownContent) {
          targetBinary = ensureSchemaVersion(
            await markdownToUpdateBinary(markdownContent),
            documentId,
          );
        }
      }
    }

    if (!targetBinary) {
      // 还原目标为空文档：无内容可灌入，交由 force-close 回退处理更稳妥
      return { loaded: false };
    }

    const targetB64 = Buffer.from(targetBinary).toString("base64");
    hocusDoc.transact(() => {
      replaceXmlFragment(hocusDoc, "default", targetB64);
    }, RESYNC_ORIGIN);
    console.log(`[Database] Resynced ${documentId} via fragment replace (no force-close)`);
    return { loaded: true };
  }

  async afterUnloadDocument({ documentName }: { documentName: string }): Promise<void> {
    const pending = this._storeQueues.get(documentName);
    if (pending) {
      // P1-10: 超时保护，防止 store HTTP 挂起时永久阻塞卸载
      let timer: ReturnType<typeof setTimeout>;
      const didTimeout = await Promise.race([
        pending.then(() => false, () => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), UNLOAD_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer!);
      if (didTimeout) {
        console.warn(
          `[Database] afterUnloadDocument timed out after ${UNLOAD_TIMEOUT_MS}ms ` +
          `for ${documentName}. In-flight store may still be running.`,
        );
      }
    }
    this._storeQueues.delete(documentName);
    _tabDocPendingStoreRegistry.delete(documentName);
    console.log(`[Database] Cleaned up store queue for ${documentName}`);
  }
}
