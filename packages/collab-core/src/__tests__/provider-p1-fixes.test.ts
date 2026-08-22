/**
 * CC-005 / CC-007 / CC-009 / CC-010 回归测试
 *
 * 通过 mock HocuspocusProvider 和 y-indexeddb 来捕获回调并模拟事件。
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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

function forceCloseEvent(code: number): { event: Partial<CloseEvent> } {
  return { event: { code } as Partial<CloseEvent> };
}

/* ------------------------------------------------------------------ */
/* CC-005: FORCE_CLOSED 后 provider.destroy() + 置 null               */
/* ------------------------------------------------------------------ */

describe("CC-005: FORCE_CLOSED 后 destroy provider 并置 null", () => {
  it("force-close 断连后 HocuspocusProvider 被 destroy 且 getProvider() 返回 null", () => {
    const cp = makeProvider();
    cp.connect();

    capturedHPOpts.onDisconnect(forceCloseEvent(CloseCode.DOCUMENT_NOT_FOUND));

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getProvider()).toBeNull();
    expect(mockHPInstance.destroy).toHaveBeenCalled();
  });

  it("force-close 后自动重连回调不改变状态", () => {
    const cp = makeProvider();
    cp.connect();

    capturedHPOpts.onDisconnect(forceCloseEvent(CloseCode.AUTH_FAILED));
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    // 模拟 HocuspocusProvider 内部定时器触发的重连回调
    capturedHPOpts.onConnect();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });
});

/* ------------------------------------------------------------------ */
/* CC-010: onConnect/onSynced FORCE_CLOSED 守卫                       */
/* ------------------------------------------------------------------ */

describe("CC-010: onConnect/onSynced 防止 FORCE_CLOSED 后状态回退", () => {
  it("stateless force_close 后 onConnect 不将状态改回 SYNCING", () => {
    const cp = makeProvider();
    cp.connect();

    // 通过 stateless 消息触发 FORCE_CLOSED
    capturedHPOpts.onStateless({
      payload: JSON.stringify({
        type: "force_close",
        reason: "document_archived",
        code: CloseCode.DOCUMENT_ARCHIVED,
        message: "文档已归档",
        timestamp: new Date().toISOString(),
      }),
    });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    capturedHPOpts.onConnect();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });

  it("onClose force-close 后 onSynced 不将状态改回 SYNCED", () => {
    const cp = makeProvider();
    cp.connect();

    capturedHPOpts.onClose(forceCloseEvent(CloseCode.PERMISSION_CHANGED));
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);

    capturedHPOpts.onSynced();
    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });
});

describe("permission_downgrade state", () => {
  it("marks provider readOnly from initial Hocuspocus auth scope", () => {
    const cp = makeProvider();
    cp.connect();
    mockHPInstance.authorizedScope = "readonly";

    capturedHPOpts.onAuthenticated();

    expect(cp.getState().readOnly).toBe(true);
  });

  it("marks provider readOnly without force-closing the connection", () => {
    const cp = makeProvider();
    cp.connect();
    capturedHPOpts.onConnect();
    capturedHPOpts.onSynced();

    capturedHPOpts.onStateless({
      payload: JSON.stringify({
        type: "permission_downgrade",
        readOnly: true,
        timestamp: new Date().toISOString(),
      }),
    });

    expect(cp.getState().status).toBe(CollabStatus.SYNCED);
    expect(cp.getState().readOnly).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* CC-007: reconnect() 替换 ydoc 时重置缓存标志                       */
/* ------------------------------------------------------------------ */

describe("CC-007: reconnect() 与 Y.Doc 生命周期", () => {
  it("provider 为空但 Y.Doc 仍在时复用文档，不重置 IndexedDB 缓存标志（ 认证恢复）", () => {
    const cp2 = makeProvider({ enableIndexedDB: true });
    cp2.connect();

    if (idbSyncedCb) idbSyncedCb();
    expect(cp2.getState().isCacheReady).toBe(true);

    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    expect(cp2.getState().status).toBe(CollabStatus.DISCONNECTED);

    const ydocBefore = cp2.getYDoc();
    // 模拟认证恢复：只拆掉 Hocuspocus，保留 Y.Doc
    (cp2 as any).provider = null;

    cp2.reconnect();
    expect(cp2.getYDoc()).toBe(ydocBefore);
    expect(cp2.getState().isCacheReady).toBe(true);
  });

  it("Y.Doc 已销毁时 reconnect 新建文档并重置缓存标志", () => {
    const cp2 = makeProvider({ enableIndexedDB: true });
    cp2.connect();
    if (idbSyncedCb) idbSyncedCb();

    capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    (cp2 as any).provider = null;
    cp2.getYDoc().destroy();

    cp2.reconnect();
    expect(cp2.getState().isCacheReady).toBe(false);
    expect(cp2.getState().hasCachedContent).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* CC-009: disconnect() 调用 flushToIndexedDB                          */
/* ------------------------------------------------------------------ */

describe("CC-009: disconnect() 调用 flushToIndexedDB", () => {
  it("disconnect 时触发 flushToIndexedDB", () => {
    const cp = makeProvider({ enableIndexedDB: true });
    cp.connect();

    const flushSpy = vi.spyOn(cp, "flushToIndexedDB").mockResolvedValue(undefined);

    cp.disconnect();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    flushSpy.mockRestore();
  });

  it("flushToIndexedDB 失败不阻塞 disconnect", () => {
    const cp = makeProvider({ enableIndexedDB: true });
    cp.connect();

    const flushSpy = vi.spyOn(cp, "flushToIndexedDB").mockRejectedValue(new Error("IDB error"));

    expect(() => cp.disconnect()).not.toThrow();
    expect(flushSpy).toHaveBeenCalled();
    flushSpy.mockRestore();
  });
});
