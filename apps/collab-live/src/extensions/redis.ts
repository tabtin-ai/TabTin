/**
 * Redis Extension — 多实例 Pub/Sub 同步
 *
 * 参照 Plane apps/live/src/extensions/redis.ts
 * 提供：
 * - Hocuspocus 文档级同步（内置）
 * - Admin channel（自定义命令广播，如 force-close）
 *
 * PERF-023: Admin sub/pub 连接在所有模块间共享（6 模块共 2 连接，非 12 连接）
 * PERF-024: Redis 断线超时后自动清空离线队列，防止无限堆内存增长
 * PERF-028: 所有连接事件上报 metrics
 */

import { Redis as HocuspocusRedis } from "@hocuspocus/extension-redis";
import type { Hocuspocus, onConfigurePayload } from "@hocuspocus/server";
import { Redis as IORedis } from "ioredis";
import { env } from "../env.js";
import { metrics } from "./metrics.js";

/** Admin 命令类型 */
export enum AdminCommand {
  FORCE_CLOSE = "force_close",
  STATELESS_BROADCAST = "stateless_broadcast",
  REVOKE_ACCESS = "revoke_access",
  REVOKE_USER_ACCESS = "revoke_user_access",
  /** E2E-022: DB-first Agent 写入后通知缓存层更新 Y.Doc version，防止 conflict 覆盖 */
  INVALIDATE_VERSION = "invalidate_version",
}

/** Admin 命令基础数据 */
export interface AdminCommandData {
  command: AdminCommand;
  docId: string;
  originServer: string;
  timestamp: string;
  [key: string]: unknown;
}

/** Force-close 命令数据 */
export interface ForceCloseCommandData extends AdminCommandData {
  command: AdminCommand.FORCE_CLOSE;
  reason: string;
  code: number;
  /** VS-003: 透传给跨节点客户端的重连延迟（document_restored 场景防止过早重连） */
  reconnect_delay_ms?: number;
}

/** Stateless broadcast 命令数据 */
export interface StatelessBroadcastCommandData extends AdminCommandData {
  command: AdminCommand.STATELESS_BROADCAST;
  message: string;
}

/** Revoke access 命令数据 */
export interface RevokeAccessCommandData extends AdminCommandData {
  command: AdminCommand.REVOKE_ACCESS;
  userId: string;
  /** RV-013: true 时降级为只读，false 时断连 */
  readOnly?: boolean;
}

/** 按用户批量撤销命令数据（跨所有文档） */
export interface RevokeUserAccessCommandData extends AdminCommandData {
  command: AdminCommand.REVOKE_USER_ACCESS;
  userId: string;
  /** RV-013: true 时降级为只读，false 时断连 */
  readOnly?: boolean;
}

/** E2E-022: invalidate-version 命令数据 */
export interface InvalidateVersionCommandData extends AdminCommandData {
  command: AdminCommand.INVALIDATE_VERSION;
  /** 完整文档名（含前缀，如 "canvas:uuid"） */
  docId: string;
  /** DB 写入后的最新版本号 */
  newVersion: number;
}

type AdminCommandHandler<T = AdminCommandData> = (data: T) => Promise<void> | void;

const ADMIN_CHANNEL = "collab-live:admin";

/**
 * PERF-024: 离线队列清空超时（ms）。
 * Redis 断线超过此时间后 disconnect+reconnect，清空堆内存中积压的离线命令。
 */
const OFFLINE_FLUSH_TIMEOUT_MS = parseInt(
  process.env.REDIS_OFFLINE_FLUSH_MS || "30000",
  10,
);

/**
 * 主动断开标记集合：被 disconnectIntentionally() 标记的客户端在 close 事件中
 * 不启动离线队列刷新定时器，防止主动清理时产生僵尸重连。
 */
const _intentionalDisconnects = new WeakSet<IORedis>();

function disconnectIntentionally(client: IORedis | null): void {
  if (!client) return;
  _intentionalDisconnects.add(client);
  client.disconnect();
}

/**
 * 创建 Redis 客户端
 *
 * PERF-024: 添加离线队列保护 — 断线超时后 disconnect+reconnect 清空积压命令
 * PERF-028: 连接事件上报 metrics
 */
