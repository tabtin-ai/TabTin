/**
 * Admin + Stateless Broadcast 端点
 *
 * - POST /admin/force-close
 * - POST /admin/invalidate-version
 * - GET  /admin/documents
 * - POST /internal/stateless-broadcast
 */

import { getErrorMessage } from "../lib/error-utils.js";
import { forceCloseDocument, ForceCloseReason, CloseCode, invalidateDocumentVersion, type ForceCloseResult } from "../extensions/force-close.js";
import { getPrimaryRedis, AdminCommand } from "../extensions/index.js";
import type { StatelessBroadcastCommandData } from "../extensions/redis.js";
import { updateTableMetaFields } from "../extensions/table-database.js";
import { findResyncExtension, findCollabFirstRestoreExtension } from "../lib/resync.js";
import { env } from "../env.js";
import type { RouteContext } from "./types.js";

const FULL_SCHEMA_FIELDS_SCOPE = "full";

export function shouldApplyTableSchemaFieldsSnapshot(payload: unknown): payload is { fields: unknown[] } {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as { fields?: unknown; fields_scope?: unknown; metadata?: { fields_scope?: unknown } };
  const fieldsScope = body.fields_scope ?? body.metadata?.fields_scope;
  return fieldsScope === FULL_SCHEMA_FIELDS_SCOPE && Array.isArray(body.fields) && body.fields.length > 0;
}

