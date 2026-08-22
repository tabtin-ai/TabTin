/**
 * COLLAB-DEGRADE 回归测试
 *
 * 1. shouldFallbackToLegacy 支持 disconnectTimedOut 参数
 * 2. useCollabProvider 断连超时 → disconnectTimedOut = true
 * 3. 重连后 disconnectTimedOut 复位
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

let capturedHPOpts: Record<string, any> = {};
let mockHPInstance: Record<string, any> = {};

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    disconnect = vi.fn();
    destroy = vi.fn();
    connect = vi.fn();
    setAwarenessField = vi.fn();
    sendStateless = vi.fn();
    constructor(opts: Record<string, any>) {
      capturedHPOpts = opts;
      mockHPInstance = this;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

vi.mock("y-indexeddb", () => {
  class MockIndexeddbPersistence {
    on = vi.fn();
    destroy = vi.fn();
    whenSynced = Promise.resolve();
    constructor() {}
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence };
});

import { shouldFallbackToLegacy } from "../errors.js";
import { resolveCollabSyncMode, STUCK_CONNECTING_FALLBACK_THRESHOLD } from "../syncMode.js";
import {
  useCollabProvider,
  CONNECTING_WATCHDOG_TIMEOUT_MS,
  DISCONNECT_TIMEOUT_MS,
} from "../useCollabProvider.js";
import {
  CollabConnectionStatus,
  CollabStatus,
  CloseCode,
  type CollabProviderOptions,
} from "../types.js";

/* ------------------------------------------------------------------ */
/* shouldFallbackToLegacy 单元测试                                     */
/* ------------------------------------------------------------------ */

describe("shouldFallbackToLegacy — DISCONNECT_TIMEOUT", () => {
  it("disconnectTimedOut=true 时返回 true，无论 status 和 errorCode", () => {
    expect(
      shouldFallbackToLegacy(CollabStatus.DISCONNECTED, undefined, true)
    ).toBe(true);
    expect(
      shouldFallbackToLegacy(CollabStatus.SYNCED, undefined, true)
    ).toBe(true);
    expect(
      shouldFallbackToLegacy(CollabStatus.INITIAL, 1006, true)
    ).toBe(true);
  });

  it("disconnectTimedOut=false 时保持原有逻辑", () => {
    expect(
      shouldFallbackToLegacy(CollabStatus.DISCONNECTED, undefined, false)
    ).toBe(false);
    expect(
      shouldFallbackToLegacy(
        CollabStatus.FORCE_CLOSED,
        CloseCode.DOCUMENT_TOO_LARGE,
        false
      )
    ).toBe(true);
  });

  it("disconnectTimedOut 省略时保持原有逻辑（向后兼容）", () => {
    expect(
      shouldFallbackToLegacy(CollabStatus.DISCONNECTED, undefined)
    ).toBe(false);
    expect(
      shouldFallbackToLegacy(
        CollabStatus.FORCE_CLOSED,
        CloseCode.DOCUMENT_TOO_LARGE
      )
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* useCollabProvider 断连超时集成测试                                    */
/* ------------------------------------------------------------------ */

const BASE_OPTIONS: CollabProviderOptions = {
  serverUrl: "ws://localhost:4100",
  documentName: "test-doc",
  token: "test-token",
  user: { id: "u1", name: "Tester", color: "#FF5733" },
  enableIndexedDB: false,
};

describe("useCollabProvider — 断连超时降级", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedHPOpts = {};
    mockHPInstance = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("初始状态 disconnectTimedOut 为 false", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));
    expect(result.current.disconnectTimedOut).toBe(false);
  });

  it("options 为 null 时 disconnectTimedOut 为 false", () => {
    const { result } = renderHook(() => useCollabProvider(null));
    expect(result.current.disconnectTimedOut).toBe(false);
  });

  it("DISCONNECT_TIMEOUT_MS 为 30 秒", () => {
    expect(DISCONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("普通 DISCONNECTED 后自动调用 reconnect，不依赖 focus/online 事件", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    expect(mockHPInstance.connect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mockHPInstance.connect).toHaveBeenCalledTimes(1);
  });

  it("配置缺失导致的 DISCONNECTED 不自动重连，但仍会超时降级", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result } = renderHook(() => useCollabProvider({
      ...BASE_OPTIONS,
      serverUrl: " ",
    }));

    expect(result.current.status).toBe(CollabStatus.DISCONNECTED);
    expect(result.current.lastError).toBe("missing_collab_server_url");
    expect(mockHPInstance.connect).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mockHPInstance.connect).toBeUndefined();
    expect(result.current.disconnectTimedOut).toBe(true);
    expect(result.current.syncMode).toBe("legacy");
  });

  it("重连恢复后停止自动 retry，并保持 disconnectTimedOut 为 false", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.disconnectTimedOut).toBe(false);
    expect(mockHPInstance.connect).toHaveBeenCalled();

    act(() => {
      capturedHPOpts.onConnect();
      capturedHPOpts.onSynced();
    });
    expect(result.current.status).toBe(CollabStatus.SYNCED);
    expect(result.current.disconnectTimedOut).toBe(false);

    const callsAfterSynced = mockHPInstance.connect.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mockHPInstance.connect).toHaveBeenCalledTimes(callsAfterSynced);
  });

  it("自动 retry 进入 CONNECTING 后仍保留 30 秒断连降级计时", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.status).toBe(CollabStatus.CONNECTING);
    expect(result.current.disconnectTimedOut).toBe(false);

    act(() => {
      vi.advanceTimersByTime(DISCONNECT_TIMEOUT_MS - 1_000);
    });

    expect(result.current.disconnectTimedOut).toBe(true);
  });

  it("连续失败时自动 retry 使用递增退避，不会每轮重置为 1 秒", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mockHPInstance.connect).toHaveBeenCalledTimes(1);

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(mockHPInstance.connect).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockHPInstance.connect).toHaveBeenCalledTimes(2);
  });

  it("unmount 后清理自动 retry timer", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { unmount } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mockHPInstance.connect).not.toHaveBeenCalled();
  });

  it("server_shutdown 维护窗口内 focus/online 旧重连路径也不会触发 retry", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onStateless({
        payload: JSON.stringify({ type: "server_shutdown" }),
      });
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(9_999);
    });

    expect(mockHPInstance.connect).not.toHaveBeenCalled();
  });

  it("force-close 终态不启动普通自动 retry", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: CloseCode.PERMISSION_CHANGED } });
      vi.advanceTimersByTime(60_000);
    });

    expect(mockHPInstance.connect).not.toHaveBeenCalled();
  });

  it("server_shutdown 维护窗口内暂停自动 retry，窗口结束后恢复", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      capturedHPOpts.onStateless({
        payload: JSON.stringify({ type: "server_shutdown" }),
      });
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
      vi.advanceTimersByTime(9_999);
    });

    expect(mockHPInstance.connect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mockHPInstance.connect).toHaveBeenCalledTimes(1);
  });
});

