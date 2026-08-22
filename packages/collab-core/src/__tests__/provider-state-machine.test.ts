/**
 * CollabProvider 状态机核心路径测试
 *
 * 覆盖 report-S3-04.md 中 5 个关键测试套件：
 * TC-A: 基本连接生命周期（状态序列 + reconnect 守卫）
 * TC-B: forceReconnect（销毁重建 + offlineSince 重置）
 * TC-C: longOfflineDetected 边界触发（精确 30min + 多次断连）
 * TC-D: forceClose 处理（stateless 触发 + reconnect 拦截）
 * TC-E: IndexedDB 清理（forceReconnect 时 IDB 销毁 + 物理删除）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

let capturedHPOpts: Record<string, any> = {};
let mockHPInstance: Record<string, any> = {};

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    constructor(opts: any) {
      capturedHPOpts = opts;
      Object.assign(this, {
        disconnect: vi.fn(),
        destroy: vi.fn(),
        connect: vi.fn(),
        setAwarenessField: vi.fn(),
        sendStateless: vi.fn(),
        _opts: opts,
      });
      mockHPInstance = this;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

let mockIDBInstance: Record<string, any> = {};
let idbSyncedCb: (() => void) | null = null;

vi.mock("y-indexeddb", () => {
  class MockIndexeddbPersistence {
    whenSynced = Promise.resolve();
    destroy = vi.fn();
    on = vi.fn((event: string, cb: () => void) => {
      if (event === "synced") idbSyncedCb = cb;
    });
    constructor() {
      idbSyncedCb = null;
      mockIDBInstance = this;
    }
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence };
});

/* ------------------------------------------------------------------ */
/* 被测模块                                                            */
/* ------------------------------------------------------------------ */

import { CollabProvider } from "../provider.js";
import {
  CollabConnectionStatus,
  CollabStatus,
  CloseCode,
  type CollabProviderOptions,
} from "../types.js";

const BASE_OPTIONS: CollabProviderOptions = {
  serverUrl: "ws://localhost:4100",
  documentName: "test-doc",
  token: "test-token",
  user: { id: "u1", name: "Tester", color: "#FF5733" },
  enableIndexedDB: false,
};

function makeProvider(overrides: Partial<CollabProviderOptions> = {}): CollabProvider {
  return new CollabProvider({ ...BASE_OPTIONS, ...overrides });
}

/** 快速将 provider 推进到 SYNCED 状态 */
function connectToSynced(cp: CollabProvider): void {
  cp.connect();
  capturedHPOpts.onConnect();
  capturedHPOpts.onSynced();
}

/* ------------------------------------------------------------------ */
/* 全局 indexedDB mock                                                 */
/* jsdom 不提供 indexedDB，需手动 stub 以支持 forceReconnect 测试       */
/* ------------------------------------------------------------------ */

const mockDeleteDatabase = vi.fn(() => {
  const req: any = {};
  queueMicrotask(() => req.onsuccess?.());
  return req;
});

beforeEach(() => {
  mockDeleteDatabase.mockClear();
  vi.stubGlobal("indexedDB", { deleteDatabase: mockDeleteDatabase });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ================================================================== */
/* TC-A: 基本连接生命周期                                              */
/* ================================================================== */

describe("TC-A: 基本连接生命周期", () => {
  it("connect → onConnect → onSynced 经历 CONNECTING → SYNCING → SYNCED", () => {
    const cp = makeProvider();
    const statuses: string[] = [];
    cp.subscribe((s) => statuses.push(s.status));

    cp.connect();
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);
    expect(cp.getState().connectionStatus).toBe(CollabConnectionStatus.CONNECTING);
    expect(cp.getState().ydoc).not.toBeNull();

    capturedHPOpts.onConnect();
    expect(cp.getState().status).toBe(CollabStatus.SYNCING);
    expect(cp.getState().connectionStatus).toBe(CollabConnectionStatus.CONNECTED);

    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
    expect(cp.getState().longOfflineDetected).toBe(false);

    expect(statuses).toEqual([
      CollabStatus.CONNECTING,
      CollabStatus.SYNCING,
      CollabStatus.SYNCED,
    ]);
  });

  it("断连后重连恢复到 SYNCED", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    expect(cp.getState().status).toBe(CollabStatus.DISCONNECTED);
    expect(cp.getState().connectionStatus).toBe(CollabConnectionStatus.FAILED);

    // provider 被销毁后 reconnect 走完整 connect() 路径
    (cp as any).provider = null;
    cp.reconnect();
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
  });

  it("treats capacity close code 4429 as retryable instead of permission denied", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({
      event: { code: 4429, reason: "connection-limit-exceeded" },
    });

    expect(cp.getState().status).toBe(CollabStatus.DISCONNECTED);
    expect(cp.getState().connectionStatus).toBe(CollabConnectionStatus.FAILED);
    expect(cp.getState().forceCloseMessage).toBeNull();
  });

  it("disconnect() 后状态回归 INITIAL 并清理 provider", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    cp.disconnect();
    expect(cp.getState().status).toBe(CollabStatus.INITIAL);
    expect(cp.getState().connectionStatus).toBe(CollabConnectionStatus.IDLE);
    expect(cp.getProvider()).toBeNull();
    expect(cp.getState().ydoc).toBeNull();
  });

  it("reconnect() 在 CONNECTING/SYNCING/SYNCED 状态下被守卫拦截", () => {
    const cp = makeProvider();
    cp.connect();

    // CONNECTING
    cp.reconnect();
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);

    // SYNCING
    capturedHPOpts.onConnect();
    cp.reconnect();
    expect(cp.getState().status).toBe(CollabStatus.SYNCING);

    // SYNCED
    capturedHPOpts.onSynced();
    cp.reconnect();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
  });
});

