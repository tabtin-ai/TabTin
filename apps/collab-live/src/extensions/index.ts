/**
 * Hocuspocus Extensions 聚合
 *
 * 扩展加载顺序：
 * 1. Logger — 日志
 * 2. MetricsExtension — 观测指标
 * 3. Database — 文档持久化
 * 4. RedisExtension — 多实例同步（可选，需要 REDIS_URL）
 * 5. ForceCloseHandler — 异常断连治理（依赖 Redis）
 */

import { Logger } from "@hocuspocus/extension-logger";
import { Database } from "./database.js";
import { TableDatabase, clearTableSnapshot, saveTableSnapshot } from "./table-database.js";
import { SlideDatabase, clearSlideSnapshot } from "./slide-database.js";
import { createVideoDatabase } from "./video-database.js";
import { createCanvasDatabase } from "./canvas-database.js";
import { MetricsExtension } from "./metrics.js";
import { RuntimeSnapshotExtension } from "./runtime-snapshot.js";
import { ConnectionLimiter } from "./connection-limiter.js";
import { PermissionGuard } from "./permission-guard.js";
import { RedisExtension, AdminCommand } from "./redis.js";
import type { StatelessBroadcastCommandData } from "./redis.js";
import { ForceCloseHandler } from "./force-close.js";
import { env } from "../env.js";

import type { Extension } from "@hocuspocus/server";

/**
 * 用于跨实例 admin 命令的 RedisExtension 引用
 * 保存第一个创建的实例供 stateless broadcast 路由使用
 */
let primaryRedis: RedisExtension | null = null;

export function getPrimaryRedis(): RedisExtension | null {
  return primaryRedis;
}

/** 创建 Redis + ForceClose 扩展（如果配置了 REDIS_URL） */
function createRedisExtensions(label: string): Extension[] {
  if (!env.REDIS_URL) {
    console.log(`[${label}] Redis not configured, running single-instance mode`);
    return [];
  }

  const redis = new RedisExtension(label);
  if (!primaryRedis) primaryRedis = redis;
  console.log(`[${label}] Redis + ForceClose enabled`);
  return [redis, new ForceCloseHandler()];
}

/** 通用模块扩展工厂：ConnectionLimiter + PermissionGuard + Logger + Metrics + Database + Redis */
function createModuleExtensions(database: Extension, label: string): Extension[] {
  return [
    new ConnectionLimiter(),
    new PermissionGuard(),
    new Logger(),
    new MetricsExtension(),
    new RuntimeSnapshotExtension(),
    database,
    ...createRedisExtensions(label),
  ];
}

/** TabDoc 文档协作扩展 */
export function getExtensions(): Extension[] {
  return createModuleExtensions(new Database(), "Extensions");
}

/** TabData 表格协作扩展（M3） */
export function getTableExtensions(): Extension[] {
  return createModuleExtensions(new TableDatabase(), "TableExtensions");
}

/** TabSlide 演示文稿协作扩展 */
export function getSlideExtensions(): Extension[] {
  return createModuleExtensions(new SlideDatabase(), "SlideExtensions");
}

/** TabVideo 视频时间轴协作扩展 */
export function getVideoExtensions(): Extension[] {
  return createModuleExtensions(createVideoDatabase(), "VideoExtensions");
}

/** TabWhiteboard 画布协作扩展 */
export function getCanvasExtensions(): Extension[] {
  return createModuleExtensions(createCanvasDatabase(), "CanvasExtensions");
}

export { clearTableSnapshot, saveTableSnapshot, clearSlideSnapshot, AdminCommand };
export type { StatelessBroadcastCommandData };