describe("useCollabProvider — CONNECTING watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedHPOpts = {};
    mockHPInstance = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("CONNECTING 超过 60 秒后销毁并重建底层 provider，同时保留 Y.Doc", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));
    const originalProvider = mockHPInstance;
    const originalYDoc = result.current.ydoc;
    const connectionStatuses: CollabConnectionStatus[] = [];
    const unsubscribe = result.current.provider?.subscribe((state) => {
      connectionStatuses.push(state.connectionStatus);
    });

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });

    expect(originalProvider.disconnect).toHaveBeenCalledTimes(1);
    expect(originalProvider.destroy).toHaveBeenCalledTimes(1);
    expect(mockHPInstance).not.toBe(originalProvider);
    expect(result.current.ydoc).toBe(originalYDoc);
    expect(connectionStatuses).toContain(CollabConnectionStatus.STUCK_CONNECTING);
    // STUCK_CONNECTING 粘滞：重建期间保持挂起状态，直到 onConnect 才恢复
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.STUCK_CONNECTING);
    expect(result.current.watchdogTriggerCount).toBe(1);
    unsubscribe?.();
  });

  it("window online 在未连接时立即重建 provider", () => {
    renderHook(() => useCollabProvider(BASE_OPTIONS));
    const originalProvider = mockHPInstance;

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(originalProvider.destroy).toHaveBeenCalledTimes(1);
    expect(mockHPInstance).not.toBe(originalProvider);
  });

  it("页面重新可见时在未连接状态立即重建 provider", () => {
    renderHook(() => useCollabProvider(BASE_OPTIONS));
    const originalProvider = mockHPInstance;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(originalProvider.destroy).toHaveBeenCalledTimes(1);
    expect(mockHPInstance).not.toBe(originalProvider);
  });

  it("正常连接成功后不会触发 watchdog", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));
    const connectedProvider = mockHPInstance;

    act(() => {
      capturedHPOpts.onConnect();
      capturedHPOpts.onSynced();
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS * 2);
    });

    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.CONNECTED);
    expect(connectedProvider.destroy).not.toHaveBeenCalled();
    expect(mockHPInstance).toBe(connectedProvider);
  });
});

/* ------------------------------------------------------------------ */
/*  兜底：握手持久挂起 → stuck_connecting 降级 → 恢复升回          */
/* ------------------------------------------------------------------ */

