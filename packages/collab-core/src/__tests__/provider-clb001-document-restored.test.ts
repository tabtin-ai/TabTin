/**
 * CLB-001 回归测试：document_restored 专用 CloseCode 4005
 *
 * 验证：
 * TC-CLB001-A: stateless 消息正常到达时，document_restored 触发 forceReconnect（已有逻辑）
 * TC-CLB001-B: stateless 消息丢失时，onDisconnect code=4005 fallback 触发 forceReconnect
 * TC-CLB001-C: code=4005 不进入永久 FORCE_CLOSED 终态
 * TC-CLB001-D: code=4004（PERMISSION_CHANGED）仍进入永久 FORCE_CLOSED 终态（回归保护）
 * TC-CLB001-E: onClose code=4005 被跳过，不重复触发状态变更
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
      });
      mockHPInstance = this;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

vi.mock("y-indexeddb", () => {
  class MockIndexeddbPersistence {
    whenSynced = Promise.resolve();
    destroy = vi.fn();
    on = vi.fn();
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence };
});

/* ------------------------------------------------------------------ */
/* 被测模块                                                            */
/* ------------------------------------------------------------------ */

import { CollabProvider } from "../provider.js";
import { CollabStatus, CloseCode, type CollabProviderOptions } from "../types.js";

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

function connectToSynced(cp: CollabProvider): void {
  cp.connect();
  capturedHPOpts.onConnect();
  capturedHPOpts.onSynced();
}

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
/* TC-CLB001-A: stateless 消息正常到达时触发 forceReconnect            */
/* ================================================================== */

describe("TC-CLB001-A: stateless document_restored 触发 forceReconnect", () => {
  it("收到 reason=document_restored 的 stateless 消息后状态变为 CONNECTING（forceReconnect）", async () => {
    const cp = makeProvider();
    connectToSynced(cp);
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);

    const fcMsg = {
      type: "force_close",
      reason: "document_restored",
      code: CloseCode.DOCUMENT_RESTORED,
      message: "文档已恢复到指定版本，请等待重新同步",
      timestamp: new Date().toISOString(),
    };

    capturedHPOpts.onStateless({ payload: JSON.stringify(fcMsg) });

    // forceReconnect 是 async，等待微任务完成
    await Promise.resolve();
    await Promise.resolve();

    // 应处于 CONNECTING（forceReconnect 重建连接），而非 FORCE_CLOSED
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);
    expect(cp.getState().forceCloseMessage).toBeNull();
  });

  it("stateless document_restored 后可以正常重新同步到 SYNCED", async () => {
    const cp = makeProvider();
    connectToSynced(cp);

    const fcMsg = {
      type: "force_close",
      reason: "document_restored",
      code: CloseCode.DOCUMENT_RESTORED,
      message: "文档已恢复到指定版本，请等待重新同步",
      timestamp: new Date().toISOString(),
    };

    capturedHPOpts.onStateless({ payload: JSON.stringify(fcMsg) });
    await Promise.resolve();
    await Promise.resolve();

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
  });
});

/* ================================================================== */
/* TC-CLB001-B: stateless 消息丢失时 onDisconnect code=4005 fallback  */
/* ================================================================== */

describe("TC-CLB001-B: onDisconnect code=4005 fallback 触发 forceReconnect", () => {
  it("onDisconnect code=4005 时不进入 FORCE_CLOSED，而是触发 forceReconnect", async () => {
    const cp = makeProvider();
    connectToSynced(cp);
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);

    // 模拟 stateless 消息丢失，直接收到 code=4005 的断连
    capturedHPOpts.onDisconnect({ event: { code: CloseCode.DOCUMENT_RESTORED } });

    // 等待 forceReconnect 的异步操作
    await Promise.resolve();
    await Promise.resolve();

    // 应处于 CONNECTING，而非永久 FORCE_CLOSED
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);
  });

  it("onDisconnect code=4005 fallback 后可以正常重新同步", async () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.DOCUMENT_RESTORED } });
    await Promise.resolve();
    await Promise.resolve();

    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
  });

  it("onDisconnect code=4005 时 forceCloseMessage 不被设置", async () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.DOCUMENT_RESTORED } });
    await Promise.resolve();
    await Promise.resolve();

    expect(cp.getState().forceCloseMessage).toBeNull();
  });
});

/* ================================================================== */
/* TC-CLB001-C: code=4005 不进入永久 FORCE_CLOSED 终态                */
/* ================================================================== */

describe("TC-CLB001-C: code=4005 不进入永久 FORCE_CLOSED 终态", () => {
  it("code=4005 后 reconnect() 不被 FORCE_CLOSED 守卫拦截", async () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.DOCUMENT_RESTORED } });
    await Promise.resolve();
    await Promise.resolve();

    // 状态不是 FORCE_CLOSED，reconnect 守卫不应拦截
    expect(cp.getState().status).not.toBe(CollabStatus.FORCE_CLOSED);
  });
});

/* ================================================================== */
/* TC-CLB001-D: code=4004 仍进入永久 FORCE_CLOSED（回归保护）          */
/* ================================================================== */

describe("TC-CLB001-D: code=4004 仍进入永久 FORCE_CLOSED（回归保护）", () => {
  it("onDisconnect code=4004 进入 FORCE_CLOSED 终态", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.PERMISSION_CHANGED } });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getState().forceCloseMessage?.reason).toBe("permission_changed");
  });

  it("stateless reason=permission_changed 进入 FORCE_CLOSED 终态", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    const fcMsg = {
      type: "force_close",
      reason: "permission_changed",
      code: CloseCode.PERMISSION_CHANGED,
      message: "文档权限已变更，请刷新页面",
      timestamp: new Date().toISOString(),
    };

    capturedHPOpts.onStateless({ payload: JSON.stringify(fcMsg) });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getState().forceCloseMessage).toEqual(fcMsg);
  });
});

/* ================================================================== */
/* TC-CLB001-E: onClose code=4005 被跳过                              */
/* ================================================================== */

describe("TC-CLB001-E: onClose code=4005 被跳过，不重复触发状态变更", () => {
  it("onClose code=4005 不设置 FORCE_CLOSED 状态", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    // onClose 不应改变状态（由 onDisconnect 处理）
    capturedHPOpts.onClose({ event: { code: CloseCode.DOCUMENT_RESTORED } });

    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
    expect(cp.getState().forceCloseMessage).toBeNull();
  });

  it("onClose code=4004 仍然设置 FORCE_CLOSED 状态（回归保护）", () => {
    const cp = makeProvider();
    connectToSynced(cp);

    capturedHPOpts.onClose({ event: { code: CloseCode.PERMISSION_CHANGED } });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });
});

/* ================================================================== */
/* TC-CLB001-F: CloseCode.DOCUMENT_RESTORED = 4005 枚举值验证          */
/* ================================================================== */

describe("TC-CLB001-F: CloseCode 枚举值验证", () => {
  it("CloseCode.DOCUMENT_RESTORED 等于 4005", () => {
    expect(CloseCode.DOCUMENT_RESTORED).toBe(4005);
  });

  it("CloseCode.PERMISSION_CHANGED 仍为 4004（回归保护）", () => {
    expect(CloseCode.PERMISSION_CHANGED).toBe(4004);
  });
});
