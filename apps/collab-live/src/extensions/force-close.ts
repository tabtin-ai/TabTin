/**
 * Force-Close Extension — 异常断连治理
 *
 * 参照 Plane apps/live/src/extensions/force-close-handler.ts
 *
 * 支持的关闭原因（4000-4005 错误码）：
 * - 4000: 文档不存在
 * - 4001: 认证失败
 * - 4002: 文档已归档/删除
 * - 4003: 文档过大
 * - 4004: 权限变更
 * - 4005: 文档已恢复（版本回滚），客户端需丢弃本地 Y.Doc 并重新拉取
 */

import type { Extension, onConfigurePayload } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { RedisExtension, AdminCommand } from "./redis.js";
import type { ForceCloseCommandData, InvalidateVersionCommandData } from "./redis.js";
import { waitForDocumentStores } from "./base-collab-database.js";
import { env } from "../env.js";

/** WebSocket 关闭码 */
export enum CloseCode {
  DOCUMENT_NOT_FOUND = 4000,
  AUTH_FAILED = 4001,
  DOCUMENT_ARCHIVED = 4002,
  DOCUMENT_TOO_LARGE = 4003,
  PERMISSION_CHANGED = 4004,
  /** CLB-001: 文档已恢复到指定版本，客户端需丢弃本地 Y.Doc 并重新拉取（不进入永久终态） */
  DOCUMENT_RESTORED = 4005,
}

/** 关闭原因 */
export enum ForceCloseReason {
  DOCUMENT_NOT_FOUND = "document_not_found",
  AUTH_FAILED = "auth_failed",
  DOCUMENT_ARCHIVED = "document_archived",
  DOCUMENT_TOO_LARGE = "document_too_large",
  PERMISSION_CHANGED = "permission_changed",
  ADMIN_ACTION = "admin_action",
  /** 文档版本被恢复，客户端需丢弃本地 Y.Doc 并重新拉取 */
  DOCUMENT_RESTORED = "document_restored",
}

/** 发给客户端的 stateless 消息 */
interface ClientForceCloseMessage {
  type: "force_close";
  reason: ForceCloseReason;
  code: CloseCode;
  message: string;
  timestamp: string;
  /**
   * CLB-009: 客户端应延迟多少毫秒后再重连。
   * document_restored 场景：服务端发完 stateless 后还需约 600ms 完成
   * 关闭连接 + Redis 广播 + unloadDocument，客户端提前重连会拿到旧 Y.Doc。
   */
  reconnect_delay_ms?: number;
}

function getForceCloseMessage(reason: ForceCloseReason): string {
  switch (reason) {
    case ForceCloseReason.DOCUMENT_NOT_FOUND:
      return "文档不存在或已被删除";
    case ForceCloseReason.AUTH_FAILED:
      return "认证失败，请重新登录";
    case ForceCloseReason.DOCUMENT_ARCHIVED:
      return "文档已归档，进入只读模式";
    case ForceCloseReason.DOCUMENT_TOO_LARGE:
      return "文档内容过大，已超过协作限制";
    case ForceCloseReason.PERMISSION_CHANGED:
      return "文档权限已变更，请刷新页面";
    case ForceCloseReason.ADMIN_ACTION:
      return "管理员操作，连接已断开";
    case ForceCloseReason.DOCUMENT_RESTORED:
      return "文档已恢复到指定版本，请等待重新同步";
    default:
      return "连接已断开";
  }
}

/**
 * CL-005: 返回版本字段名。
 * 所有模块（table/slide/video/canvas/doc）统一使用 "version"。
 */
export function getVersionFieldName(_docId: string): "version" {
  return "version";
}

/**
 * VS-004: force-close 后客户端重连延迟（ms），可通过环境变量配置。
 * 默认 650ms = 关闭连接(50ms) + Redis 广播(500ms) + 余量(100ms)。
 * Redis 高负载或跨区域部署时可适当增大。
 */
const FORCE_CLOSE_RECONNECT_DELAY_MS = parseInt(
  process.env.COLLAB_FORCE_CLOSE_RECONNECT_DELAY_MS || "650",
  10,
);

export interface ForceCloseResult {
  /** 文档是否在本节点 Hocuspocus 内存中 */
  loaded: boolean;
  /** 本节点关闭的 WebSocket 连接数 */
  connections_closed: number;
}

