/**
 * P0-3 回归测试 — STATELESS_BROADCAST handler 注册
 *
 * 验证每个 RedisExtension 实例在 onConfigure 后都自动注册
 * STATELESS_BROADCAST handler，并且仅广播到自己绑定的 instance。
 *
 * PERF-023 适配：admin sub/pub 现在是共享的（而非 per-instance），
 * 消息通过 shared admin bus 分发到所有注册的 RedisExtension 实例。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../env.js", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    SERVER_NAME: "test-server",
  },
}));

/** 所有创建的 MockRedis 实例，用于找到 shared admin sub */
const mockRedisInstances: any[] = [];

vi.mock("ioredis", () => {
  class MockRedis {
    private _handlers = new Map<string, Function>();
    status = "ready";
    constructor() {
      mockRedisInstances.push(this);
    }
    on(event: string, handler: Function) {
      this._handlers.set(event, handler);
      return this;
    }
    subscribe() { return Promise.resolve(); }
    publish() { return Promise.resolve(1); }
    unsubscribe() { return Promise.resolve(); }
    disconnect() {}
    connect() { return Promise.resolve(); }
    emit(event: string, ...args: any[]) {
      const h = this._handlers.get(event);
      if (h) h(...args);
    }
    _hasHandler(event: string): boolean {
      return this._handlers.has(event);
    }
  }
  return { Redis: MockRedis };
});

vi.mock("@hocuspocus/extension-redis", () => {
  class MockHocuspocusRedis {
    constructor(_opts: any) {}
    async onConfigure(_payload: any) {}
  }
  return { Redis: MockHocuspocusRedis };
});

import { RedisExtension, AdminCommand } from "../extensions/redis.js";
import type { StatelessBroadcastCommandData } from "../extensions/redis.js";

function createMockInstance(documents: Map<string, any> = new Map()) {
  return {
    documents,
    configuration: { extensions: [] },
  };
}

/**
 * 获取 shared admin bus 的 sub client（拥有 "message" handler 的 MockRedis 实例）
 */
function getSharedAdminSub(): any {
  return mockRedisInstances.find((r) => r._hasHandler("message")) || null;
}

const activeExtensions: RedisExtension[] = [];

async function setupRedis(documents: Map<string, any> = new Map()) {
  const redis = new RedisExtension();
  activeExtensions.push(redis);
  const instance = createMockInstance(documents);
  await redis.onConfigure({ instance } as any);

  return { redis, instance };
}

async function simulateAdminMessage(data: Record<string, unknown>) {
  const adminSub = getSharedAdminSub();
  if (!adminSub) throw new Error("Shared admin sub not initialized");
  adminSub.emit("message", "collab-live:admin", JSON.stringify(data));
  await new Promise((r) => setTimeout(r, 10));
}

afterEach(async () => {
  for (const ext of activeExtensions) {
    await ext.onDestroy();
  }
  activeExtensions.length = 0;
  mockRedisInstances.length = 0;
});

describe("RedisExtension STATELESS_BROADCAST (P0-3)", () => {
  it("saves instance reference during onConfigure", async () => {
    const { redis, instance } = await setupRedis();
    expect(redis.getInstance()).toBe(instance);
  });

  it("broadcasts to document in own instance on STATELESS_BROADCAST", async () => {
    const broadcastStateless = vi.fn();
    const getConnectionsCount = vi.fn().mockReturnValue(3);
    const mockDoc = { broadcastStateless, getConnectionsCount };
    const documents = new Map([["table:tbl-1", mockDoc]]);

    await setupRedis(documents);

    const broadcastData: StatelessBroadcastCommandData = {
      command: AdminCommand.STATELESS_BROADCAST,
      docId: "table:tbl-1",
      message: JSON.stringify({ type: "test_event", payload: {} }),
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    };

    await simulateAdminMessage(broadcastData);

    expect(broadcastStateless).toHaveBeenCalledWith(broadcastData.message);
  });

  it("ignores broadcast for documents not in own instance", async () => {
    await setupRedis(new Map());

    const broadcastData: StatelessBroadcastCommandData = {
      command: AdminCommand.STATELESS_BROADCAST,
      docId: "docs:doc-999",
      message: JSON.stringify({ type: "test_event" }),
      originServer: "other-server",
      timestamp: new Date().toISOString(),
    };

    await simulateAdminMessage(broadcastData);
    // no error — message silently ignored for non-local docs
  });

  it("ignores own messages (originServer matches)", async () => {
    const broadcastStateless = vi.fn();
    const mockDoc = {
      broadcastStateless,
      getConnectionsCount: () => 1,
    };
    const documents = new Map([["docs:doc-1", mockDoc]]);

    await setupRedis(documents);

    await simulateAdminMessage({
      command: AdminCommand.STATELESS_BROADCAST,
      docId: "docs:doc-1",
      message: JSON.stringify({ type: "test" }),
      originServer: "test-server",
      timestamp: new Date().toISOString(),
    });

    expect(broadcastStateless).not.toHaveBeenCalled();
  });

  it("each RedisExtension independently handles its own instance", async () => {
    const broadcastStateless1 = vi.fn();
    const broadcastStateless2 = vi.fn();

    const doc1 = {
      broadcastStateless: broadcastStateless1,
      getConnectionsCount: () => 2,
    };
    const doc2 = {
      broadcastStateless: broadcastStateless2,
      getConnectionsCount: () => 1,
    };

    await setupRedis(new Map([["docs:doc-1", doc1]]));
    await setupRedis(new Map([["table:tbl-1", doc2]]));

    const broadcastMsg = {
      command: AdminCommand.STATELESS_BROADCAST,
      docId: "table:tbl-1",
      message: JSON.stringify({ type: "cell_update" }),
      originServer: "remote-server",
      timestamp: new Date().toISOString(),
    };

    // 共享 admin bus：一次 emit 到达所有注册的 RedisExtension 实例
    await simulateAdminMessage(broadcastMsg);

    expect(broadcastStateless1).not.toHaveBeenCalled();
    expect(broadcastStateless2).toHaveBeenCalledTimes(1);
  });
});
