/**
 * CC-001 回归测试 — onDisconnect 递归守卫
 * CC-016 回归测试 — 离线时长检测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    _opts: any;
    setAwarenessField = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    sendStateless = vi.fn();

    constructor(opts: any) {
      this._opts = opts;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

vi.mock("y-indexeddb", () => {
  return {
    IndexeddbPersistence: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      whenSynced: Promise.resolve(),
    })),
  };
});

import { CollabProvider } from "./provider";
import { CollabStatus, CloseCode } from "./types";
import { HocuspocusProvider } from "@hocuspocus/provider";

function createTestProvider() {
  return new CollabProvider({
    serverUrl: "ws://localhost:1234",
    documentName: "test-doc",
    token: "test-token",
    user: { id: "u1", name: "Test", color: "#ff0000" },
    enableIndexedDB: false,
  });
}

function getCallbacksFromProvider(collab: CollabProvider) {
  const hp = collab.getProvider() as any;
  return hp._opts;
}

describe("provider configuration guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not construct HocuspocusProvider with a blank serverUrl", () => {
    const collab = new CollabProvider({
      serverUrl: "   ",
      documentName: "test-doc",
      token: "test-token",
      user: { id: "u1", name: "Test", color: "#ff0000" },
      enableIndexedDB: false,
    });

    collab.connect();

    expect(collab.getProvider()).toBeNull();
    expect(collab.getState().status).toBe(CollabStatus.DISCONNECTED);
    expect(collab.getState().lastError).toBe("missing_collab_server_url");
  });
});

describe("CC-001: onDisconnect recursive guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should set _disconnecting before calling provider.disconnect() on force-close", () => {
    const collab = createTestProvider();
    collab.connect();

    const hpInstance = collab.getProvider()! as any;
    const origDisconnect = hpInstance.disconnect;

    let guardValueDuringDisconnect: boolean | undefined;
    hpInstance.disconnect = vi.fn(() => {
      guardValueDuringDisconnect = (collab as any)._disconnecting;
    });

    const callbacks = getCallbacksFromProvider(collab);
    callbacks.onDisconnect({ event: { code: CloseCode.DOCUMENT_NOT_FOUND } });

    expect(guardValueDuringDisconnect).toBe(true);
    expect(collab.getState().status).toBe(CollabStatus.FORCE_CLOSED);
  });

  it("should not process onDisconnect twice when re-triggered by provider.disconnect()", () => {
    const collab = createTestProvider();
    collab.connect();

    const callbacks = getCallbacksFromProvider(collab);
    const hpInstance = collab.getProvider()! as any;

    hpInstance.disconnect = vi.fn(() => {
      callbacks.onDisconnect({ event: { code: CloseCode.AUTH_FAILED } });
    });

    const stateChanges: string[] = [];
    collab.subscribe((s) => stateChanges.push(s.status));

    callbacks.onDisconnect({ event: { code: CloseCode.DOCUMENT_NOT_FOUND } });

    const forceCloseCount = stateChanges.filter(
      (s) => s === CollabStatus.FORCE_CLOSED,
    ).length;
    expect(forceCloseCount).toBe(1);
  });

  it("should still allow normal disconnect after force-close guard resets via disconnect()", () => {
    const collab = createTestProvider();
    collab.connect();

    const callbacks = getCallbacksFromProvider(collab);
    callbacks.onDisconnect({ event: { code: CloseCode.DOCUMENT_NOT_FOUND } });

    expect((collab as any)._disconnecting).toBe(true);

    collab.disconnect();
    expect(collab.getState().status).toBe(CollabStatus.INITIAL);
  });
});

describe("CC-016: long offline detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should detect long offline (>30min) and set longOfflineDetected", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    // 首次 sync — 建立连接
    callbacks.onSynced();
    expect(collab.getState().longOfflineDetected).toBe(false);

    // 断连
    callbacks.onDisconnect({ event: { code: 1006 } });
    expect(collab.getState().status).toBe(CollabStatus.DISCONNECTED);

    // 经过 31 分钟后重连
    vi.advanceTimersByTime(31 * 60 * 1000);

    callbacks.onConnect();
    callbacks.onSynced();
    expect(collab.getState().longOfflineDetected).toBe(true);
    expect(collab.getState().status).toBe(CollabStatus.SYNCED);
  });

  it("should NOT detect long offline for short disconnections (<30min)", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    callbacks.onSynced();

    // 断连
    callbacks.onDisconnect({ event: { code: 1006 } });

    // 只过了 5 分钟
    vi.advanceTimersByTime(5 * 60 * 1000);

    callbacks.onConnect();
    callbacks.onSynced();
    expect(collab.getState().longOfflineDetected).toBe(false);
  });

  it("should NOT detect long offline on first connection", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    // 首次 sync — offlineSince 为 0，不触发检测
    callbacks.onSynced();
    expect(collab.getState().longOfflineDetected).toBe(false);
  });

  it("should reset longOfflineDetected via acknowledgeLongOffline()", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    callbacks.onSynced();
    callbacks.onDisconnect({ event: { code: 1006 } });

    vi.advanceTimersByTime(31 * 60 * 1000);
    callbacks.onConnect();
    callbacks.onSynced();
    expect(collab.getState().longOfflineDetected).toBe(true);

    collab.acknowledgeLongOffline();
    expect(collab.getState().longOfflineDetected).toBe(false);
  });

  it("should reset offlineSince on manual disconnect()", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    callbacks.onSynced();
    callbacks.onDisconnect({ event: { code: 1006 } });
    expect((collab as any).offlineSince).toBeGreaterThan(0);

    collab.disconnect();
    expect((collab as any).offlineSince).toBe(0);
    expect(collab.getState().longOfflineDetected).toBe(false);
  });
});
