/**
 * CLB-001 回归测试 — document_restored 专用 CloseCode 4005
 *
 * 修复前：DOCUMENT_RESTORED reason 在 admin.ts 被映射到 CloseCode.PERMISSION_CHANGED (4004)，
 *   stateless 消息丢失时客户端 onDisconnect 收到 code=4004，codeToReason(4004) 返回
 *   "permission_changed"，客户端进入永久 FORCE_CLOSED 终态，用户需手动刷新。
 *
 * 修复后：
 *   1. CloseCode 枚举新增 DOCUMENT_RESTORED = 4005
 *   2. admin.ts 将 DOCUMENT_RESTORED reason 映射到 CloseCode.DOCUMENT_RESTORED (4005)
 *   3. forceCloseDocument 发送的 stateless 消息中 code 字段为 4005
 *   4. 客户端 onDisconnect 收到 code=4005 时触发 forceReconnect 而非进入永久终态
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../env.js", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    SERVER_NAME: "test-server",
  },
}));

import {
  forceCloseDocument,
  ForceCloseReason,
  CloseCode,
} from "../extensions/force-close.js";
import { RedisExtension, AdminCommand } from "../extensions/redis.js";

function createMockConnection() {
  return {
    connection: {
      sendStateless: vi.fn(),
      close: vi.fn(),
    },
  };
}

function createMockDocument(connectionCount: number) {
  const connections = Array.from({ length: connectionCount }, createMockConnection);
  return {
    connections,
    getConnectionsCount: () => connectionCount,
  };
}

function createMockRedisExtension() {
  return Object.assign(Object.create(RedisExtension.prototype), {
    publishAdminCommand: vi.fn().mockResolvedValue(1),
  });
}

function createMockInstance(docs: Map<string, any> = new Map(), redisExt?: any) {
  const extensions: any[] = redisExt ? [redisExt] : [];
  return {
    documents: docs,
    configuration: { extensions },
    unloadDocument: vi.fn().mockResolvedValue(undefined),
  };
}

/* ================================================================== */
/* TC-CLB001-SRV-A: CloseCode 枚举值验证                              */
/* ================================================================== */

describe("TC-CLB001-SRV-A: CloseCode 枚举值验证", () => {
  it("CloseCode.DOCUMENT_RESTORED 等于 4005", () => {
    expect(CloseCode.DOCUMENT_RESTORED).toBe(4005);
  });

  it("CloseCode.PERMISSION_CHANGED 仍为 4004（回归保护）", () => {
    expect(CloseCode.PERMISSION_CHANGED).toBe(4004);
  });

  it("DOCUMENT_RESTORED 与 PERMISSION_CHANGED 不相等", () => {
    expect(CloseCode.DOCUMENT_RESTORED).not.toBe(CloseCode.PERMISSION_CHANGED);
  });
});

/* ================================================================== */
/* TC-CLB001-SRV-B: forceCloseDocument 发送正确的 code=4005           */
/* ================================================================== */

describe("TC-CLB001-SRV-B: forceCloseDocument 发送 code=4005 给客户端", () => {
  it("DOCUMENT_RESTORED reason 时 stateless 消息中 code 为 4005", async () => {
    const doc = createMockDocument(2);
    const docs = new Map([["slide:test-123", doc]]);
    const instance = createMockInstance(docs);

    await forceCloseDocument(
      instance as any,
      "slide:test-123",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    // 验证发送给客户端的 stateless 消息中 code=4005
    for (const conn of doc.connections) {
      expect(conn.connection.sendStateless).toHaveBeenCalledTimes(1);
      const sentPayload = JSON.parse(conn.connection.sendStateless.mock.calls[0][0]);
      expect(sentPayload.type).toBe("force_close");
      expect(sentPayload.reason).toBe(ForceCloseReason.DOCUMENT_RESTORED);
      expect(sentPayload.code).toBe(4005);
    }
  });

  it("DOCUMENT_RESTORED reason 时 WebSocket close 使用 code=4005", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["canvas:test-456", doc]]);
    const instance = createMockInstance(docs);

    await forceCloseDocument(
      instance as any,
      "canvas:test-456",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    const conn = doc.connections[0].connection;
    expect(conn.close).toHaveBeenCalledWith({
      code: CloseCode.DOCUMENT_RESTORED,
      reason: ForceCloseReason.DOCUMENT_RESTORED,
    });
  });

  it("DOCUMENT_RESTORED reason 时 Redis 广播携带 code=4005", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["doc:test-789", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    await forceCloseDocument(
      instance as any,
      "doc:test-789",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.DOCUMENT_RESTORED,
    );

    expect(redisExt.publishAdminCommand).toHaveBeenCalledTimes(1);
    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.command).toBe(AdminCommand.FORCE_CLOSE);
    expect(callArg.reason).toBe(ForceCloseReason.DOCUMENT_RESTORED);
    expect(callArg.code).toBe(CloseCode.DOCUMENT_RESTORED);
  });
});

/* ================================================================== */
/* TC-CLB001-SRV-C: PERMISSION_CHANGED 仍使用 4004（回归保护）        */
/* ================================================================== */

describe("TC-CLB001-SRV-C: PERMISSION_CHANGED 仍使用 code=4004（回归保护）", () => {
  it("PERMISSION_CHANGED reason 时 stateless 消息 code 为 4004", async () => {
    const doc = createMockDocument(1);
    const docs = new Map([["doc:perm-test", doc]]);
    const instance = createMockInstance(docs);

    await forceCloseDocument(
      instance as any,
      "doc:perm-test",
      ForceCloseReason.PERMISSION_CHANGED,
      CloseCode.PERMISSION_CHANGED,
    );

    const conn = doc.connections[0].connection;
    const sentPayload = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(sentPayload.code).toBe(4004);
    expect(sentPayload.reason).toBe(ForceCloseReason.PERMISSION_CHANGED);
  });
});
