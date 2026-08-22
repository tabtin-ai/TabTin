/**
 * PermissionGuard — 连接生命周期内的权限持续验证
 *
 * 解决 RT-02：Hocuspocus onAuthenticate 仅在握手时调用一次，
 * 权限撤销后 Y.js update 仍广播。
 *
 * 三层防御：
 * 1. 定时器（REVALIDATION_INTERVAL_MS）定期对所有活跃连接重新
 *    调用 Django verifyCollabAccess，检测权限撤销和 JWT 过期。
 * 2. beforeHandleMessage hook 在消息处理前检查 permissionRevoked
 *    标志，防止已标记撤销但 WS 尚未关闭窗口期内的消息被广播。
 * 3. /internal/revoke-access 端点（见 server.ts）允许 Django 在
 *    权限变更时主动推送撤销，零延迟断连。
 */

import type {
  Extension,
  onConfigurePayload,
  beforeHandleMessagePayload,
  onStatelessPayload,
} from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import type { Connection } from "@hocuspocus/server";
import { verifyCollabAccess } from "../services/django-api.js";
import { CloseCode, ForceCloseReason } from "./force-close.js";
import { RedisExtension, AdminCommand } from "./redis.js";
import type { RevokeAccessCommandData, RevokeUserAccessCommandData } from "./redis.js";

const MIN_REVALIDATION_INTERVAL_MS = 10_000;   // 10s
const MAX_REVALIDATION_INTERVAL_MS = 300_000;  // 5min

const REVALIDATION_INTERVAL_MS = Math.min(
  Math.max(
    parseInt(process.env.PERMISSION_REVALIDATION_INTERVAL_MS || "60000", 10) || 60_000,
    MIN_REVALIDATION_INTERVAL_MS,
  ),
  MAX_REVALIDATION_INTERVAL_MS,
);

/**
 * DS-024 fix: 消息级短 TTL 重验间隔。
 * 在 beforeHandleMessage 中，若距上次重验超过此时间，
 * 则对 Django 发起实时权限检查，将 Y.Doc 污染窗口从 60s 缩短至此值。
 */
const MIN_MESSAGE_REVALIDATION_TTL_MS = 2_000;    // 2s
const MAX_MESSAGE_REVALIDATION_TTL_MS = 30_000;   // 30s

const MESSAGE_REVALIDATION_TTL_MS = Math.min(
  Math.max(
    parseInt(process.env.COLLAB_MESSAGE_REVALIDATION_TTL_MS || "5000", 10) || 5_000,
    MIN_MESSAGE_REVALIDATION_TTL_MS,
  ),
  MAX_MESSAGE_REVALIDATION_TTL_MS,
);

const MAX_TOKEN_AGE_MS = Math.min(
  Math.max(
    parseInt(process.env.COLLAB_MAX_TOKEN_AGE_MS || "1800000", 10) || 1_800_000,
    60_000,        // at least 1min
  ),
  3_600_000,       // at most 60min
);

/**
 * COL-023: Token 刷新机制
 *
 * ADVANCE — 在 MAX_TOKEN_AGE_MS 到期前多久开始通知客户端刷新
 * GRACE  — MAX_TOKEN_AGE_MS 到期后额外宽限，等待客户端发回新 token
 */
const TOKEN_REFRESH_ADVANCE_MS = Math.min(
  Math.max(
    parseInt(process.env.COLLAB_TOKEN_REFRESH_ADVANCE_MS || "120000", 10) || 120_000,
    30_000,
  ),
  MAX_TOKEN_AGE_MS / 2,
);

const TOKEN_REFRESH_GRACE_MS = Math.min(
  Math.max(
    parseInt(process.env.COLLAB_TOKEN_REFRESH_GRACE_MS || "30000", 10) || 30_000,
    10_000,
  ),
  120_000,
);

const REVALIDATION_BATCH_DELAY_MS = 50;

const MAX_CONSECUTIVE_FAILURES = Math.max(
  parseInt(process.env.PERMISSION_GUARD_MAX_CONSECUTIVE_FAILURES || "3", 10) || 3,
  1,
);

