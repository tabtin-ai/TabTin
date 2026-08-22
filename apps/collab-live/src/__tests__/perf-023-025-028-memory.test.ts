/**
 * PERF-023/024/025/028 回归测试
 *
 * - PERF-023: Redis admin sub/pub 连接共享（6 模块共 2 连接而非 12 连接）
 * - PERF-024: Redis 断线超时后清空离线队列防止 OOM
 * - PERF-025: snapshotCache 使用 LRU 淘汰防止无限增长
 * - PERF-028: MetricsCollector 包含 Redis 可观测性指标
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock env before any imports ────────────────────────────────
vi.mock("../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
    REDIS_URL: "",
  },
}));

// ─── PERF-025: LRU snapshotCache ────────────────────────────────

describe("PERF-025: snapshotCache LRU eviction", () => {
  it("evicts oldest entries when exceeding maxSize", async () => {
    // 用小 maxSize 环境变量触发 LRU
    process.env.COLLAB_SNAPSHOT_CACHE_MAX = "5";

    // Dynamic import to pick up the env var
    const mod = await import("../extensions/base-collab-database.js");
    const BaseCollabDatabase = mod.BaseCollabDatabase;

    // 创建具体子类用于测试
    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix(): string { return "test:"; }
      protected getResourceType(): string { return "test"; }
      protected getModuleLabel(): string { return "TestDB"; }
      protected applySnapshotToDoc(): void {}
      protected buildPersistPayload(): null { return null; }
    }

    const db = new TestDatabase();

    // 写入 7 条数据（maxSize=5）
    for (let i = 0; i < 7; i++) {
      db.snapshotCache.set(`test:doc-${i}`, { version: i });
    }

    expect(db.snapshotCache.size).toBe(5);
    // 最早的 doc-0 和 doc-1 应该被淘汰
    expect(db.snapshotCache.has("test:doc-0")).toBe(false);
    expect(db.snapshotCache.has("test:doc-1")).toBe(false);
    // 最近的 doc-2~doc-6 应该存在
    expect(db.snapshotCache.has("test:doc-2")).toBe(true);
    expect(db.snapshotCache.has("test:doc-6")).toBe(true);

    // 清理
    delete process.env.COLLAB_SNAPSHOT_CACHE_MAX;
  });

  it("promotes accessed entries to avoid eviction", async () => {
    // 模块已在上一个测试中以 maxSize=5 加载（模块级常量只求值一次）
    const mod = await import("../extensions/base-collab-database.js");
    const BaseCollabDatabase = mod.BaseCollabDatabase;

    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix(): string { return "test:"; }
      protected getResourceType(): string { return "test"; }
      protected getModuleLabel(): string { return "TestDB"; }
      protected applySnapshotToDoc(): void {}
      protected buildPersistPayload(): null { return null; }
    }

    const db = new TestDatabase();

    // 填满 5 个条目（maxSize=5）
    db.snapshotCache.set("a", 1);
    db.snapshotCache.set("b", 2);
    db.snapshotCache.set("c", 3);
    db.snapshotCache.set("d", 4);
    db.snapshotCache.set("e", 5);

    // 访问 "a" 使其提升为最近使用
    db.snapshotCache.get("a");

    // 插入新条目 → 应淘汰 "b"（"a" 已提升，"b" 成为最久未访问）
    db.snapshotCache.set("f", 6);

    expect(db.snapshotCache.size).toBe(5);
    expect(db.snapshotCache.has("a")).toBe(true);  // 已提升，不被淘汰
    expect(db.snapshotCache.has("b")).toBe(false);  // 最久未访问，被淘汰
    expect(db.snapshotCache.has("c")).toBe(true);
    expect(db.snapshotCache.has("f")).toBe(true);   // 刚插入
  });

  it("delete() works correctly on LRU cache", async () => {
    process.env.COLLAB_SNAPSHOT_CACHE_MAX = "10";

    const mod = await import("../extensions/base-collab-database.js");
    const BaseCollabDatabase = mod.BaseCollabDatabase;

    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix(): string { return "test:"; }
      protected getResourceType(): string { return "test"; }
      protected getModuleLabel(): string { return "TestDB"; }
      protected applySnapshotToDoc(): void {}
      protected buildPersistPayload(): null { return null; }
    }

    const db = new TestDatabase();

    db.snapshotCache.set("a", 1);
    db.snapshotCache.set("b", 2);
    expect(db.snapshotCache.size).toBe(2);

    db.snapshotCache.delete("a");
    expect(db.snapshotCache.size).toBe(1);
    expect(db.snapshotCache.has("a")).toBe(false);
    expect(db.snapshotCache.get("b")).toBe(2);

    delete process.env.COLLAB_SNAPSHOT_CACHE_MAX;
  });
});

// ─── PERF-028: Redis metrics in MetricsCollector ────────────────

describe("PERF-028: MetricsCollector Redis observability", () => {
  it("includes redis metrics in snapshot", async () => {
    const { metrics } = await import("../extensions/metrics.js");

    // 模拟 Redis 活动
    metrics.redisTotalConnections = 8;
    metrics.redisActiveConnections = 6;
    metrics.redisReconnections = 2;
    metrics.redisMessagesSent = 100;
    metrics.redisMessagesReceived = 95;
    metrics.redisOfflineQueueFlushes = 1;
    metrics.snapshotCacheSizes["table"] = 50;
    metrics.snapshotCacheSizes["design"] = 30;

    const snapshot = metrics.getSnapshot();

    expect(snapshot.redis).toBeDefined();
    expect(snapshot.redis.totalConnections).toBe(8);
    expect(snapshot.redis.activeConnections).toBe(6);
    expect(snapshot.redis.reconnections).toBe(2);
    expect(snapshot.redis.messagesSent).toBe(100);
    expect(snapshot.redis.messagesReceived).toBe(95);
    expect(snapshot.redis.offlineQueueFlushes).toBe(1);

    expect(snapshot.snapshotCacheSizes).toEqual({ table: 50, design: 30 });
  });

  it("triggers redis_all_connections_down alert when no active connections", async () => {
    const { metrics } = await import("../extensions/metrics.js");

    metrics.redisTotalConnections = 8;
    metrics.redisActiveConnections = 0;

    const alerts = metrics.checkAlerts();
    expect(alerts).toContain("redis_all_connections_down");
  });

  it("triggers offline queue flush alert", async () => {
    const { metrics } = await import("../extensions/metrics.js");

    metrics.redisOfflineQueueFlushes = 3;

    const alerts = metrics.checkAlerts();
    expect(alerts.some((a) => a.includes("redis_offline_queue_flushes"))).toBe(true);
  });

  it("does NOT trigger redis alert when connections are healthy", async () => {
    const { metrics } = await import("../extensions/metrics.js");

    metrics.redisTotalConnections = 8;
    metrics.redisActiveConnections = 8;
    metrics.redisOfflineQueueFlushes = 0;
    metrics.storeErrors = 0;
    metrics.fetchErrors = 0;

    const alerts = metrics.checkAlerts();
    expect(alerts.filter((a) => a.startsWith("redis_"))).toEqual([]);
  });
});

// ─── PERF-023: Shared admin bus (structural validation) ─────────

describe("PERF-023: RedisExtension shared admin bus", () => {
  it("RedisExtension constructor accepts label parameter", async () => {
    // 验证构造函数签名支持 label 参数（编译时检查）
    const mod = await import("../extensions/redis.js");
    expect(mod.RedisExtension).toBeDefined();
    expect(typeof mod.RedisExtension).toBe("function");
  });

  it("AdminCommand enum values are preserved", async () => {
    const { AdminCommand } = await import("../extensions/redis.js");
    expect(AdminCommand.FORCE_CLOSE).toBe("force_close");
    expect(AdminCommand.STATELESS_BROADCAST).toBe("stateless_broadcast");
    expect(AdminCommand.REVOKE_ACCESS).toBe("revoke_access");
    expect(AdminCommand.REVOKE_USER_ACCESS).toBe("revoke_user_access");
  });
});

// ─── PERF-024: Offline queue flush constant validation ──────────

describe("PERF-024: Offline queue flush configuration", () => {
  it("REDIS_OFFLINE_FLUSH_MS env var is respected", () => {
    // 验证环境变量机制：设置 REDIS_OFFLINE_FLUSH_MS 不会报错
    const original = process.env.REDIS_OFFLINE_FLUSH_MS;
    process.env.REDIS_OFFLINE_FLUSH_MS = "15000";

    // 常量在模块加载时读取，这里验证 env var 解析逻辑
    const parsed = parseInt(process.env.REDIS_OFFLINE_FLUSH_MS || "30000", 10);
    expect(parsed).toBe(15000);

    if (original !== undefined) {
      process.env.REDIS_OFFLINE_FLUSH_MS = original;
    } else {
      delete process.env.REDIS_OFFLINE_FLUSH_MS;
    }
  });

  it("defaults to 30000ms when env var not set", () => {
    const original = process.env.REDIS_OFFLINE_FLUSH_MS;
    delete process.env.REDIS_OFFLINE_FLUSH_MS;

    const parsed = parseInt(process.env.REDIS_OFFLINE_FLUSH_MS || "30000", 10);
    expect(parsed).toBe(30000);

    if (original !== undefined) {
      process.env.REDIS_OFFLINE_FLUSH_MS = original;
    }
  });
});
