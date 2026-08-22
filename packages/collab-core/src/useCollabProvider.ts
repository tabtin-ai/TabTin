/**
 * useCollabProvider — 核心 React Hook
 *
 * 管理 CollabProvider 的生命周期，暴露响应式状态。
 *
 * 用法:
 * ```tsx
 * const { status, ydoc, peers, sendStateless } = useCollabProvider({
 *   serverUrl: 'ws://localhost:4100/collaboration',
 *   documentName: 'doc-uuid-xxx',
 *   token: jwtToken,
 *   user: { id: '...', name: '...', color: '#FF5733' },
 * })
 * ```
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { CollabProvider, isNonRetryableCollabError } from "./provider.js";
import {
  INITIAL_COLLAB_STATE,
  CollabConnectionStatus,
  CollabStatus,
  type CollabProviderOptions,
  type CollabState,
  type CollabPeerState,
  type StatelessEvent,
} from "./types.js";
import {
  resolveCollabSyncMode,
  type CollabSyncModeState,
} from "./syncMode.js";
import {
  acquireCollabProviderRuntime,
  type CollabProviderRuntimeLease,
} from "./collabProviderRuntimeRegistry.js";

/** 断连超过此时长后自动降级到旧链路（ms） */
export const DISCONNECT_TIMEOUT_MS = 30_000;

/** WebSocket 握手长时间无结果时，主动重建底层 Provider（ms） */
export const CONNECTING_WATCHDOG_TIMEOUT_MS = 60_000;

/** 普通断线自动重连退避参数（ms） */
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const RECONNECT_JITTER_RATIO = 0.2;

function computeReconnectDelay(attempt: number): number {
  const safeAttempt = Math.max(0, attempt);
  const exponentialDelay = RECONNECT_INITIAL_DELAY_MS * (RECONNECT_BACKOFF_FACTOR ** safeAttempt);
  const baseDelay = Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
  const jitter = baseDelay * RECONNECT_JITTER_RATIO * Math.random();
  return Math.round(baseDelay + jitter);
}

function shouldAutoReconnect(provider: CollabProvider): boolean {
  const currentState = provider.getState();
  // missing_collab_token / auth_failed：等 token 刷新或 forceRebuild，勿普通退避空转
  if (isNonRetryableCollabError(currentState.lastError)) {
    return false;
  }
  return (
    currentState.status === CollabStatus.DISCONNECTED
    && !currentState.serverShutdown
  );
}

export interface UseCollabProviderResult {
  /** 连接状态 */
  status: CollabStatus;
  /** Provider 连接生命周期状态 */
  connectionStatus: CollabConnectionStatus;
  /** Y.js 文档实例 */
  ydoc: CollabState["ydoc"];
  /** 在线协作者列表 */
  peers: CollabState["peers"];
  /** IndexedDB 缓存就绪 */
  isCacheReady: boolean;
  /** IndexedDB 中有缓存内容 */
  hasCachedContent: boolean;
  /** Force-close 消息 */
  forceCloseMessage: CollabState["forceCloseMessage"];
  /** 最近错误 */
  lastError: string | null;
  /** CC-016: 是否检测到长时间离线后重连 */
  longOfflineDetected: boolean;
  /** 断连超时，已自动降级 */
  disconnectTimedOut: boolean;
  /** 连续 CONNECTING watchdog 触发次数（连接成功后清零） */
  watchdogTriggerCount: number;
  /** 发送 Stateless 业务消息 */
  sendStateless: (event: StatelessEvent) => void;
  /** 手动重连 */
  reconnect: () => void;
  /**
   * 用户手动触发的强制重连：重建底层 HocuspocusProvider，保留 Y.Doc 与
   * IndexedDB（区别于 forceReconnect 的丢弃语义）。CONNECTING 挂起 /
   * STUCK / DISCONNECTED 态均可用；reconnect() 会被 CONNECTING 守卫挡住。
   */
  manualReconnect: () => void;
  /** 更新自己的 Awareness 字段 */
  setAwareness: (key: string, value: unknown) => void;
  /** CC-016: 确认长离线提示 */
  acknowledgeLongOffline: () => void;
  /** 底层 Provider 实例（高级用途） */
  provider: CollabProvider | null;
  /**
   * HocuspocusProvider 世代号（认证恢复重建时递增，Y.Doc 不变）。
   * TabDoc 用于 CollaborationCursor 受控 remount。
   */
  providerGeneration: number;
  /** 是否处于在线协作状态 */
  isOnline: boolean;
  /** 资源级同步模式：collab 模式不消费 legacy domain delta */
  syncMode: CollabSyncModeState["mode"];
  /** 进入 legacy 模式的原因；collab 模式下为空 */
  syncModeReason?: CollabSyncModeState["reason"];
  /** 服务端持久化（store）失败，需提示用户 */
  storeFailed: boolean;
  /** 服务端通知即将关闭（计划维护），暂停重连 */
  serverShutdown: boolean;
  /** 服务端已将当前协作连接降级为只读 */
  readOnly: boolean;
  /** 当前协作连接是否允许编辑 */
  canEdit: boolean;
}