function createRedisClient(label: string = "default"): IORedis {
  const client = new IORedis(env.REDIS_URL, {
    lazyConnect: false,
    keepAlive: 30000,
    connectTimeout: 10000,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      console.warn(`[Redis:${label}] Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  metrics.redisTotalConnections++;

  let isReady = false;
  let wasEverReady = false;
  let offlineFlushTimer: ReturnType<typeof setTimeout> | null = null;

  client.on("error", (err) => {
    console.error(`[Redis:${label}] Connection error:`, err.message);
  });

  client.on("connect", () => {
    console.log(`[Redis:${label}] Connected`);
  });

  client.on("ready", () => {
    if (wasEverReady && !isReady) {
      metrics.redisReconnections++;
    }
    wasEverReady = true;
    if (!isReady) {
      isReady = true;
      metrics.redisActiveConnections++;
    }
    if (offlineFlushTimer) {
      clearTimeout(offlineFlushTimer);
      offlineFlushTimer = null;
    }
  });

  client.on("close", () => {
    console.warn(`[Redis:${label}] Connection closed`);
    if (isReady) {
      isReady = false;
      metrics.redisActiveConnections = Math.max(0, metrics.redisActiveConnections - 1);
    }

    // 主动断开时不启动离线刷新定时器（防止僵尸重连）
    if (_intentionalDisconnects.has(client)) return;

    // PERF-024: 断线超时后清空离线队列防止 OOM
    if (!offlineFlushTimer) {
      offlineFlushTimer = setTimeout(() => {
        offlineFlushTimer = null;
        if (client.status !== "ready") {
          console.warn(
            `[Redis:${label}] Offline for >${OFFLINE_FLUSH_TIMEOUT_MS}ms, ` +
            `flushing offline queue and reconnecting`,
          );
          metrics.redisOfflineQueueFlushes++;
          client.disconnect();
          client.connect().catch(() => {});
        }
      }, OFFLINE_FLUSH_TIMEOUT_MS);
    }
  });

  return client;
}

// ── Shared Admin Channel Bus (PERF-023) ─────────────────────────
//
// 所有 RedisExtension 实例共享一对 admin sub/pub 连接，而非各自创建。
// 6 模块 × 2 连接 → 共 2 连接（节省 10 个 Redis 连接）。
// 最后一个 listener 注销时自动清理共享连接。

const _adminBus = {
  sub: null as IORedis | null,
  pub: null as IORedis | null,
  initialized: false,
  listeners: [] as Array<(message: string) => Promise<void>>,
};

/** Promise 锁防止 6 个模块并发初始化 admin bus（竞态导致连接泄漏） */
let _adminBusInitPromise: Promise<void> | null = null;

async function ensureAdminBus(): Promise<void> {
  if (_adminBus.initialized) return;
  if (!_adminBusInitPromise) {
    _adminBusInitPromise = _doInitAdminBus();
  }
  return _adminBusInitPromise;
}

async function _doInitAdminBus(): Promise<void> {
  const sub = createRedisClient("shared-admin-sub");
  const pub = createRedisClient("shared-admin-pub");

  try {
    await sub.subscribe(ADMIN_CHANNEL);
  } catch (err) {
    sub.disconnect();
    pub.disconnect();
    _adminBusInitPromise = null;
    throw err;
  }

  sub.on("message", (channel: string, message: string) => {
    if (channel !== ADMIN_CHANNEL) return;
    metrics.redisMessagesReceived++;
    for (const fn of _adminBus.listeners) {
      fn(message).catch((err) => {
        console.error("[Redis] Admin message handler error:", err);
      });
    }
  });

  _adminBus.sub = sub;
  _adminBus.pub = pub;
  _adminBus.initialized = true;
  console.log("[Redis] Shared admin bus initialized:", ADMIN_CHANNEL);
}

function registerAdminListener(fn: (msg: string) => Promise<void>): void {
  _adminBus.listeners.push(fn);
}

function unregisterAdminListener(fn: (msg: string) => Promise<void>): void {
  const idx = _adminBus.listeners.indexOf(fn);
  if (idx >= 0) _adminBus.listeners.splice(idx, 1);

  if (_adminBus.listeners.length === 0 && _adminBus.initialized) {
    _adminBus.sub?.unsubscribe(ADMIN_CHANNEL).catch(() => {});
    disconnectIntentionally(_adminBus.sub);
    disconnectIntentionally(_adminBus.pub);
    _adminBus.sub = null;
    _adminBus.pub = null;
    _adminBus.initialized = false;
    _adminBusInitPromise = null;
    console.log("[Redis] Shared admin bus destroyed (all listeners removed)");
  }
}

// ── RedisExtension ──────────────────────────────────────────────

export class RedisExtension extends HocuspocusRedis {
  private adminHandlers = new Map<AdminCommand, AdminCommandHandler>();
  private _hocuspocusRef: Hocuspocus | null = null;
  private readonly _boundHandleMsg: (msg: string) => Promise<void>;
  private readonly _redisClient: IORedis;

  constructor(label: string = "default") {
    const client = createRedisClient(`hocuspocus-${label}`);
    super({ redis: client });
    this._redisClient = client;
    this._boundHandleMsg = this.handleAdminMessage.bind(this);
  }

  /** 获取绑定的 Hocuspocus 实例（onConfigure 后可用） */
  public getInstance(): Hocuspocus | null {
    return this._hocuspocusRef;
  }

  async onConfigure(payload: onConfigurePayload) {
    await super.onConfigure(payload);
    this._hocuspocusRef = payload.instance;

    // PERF-023: 注册到共享 admin bus（而非各自创建 sub/pub 连接）
    await ensureAdminBus();
    registerAdminListener(this._boundHandleMsg);

    this.registerStatelessBroadcastHandler();
    console.log("[Redis] Admin channel registered (shared):", ADMIN_CHANNEL);
  }

  private registerStatelessBroadcastHandler(): void {
    this.onAdminCommand<StatelessBroadcastCommandData>(
      AdminCommand.STATELESS_BROADCAST,
      (data) => {
        const { docId, message } = data;
        if (!docId || !message || !this._hocuspocusRef) return;

        const doc = this._hocuspocusRef.documents.get(docId);
        if (doc) {
          doc.broadcastStateless(message);
          console.log(
            `[StatelessBroadcast:Redis] Received from remote, broadcasted to ${docId} (${doc.getConnectionsCount()} connections)`,
          );
        }
      },
    );
  }

  private async handleAdminMessage(message: string): Promise<void> {
    try {
      const data = JSON.parse(message) as AdminCommandData;
      // 忽略自己发出的消息
      if (data.originServer === env.SERVER_NAME) return;

      const handler = this.adminHandlers.get(data.command);
      if (handler) {
        await handler(data);
      }
    } catch (err: unknown) {
      console.error("[Redis] Failed to parse admin message:", err);
    }
  }

  /**
   * 注册 admin 命令处理器
   */
  public onAdminCommand<T extends AdminCommandData>(
    command: AdminCommand,
    handler: AdminCommandHandler<T>
  ): void {
    this.adminHandlers.set(command, handler as AdminCommandHandler);
  }

  /**
   * 发布 admin 命令到所有实例（通过共享 pub 连接）
   */
  public async publishAdminCommand<T extends AdminCommandData>(data: T): Promise<number> {
    if (!_adminBus.pub) {
      throw new Error("Admin bus not initialized — cannot publish admin command");
    }
    const message = JSON.stringify(data);
    const receivers = await _adminBus.pub.publish(ADMIN_CHANNEL, message);
    metrics.redisMessagesSent++;
    console.log(`[Redis] Published admin command: ${data.command}, receivers: ${receivers}`);
    return receivers;
  }

  async onDestroy(): Promise<void> {
    unregisterAdminListener(this._boundHandleMsg);
    try {
      await super.onDestroy();
    } catch (err) {
      console.error("[Redis] Parent onDestroy failed:", err);
    } finally {
      disconnectIntentionally(this._redisClient);
    }
  }
}