export function setupAdminRoutes(ctx: RouteContext): void {
  const { app, requireLiveSecret } = ctx;

  app.post("/admin/force-close", requireLiveSecret, async (req, res) => {
    try {
      const { document_id, reason } = req.body;

      if (!document_id) {
        res.status(400).json({ status: "error", message: "缺少 document_id" });
        return;
      }

      const { instance, documentName } = ctx.resolveHocuspocusInstance(document_id);

      // 根据 reason 选择合适的 CloseCode
      let closeCode = CloseCode.DOCUMENT_NOT_FOUND;
      const resolvedReason = (reason as ForceCloseReason) || ForceCloseReason.ADMIN_ACTION;
      if (resolvedReason === ForceCloseReason.PERMISSION_CHANGED) {
        closeCode = CloseCode.PERMISSION_CHANGED;
      } else if (resolvedReason === ForceCloseReason.DOCUMENT_RESTORED) {
        closeCode = CloseCode.DOCUMENT_RESTORED;
      } else if (resolvedReason === ForceCloseReason.AUTH_FAILED) {
        closeCode = CloseCode.AUTH_FAILED;
      } else if (resolvedReason === ForceCloseReason.DOCUMENT_ARCHIVED) {
        closeCode = CloseCode.DOCUMENT_ARCHIVED;
      } else if (resolvedReason === ForceCloseReason.DOCUMENT_TOO_LARGE) {
        closeCode = CloseCode.DOCUMENT_TOO_LARGE;
      }

      const result: ForceCloseResult = await forceCloseDocument(
        instance,
        documentName,
        resolvedReason,
        closeCode
      );

      res.json({
        status: "ok",
        data: {
          document_id,
          reason,
          loaded: result.loaded,
          connections_closed: result.connections_closed,
        },
      });
    } catch (error: unknown) {
      console.error("[Admin] force-close error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  /**
   * E2E-022: DB-first Agent 写入后通知 collab-live 更新 Y.Doc version，
   * 防止后续 onStore debounce 触发时因 base_version 过期产生 conflict 覆盖 Agent 写入。
   *
   * 实现「缓存失效 Write-Through」模式：DB 是权威源，Y.Doc 是内存缓存。
   * 权威源更新后通知缓存层更新 version 字段，下次 onStore 时 base_version 与 DB 一致，
   * 不触发 conflict，用户编辑不被中断。
   *
   * 请求体: { documentName: string, newVersion: number }
   * - documentName: 完整文档名（含前缀，如 "canvas:uuid"、"video:uuid"、"docs:uuid"）
   * - newVersion: DB 写入后的最新版本号
   *
   * 所有模块统一使用 "version" 字段。
   */
  app.post("/admin/invalidate-version", requireLiveSecret, async (req, res) => {
    try {
      const { documentName, newVersion } = req.body as {
        documentName?: string;
        newVersion?: number;
      };

      if (!documentName) {
        res.status(400).json({ status: "error", message: "缺少 documentName" });
        return;
      }
      if (typeof newVersion !== "number" || !Number.isFinite(newVersion)) {
        res.status(400).json({ status: "error", message: "newVersion 必须为有效数字" });
        return;
      }

      // CL-004 + CL-005: 委托给 invalidateDocumentVersion，
      // 确保无论文档在哪个节点都通过 Redis 广播，且使用 getVersionFieldName 统一字段映射
      const { instance } = ctx.resolveHocuspocusInstance(documentName);
      const result = await invalidateDocumentVersion(instance, documentName, newVersion);

      res.json({
        status: "ok",
        data: { documentName, newVersion, updated: result.updated },
      });
    } catch (error: unknown) {
      console.error("[Admin] invalidate-version error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  /**
   * : 版本还原服务端重同步端点。
   *
   * Django 完成 DB 权威还原后调用本端点。若文档在本节点内存中已加载，则用还原后的
   * 快照算出 CRDT delta 广播给所有在线客户端（无需 force-close 断线重连），返回
   * resynced=true。若文档未在本节点加载（跨节点 / 无在线客户端），返回 resynced=false，
   * 由 Django 回退到 force-close。
   *
   * 单节点部署（本地 / 单实例）该端点始终命中本节点内存；多节点跨节点场景由 Django
   * 回退 force-close 兜底（已知限制，见 PR）。
   *
   * 请求体: { document_id: string }（完整文档名，含前缀，如 "table:uuid"、"docs:uuid"）
   */
  app.post("/admin/resync-document", requireLiveSecret, async (req, res) => {
    try {
      const { document_id } = req.body as { document_id?: string };
      if (!document_id) {
        res.status(400).json({ status: "error", message: "缺少 document_id" });
        return;
      }

      const { instance, documentName } = ctx.resolveHocuspocusInstance(document_id);
      const ext = findResyncExtension(instance);
      if (!ext) {
        res.json({ status: "ok", data: { document_id, resynced: false, reason: "no_resync_extension" } });
        return;
      }

      const result = await ext.resyncLoadedDocument(instance, documentName);
      res.json({ status: "ok", data: { document_id, resynced: result.loaded } });
    } catch (error: unknown) {
      console.error("[Admin] resync-document error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  /**
   * : 表格 collab-first 版本还原。
   *
   * Django 在 DB 落盘前调用：用 VH 快照直接更新本节点内存 Y.Doc。
   * PostgreSQL 由 Django restore_from_snapshot 写入；文档未加载时返回 loaded=false。
   *
   * 请求体: {
   *   document_id: string,
   *   snapshot: object,
   *   editor_type?, editor_id?, editor_name?
   * }
   */
  app.post("/admin/collab-first-restore", requireLiveSecret, async (req, res) => {
    try {
      const {
        document_id,
        snapshot,
        editor_type,
        editor_id,
        editor_name,
      } = req.body as {
        document_id?: string;
        snapshot?: Record<string, unknown>;
        editor_type?: string;
        editor_id?: string;
        editor_name?: string;
      };

      if (!document_id || !snapshot || typeof snapshot !== "object") {
        res.status(400).json({ status: "error", message: "缺少 document_id 或 snapshot" });
        return;
      }

      const { instance, documentName } = ctx.resolveHocuspocusInstance(document_id);
      const ext = findCollabFirstRestoreExtension(instance);
      if (!ext) {
        res.json({
          status: "ok",
          data: { document_id, loaded: false, reason: "no_collab_first_restore_extension" },
        });
        return;
      }

      const result = await ext.collabFirstRestoreLoadedDocument(
        instance,
        documentName,
        snapshot,
        { editor_type, editor_id, editor_name },
      );
      res.json({
        status: "ok",
        data: {
          document_id,
          loaded: result.loaded,
        },
      });
    } catch (error: unknown) {
      console.error("[Admin] collab-first-restore error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });

  app.get("/admin/documents", requireLiveSecret, (_req, res) => {
    const documents: Array<{ id: string; connections: number; module: string }> = [];

    for (const { instance, module } of ctx.allInstances()) {
      instance.documents.forEach((doc, id) => {
        documents.push({
          id,
          connections: doc.getConnectionsCount(),
          module,
        });
      });
    }

    res.json({ status: "ok", data: { documents, count: documents.length } });
  });

  app.post("/internal/stateless-broadcast", requireLiveSecret, async (req, res) => {
    try {
      const { document_name, event, source, op_id, ts, payload } = req.body;

      if (!document_name || !event) {
        res.status(400).json({ status: "error", message: "缺少 document_name 或 event" });
        return;
      }

      const message = JSON.stringify({
        type: event,
        payload: payload || {},
        source: source || "django",
        op_id: op_id || "",
        ts: ts || new Date().toISOString(),
      });

      let broadcasted = false;

      for (const { instance } of ctx.allInstances()) {
        const doc = instance.documents.get(document_name);
        if (doc) {
          if (event === "table.schema.changed" && shouldApplyTableSchemaFieldsSnapshot(payload)) {
            try {
              updateTableMetaFields(doc, payload.fields);
              console.log(
                `[StatelessBroadcast] Updated Y.Doc meta.fields for ${document_name} (${payload.fields.length} fields)`
              );
            } catch (err: unknown) {
              console.error(
                `[StatelessBroadcast] Failed to update meta.fields for ${document_name}:`,
                getErrorMessage(err),
              );
            }
          }

          doc.broadcastStateless(message);
          broadcasted = true;
          console.log(
            `[StatelessBroadcast] Local broadcast ${event} to ${document_name} (${doc.getConnectionsCount()} connections)`
          );
        }
      }

      const redis = getPrimaryRedis();
      if (redis) {
        try {
          await redis.publishAdminCommand({
            command: AdminCommand.STATELESS_BROADCAST,
            docId: document_name,
            originServer: env.SERVER_NAME,
            timestamp: ts || new Date().toISOString(),
            message,
          } satisfies StatelessBroadcastCommandData);
        } catch (err: unknown) {
          console.error("[StatelessBroadcast] Redis publish failed:", getErrorMessage(err));
        }
      }

      res.json({
        status: "ok",
        data: { document_name, event, broadcasted },
      });
    } catch (error: unknown) {
      console.error("[StatelessBroadcast] Error:", error);
      res.status(500).json({ status: "error", message: getErrorMessage(error) });
    }
  });
}