/* ================================================================== */
/* TC-B: forceReconnect 行为                                           */
/* ================================================================== */

describe("TC-B: forceReconnect 行为", () => {
  it("SYNCED 状态下销毁旧连接并创建新 Y.Doc", async () => {
    const cp = makeProvider();
    connectToSynced(cp);

    const oldYdoc = cp.getYDoc();
    const oldDisconnect = mockHPInstance.disconnect;
    const oldDestroy = mockHPInstance.destroy;

    await cp.forceReconnect();

    expect(oldDisconnect).toHaveBeenCalled();
    expect(oldDestroy).toHaveBeenCalled();
    expect(cp.getYDoc()).not.toBe(oldYdoc);
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
  });

  it("重置 offlineSince 使长离线后不触发 longOfflineDetected", async () => {
    vi.useFakeTimers();
    try {
      const cp = makeProvider();
      connectToSynced(cp);

      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
      expect((cp as any).offlineSince).toBeGreaterThan(0);

      vi.advanceTimersByTime(31 * 60 * 1000);

      await cp.forceReconnect();
      expect((cp as any).offlineSince).toBe(0);

      capturedHPOpts.onConnect();
      capturedHPOpts.onSynced();
      expect(cp.getState().longOfflineDetected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ================================================================== */
/* TC-C: longOfflineDetected 边界触发                                  */
/* ================================================================== */

describe("TC-C: longOfflineDetected 边界触发", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("恰好 30 分钟不触发（条件为严格大于阈值）", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    vi.advanceTimersByTime(30 * 60 * 1000);

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().longOfflineDetected).toBe(false);
  });

  it("30 分钟 + 1ms 触发 longOfflineDetected", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().longOfflineDetected).toBe(true);
  });

  it("多次 onDisconnect 只记录首次离线时间", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    vi.setSystemTime(1000);
    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    expect((cp as any).offlineSince).toBe(1000);

    vi.setSystemTime(5000);
    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    expect((cp as any).offlineSince).toBe(1000);

    // 从首次断连(t=1000)算起超过 30 分钟
    vi.setSystemTime(1000 + 30 * 60 * 1000 + 1);
    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().longOfflineDetected).toBe(true);
  });
});

/* ================================================================== */
/* TC-D: forceClose 处理                                               */
/* ================================================================== */

describe("TC-D: forceClose 处理", () => {
  it("stateless force_close 消息设为 FORCE_CLOSED 并携带完整消息体", () => {
    const cp = makeProvider();
    cp.connect();

    const fcMsg = {
      type: "force_close",
      reason: "document_archived",
      code: CloseCode.DOCUMENT_ARCHIVED,
      message: "文档已归档",
      timestamp: "2026-03-18T00:00:00.000Z",
    };

    capturedHPOpts.onStateless({ payload: JSON.stringify(fcMsg) });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getState().forceCloseMessage).toEqual(fcMsg);
    expect(cp.getState().lastError).toBe("文档已归档");
  });

  it("FORCE_CLOSED 后 reconnect() 被拦截", () => {
    const cp = makeProvider();
    cp.connect();

    capturedHPOpts.onDisconnect({
      event: { code: CloseCode.DOCUMENT_NOT_FOUND },
    });
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    cp.reconnect();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });

  it("FORCE_CLOSED 后 onConnect/onSynced 不改变状态", () => {
    const cp = makeProvider();
    cp.connect();

    capturedHPOpts.onStateless({
      payload: JSON.stringify({
        type: "force_close",
        reason: "auth_failed",
        code: CloseCode.AUTH_FAILED,
        message: "认证失败",
        timestamp: "2026-03-18T00:00:00.000Z",
      }),
    });

    capturedHPOpts.onConnect();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });
});

/* ================================================================== */
/* TC-E: forceReconnect 时 IndexedDB 清理                              */
/* ================================================================== */

describe("TC-E: forceReconnect 时 IndexedDB 清理", () => {
  it("销毁 IDB persistence 实例并物理删除数据库", async () => {
    const cp = makeProvider({ enableIndexedDB: true });
    connectToSynced(cp);

    const oldIdbDestroy = mockIDBInstance.destroy;

    await cp.forceReconnect();

    expect(oldIdbDestroy).toHaveBeenCalled();
    expect(mockDeleteDatabase).toHaveBeenCalledWith("collab:test-doc");
  });
});