interface PermissionGuardContext {
  authToken?: string;
  resourceType?: string;
  resourceId?: string;
  parentDocumentId?: string;
  userId?: string;
  lastRevalidation?: number;
  permissionRevoked?: boolean;
  readOnly?: boolean;
  connectionEstablishedAt?: number;
  consecutiveFailures?: number;
  /** DS-024: prevents thundering herd when multiple messages arrive past the short TTL */
  _msgRevalidationInProgress?: boolean;
  /** COL-023: timestamp when token_refresh_required was sent (send only once) */
  tokenRefreshSentAt?: number;
}

/**
 * DS-024: 判断 verifyCollabAccess 返回的 reason 是否为瞬态故障（网络/超时/服务端错误），
 * 用于区分需要立即撤销的权限拒绝和可重试的瞬态错误。
 * 未知 reason 默认为永久拒绝（fail-closed）。
 */
function isTransientAuthFailure(reason?: string): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes("timeout")
    || r.includes("network error")
    || r.includes("access_verification_unavailable")
    || r.includes("non-json")
    || r.includes("endpoint not found")
    || r.includes("missing user_id")
    || /^http 5\d\d/.test(r);
}

function sendPermissionRevokedMessage(connection: Connection): void {
  try {
    connection.sendStateless(JSON.stringify({
      type: "force_close",
      reason: ForceCloseReason.PERMISSION_CHANGED,
      code: CloseCode.PERMISSION_CHANGED,
      message: "文档权限已变更，连接即将关闭",
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // connection may already be closed
  }
}

/**
 * COL-023: Notify client that its token is nearing expiry.
 * Client should refresh its JWT and send back a `token_refresh` stateless message.
 */
function sendTokenRefreshRequired(connection: Connection): void {
  try {
    connection.sendStateless(JSON.stringify({
      type: "token_refresh_required",
      message: "认证令牌即将过期，请刷新",
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // connection may already be closed
  }
}

function sendReadOnlyDowngradeMessage(connection: Connection): void {
  try {
    connection.sendStateless(JSON.stringify({
      type: "permission_downgrade",
      readOnly: true,
      code: CloseCode.PERMISSION_CHANGED,
      message: "权限已变更为只读模式",
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // connection may already be closed
  }
}

function setConnectionReadOnly(connection: Connection | undefined, readOnly: boolean, context?: PermissionGuardContext): void {
  if (connection) connection.readOnly = readOnly;
  const ctx = context ?? (connection?.context as PermissionGuardContext | undefined);
  if (ctx) ctx.readOnly = readOnly;
}

function closeConnection(connection: Connection): void {
  try {
    connection.close({
      code: CloseCode.PERMISSION_CHANGED,
      reason: ForceCloseReason.PERMISSION_CHANGED,
    });
  } catch {
    // connection may already be closed
  }
}

/**
 * 按 userId + documentName 撤销指定连接。
 * 返回被关闭的连接数。
 */
export function revokeUserConnections(
  instance: Hocuspocus,
  documentName: string,
  userId: string,
): number {
  const doc = instance.documents.get(documentName);
  if (!doc) return 0;

  let closed = 0;
  for (const connection of doc.getConnections()) {
    const ctx = connection.context as PermissionGuardContext | undefined;
    if (ctx?.userId === userId) {
      ctx.permissionRevoked = true;
      sendPermissionRevokedMessage(connection);
      setTimeout(() => closeConnection(connection), 100);
      closed++;
    }
  }

  if (closed > 0) {
    console.log(
      `[PermissionGuard] Revoked ${closed} connection(s) for user=${userId} doc=${documentName}`,
    );
  }
  return closed;
}

/**
 * 按 userId + documentName 将指定连接降级为只读模式（RV-013）。
 * 不关闭连接，而是设置 readOnly 标志并发送通知。
 * 返回被降级的连接数。
 */
export function downgradeUserConnectionsToReadOnly(
  instance: Hocuspocus,
  documentName: string,
  userId: string,
): number {
  const doc = instance.documents.get(documentName);
  if (!doc) return 0;

  let downgraded = 0;
  for (const connection of doc.getConnections()) {
    const ctx = connection.context as PermissionGuardContext | undefined;
    if (ctx?.userId === userId && !ctx?.permissionRevoked && !connection.readOnly && !ctx?.readOnly) {
      setConnectionReadOnly(connection, true);
      sendReadOnlyDowngradeMessage(connection);
      downgraded++;
    }
  }

  if (downgraded > 0) {
    console.log(
      `[PermissionGuard] Downgraded ${downgraded} connection(s) to readOnly for user=${userId} doc=${documentName}`,
    );
  }
  return downgraded;
}

/**
 * 按 userId 批量将该用户在所有文档上的连接降级为只读模式（RV-013）。
 * 返回被降级的连接总数。
 */
export function downgradeAllUserConnectionsToReadOnly(
  instance: Hocuspocus,
  userId: string,
): number {
  let downgraded = 0;
  for (const [, doc] of instance.documents) {
    for (const connection of doc.getConnections()) {
      const ctx = connection.context as PermissionGuardContext | undefined;
      if (ctx?.userId === userId && !ctx?.permissionRevoked && !connection.readOnly && !ctx?.readOnly) {
        setConnectionReadOnly(connection, true);
        sendReadOnlyDowngradeMessage(connection);
        downgraded++;
      }
    }
  }

  if (downgraded > 0) {
    console.log(
      `[PermissionGuard] Bulk-downgraded ${downgraded} connection(s) to readOnly for user=${userId} across all documents`,
    );
  }
  return downgraded;
}

/**
 * 按 userId 批量撤销该用户在所有文档上的连接。
 * 遍历 Hocuspocus 实例内所有已加载文档，关闭属于该用户的全部连接。
 * 返回被关闭的连接总数。
 */
export function revokeAllUserConnections(
  instance: Hocuspocus,
  userId: string,
): number {
  let closed = 0;
  for (const [documentName, doc] of instance.documents) {
    for (const connection of doc.getConnections()) {
      const ctx = connection.context as PermissionGuardContext | undefined;
      if (ctx?.userId === userId) {
        ctx.permissionRevoked = true;
        sendPermissionRevokedMessage(connection);
        setTimeout(() => closeConnection(connection), 100);
        closed++;
      }
    }
  }

  if (closed > 0) {
    console.log(
      `[PermissionGuard] Bulk-revoked ${closed} connection(s) for user=${userId} across all documents`,
    );
  }
  return closed;
}

export class PermissionGuard implements Extension {
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;
  private instance: Hocuspocus | null = null;

  async onConfigure({ instance }: onConfigurePayload): Promise<void> {
    this.instance = instance;

    this.revalidationTimer = setInterval(
      () => { this.revalidateAllConnections(); },
      REVALIDATION_INTERVAL_MS,
    );

    this.registerRevokeHandler(instance);

    console.log(
      `[PermissionGuard] Initialized (interval=${REVALIDATION_INTERVAL_MS}ms)`,
    );
  }

  /**
   * DS-024 fix: 在每条 Y.js 消息处理前执行权限检查。
   *
   * 四层检查（按成本从低到高）：
   *  1. 内存 permissionRevoked 标志（零成本快速路径）
   *  2. readOnly state sync to Hocuspocus Connection
   *  3. token 存活时间 / 重验超期（本地计算）
   *  4. **短 TTL 实时 Django 权限验证**（MESSAGE_REVALIDATION_TTL_MS，默认 5s）
   *     —— 将 Y.Doc 污染窗口从 60s 缩短至 5s，彻底关闭"借刀写入"攻击面
   */
  async beforeHandleMessage({
    context,
    connection,
    documentName,
  }: beforeHandleMessagePayload): Promise<void> {
    const ctx = context as PermissionGuardContext | undefined;
    if (!ctx) return;

    // Layer 1: fast path — already revoked
    if (ctx.permissionRevoked) {
      throw new Error("Permission revoked — message rejected");
    }

    // Layer 2: read-only enforcement
    if (connection?.readOnly && !ctx.readOnly) {
      setConnectionReadOnly(connection, true, ctx);
    } else if (ctx.readOnly && !connection?.readOnly) {
      setConnectionReadOnly(connection, true, ctx);
    }

    const now = Date.now();

    if (!ctx.connectionEstablishedAt) {
      ctx.connectionEstablishedAt = now;
      return;
    }

    // Layer 3: token age / revalidation overdue (local checks)
    // COL-023: Instead of immediately killing the connection when the token
    // expires, notify the client to refresh and allow a grace period.
    const tokenAge = now - ctx.connectionEstablishedAt;

    if (tokenAge > MAX_TOKEN_AGE_MS + TOKEN_REFRESH_GRACE_MS) {
      console.warn(
        `[PermissionGuard] Token grace period expired for user=${ctx.userId} ` +
        `doc=${documentName} (age=${Math.round(tokenAge / 1000)}s), closing connection`,
      );
      ctx.permissionRevoked = true;
      throw new Error("Token expired — grace period exceeded");
    }

    if (tokenAge > MAX_TOKEN_AGE_MS - TOKEN_REFRESH_ADVANCE_MS && !ctx.tokenRefreshSentAt) {
      ctx.tokenRefreshSentAt = now;
      console.log(
        `[PermissionGuard] COL-023: Sending token_refresh_required to user=${ctx.userId} ` +
        `doc=${documentName} (age=${Math.round(tokenAge / 1000)}s)`,
      );
      sendTokenRefreshRequired(connection);
    }

    const lastCheck = ctx.lastRevalidation ?? ctx.connectionEstablishedAt;
    if (now - lastCheck > REVALIDATION_INTERVAL_MS * 2) {
      ctx.permissionRevoked = true;
      throw new Error("Permission revalidation overdue — message rejected");
    }

    // Layer 4 (DS-024): short-TTL inline revalidation via Django API.
    // Only triggers when auth metadata is present and TTL has elapsed.
    if (!ctx.authToken || !ctx.resourceType || !ctx.resourceId) return;

    const elapsed = now - (ctx.lastRevalidation || 0);
    if (elapsed < MESSAGE_REVALIDATION_TTL_MS) return;

    if (ctx._msgRevalidationInProgress) return;

    ctx._msgRevalidationInProgress = true;
    try {
      const { authorized, reason, permission } = await verifyCollabAccess(
        ctx.resourceType,
        ctx.resourceId,
        ctx.authToken,
        ctx.parentDocumentId,
      );

      ctx.lastRevalidation = Date.now();

      if (!authorized) {
        if (isTransientAuthFailure(reason)) {
          const failures = (ctx.consecutiveFailures ?? 0) + 1;
          ctx.consecutiveFailures = failures;

          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(
              `[PermissionGuard] ${failures} consecutive message-revalidation transient failures ` +
              `for user=${ctx.userId} doc=${documentName} — fail-closed`,
            );
            ctx.permissionRevoked = true;
            sendPermissionRevokedMessage(connection);
            setTimeout(() => closeConnection(connection), 100);
            throw new Error("Permission revoked — message rejected (consecutive failures)");
          }

          console.warn(
            `[PermissionGuard] Message-revalidation transient failure ` +
            `(${failures}/${MAX_CONSECUTIVE_FAILURES}) for user=${ctx.userId} ` +
            `doc=${documentName}: ${reason}`,
          );
          return;
        }

        console.warn(
          `[PermissionGuard] Message-level revalidation denied for user=${ctx.userId} ` +
          `doc=${documentName}: ${reason}`,
        );
        ctx.permissionRevoked = true;
        ctx.consecutiveFailures = 0;
        sendPermissionRevokedMessage(connection);
        setTimeout(() => closeConnection(connection), 100);
        throw new Error("Permission revoked — message rejected");
      }

      ctx.consecutiveFailures = 0;

      // RV-013: 消息级重验发现 permission=view 时立即降级，并拒绝当前写消息
      if (permission === "view" && !ctx.readOnly) {
        setConnectionReadOnly(connection, true);
        sendReadOnlyDowngradeMessage(connection);
      }
    } catch (err: unknown) {
      if (ctx.permissionRevoked) throw err;

      const failures = (ctx.consecutiveFailures ?? 0) + 1;
      ctx.consecutiveFailures = failures;
      ctx.lastRevalidation = Date.now();

      const msg = err instanceof Error ? err.message : String(err);

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[PermissionGuard] ${failures} consecutive message-revalidation errors for ` +
          `user=${ctx.userId} doc=${documentName} — fail-closed: ${msg}`,
        );
        ctx.permissionRevoked = true;
        sendPermissionRevokedMessage(connection);
        setTimeout(() => closeConnection(connection), 100);
        throw new Error("Permission revoked — message rejected (consecutive failures)");
      }

      console.warn(
        `[PermissionGuard] Message-revalidation error (${failures}/${MAX_CONSECUTIVE_FAILURES}) ` +
        `for user=${ctx.userId} doc=${documentName}: ${msg}`,
      );
    } finally {
      ctx._msgRevalidationInProgress = false;
    }
  }

  async onDestroy(): Promise<void> {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
  }

  /**
   * COL-023: Handle `token_refresh` stateless message from client.
   * Validate the new token via Django and reset the connection's auth state.
   */
  async onStateless({ connection, documentName, payload }: onStatelessPayload): Promise<void> {
    let msg: { type?: string; token?: string };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type !== "token_refresh" || !msg.token) return;

    const ctx = connection.context as PermissionGuardContext | undefined;
    if (!ctx?.resourceType || !ctx?.resourceId) return;

    try {
      const { authorized, permission } = await verifyCollabAccess(
        ctx.resourceType,
        ctx.resourceId,
        msg.token,
        ctx.parentDocumentId,
      );

      if (!authorized) {
        console.warn(
          `[PermissionGuard] COL-023: token_refresh rejected for user=${ctx.userId} ` +
          `doc=${documentName} — new token not authorized`,
        );
        return;
      }

      ctx.authToken = msg.token;
      ctx.connectionEstablishedAt = Date.now();
      ctx.lastRevalidation = Date.now();
      ctx.tokenRefreshSentAt = undefined;
      ctx.consecutiveFailures = 0;

      if (permission === "view" && !ctx.readOnly) {
        setConnectionReadOnly(connection, true);
        sendReadOnlyDowngradeMessage(connection);
      } else if (permission === "edit" && ctx.readOnly) {
        setConnectionReadOnly(connection, false);
      }

      console.log(
        `[PermissionGuard] COL-023: Token refreshed for user=${ctx.userId} doc=${documentName}`,
      );
    } catch (err) {
      console.warn(
        `[PermissionGuard] COL-023: token_refresh validation error for user=${ctx.userId} ` +
        `doc=${documentName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private registerRevokeHandler(instance: Hocuspocus): void {
    const redisExt = instance.configuration.extensions.find(
      (ext) => ext instanceof RedisExtension,
    ) as RedisExtension | undefined;

    if (!redisExt) {
      console.warn(
        "[PermissionGuard] RedisExtension not found — running in single-instance mode. " +
        "Cross-instance revoke-access commands will NOT be received. " +
        "If running multiple collab-live instances, configure Redis to enable cluster-wide revocation.",
      );
      return;
    }

    redisExt.onAdminCommand<RevokeAccessCommandData>(
      AdminCommand.REVOKE_ACCESS,
      (data) => {
        const { docId, userId, readOnly } = data;
        if (readOnly) {
          downgradeUserConnectionsToReadOnly(instance, docId, userId);
        } else {
          revokeUserConnections(instance, docId, userId);
        }
      },
    );

    redisExt.onAdminCommand<RevokeUserAccessCommandData>(
      AdminCommand.REVOKE_USER_ACCESS,
      (data) => {
        if (data.readOnly) {
          downgradeAllUserConnectionsToReadOnly(instance, data.userId);
        } else {
          revokeAllUserConnections(instance, data.userId);
        }
      },
    );

    console.log("[PermissionGuard] Redis cross-instance revoke handler registered");
  }

  private async revalidateAllConnections(): Promise<void> {
    if (!this.instance) return;

    const now = Date.now();
    const connectionsToCheck: Array<{
      connection: Connection;
      ctx: PermissionGuardContext;
      documentName: string;
    }> = [];

    for (const [, doc] of this.instance.documents) {
      for (const connection of doc.getConnections()) {
        const ctx = connection.context as PermissionGuardContext | undefined;
        if (!ctx?.authToken || !ctx?.resourceType || !ctx?.resourceId) continue;
        if (ctx.permissionRevoked) continue;

        const elapsed = now - (ctx.lastRevalidation || 0);
        if (elapsed < REVALIDATION_INTERVAL_MS) continue;

        connectionsToCheck.push({
          connection,
          ctx,
          documentName: doc.name,
        });
      }
    }

    if (connectionsToCheck.length === 0) return;

    console.log(
      `[PermissionGuard] Revalidating ${connectionsToCheck.length} connection(s)`,
    );

    for (const { connection, ctx, documentName } of connectionsToCheck) {
      if (!ctx.connectionEstablishedAt) {
        ctx.connectionEstablishedAt = now;
      }

      const tokenAge = now - ctx.connectionEstablishedAt;

      // COL-023: Grace period exceeded → force close
      if (tokenAge > MAX_TOKEN_AGE_MS + TOKEN_REFRESH_GRACE_MS) {
        console.warn(
          `[PermissionGuard] Token age ${Math.round(tokenAge / 1000)}s exceeds ` +
          `max+grace for user=${ctx.userId} doc=${documentName}, closing connection`,
        );
        ctx.permissionRevoked = true;
        sendPermissionRevokedMessage(connection);
        setTimeout(() => closeConnection(connection), 100);
        await new Promise((r) => setTimeout(r, REVALIDATION_BATCH_DELAY_MS));
        continue;
      }

      // COL-023: Approaching expiry → send refresh notice
      if (tokenAge > MAX_TOKEN_AGE_MS - TOKEN_REFRESH_ADVANCE_MS && !ctx.tokenRefreshSentAt) {
        ctx.tokenRefreshSentAt = now;
        console.log(
          `[PermissionGuard] COL-023: Revalidation sending token_refresh_required to ` +
          `user=${ctx.userId} doc=${documentName} (age=${Math.round(tokenAge / 1000)}s)`,
        );
        sendTokenRefreshRequired(connection);
      }

      try {
        const result = await verifyCollabAccess(
          ctx.resourceType!,
          ctx.resourceId!,
          ctx.authToken!,
          ctx.parentDocumentId,
        );

        ctx.lastRevalidation = Date.now();

        if (!result.authorized) {
          if (isTransientAuthFailure(result.reason)) {
            const failures = (ctx.consecutiveFailures ?? 0) + 1;
            ctx.consecutiveFailures = failures;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              console.error(
                `[PermissionGuard] ${failures} consecutive revalidation transient failures for ` +
                `user=${ctx.userId} doc=${documentName} — fail-closed`,
              );
              ctx.permissionRevoked = true;
              sendPermissionRevokedMessage(connection);
              setTimeout(() => closeConnection(connection), 100);
            } else {
              console.warn(
                `[PermissionGuard] Revalidation transient failure ` +
                `(${failures}/${MAX_CONSECUTIVE_FAILURES}) for user=${ctx.userId} ` +
                `doc=${documentName}: ${result.reason}`,
              );
            }
          } else if (ctx.readOnly) {
            ctx.consecutiveFailures = 0;
            console.warn(
              `[PermissionGuard] ReadOnly revalidation failed for user=${ctx.userId} ` +
              `doc=${documentName}: ${result.reason} — closing connection`,
            );
            ctx.permissionRevoked = true;
            sendPermissionRevokedMessage(connection);
            setTimeout(() => closeConnection(connection), 100);
          } else {
            ctx.consecutiveFailures = 0;
            console.warn(
              `[PermissionGuard] Revalidation failed for user=${ctx.userId} ` +
              `doc=${documentName}: ${result.reason}`,
            );
            ctx.permissionRevoked = true;
            sendPermissionRevokedMessage(connection);
            setTimeout(() => closeConnection(connection), 100);
          }
        } else if (!ctx.readOnly && result.permission === "view") {
          ctx.consecutiveFailures = 0;
          console.log(
            `[PermissionGuard] User=${ctx.userId} doc=${documentName} downgraded to readOnly during revalidation`,
          );
          setConnectionReadOnly(connection, true);
          sendReadOnlyDowngradeMessage(connection);
        } else if (ctx.readOnly && result.permission === "edit") {
          ctx.consecutiveFailures = 0;
          console.log(
            `[PermissionGuard] User=${ctx.userId} doc=${documentName} upgraded from readOnly to editor during revalidation`,
          );
          setConnectionReadOnly(connection, false);
        } else {
          ctx.consecutiveFailures = 0;
        }
      } catch (err: unknown) {
        const failures = (ctx.consecutiveFailures ?? 0) + 1;
        ctx.consecutiveFailures = failures;
        ctx.lastRevalidation = Date.now();

        const msg = err instanceof Error ? err.message : String(err);

        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[PermissionGuard] ${failures} consecutive revalidation failures for ` +
            `user=${ctx.userId} doc=${documentName} — fail-closed, closing connection: ${msg}`,
          );
          ctx.permissionRevoked = true;
          sendPermissionRevokedMessage(connection);
          setTimeout(() => closeConnection(connection), 100);
        } else {
          console.warn(
            `[PermissionGuard] Revalidation network error (${failures}/${MAX_CONSECUTIVE_FAILURES}) for ` +
            `user=${ctx.userId} doc=${documentName}: ${msg}`,
          );
        }
      }

      await new Promise((r) => setTimeout(r, REVALIDATION_BATCH_DELAY_MS));
    }
  }
}
