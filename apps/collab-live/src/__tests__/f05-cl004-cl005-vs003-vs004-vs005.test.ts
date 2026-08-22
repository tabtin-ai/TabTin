/**
 * F05 回归测试 — CL-004 / CL-005 / VS-003 / VS-004 / VS-005
 *
 * CL-004: invalidateDocumentVersion 总是通过 Redis 广播，即使本地已更新
 * CL-005: getVersionFieldName 集中维护版本字段名映射
 * VS-003: force_close Redis 广播透传 reconnect_delay_ms
 * VS-004: force-close 重连延迟可配置
 * VS-005: force-close 在 unloadDocument 前等待 in-flight store
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

vi.mock("../env.js", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    SERVER_NAME: "test-server",
  },
}));

vi.mock("./base-collab-database-wait-mock.js", () => ({}));

import {
  forceCloseDocument,
  ForceCloseHandler,
  ForceCloseReason,
  CloseCode,
  getVersionFieldName,
  invalidateDocumentVersion,
  type InvalidateVersionResult,
} from "../extensions/force-close.js";
import { RedisExtension, AdminCommand } from "../extensions/redis.js";
import { waitForDocumentStores } from "../extensions/base-collab-database.js";

// ── 辅助函数 ──────────────────────────────────────────────────────

function createMockConnection() {
  return {
    connection: {
      sendStateless: vi.fn(),
      close: vi.fn(),
    },
  };
}

function createMockDocument(connectionCount: number) {
  const ydoc = new Y.Doc();
  const connections = Array.from({ length: connectionCount }, createMockConnection);
  return {
    connections,
    getConnectionsCount: () => connectionCount,
    getMap: (name: string) => ydoc.getMap(name),
    transact: (fn: () => void) => ydoc.transact(fn),
    _ydoc: ydoc,
  };
}

function createMockRedisExtension() {
  return Object.assign(Object.create(RedisExtension.prototype), {
    publishAdminCommand: vi.fn().mockResolvedValue(1),
    onAdminCommand: vi.fn(),
  });
}

function createMockInstance(
  docs: Map<string, any> = new Map(),
  redisExt?: any,
) {
  const extensions: any[] = redisExt ? [redisExt] : [];
  return {
    documents: docs,
    configuration: { extensions },
    unloadDocument: vi.fn().mockResolvedValue(undefined),
  };
}

// ── CL-005: getVersionFieldName ──────────────────────────────────

describe("CL-005: getVersionFieldName 版本字段名映射", () => {
  it("design 文档返回 revn", () => {
    expect(getVersionFieldName("design:abc-123")).toBe("revn");
    expect(getVersionFieldName("design:")).toBe("revn");
  });

  it("table 文档返回 version", () => {
    expect(getVersionFieldName("table:abc-123")).toBe("version");
  });

  it("slide 文档返回 version", () => {
    expect(getVersionFieldName("slide:abc-123")).toBe("version");
  });

  it("video 文档返回 version", () => {
    expect(getVersionFieldName("video:abc-123")).toBe("version");
  });

  it("canvas 文档返回 version", () => {
    expect(getVersionFieldName("canvas:abc-123")).toBe("version");
  });

  it("docs 文档返回 version", () => {
    expect(getVersionFieldName("docs:abc-123")).toBe("version");
  });

  it("未知前缀也返回 version（安全降级）", () => {
    expect(getVersionFieldName("unknown:abc-123")).toBe("version");
    expect(getVersionFieldName("")).toBe("version");
  });
});

// ── CL-004: invalidateDocumentVersion 跨节点广播 ─────────────────

describe("CL-004: invalidateDocumentVersion 总是通过 Redis 广播", () => {
  it("文档在本地内存中：更新本地 + 广播 Redis", async () => {
    const doc = createMockDocument(0);
    doc._ydoc.getMap("meta").set("version", 5);
    const docs = new Map([["canvas:abc-123", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    const result: InvalidateVersionResult = await invalidateDocumentVersion(
      instance as any,
      "canvas:abc-123",
      6,
    );

    expect(result.updated).toBe(true);
    expect(doc._ydoc.getMap("meta").get("version")).toBe(6);

    // 关键：即使本地已更新，仍广播 Redis
    expect(redisExt.publishAdminCommand).toHaveBeenCalledTimes(1);
    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.command).toBe(AdminCommand.INVALIDATE_VERSION);
    expect(callArg.docId).toBe("canvas:abc-123");
    expect(callArg.newVersion).toBe(6);
  });

  it("文档不在本地内存：不更新本地 + 广播 Redis", async () => {
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(new Map(), redisExt);

    const result = await invalidateDocumentVersion(
      instance as any,
      "slide:xyz-456",
      10,
    );

    expect(result.updated).toBe(false);
    expect(redisExt.publishAdminCommand).toHaveBeenCalledTimes(1);
    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.docId).toBe("slide:xyz-456");
    expect(callArg.newVersion).toBe(10);
  });

  it("design 文档：更新 revn 字段", async () => {
    const doc = createMockDocument(0);
    doc._ydoc.getMap("meta").set("revn", 3);
    const docs = new Map([["design:des-001", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    await invalidateDocumentVersion(instance as any, "design:des-001", 4);

    expect(doc._ydoc.getMap("meta").get("revn")).toBe(4);
    expect(doc._ydoc.getMap("meta").get("version")).toBeUndefined();
  });

  it("无 Redis 时只更新本地", async () => {
    const doc = createMockDocument(0);
    doc._ydoc.getMap("meta").set("version", 1);
    const docs = new Map([["table:no-redis", doc]]);
    const instance = createMockInstance(docs);

    const result = await invalidateDocumentVersion(
      instance as any,
      "table:no-redis",
      2,
    );

    expect(result.updated).toBe(true);
    expect(doc._ydoc.getMap("meta").get("version")).toBe(2);
  });
});

// ── VS-003: force_close Redis 广播携带 reconnect_delay_ms ────────

describe("VS-003: force_close 广播携带 reconnect_delay_ms", () => {
  it("DOCUMENT_RESTORED 广播包含 reconnect_delay_ms", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["slide:restore-test", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    await forceCloseDocument(
      instance as any,
      "slide:restore-test",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    expect(redisExt.publishAdminCommand).toHaveBeenCalledTimes(1);
    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.reconnect_delay_ms).toBeGreaterThan(0);
  });

  it("非 DOCUMENT_RESTORED 广播不包含 reconnect_delay_ms", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["table:perm-test", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    await forceCloseDocument(
      instance as any,
      "table:perm-test",
      ForceCloseReason.PERMISSION_CHANGED,
      CloseCode.PERMISSION_CHANGED,
    );

    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.reconnect_delay_ms).toBeUndefined();
  });

  it("文档不在本地时 DOCUMENT_RESTORED 广播也包含 reconnect_delay_ms", async () => {
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(new Map(), redisExt);

    await forceCloseDocument(
      instance as any,
      "design:not-local",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.reconnect_delay_ms).toBeGreaterThan(0);
  });

  it("ForceCloseHandler 接收广播后透传 reconnect_delay_ms 到客户端", async () => {
    const doc = createMockDocument(2);
    const docs = new Map([["slide:remote-test", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    let registeredForceCloseHandler: ((data: any) => Promise<void>) | null = null;
    const handlers = new Map<string, (data: any) => Promise<void>>();
    redisExt.onAdminCommand.mockImplementation((cmd: string, handler: any) => {
      handlers.set(cmd, handler);
    });

    const handler = new ForceCloseHandler();
    await handler.onConfigure({ instance } as any);

    const forceCloseH = handlers.get(AdminCommand.FORCE_CLOSE);
    expect(forceCloseH).toBeDefined();

    await forceCloseH!({
      command: AdminCommand.FORCE_CLOSE,
      docId: "slide:remote-test",
      reason: ForceCloseReason.DOCUMENT_RESTORED,
      code: CloseCode.DOCUMENT_RESTORED,
      reconnect_delay_ms: 800,
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    });

    // 验证客户端收到的 stateless 消息包含 reconnect_delay_ms
    const sentMsg = doc.connections[0].connection.sendStateless.mock.calls[0][0];
    const parsed = JSON.parse(sentMsg);
    expect(parsed.reconnect_delay_ms).toBe(800);
  });

  it("ForceCloseHandler 无 reconnect_delay_ms 时不传递该字段", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["table:no-delay", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    const handlers = new Map<string, (data: any) => Promise<void>>();
    redisExt.onAdminCommand.mockImplementation((cmd: string, handler: any) => {
      handlers.set(cmd, handler);
    });

    const handler = new ForceCloseHandler();
    await handler.onConfigure({ instance } as any);

    await handlers.get(AdminCommand.FORCE_CLOSE)!({
      command: AdminCommand.FORCE_CLOSE,
      docId: "table:no-delay",
      reason: ForceCloseReason.ADMIN_ACTION,
      code: CloseCode.DOCUMENT_NOT_FOUND,
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    });

    const parsed = JSON.parse(doc.connections[0].connection.sendStateless.mock.calls[0][0]);
    expect(parsed.reconnect_delay_ms).toBeUndefined();
  });
});

// ── VS-004: reconnect_delay_ms 可配置 ───────────────────────────

describe("VS-004: reconnect_delay_ms 默认值与可配置性", () => {
  it("DOCUMENT_RESTORED 场景 reconnect_delay_ms 使用默认值(>=600)", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["canvas:delay-cfg", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    await forceCloseDocument(
      instance as any,
      "canvas:delay-cfg",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    const sentMsg = JSON.parse(doc.connections[0].connection.sendStateless.mock.calls[0][0]);
    expect(sentMsg.reconnect_delay_ms).toBeGreaterThanOrEqual(600);
  });
});

// ── VS-005: waitForDocumentStores ───────────────────────────────

describe("VS-005: waitForDocumentStores 基础行为", () => {
  it("无 pending store 时立即返回 true", async () => {
    const result = await waitForDocumentStores("nonexistent:doc");
    expect(result).toBe(true);
  });
});

// ── CL-005: ForceCloseHandler invalidate_version 使用 getVersionFieldName ──

describe("CL-005: ForceCloseHandler invalidate_version 使用 getVersionFieldName", () => {
  it("design 文档通过 Redis 更新 revn 字段", async () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("meta").set("revn", 5);
    const doc = {
      connections: [],
      getConnectionsCount: () => 0,
      getMap: (name: string) => ydoc.getMap(name),
      transact: (fn: () => void) => ydoc.transact(fn),
    };
    const docs = new Map([["design:test-001", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    const handlers = new Map<string, (data: any) => void>();
    redisExt.onAdminCommand.mockImplementation((cmd: string, handler: any) => {
      handlers.set(cmd, handler);
    });

    const handler = new ForceCloseHandler();
    await handler.onConfigure({ instance } as any);

    const invalidateH = handlers.get(AdminCommand.INVALIDATE_VERSION);
    expect(invalidateH).toBeDefined();

    invalidateH!({
      command: AdminCommand.INVALIDATE_VERSION,
      docId: "design:test-001",
      newVersion: 6,
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    });

    expect(ydoc.getMap("meta").get("revn")).toBe(6);
    expect(ydoc.getMap("meta").get("version")).toBeUndefined();
  });

  it("canvas 文档通过 Redis 更新 version 字段", async () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("meta").set("version", 10);
    const doc = {
      connections: [],
      getConnectionsCount: () => 0,
      getMap: (name: string) => ydoc.getMap(name),
      transact: (fn: () => void) => ydoc.transact(fn),
    };
    const docs = new Map([["canvas:test-002", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    const handlers = new Map<string, (data: any) => void>();
    redisExt.onAdminCommand.mockImplementation((cmd: string, handler: any) => {
      handlers.set(cmd, handler);
    });

    const handler = new ForceCloseHandler();
    await handler.onConfigure({ instance } as any);

    handlers.get(AdminCommand.INVALIDATE_VERSION)!({
      command: AdminCommand.INVALIDATE_VERSION,
      docId: "canvas:test-002",
      newVersion: 11,
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    });

    expect(ydoc.getMap("meta").get("version")).toBe(11);
  });

  it("文档不在内存时 invalidate_version handler 静默跳过", async () => {
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(new Map(), redisExt);

    const handlers = new Map<string, (data: any) => void>();
    redisExt.onAdminCommand.mockImplementation((cmd: string, handler: any) => {
      handlers.set(cmd, handler);
    });

    const handler = new ForceCloseHandler();
    await handler.onConfigure({ instance } as any);

    // 不应抛异常
    handlers.get(AdminCommand.INVALIDATE_VERSION)!({
      command: AdminCommand.INVALIDATE_VERSION,
      docId: "table:not-loaded",
      newVersion: 99,
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    });
  });
});