export interface InvalidateVersionResult {
  /** 文档是否在本节点 Hocuspocus 内存中被更新 */
  updated: boolean;
}

/**
 * 强制关闭文档的所有连接（跨服务器）
 *
 * CL-009 fix: 文档不在本节点内存时，仍通过 Redis 广播到其他节点，
 * 并返回 `{ loaded: false }` 让调用方（Django）区分两种情况。
 */
export async function forceCloseDocument(
  instance: Hocuspocus,
  docId: string,
  reason: ForceCloseReason,
  code: CloseCode = CloseCode.DOCUMENT_NOT_FOUND
): Promise<ForceCloseResult> {
  const document = instance.documents.get(docId);

  if (!document) {
    console.log(`[ForceClose] Doc ${docId} not in local memory, broadcasting via Redis only`);

    const redisExt = instance.configuration.extensions.find(
      (ext) => ext instanceof RedisExtension
    ) as RedisExtension | undefined;

    if (redisExt) {
      // VS-003: 透传 reconnect_delay_ms 到跨节点客户端
      const reconnectDelayMs = reason === ForceCloseReason.DOCUMENT_RESTORED
        ? FORCE_CLOSE_RECONNECT_DELAY_MS : undefined;
      const commandData: ForceCloseCommandData = {
        command: AdminCommand.FORCE_CLOSE,
        docId,
        reason,
        code,
        originServer: env.SERVER_NAME,
        timestamp: new Date().toISOString(),
        ...(reconnectDelayMs !== undefined ? { reconnect_delay_ms: reconnectDelayMs } : {}),
      };
      await redisExt.publishAdminCommand(commandData);
    }

    return { loaded: false, connections_closed: 0 };
  }

  const connectionsCount = document.getConnectionsCount();
  console.log(`[ForceClose] Closing doc=${docId}, reason=${reason}, code=${code}, connections=${connectionsCount}`);

  // 1. 发送 force_close stateless 消息给所有客户端
  // VS-004: document_restored 场景需告知客户端延迟重连，延迟值可通过环境变量配置
  const reconnectDelayMs = reason === ForceCloseReason.DOCUMENT_RESTORED
    ? FORCE_CLOSE_RECONNECT_DELAY_MS : undefined;
  const forceCloseMessage: ClientForceCloseMessage = {
    type: "force_close",
    reason,
    code,
    message: getForceCloseMessage(reason),
    timestamp: new Date().toISOString(),
    ...(reconnectDelayMs !== undefined ? { reconnect_delay_ms: reconnectDelayMs } : {}),
  };

  document.connections.forEach(({ connection }) => {
    try {
      connection.sendStateless(JSON.stringify(forceCloseMessage));
    } catch {
      // 连接可能已断开
    }
  });

  // 等待消息发送
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 2. 关闭所有本地连接
  document.connections.forEach(({ connection }) => {
    try {
      connection.close({ code, reason });
    } catch {
      // 忽略已关闭的连接
    }
  });

  // 3. 广播到其他服务器（如果 Redis 可用）
  const redisExt = instance.configuration.extensions.find(
    (ext) => ext instanceof RedisExtension
  ) as RedisExtension | undefined;

  if (redisExt) {
    // VS-003: 透传 reconnect_delay_ms 到跨节点客户端
    const commandData: ForceCloseCommandData = {
      command: AdminCommand.FORCE_CLOSE,
      docId,
      reason,
      code,
      originServer: env.SERVER_NAME,
      timestamp: new Date().toISOString(),
      ...(reconnectDelayMs !== undefined ? { reconnect_delay_ms: reconnectDelayMs } : {}),
    };
    await redisExt.publishAdminCommand(commandData);
    // 等待其他服务器处理
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // VS-005: 等待 in-flight store 完成后再 unload，防止 onStoreSuccess 操作已卸载的 Y.Doc
  await waitForDocumentStores(docId);

  // 4. 卸载文档
  try {
    await instance.unloadDocument(document);
  } catch {
    // 文档可能已卸载
  }

  return { loaded: true, connections_closed: connectionsCount };
}

/**
 * Force-Close Handler Extension
 *
 * 监听 Redis admin channel 的 force_close 命令，
 * 在本地关闭对应文档的所有连接。
 */
export class ForceCloseHandler implements Extension {
  async onConfigure({ instance }: onConfigurePayload): Promise<void> {
    const redisExt = instance.configuration.extensions.find(
      (ext) => ext instanceof RedisExtension
    ) as RedisExtension | undefined;

    if (!redisExt) {
      console.log("[ForceClose] Redis not available, skip cross-server handler registration");
      return;
    }

    // 注册 force_close 命令处理器
    redisExt.onAdminCommand<ForceCloseCommandData>(
      AdminCommand.FORCE_CLOSE,
      async (data) => {
        // VS-003: 从广播数据中提取 reconnect_delay_ms
        const { docId, reason, code, reconnect_delay_ms } = data;
        const document = instance.documents.get(docId);
        if (!document) return;

        console.log(`[ForceClose] Received remote force_close for doc=${docId}, reason=${reason}`);

        // VS-003: 透传 reconnect_delay_ms 到本地客户端
        const message: ClientForceCloseMessage = {
          type: "force_close",
          reason: reason as ForceCloseReason,
          code,
          message: getForceCloseMessage(reason as ForceCloseReason),
          timestamp: new Date().toISOString(),
          ...(reconnect_delay_ms != null ? { reconnect_delay_ms } : {}),
        };

        document.connections.forEach(({ connection }) => {
          try {
            connection.sendStateless(JSON.stringify(message));
          } catch {
            // 忽略
          }
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        document.connections.forEach(({ connection }) => {
          try {
            connection.close({ code, reason });
          } catch {
            // 忽略
          }
        });

        // VS-005: 等待 in-flight store 完成后再 unload
        await waitForDocumentStores(docId);

        // CLB-003: 卸载文档，防止旧 Y.Doc 被下次连接复用，跳过 onFetch
        try {
          await instance.unloadDocument(document);
        } catch {
          // 文档可能已卸载
        }
      }
    );

    // E2E-022: 注册 invalidate_version 命令处理器（跨节点缓存失效）
    redisExt.onAdminCommand<InvalidateVersionCommandData>(
      AdminCommand.INVALIDATE_VERSION,
      (data) => {
        const { docId, newVersion } = data;
        if (!docId || typeof newVersion !== "number") return;

        const document = instance.documents.get(docId);
        if (!document) return;

        // CL-005: 使用 getVersionFieldName 替代硬编码前缀判断
        const fieldName = getVersionFieldName(docId);
        document.transact(() => {
          const meta = document.getMap("meta");
          meta.set(fieldName, newVersion);
        });
        console.log(
          `[ForceClose] invalidate-version (Redis): updated ${docId} ${fieldName}=${newVersion}`,
        );
      },
    );

    console.log("[ForceClose] Cross-server handler registered");
  }
}

/**
 * CL-004: 更新文档的 Y.Doc meta version 并通过 Redis 广播到所有节点。
 *
 * 与旧的 admin.ts 内联逻辑不同，此函数无论文档是否在本节点内存中
 * 都会通过 Redis 广播，确保多节点部署时所有持有该文档的节点都能更新。
 * 参照 forceCloseDocument 的广播模式（总是广播）。
 */
export async function invalidateDocumentVersion(
  instance: Hocuspocus,
  docId: string,
  newVersion: number,
): Promise<InvalidateVersionResult> {
  const document = instance.documents.get(docId);
  let updated = false;

  if (document) {
    const fieldName = getVersionFieldName(docId);
    document.transact(() => {
      const meta = document.getMap("meta");
      meta.set(fieldName, newVersion);
    });
    updated = true;
    console.log(
      `[ForceClose] invalidate-version (local): updated ${docId} ${fieldName}=${newVersion}`,
    );
  }

  // CL-004: 无论本地是否找到文档，都通过 Redis 广播到其他节点
  const redisExt = instance.configuration.extensions.find(
    (ext) => ext instanceof RedisExtension
  ) as RedisExtension | undefined;

  if (redisExt) {
    const commandData: InvalidateVersionCommandData = {
      command: AdminCommand.INVALIDATE_VERSION,
      docId,
      newVersion,
      originServer: env.SERVER_NAME,
      timestamp: new Date().toISOString(),
    };
    await redisExt.publishAdminCommand(commandData);
    if (!updated) {
      console.log(
        `[ForceClose] invalidate-version: doc ${docId} not local, broadcast via Redis`,
      );
    }
  }

  return { updated };
}
