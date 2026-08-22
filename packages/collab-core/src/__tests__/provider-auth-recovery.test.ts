/**
 *  / : Hocuspocus 4401 / 协议认证失败 → 保留 Y.Doc 重建 Provider
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedHPOpts: Record<string, any> = {};
let mockHPInstance: Record<string, any> = {};
let hpConstructCount = 0;

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    constructor(opts: any) {
      hpConstructCount += 1;
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

import { CollabProvider } from "../provider.js";
import { CollabStatus, CloseCode, type CollabProviderOptions } from "../types.js";

const BASE_OPTIONS: CollabProviderOptions = {
  serverUrl: "ws://localhost:4100",
  documentName: "test-doc",
  token: "test-token",
  user: { id: "u1", name: "Tester", color: "#FF5733" },
  enableIndexedDB: false,
};

describe("CollabProvider auth recovery ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hpConstructCount = 0;
    capturedHPOpts = {};
    mockHPInstance = {};
  });

  it("4401 keeps Y.Doc, destroys Hocuspocus, marks auth_failed (not FORCE_CLOSED)", async () => {
    const onTokenRefreshRequired = vi.fn();
    const cp = new CollabProvider({ ...BASE_OPTIONS, onTokenRefreshRequired });
    cp.connect();
    const ydocBefore = cp.getYDoc();
    expect(hpConstructCount).toBe(1);

    capturedHPOpts.onDisconnect({ event: { code: 4401 } });

    expect(cp.getState().status).toBe(CollabStatus.DISCONNECTED);
    expect(cp.getState().lastError).toBe("auth_failed");
    expect(cp.getState().forceCloseMessage).toBeNull();
    expect(cp.getYDoc()).toBe(ydocBefore);
    expect(onTokenRefreshRequired).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    // microtask forceRebuildProvider
    expect(hpConstructCount).toBe(2);
    expect(cp.getState().providerGeneration).toBe(1);
    expect(cp.getYDoc()).toBe(ydocBefore);
  });

  it("onAuthenticationFailed is recoverable (not TabTin 4001 FORCE_CLOSED)", async () => {
    const cp = new CollabProvider(BASE_OPTIONS);
    cp.connect();
    const ydocBefore = cp.getYDoc();

    capturedHPOpts.onAuthenticationFailed({ reason: "JWT token invalid or expired" });

    expect(cp.getState().status).toBe(CollabStatus.DISCONNECTED);
    expect(cp.getState().lastError).toBe("auth_failed");
    expect(cp.getYDoc()).toBe(ydocBefore);

    await Promise.resolve();
    expect(hpConstructCount).toBe(2);
  });

  it("onAuthenticationFailed with a definite permission reason is terminal", async () => {
    const onTokenRefreshRequired = vi.fn();
    const cp = new CollabProvider({ ...BASE_OPTIONS, onTokenRefreshRequired });
    cp.connect();

    capturedHPOpts.onAuthenticationFailed({ reason: "Unauthorized: 您没有权限执行此操作" });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getState().lastError).toBe("permission_denied");
    expect(cp.getState().forceCloseMessage).toMatchObject({
      code: CloseCode.PERMISSION_DENIED,
      reason: "permission_denied",
    });
    expect(cp.getProvider()).toBeNull();
    expect(onTokenRefreshRequired).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(hpConstructCount).toBe(1);
  });

  it("4403 closes permanently without rebuilding the Provider", async () => {
    const cp = new CollabProvider(BASE_OPTIONS);
    cp.connect();

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.PERMISSION_DENIED } });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getState().forceCloseMessage).toMatchObject({
      code: CloseCode.PERMISSION_DENIED,
      reason: "permission_denied",
    });
    expect(cp.getProvider()).toBeNull();

    await Promise.resolve();
    expect(hpConstructCount).toBe(1);
  });

  it("TabTin business CloseCode.AUTH_FAILED (4001) remains FORCE_CLOSED", () => {
    const cp = new CollabProvider(BASE_OPTIONS);
    cp.connect();

    capturedHPOpts.onDisconnect({ event: { code: CloseCode.AUTH_FAILED } });

    expect(cp.getState().status).toBe(CollabStatus.FORCE_CLOSED);
    expect(cp.getProvider()).toBeNull();
  });

  it("updateToken during auth recovery does not double-rebuild with the scheduled microtask", async () => {
    let cp!: CollabProvider;
    const onTokenRefreshRequired = vi.fn(() => {
      // 模拟宿主立刻回写 token（与 microtask rebuild 竞态）
      cp.updateToken("refreshed-token");
    });
    cp = new CollabProvider({ ...BASE_OPTIONS, onTokenRefreshRequired });
    cp.connect();
    expect(hpConstructCount).toBe(1);

    capturedHPOpts.onDisconnect({ event: { code: 4401 } });
    expect(onTokenRefreshRequired).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    // 一轮恢复只应再建一个 Hocuspocus 实例
    expect(hpConstructCount).toBe(2);
    expect(cp.getState().providerGeneration).toBe(1);
  });

  it("forceRebuildProvider does not touch IndexedDB persistence instance", () => {
    const cp = new CollabProvider({ ...BASE_OPTIONS, enableIndexedDB: true });
    cp.connect();
    const idbBefore = (cp as any).idbPersistence;
    expect(idbBefore).toBeTruthy();

    cp.forceRebuildProvider();

    expect((cp as any).idbPersistence).toBe(idbBefore);
    expect(idbBefore.destroy).not.toHaveBeenCalled();
    expect(cp.getState().providerGeneration).toBe(1);
  });

  it("connect with blank token stays disconnected until updateToken", () => {
    const cp = new CollabProvider({ ...BASE_OPTIONS, token: "" });
    cp.connect();
    expect(cp.getState().lastError).toBe("missing_collab_token");
    expect(cp.getProvider()).toBeNull();
    expect(hpConstructCount).toBe(0);

    cp.updateToken("arrived-token");
    expect(cp.getProvider()).not.toBeNull();
    expect(hpConstructCount).toBe(1);
    expect(cp.getState().status).toBe(CollabStatus.CONNECTING);
  });
});