/**
 * 核心协作 Hook
 *
 * 自动管理 Provider 的 connect/disconnect 生命周期。
 * documentName 变化时自动重建连接。
 */
export function useCollabProvider(
  options: CollabProviderOptions | null
): UseCollabProviderResult {
  const [state, setState] = useState<CollabState>(INITIAL_COLLAB_STATE);
  const [disconnectTimedOut, setDisconnectTimedOut] = useState(false);
  const providerRef = useRef<CollabProvider | null>(null);
  const runtimeLeaseRef = useRef<CollabProviderRuntimeLease | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);
  const clearConnectingWatchdog = useCallback(() => {
    if (connectingWatchdogTimerRef.current) {
      clearTimeout(connectingWatchdogTimerRef.current);
      connectingWatchdogTimerRef.current = null;
    }
  }, []);
  const enabled = options != null;

  // 创建/重建 Provider
  useEffect(() => {
    if (!options) {
      // 未配置，保持初始状态
      if (providerRef.current) {
        providerRef.current.disconnect();
        providerRef.current = null;
        setState(INITIAL_COLLAB_STATE);
      }
      setDisconnectTimedOut(false);
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      clearReconnectTimer();
      clearConnectingWatchdog();
      reconnectAttemptRef.current = 0;
      return;
    }

    // 显式资源键使用共享运行时；其余入口保持原有独占生命周期。
    const runtimeLease = options.sharedRuntimeKey
      ? acquireCollabProviderRuntime(options.sharedRuntimeKey, options)
      : null;
    const provider = runtimeLease?.provider ?? new CollabProvider(options);
    runtimeLeaseRef.current = runtimeLease;
    providerRef.current = provider;

    // 监听状态变更
    const unsub = provider.subscribe((newState) => {
      setState(newState);
    });

    setState(provider.getState());
    // 共享运行时在首个租约获取时已经连接；独占运行时由当前 Hook 启动。
    if (!runtimeLease) provider.connect();

    return () => {
      unsub();
      runtimeLease?.release();
      if (!runtimeLease) provider.disconnect();
      runtimeLeaseRef.current = null;
      providerRef.current = null;
      setDisconnectTimedOut(false);
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      clearReconnectTimer();
      clearConnectingWatchdog();
      reconnectAttemptRef.current = 0;
    };
    // COL-022: token is NOT in the dependency array — token changes are
    // handled by updateToken() below to avoid destroying/rebuilding the
    // entire provider (which creates a new Y.Doc, risking canvas blank).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    options?.serverUrl,
    options?.documentName,
    options?.user?.id,
    options?.sharedRuntimeKey,
    clearReconnectTimer,
    clearConnectingWatchdog,
  ]);

  // COL-022: Forward token updates to the existing provider without rebuild.
  // This lets HocuspocusProvider use the fresh token on its next reconnect
  // attempt, surviving JWT refresh without creating a new Y.Doc.
  useEffect(() => {
    if (options) {
      runtimeLeaseRef.current?.update(options);
    }
    if (providerRef.current && options?.token) {
      providerRef.current.updateToken(options.token);
    }
  }, [options, options?.token]);

  // ── CONNECTING watchdog ──
  useEffect(() => {
    // STUCK_CONNECTING 粘滞期间重建的新 provider 仍可能挂起，watchdog 必须继续跑
    // （每次触发 watchdogTriggerCount+1，供 syncMode 降级判定）。
    const waitingForConnection =
      state.connectionStatus === CollabConnectionStatus.CONNECTING
      || state.connectionStatus === CollabConnectionStatus.RECONNECTING
      || state.connectionStatus === CollabConnectionStatus.STUCK_CONNECTING;

    if (!enabled || !waitingForConnection) {
      clearConnectingWatchdog();
      return;
    }

    clearConnectingWatchdog();
    connectingWatchdogTimerRef.current = setTimeout(() => {
      connectingWatchdogTimerRef.current = null;
      providerRef.current?.recoverConnection("watchdog");
    }, CONNECTING_WATCHDOG_TIMEOUT_MS);

    return clearConnectingWatchdog;
  }, [
    enabled,
    state.connectionStatus,
    state.providerGeneration,
    clearConnectingWatchdog,
  ]);

  // ── 断连超时降级 ──
  useEffect(() => {
    if (state.status === CollabStatus.DISCONNECTED) {
      if (!disconnectTimerRef.current && !disconnectTimedOut) {
        disconnectTimerRef.current = setTimeout(() => {
          disconnectTimerRef.current = null;
          setDisconnectTimedOut(true);
        }, DISCONNECT_TIMEOUT_MS);
      }
    } else if (
      state.status === CollabStatus.SYNCED ||
      state.status === CollabStatus.SYNCING ||
      state.status === CollabStatus.INITIAL ||
      state.status === CollabStatus.FORCE_CLOSED
    ) {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      if (
        disconnectTimedOut &&
        (state.status === CollabStatus.SYNCED ||
          state.status === CollabStatus.SYNCING)
      ) {
        setDisconnectTimedOut(false);
      }
    }
  }, [state.status, disconnectTimedOut]);

  // ── 普通断线自动重连 ──
  useEffect(() => {
    if (
      !enabled ||
      state.status !== CollabStatus.DISCONNECTED ||
      state.serverShutdown
    ) {
      clearReconnectTimer();
      if (
        !enabled ||
        state.status === CollabStatus.SYNCED ||
        state.status === CollabStatus.SYNCING ||
        state.status === CollabStatus.INITIAL ||
        state.status === CollabStatus.FORCE_CLOSED
      ) {
        reconnectAttemptRef.current = 0;
      }
      return;
    }

    if (reconnectTimerRef.current) return;

    const attempt = reconnectAttemptRef.current;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current = attempt + 1;

      const provider = providerRef.current;
      if (provider && shouldAutoReconnect(provider)) {
        provider.reconnect();
      }
    }, computeReconnectDelay(attempt));

    return clearReconnectTimer;
  }, [
    enabled,
    state.status,
    state.serverShutdown,
    clearReconnectTimer,
  ]);

  // ── 页面可见性与在线状态处理 ──
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        providerRef.current?.recoverConnection("visibility");
      }
    };

    const handleOnline = () => {
      providerRef.current?.recoverConnection("online");
    };

    const handleFocus = () => {
      providerRef.current?.recoverConnection("focus");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled]);

  // ── 稳定回调 ──
  const sendStateless = useCallback((event: StatelessEvent) => {
    providerRef.current?.sendStateless(event);
  }, []);

  const reconnect = useCallback(() => {
    providerRef.current?.reconnect();
  }, []);

  const manualReconnect = useCallback(() => {
    providerRef.current?.recoverConnection("manual");
  }, []);

  const setAwareness = useCallback((key: string, value: unknown) => {
    providerRef.current?.setAwarenessField(key, value);
  }, []);

  const acknowledgeLongOffline = useCallback(() => {
    providerRef.current?.acknowledgeLongOffline();
  }, []);

  const isOnline = state.status === CollabStatus.SYNCED || state.status === CollabStatus.SYNCING;
  const syncModeState = resolveCollabSyncMode({
    providerConfigured: options != null,
    status: state.status,
    forceCloseCode: state.forceCloseMessage?.code,
    disconnectTimedOut,
    watchdogTriggerCount: state.watchdogTriggerCount,
  });

  return useMemo(
    () => ({
      status: state.status,
      connectionStatus: state.connectionStatus,
      ydoc: state.ydoc,
      peers: state.peers,
      isCacheReady: state.isCacheReady,
      hasCachedContent: state.hasCachedContent,
      forceCloseMessage: state.forceCloseMessage,
      lastError: state.lastError,
      longOfflineDetected: state.longOfflineDetected,
      disconnectTimedOut,
      watchdogTriggerCount: state.watchdogTriggerCount,
      sendStateless,
      reconnect,
      manualReconnect,
      setAwareness,
      acknowledgeLongOffline,
      provider: providerRef.current,
      providerGeneration: state.providerGeneration,
      isOnline,
      syncMode: syncModeState.mode,
      syncModeReason: syncModeState.reason,
      storeFailed: state.storeFailed,
      serverShutdown: state.serverShutdown,
      readOnly: state.readOnly,
      canEdit: !state.readOnly,
    }),
    [
      state,
      disconnectTimedOut,
      sendStateless,
      reconnect,
      manualReconnect,
      setAwareness,
      acknowledgeLongOffline,
      isOnline,
      syncModeState.mode,
      syncModeState.reason,
    ]
  );
}

/**
 * 订阅高频 Awareness 变更（绕过 fingerprint 节流）。
 *
 * CC-014 修复后 computePeersFingerprint 排除了 cursor/playhead/lastActive，
 * peers state 不再随光标变化更新。需要实时光标位置的消费者（如画布协作光标渲染）
 * 应使用此 Hook 获取每次 awareness update 的完整 peer 列表。
 *
 * @param provider CollabProvider 实例（通常取自 useCollabProvider().provider）
 */
export function useAwarenessStates(
  provider: CollabProvider | null,
): CollabPeerState[] {
  const [peers, setPeers] = useState<CollabPeerState[]>([]);

  useEffect(() => {
    if (!provider) {
      setPeers([]);
      return;
    }

    const unsub = provider.subscribeAwareness((newPeers) => {
      setPeers(newPeers);
    });

    return unsub;
  }, [provider]);

  return peers;
}
