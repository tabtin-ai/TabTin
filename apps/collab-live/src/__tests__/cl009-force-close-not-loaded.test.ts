/**
 * CL-009 回归测试 — forceCloseDocument 文档不在内存时仍广播 Redis
 *
 * 修复前：文档不在本节点 Hocuspocus 内存时，forceCloseDocument 在
 *   `if (!document) return` 处静默退出，不执行 Redis 广播，且调用方
 *   (admin.ts) 返回 `{ status: "ok" }` 让 Django 误认为关闭成功。
 *
 * 修复后：
 *   1. 文档不在内存时仍通过 Redis 广播到其他节点
 *   2. 返回 `{ loaded: false, connections_closed: 0 }` 让调用方区分
 *   3. 文档在内存时返回 `{ loaded: true, connections_closed: N }`
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
  type ForceCloseResult,
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

describe("CL-009: forceCloseDocument — document not in memory", () => {
  it("returns loaded=false when document is not in local memory", async () => {
    const instance = createMockInstance();

    const result: ForceCloseResult = await forceCloseDocument(
      instance as any,
      "slide:abc-123",
      ForceCloseReason.DOCUMENT_RESTORED,
    );

    expect(result.loaded).toBe(false);
    expect(result.connections_closed).toBe(0);
  });

  it("still broadcasts via Redis when document not in local memory", async () => {
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(new Map(), redisExt);

    await forceCloseDocument(
      instance as any,
      "slide:abc-123",
      ForceCloseReason.DOCUMENT_RESTORED,
      CloseCode.PERMISSION_CHANGED,
    );

    expect(redisExt.publishAdminCommand).toHaveBeenCalledTimes(1);
    const callArg = redisExt.publishAdminCommand.mock.calls[0][0];
    expect(callArg.command).toBe(AdminCommand.FORCE_CLOSE);
    expect(callArg.docId).toBe("slide:abc-123");
    expect(callArg.reason).toBe(ForceCloseReason.DOCUMENT_RESTORED);
    expect(callArg.code).toBe(CloseCode.PERMISSION_CHANGED);
  });

  it("does not call Redis if no RedisExtension available and doc not loaded", async () => {
    const instance = createMockInstance();

    const result = await forceCloseDocument(
      instance as any,
      "doc:no-redis",
      ForceCloseReason.ADMIN_ACTION,
    );

    expect(result.loaded).toBe(false);
    expect(result.connections_closed).toBe(0);
  });

  it("returns loaded=true and closes connections when document IS in memory", async () => {
    const doc = createMockDocument(3);
    const docs = new Map([["table:xyz", doc]]);
    const redisExt = createMockRedisExtension();
    const instance = createMockInstance(docs, redisExt);

    const result: ForceCloseResult = await forceCloseDocument(
      instance as any,
      "table:xyz",
      ForceCloseReason.DOCUMENT_RESTORED,
    );

    expect(result.loaded).toBe(true);
    expect(result.connections_closed).toBe(3);

    for (const conn of doc.connections) {
      expect(conn.connection.sendStateless).toHaveBeenCalled();
      expect(conn.connection.close).toHaveBeenCalled();
    }

    expect(redisExt.publishAdminCommand).toHaveBeenCalled();
    expect(instance.unloadDocument).toHaveBeenCalledWith(doc);
  });
});