describe("useCollabProvider — STUCK_CONNECTING 降级与恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedHPOpts = {};
    mockHPInstance = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("阈值为 2 次连续 watchdog 触发", () => {
    expect(STUCK_CONNECTING_FALLBACK_THRESHOLD).toBe(2);
  });

  it("单次 watchdog 触发（60s 挂起）不降级，syncMode 保持 collab", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });

    expect(result.current.watchdogTriggerCount).toBe(1);
    expect(result.current.syncMode).toBe("collab");
  });

  it("连续 2 次 watchdog 触发（120s 挂起）降级 legacy，reason=stuck_connecting", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    // 第 1 次：60s 无回调 → watchdog 重建；粘滞期间 watchdog 继续跑
    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    // 第 2 次：重建的新 provider 又挂 60s
    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });

    expect(result.current.watchdogTriggerCount).toBe(2);
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.STUCK_CONNECTING);
    expect(result.current.status).toBe(CollabStatus.CONNECTING);
    expect(result.current.syncMode).toBe("legacy");
    expect(result.current.syncModeReason).toBe("stuck_connecting");
  });

  it("降级后连接恢复：计数清零、升回 collab、状态 CONNECTED", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    expect(result.current.syncMode).toBe("legacy");

    // 网络栈恢复，重建的 provider 连接成功
    act(() => {
      capturedHPOpts.onConnect();
      capturedHPOpts.onSynced();
    });

    expect(result.current.watchdogTriggerCount).toBe(0);
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.CONNECTED);
    expect(result.current.status).toBe(CollabStatus.SYNCED);
    expect(result.current.syncMode).toBe("collab");
    expect(result.current.syncModeReason).toBeUndefined();
  });

  it("恢复后再次挂起：watchdog 计数从零重新累计", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    act(() => {
      capturedHPOpts.onConnect();
    });
    expect(result.current.watchdogTriggerCount).toBe(0);

    // 断连后重连再次挂起
    act(() => {
      capturedHPOpts.onDisconnect({ event: { code: 1006 } });
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });

    // 计数从零重新累计（首轮的 1 次不遗留）
    expect(result.current.watchdogTriggerCount).toBe(1);
    // 经过 DISCONNECTED 的挂起由更快的 30s disconnectTimedOut 通道先降级——两通道协同
    expect(result.current.syncMode).toBe("legacy");
    expect(result.current.syncModeReason).toBe("runtime_fallback");
  });

  it("manualReconnect 在 STUCK 态重建 provider、保留 Y.Doc、状态回 RECONNECTING、计数不清零", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));
    const originalYDoc = result.current.ydoc;

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    const stuckProvider = mockHPInstance;
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.STUCK_CONNECTING);

    act(() => {
      result.current.manualReconnect();
    });

    expect(stuckProvider.destroy).toHaveBeenCalledTimes(1);
    expect(mockHPInstance).not.toBe(stuckProvider);
    expect(result.current.ydoc).toBe(originalYDoc);
    // 手动重连给出「正在重试」的即时反馈；未连上前计数保留，syncMode 仍 legacy
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.RECONNECTING);
    expect(result.current.watchdogTriggerCount).toBe(2);
    expect(result.current.syncMode).toBe("legacy");

    act(() => {
      capturedHPOpts.onConnect();
    });
    expect(result.current.watchdogTriggerCount).toBe(0);
    expect(result.current.syncMode).toBe("collab");
  });

  it("FORCE_CLOSED 短路：残留计数不得把归档/权限终态误判为 stuck legacy（review P2-1）", () => {
    // 归档（4002）应走 READONLY 遮罩语义，非 TOO_LARGE 不降级
    expect(resolveCollabSyncMode({
      providerConfigured: true,
      status: CollabStatus.FORCE_CLOSED,
      forceCloseCode: 4002,
      watchdogTriggerCount: STUCK_CONNECTING_FALLBACK_THRESHOLD,
    })).toEqual({ mode: "collab" });

    // TOO_LARGE 仍按既有 force_closed 降级，不受计数影响
    expect(resolveCollabSyncMode({
      providerConfigured: true,
      status: CollabStatus.FORCE_CLOSED,
      forceCloseCode: 4003,
      watchdogTriggerCount: STUCK_CONNECTING_FALLBACK_THRESHOLD,
    })).toEqual({ mode: "legacy", reason: "force_closed" });
  });

  it("manual 重连绕过 auth_failed 等非重试错误守卫（review P2-2）", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    // 模拟协议级认证失败 → lastError=auth_failed、DISCONNECTED
    act(() => {
      capturedHPOpts.onAuthenticationFailed({ reason: "JWT token invalid or expired" });
    });
    expect(result.current.lastError).toBe("auth_failed");

    const failedProvider = mockHPInstance;
    // 自动恢复路径（online 等）仍被守卫挡住
    expect(result.current.provider!.recoverConnection("online")).toBe(false);

    // 用户显式点击放行：重建 provider（token getter 会取最新 JWT）
    act(() => {
      expect(result.current.provider!.recoverConnection("manual")).toBe(true);
    });
    expect(mockHPInstance).not.toBe(failedProvider);
    expect(result.current.status).toBe(CollabStatus.CONNECTING);
  });

  it("STUCK 粘滞期间 online 等网络事件恢复不打断挂起显示", () => {
    const { result } = renderHook(() => useCollabProvider(BASE_OPTIONS));

    act(() => {
      vi.advanceTimersByTime(CONNECTING_WATCHDOG_TIMEOUT_MS);
    });
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.STUCK_CONNECTING);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    // online 重建 provider，但 UI 保持 STUCK（避免异常↔重连中闪跳），直到真正连上
    expect(result.current.connectionStatus).toBe(CollabConnectionStatus.STUCK_CONNECTING);
  });
});
