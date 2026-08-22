/**
 * CollabProvider — 统一协作连接管理
 *
 * 封装 HocuspocusProvider + IndexedDB + 状态机 + force-close 处理。
 * 供 TabDoc 和 TabData 的 React Hook 使用。
 *
 * 参照 Plane packages/editor/src/core/hooks/use-yjs-setup.ts
 */

import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";

import {
  CollabConnectionStatus,
  CollabStatus,
  CloseCode,
  INITIAL_COLLAB_STATE,
  type CollabProviderOptions,
  type CollabState,
  type CollabPeerState,
  type ForceCloseMessage,
  type StatelessEvent,
} from "./types.js";

/** 状态变更回调 */
type StateChangeCallback = (state: CollabState) => void;

/** Stateless 事件回调 */
type StatelessCallback = (event: StatelessEvent) => void;

/** Awareness 变更回调（绕过 fingerprint 节流，用于高频光标等场景） */
type AwarenessChangeCallback = (peers: CollabPeerState[]) => void;

/** CC-016: 离线超过此阈值（30 分钟）后重连时提示用户 */
const LONG_OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;

/** CL-014: IndexedDB 累积 update 条目超过此阈值时触发 compaction */
const IDB_COMPACTION_THRESHOLD = 300;

/** 判断关闭码是否为业务终态 force-close。 */
function isForceCloseCode(code: number): boolean {
  return (
    (code >= CloseCode.DOCUMENT_NOT_FOUND && code <= CloseCode.DOCUMENT_RESTORED)
    || code === CloseCode.PERMISSION_DENIED
  );
}

/** CLB-001: 判断关闭码是否为"文档已恢复"——需 forceReconnect 而非进入永久终态 */
function isDocumentRestoredCode(code: number): boolean {
  return code === CloseCode.DOCUMENT_RESTORED;
}

/**
 * 上游 Hocuspocus Unauthorized（idle timeout / 认证竞态）。
 * 与 TabTin 业务 force-close `CloseCode.AUTH_FAILED=4001` 不同；
 * 2.x 收到后会 `shouldConnect=false` 并打「token is required… Won't try again.」。
 */
const HOCUSPOCUS_UNAUTHORIZED_CODE = 4401;

/** 协议级认证失败后自动重建 Provider 的次数上限（同 token 也算一次） */
const MAX_AUTH_RECOVERY_ATTEMPTS = 1;

/** Hocuspocus 会把服务端 onAuthenticate 抛错文本放进 authenticationFailed.reason。 */
function isPermanentPermissionDenial(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("permission denied")
    || normalized.includes("forbidden")
    || normalized.includes("need editor permission")
    || normalized.includes("没有权限")
    || normalized.includes("无权限")
    || normalized.includes("权限不足")
  );
}

/**
 * 握手持久挂起（watchdog 触发）时在 window 上广播的事件名。
 * detail: { documentName: string; watchdogTriggerCount: number }
 * Electron 渲染进程据此聚合触发主进程网络栈软自愈。
 */
export const COLLAB_STUCK_CONNECTING_EVENT = "tabtin:collab-stuck-connecting";

/** 不可靠普通退避重连的配置/认证错误 */
export function isNonRetryableCollabError(lastError: string | null | undefined): boolean {
  if (!lastError) return false;
  return (
    lastError === "missing_collab_server_url"
    || lastError === "missing_collab_token"
    || lastError === "auth_failed"
    || lastError.startsWith("collab_provider_init_failed:")
  );
}

/** 从关闭码推断原因（当 stateless 消息未到达时的 fallback） */
function codeToReason(code: number): string {
  switch (code) {
    case CloseCode.DOCUMENT_NOT_FOUND: return "document_not_found";
    case CloseCode.AUTH_FAILED: return "auth_failed";
    case CloseCode.DOCUMENT_ARCHIVED: return "document_archived";
    case CloseCode.DOCUMENT_TOO_LARGE: return "document_too_large";
    case CloseCode.PERMISSION_CHANGED: return "permission_changed";
    case CloseCode.DOCUMENT_RESTORED: return "document_restored";
    case CloseCode.PERMISSION_DENIED: return "permission_denied";
    default: return "unknown";
  }
}

function codeToMessage(code: number): string {
  switch (code) {
    case CloseCode.DOCUMENT_NOT_FOUND: return "Document not found or has been deleted";
    case CloseCode.AUTH_FAILED: return "Authentication failed, please sign in again";
    case CloseCode.DOCUMENT_ARCHIVED: return "Document archived, read-only mode";
    case CloseCode.DOCUMENT_TOO_LARGE: return "Document too large, collaboration limit exceeded";
    case CloseCode.PERMISSION_CHANGED: return "Document permissions changed, please refresh";
    case CloseCode.DOCUMENT_RESTORED: return "Document restored to a previous version, re-syncing";
    case CloseCode.PERMISSION_DENIED: return "You do not have permission to access this collaborative resource";
    default: return "Connection closed";
  }
}

export class CollabProvider {
  private options: CollabProviderOptions;
  private provider: HocuspocusProvider | null = null;
  private idbPersistence: IndexeddbPersistence | null = null;
  private ydoc: Y.Doc;
  private _disconnecting = false;
  private _peersFingerprint = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** CC-016: 记录进入 DISCONNECTED 状态的时间戳，用于离线时长检测 */
  private offlineSince = 0;

  /** COL-022: 最新 token，供 HocuspocusProvider 重连时动态获取 */
  private _latestToken: string;

  /** COL-023: 服务端已请求 token 刷新，下次 updateToken 时自动回发 */
  private _tokenRefreshPending = false;

  /**
   * : 上游 4401 / onAuthenticationFailed 后等待 token 刷新或同 token 重建。
   * 为 true 时普通 reconnect 退避禁用，由 updateToken / 立即 rebuild 恢复。
   */
  private _authRecoveryPending = false;

  /** 当前连接世代内已尝试的认证恢复次数 */
  private _authRecoveryAttempts = 0;

  /** 已排队一次 forceRebuild，避免与 updateToken 双触发 */
  private _authRebuildScheduled = false;

  /** HocuspocusProvider 世代（重建时递增，Y.Doc 不变） */
  private _providerGeneration = 0;

  /** 当前 CollabProvider 生命周期内的主动重建次数 */
  private _retryCount = 0;

  /** 当前底层 Provider 世代内的 WebSocket 连接尝试次数 */
  private _connectionAttemptCount = 0;

  /** 当前状态 */
  private _state: CollabState = { ...INITIAL_COLLAB_STATE };

  /** 状态变更监听器 */
  private stateListeners = new Set<StateChangeCallback>();

  /** Stateless 事件监听器 */
  private statelessListeners = new Map<string, Set<StatelessCallback>>();

  /** 通配符 Stateless 监听器（接收所有事件） */
  private allStatelessListeners = new Set<StatelessCallback>();

  /** Awareness 变更监听器（每次 awareness update 都通知，不受 fingerprint 节流） */
  private awarenessListeners = new Set<AwarenessChangeCallback>();

  constructor(options: CollabProviderOptions) {
    this.options = options;
    this._latestToken = options.token;
    this.ydoc = new Y.Doc();
  }

  // ================================================================
  // 生命周期
  // ================================================================

  /**
   * 启动连接
   */
  connect(): void {
    if (this.provider) return; // 避免重复连接

    const serverUrl = (this.options.serverUrl ?? "").trim();
    if (!serverUrl) {
      this.updateState({
        status: CollabStatus.DISCONNECTED,
        connectionStatus: CollabConnectionStatus.FAILED,
        lastError: "missing_collab_server_url",
      });
      return;
    }

    const authToken = (this._latestToken ?? "").trim();
    if (!authToken) {
      this.updateState({
        status: CollabStatus.DISCONNECTED,
        connectionStatus: CollabConnectionStatus.FAILED,
        lastError: "missing_collab_token",
      });
      return;
    }

    this._disconnecting = false;
    this.updateState({
      status: CollabStatus.CONNECTING,
      connectionStatus: CollabConnectionStatus.CONNECTING,
      ydoc: this.ydoc,
      providerGeneration: this._providerGeneration,
    });

    if (!this.attachHocuspocusProvider(serverUrl)) {
      return;
    }

    // 启用 IndexedDB 本地缓存（重建 Provider 时不重复 setup）
    if (this.options.enableIndexedDB !== false && !this.idbPersistence) {
      this.setupIndexedDB();
    }
  }

  /**
   * 创建并挂接 HocuspocusProvider（保留当前 Y.Doc）。
   * @returns false 表示构造失败
   */
  private attachHocuspocusProvider(serverUrl: string): boolean {
    // COL-022: token getter — 重连时取最新 JWT，避免因刷新销毁 Y.Doc
    try {
      this.logConnectionEvent("provider_create", {
        generation: this._providerGeneration,
        retryCount: this._retryCount,
      });
      this.provider = new HocuspocusProvider({
        url: serverUrl,
        name: this.options.documentName,
        document: this.ydoc,
        token: () => this._latestToken,
        parameters: this.options.parameters,

        onStatus: ({ status }) => {
          if (status !== "connecting") return;
          this._connectionAttemptCount += 1;
          this.logConnectionEvent("connect_start", {
            attempt: this._connectionAttemptCount,
            retryCount: this._retryCount,
            generation: this._providerGeneration,
          });
        },

        onConnect: () => {
          if (this._disconnecting) return;
          if (this._state.status === CollabStatus.FORCE_CLOSED) return;
          this._authRecoveryPending = false;
          this._authRecoveryAttempts = 0;
          this._retryCount = 0;
          this._connectionAttemptCount = 0;
          this.logConnectionEvent("connect_success", {
            generation: this._providerGeneration,
          });
          this.updateState({
            status: CollabStatus.SYNCING,
            connectionStatus: CollabConnectionStatus.CONNECTED,
            lastError: null,
            watchdogTriggerCount: 0,
          });
        },

        onSynced: () => {
          if (this._disconnecting) return;
          if (this._state.status === CollabStatus.FORCE_CLOSED) return;

          const wasLongOffline =
            this.offlineSince > 0 &&
            Date.now() - this.offlineSince > LONG_OFFLINE_THRESHOLD_MS;
          this.offlineSince = 0;

          this._authRecoveryPending = false;
          this._authRecoveryAttempts = 0;

          this.updateState({
            status: CollabStatus.SYNCED,
            storeFailed: false,
            ...(wasLongOffline ? { longOfflineDetected: true } : {}),
          });

          this.startHeartbeat();
        },

        onDisconnect: ({ event }) => {
          this.stopHeartbeat();
          if (this._disconnecting) return;

          const wsEvent = event as CloseEvent | undefined;
          const code = wsEvent?.code ?? 0;

          // 上游 Unauthorized：依赖内建重连已停，走可恢复认证路径（勿与 4001 业务强关混淆）
          if (code === HOCUSPOCUS_UNAUTHORIZED_CODE) {
            this.beginAuthRecovery("hocuspocus_unauthorized");
            return;
          }

          if (isForceCloseCode(code)) {
            if (isDocumentRestoredCode(code)) {
              if (this._state.status !== CollabStatus.CONNECTING && this._state.status !== CollabStatus.SYNCING) {
                console.log("[CollabProvider] onDisconnect fallback: document_restored (code=4005), triggering forceReconnect");
                this.forceReconnect();
              }
              return;
            }

            this._disconnecting = true;
            this.flushToIndexedDB().catch(() => {});

            const existing = this._state.forceCloseMessage;
            this.updateState({
              status: CollabStatus.FORCE_CLOSED,
              connectionStatus: CollabConnectionStatus.FAILED,
              forceCloseMessage: existing ?? {
                type: "force_close",
                reason: codeToReason(code),
                code,
                message: codeToMessage(code),
                timestamp: new Date().toISOString(),
              },
            });
            this.destroyHocuspocusOnly();
            return;
          }

          if (this._state.status !== CollabStatus.FORCE_CLOSED) {
            if (this.offlineSince === 0) {
              this.offlineSince = Date.now();
            }
            this.logConnectionEvent("connect_error", { code });
            this.updateState({
              status: CollabStatus.DISCONNECTED,
              connectionStatus: CollabConnectionStatus.FAILED,
            });
          }
        },

        onClose: ({ event }) => {
          if (this._disconnecting) return;

          const wsEvent = event as CloseEvent | undefined;
          const code = wsEvent?.code ?? 0;

          if (code === HOCUSPOCUS_UNAUTHORIZED_CODE) {
            // onDisconnect 已处理；避免重复
            return;
          }

          if (isForceCloseCode(code)) {
            if (isDocumentRestoredCode(code)) return;

            const existing = this._state.forceCloseMessage;
            this.updateState({
              status: CollabStatus.FORCE_CLOSED,
              connectionStatus: CollabConnectionStatus.FAILED,
              forceCloseMessage: existing ?? {
                type: "force_close",
                reason: codeToReason(code),
                code,
                message: codeToMessage(code),
                timestamp: new Date().toISOString(),
              },
            });
            return;
          }

          this.logConnectionEvent("connect_error", {
            code,
            reason: wsEvent?.reason || "websocket_closed",
          });
        },

        onAwarenessUpdate: ({ states }: { states: Array<{ clientId: number; [key: string]: any }> }) => {
          if (this._disconnecting) return;
          const peers = this.parseAwarenessStates(states);

          for (const listener of this.awarenessListeners) {
            try {
              listener(peers);
            } catch (err) {
              console.error("[CollabProvider] Awareness listener error:", err);
            }
          }

          const fp = this.computePeersFingerprint(peers);
          if (fp === this._peersFingerprint) return;
          this._peersFingerprint = fp;
          this.updateState({ peers });
        },

        onStateless: ({ payload }) => {
          if (this._disconnecting) return;
          this.handleStatelessMessage(payload);
        },

        onAuthenticated: () => {
          if (this._disconnecting) return;
          const scope = (this.provider as unknown as { authorizedScope?: string } | null)?.authorizedScope;
          this.updateState({ readOnly: scope === "readonly" });
        },

        onAuthenticationFailed: ({ reason }: { reason: string }) => {
          if (this._disconnecting) return;
          if (isPermanentPermissionDenial(reason)) {
            this.enterPermissionDeniedState(reason);
            return;
          }
          // 协议级失败：可恢复（重建 Provider + 刷新 token）。
          // TabTin 业务 4001 仍走 force-close 终态。
          this.beginAuthRecovery("auth_failed");
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.provider = null;
      this.logConnectionEvent("connect_error", { message }, "error");
      this.updateState({
        status: CollabStatus.DISCONNECTED,
        connectionStatus: CollabConnectionStatus.FAILED,
        lastError: `collab_provider_init_failed: ${message}`,
      });
      return false;
    }

    this.provider.setAwarenessField("user", this.options.user);
    return true;
  }

  /** 仅销毁 Hocuspocus 实例，保留 Y.Doc / IndexedDB */
  private destroyHocuspocusOnly(): void {
    const p = this.provider;
    this.provider = null;
    if (!p) return;
    // 防止 disconnect/destroy 同步触发 onDisconnect 重入认证恢复
    const prev = this._disconnecting;
    this._disconnecting = true;
    try {
      p.disconnect();
    } catch {
      // ignore
    }
    try {
      p.destroy();
    } catch {
      // ignore
    }
    this._disconnecting = prev;
  }

  /** 明确权限拒绝是业务终态：销毁底层 Provider，禁止 token recovery / 自动重连。 */
  private enterPermissionDeniedState(serverReason?: string): void {
    if (this._state.status === CollabStatus.FORCE_CLOSED) return;

    this.stopHeartbeat();
    this._authRecoveryPending = false;
    this._authRebuildScheduled = false;
    this._disconnecting = true;
    this.flushToIndexedDB().catch(() => {});
    this.updateState({
      status: CollabStatus.FORCE_CLOSED,
      connectionStatus: CollabConnectionStatus.FAILED,
      lastError: "permission_denied",
      forceCloseMessage: {
        type: "force_close",
        reason: "permission_denied",
        code: CloseCode.PERMISSION_DENIED,
        message: serverReason || codeToMessage(CloseCode.PERMISSION_DENIED),
        timestamp: new Date().toISOString(),
      },
    });
    this.destroyHocuspocusOnly();
  }

  /**
   * : 上游认证坏状态恢复。
   * 保留 Y.Doc，销毁坏掉的 HocuspocusProvider，请求刷新 token，并在有 token 时立即重建一次。
   */
  private beginAuthRecovery(reason: string): void {
    if (this._state.status === CollabStatus.FORCE_CLOSED) return;
    if (this._authRecoveryPending && this._authRecoveryAttempts >= MAX_AUTH_RECOVERY_ATTEMPTS) {
      return;
    }

    console.warn(`[CollabProvider] auth recovery (${reason}): rebuild provider, keep Y.Doc`);

    this.stopHeartbeat();
    this.destroyHocuspocusOnly();

    if (this.offlineSince === 0) {
      this.offlineSince = Date.now();
    }

    this._authRecoveryPending = true;
    this.updateState({
      status: CollabStatus.DISCONNECTED,
      connectionStatus: CollabConnectionStatus.FAILED,
      lastError: "auth_failed",
      ydoc: this.ydoc,
      providerGeneration: this._providerGeneration,
    });

    try {
      this.options.onTokenRefreshRequired?.();
    } catch (err) {
      console.error("[CollabProvider] onTokenRefreshRequired during auth recovery failed:", err);
    }

    // 同 token 也可能修好依赖内部 shouldConnect=false；每轮恢复最多排队重建一次。
    // updateToken 若先到：只更新 _latestToken，由本次 microtask 使用新 token，避免双重建。
    this.scheduleAuthRebuild();
  }

  /** 认证恢复周期内最多排队一次 Provider 重建 */
  private scheduleAuthRebuild(): void {
    if (!(this._latestToken ?? "").trim()) return;
    if (this._authRecoveryAttempts >= MAX_AUTH_RECOVERY_ATTEMPTS) return;
    if (this._authRebuildScheduled) return;

    this._authRecoveryAttempts += 1;
    this._authRebuildScheduled = true;
    queueMicrotask(() => {
      this._authRebuildScheduled = false;
      if (this._state.status === CollabStatus.FORCE_CLOSED) return;
      if (!this._authRecoveryPending) return;
      // 已有连接中的新实例则不再毁建（token getter 会带上最新 JWT）
      if (
        this.provider
        && (
          this._state.status === CollabStatus.CONNECTING
          || this._state.status === CollabStatus.SYNCING
          || this._state.status === CollabStatus.SYNCED
        )
      ) {
        return;
      }
      this.forceRebuildProvider();
    });
  }

  /**
   * 仅重建 HocuspocusProvider，保留 Y.Doc 与 IndexedDB。
   * 用于 4401 / 协议认证失败后的恢复，避免 forceReconnect 丢本地编辑。
   */
  forceRebuildProvider(reason = "auth_recovery"): void {
    if (this._state.status === CollabStatus.FORCE_CLOSED) return;

    const serverUrl = (this.options.serverUrl ?? "").trim();
    const authToken = (this._latestToken ?? "").trim();
    if (!serverUrl || !authToken) {
      this.updateState({
        status: CollabStatus.DISCONNECTED,
        connectionStatus: CollabConnectionStatus.FAILED,
        lastError: !serverUrl ? "missing_collab_server_url" : "missing_collab_token",
      });
      return;
    }

    this._disconnecting = true;
    this.stopHeartbeat();
    this.destroyHocuspocusOnly();
    this._disconnecting = false;

    this._retryCount += 1;
    this._connectionAttemptCount = 0;
    this._providerGeneration += 1;
    this.logConnectionEvent("retry", {
      reason,
      retryCount: this._retryCount,
      generation: this._providerGeneration,
    });
    // STUCK_CONNECTING 粘滞：watchdog 判定挂起后，重建期间保持该状态直到真正
    // CONNECTED（onConnect）或用户手动重连，避免 UI 在「异常 ↔ 重连中」间闪跳。
    const keepStuck =
      this._state.connectionStatus === CollabConnectionStatus.STUCK_CONNECTING
      && reason !== "manual";
    this.updateState({
      status: CollabStatus.CONNECTING,
      connectionStatus: keepStuck
        ? CollabConnectionStatus.STUCK_CONNECTING
        : CollabConnectionStatus.RECONNECTING,
      lastError: null,
      ydoc: this.ydoc,
      providerGeneration: this._providerGeneration,
    });

    if (!this.attachHocuspocusProvider(serverUrl)) {
      return;
    }
  }

  /**
   * 网络恢复、watchdog 或用户手动触发的主动恢复。
   * 只重建底层 HocuspocusProvider，保留 Y.Doc 与 IndexedDB 中的本地状态。
   */
  recoverConnection(reason: "watchdog" | "online" | "visibility" | "focus" | "manual"): boolean {
    if (
      this._state.status === CollabStatus.FORCE_CLOSED
      || this._state.serverShutdown
      || this._state.connectionStatus === CollabConnectionStatus.CONNECTED
    ) {
      return false;
    }
    // 配置/认证类错误挡自动恢复（空转无意义）；manual 是用户显式意图放行——
    // 重建经 token getter 取最新 JWT，auth_failed 后手动重试是合理路径
    // （缺 serverUrl/token 时 forceRebuildProvider 会早退置 FAILED，无害）。
    if (reason !== "manual" && isNonRetryableCollabError(this._state.lastError)) {
      return false;
    }

    if (reason === "watchdog") {
      const watchdogTriggerCount = this._state.watchdogTriggerCount + 1;
      this.logConnectionEvent("watchdog_trigger", {
        generation: this._providerGeneration,
        retryCount: this._retryCount,
        watchdogTriggerCount,
      }, "warn");
      this.updateState({
        connectionStatus: CollabConnectionStatus.STUCK_CONNECTING,
        watchdogTriggerCount,
      });
      // 供宿主环境（如 Electron 主进程网络栈自愈）聚合监听；浏览器外无监听者，无害。
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        try {
          window.dispatchEvent(new CustomEvent(COLLAB_STUCK_CONNECTING_EVENT, {
            detail: {
              documentName: this.options.documentName,
              watchdogTriggerCount,
            },
          }));
        } catch {
          // ignore
        }
      }
    }

    this.forceRebuildProvider(reason);
    return true;
  }

  /**
   * 断开连接并清理
   */
  disconnect(): void {
    this._disconnecting = true;
    this.stopHeartbeat();

    // 0. best-effort 刷新 IndexedDB 未落盘数据（CC-009）
    this.flushToIndexedDB().catch(() => {});

    // 1. 断开 IndexedDB
    if (this.idbPersistence) {
      try {
        this.idbPersistence.destroy();
      } catch {
        // 忽略
      }
      this.idbPersistence = null;
    }

    // 2. 断开 Hocuspocus provider（会触发 onDisconnect/onClose，但守卫会跳过）
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }

    // 3. 最后销毁 Y.Doc
    this.ydoc.destroy();

    this._peersFingerprint = "";
    this.offlineSince = 0;
    this.awarenessListeners.clear();
    this.updateState({ ...INITIAL_COLLAB_STATE });
  }

  /**
   * COL-022: 更新认证 token（默认不重建连接）。
   *
   * 认证恢复中：优先只写入 _latestToken，由已排队的单次 rebuild 使用；
   * 若尚未排队且无可用 provider，再 scheduleAuthRebuild（仍保证一轮最多一次）。
   */
  updateToken(newToken: string): void {
    if (!newToken) return;
    const changed = this._latestToken !== newToken;
    this._latestToken = newToken;

    // 初始 connect 因缺 token 失败后，token 到达则立刻连接
    if (
      !this.provider
      && this._state.status === CollabStatus.DISCONNECTED
      && this._state.lastError === "missing_collab_token"
      && !this._authRecoveryPending
    ) {
      this.connect();
      return;
    }

    if (this._authRecoveryPending) {
      // 已排队 / 已在连：getter 会用新 token，勿再 forceRebuild
      this.scheduleAuthRebuild();
      return;
    }

    // COL-023: If the server previously requested a token refresh,
    // send the fresh token now (the initial auto-reply may have used a stale token).
    if (changed && this._tokenRefreshPending && this.provider) {
      this._tokenRefreshPending = false;
      this.provider.sendStateless(JSON.stringify({
        type: "token_refresh",
        token: newToken,
      }));
    }
  }

  /**
   * 普通重连
   *
   * CO-65: 守卫 CONNECTING/SYNCING/SYNCED 状态，避免重复连接。
   * CO-66: provider 已销毁但 Y.Doc 仍在（认证恢复）→ connect() 复用 Y.Doc；
   *        仅当 Y.Doc 已销毁时才新建。
   * 认证恢复中勿走此路径（依赖内建 connect 无法清 shouldConnect=false）。
   */
  reconnect(): void {
    if (this._state.status === CollabStatus.FORCE_CLOSED) return;
    if (this._authRecoveryPending) {
      this.scheduleAuthRebuild();
      return;
    }

    if (
      this._state.status === CollabStatus.CONNECTING ||
      this._state.status === CollabStatus.SYNCING ||
      this._state.status === CollabStatus.SYNCED
    ) {
      return;
    }

    this._disconnecting = false;

    if (!this.provider) {
      const ydocDestroyed =
        typeof (this.ydoc as { isDestroyed?: boolean }).isDestroyed === "boolean"
          ? Boolean((this.ydoc as { isDestroyed?: boolean }).isDestroyed)
          : false;
      if (ydocDestroyed) {
        this.ydoc = new Y.Doc();
        this.updateState({ isCacheReady: false, hasCachedContent: false });
      }
      this._retryCount += 1;
      this.connect();
      if (this.provider) {
        this.logConnectionEvent("retry", {
          reason: "provider_missing",
          retryCount: this._retryCount,
        });
        this.updateState({ connectionStatus: CollabConnectionStatus.RECONNECTING });
      }
      return;
    }

    this.provider.connect();
    this._retryCount += 1;
    this.logConnectionEvent("retry", {
      reason: "disconnect_backoff",
      retryCount: this._retryCount,
    });
    this.updateState({
      status: CollabStatus.CONNECTING,
      connectionStatus: CollabConnectionStatus.RECONNECTING,
    });

    if (!this.idbPersistence && this.options.enableIndexedDB !== false) {
      this.setupIndexedDB();
    }
  }

  /**
   * 强制重连：完整销毁当前连接 + Y.Doc，再重新 connect()。
   *
   * 与 reconnect() 不同，此方法绕过 SYNCED/CONNECTING/SYNCING 守卫，
   * 适用于版本恢复等场景——服务端文档已被外部替换，客户端必须丢弃本地
   * Y.Doc 并从服务端重新拉取。
   */
  async forceReconnect(): Promise<void> {
    this._disconnecting = true;
    this.stopHeartbeat();

    // 1. 销毁 IndexedDB persistence 实例（关闭连接）
    const idbName = `collab:${this.options.documentName}`;
    if (this.idbPersistence) {
      try {
        this.idbPersistence.destroy();
      } catch {
        // 忽略
      }
      this.idbPersistence = null;
    }

    // 1.5 物理删除 IndexedDB 数据库，防止旧数据被 merge 回新 Y.Doc
    // CLB-010: onblocked 时等待其他标签页关闭连接（最多 3 秒），
    // 避免旧数据在 deleteDatabase 完成前被新 Y.Doc 的 IndexeddbPersistence merge 进来。
    if (typeof indexedDB !== "undefined") {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(idbName);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => {
            console.warn("[CollabProvider] IndexedDB delete blocked by other tabs, waiting up to 3s");
            // 等待其他标签页关闭连接后 deleteDatabase 会自动完成（触发 onsuccess）。
            // 设置超时兜底：3 秒后若仍未完成则强制 resolve，避免 forceReconnect 永久挂起。
            const fallbackTimer = setTimeout(() => {
              console.warn("[CollabProvider] IndexedDB delete still blocked after 3s, proceeding anyway");
              resolve();
            }, 3000);
            // 若 deleteDatabase 在超时前完成，onsuccess 会先触发并 resolve，
            // clearTimeout 防止 fallbackTimer 重复 resolve。
            req.onsuccess = () => {
              clearTimeout(fallbackTimer);
              resolve();
            };
          };
        });
      } catch (err) {
        console.warn("[CollabProvider] Failed to delete IndexedDB:", err);
      }
    }

    // 2. 断开并销毁 Hocuspocus provider
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }

    // 3. 销毁旧 Y.Doc
    this.ydoc.destroy();

    // 4. 重置内部状态
    this._peersFingerprint = "";
    this.offlineSince = 0;
    this._disconnecting = false;
    this._authRecoveryPending = false;
    this._authRecoveryAttempts = 0;
    this._authRebuildScheduled = false;
    this._providerGeneration += 1;

    // 5. 创建全新 Y.Doc 并重新连接
    this.ydoc = new Y.Doc();
    this.updateState({
      ...INITIAL_COLLAB_STATE,
      status: CollabStatus.CONNECTING,
      connectionStatus: CollabConnectionStatus.RECONNECTING,
      ydoc: this.ydoc,
      providerGeneration: this._providerGeneration,
    });
    this.connect();
  }

  // ================================================================
  // Awareness
  // ================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.provider?.setAwarenessField('lastActive', Date.now());
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 更新自己的 Awareness 字段
   *
   * 自动附带 lastActive 时间戳（除非 key 本身就是 lastActive），
   * 确保 isPresenceStale 判定有效。
   */
  setAwarenessField(key: string, value: unknown): void {
    this.provider?.setAwarenessField(key, value);
    if (key !== 'lastActive') {
      this.provider?.setAwarenessField('lastActive', Date.now());
    }
  }

  /**
   * 订阅 Awareness 变更（绕过 fingerprint 节流）。
   *
   * CC-014 修复后 computePeersFingerprint 排除了 cursor/playhead/lastActive，
   * 导致 peers state 不再随光标变化更新。需要高频光标数据的消费者（如画布协作光标）
   * 应通过此方法直接订阅 awareness 变化。
   */
  subscribeAwareness(callback: AwarenessChangeCallback): () => void {
    this.awarenessListeners.add(callback);
    return () => {
      this.awarenessListeners.delete(callback);
    };
  }

  // ================================================================
  // Stateless 事件
  // ================================================================

  /**
   * 发送 Stateless 业务消息
   */
  sendStateless(event: StatelessEvent): void {
    if (!this.provider) return;
    this.provider.sendStateless(JSON.stringify(event));
  }

  /**
   * 监听特定类型的 Stateless 事件
   */
  onStatelessEvent(type: string, callback: StatelessCallback): () => void {
    if (!this.statelessListeners.has(type)) {
      this.statelessListeners.set(type, new Set());
    }
    this.statelessListeners.get(type)!.add(callback);

    return () => {
      this.statelessListeners.get(type)?.delete(callback);
    };
  }

  /**
   * 监听所有 Stateless 事件
   */
  onAnyStatelessEvent(callback: StatelessCallback): () => void {
    this.allStatelessListeners.add(callback);
    return () => {
      this.allStatelessListeners.delete(callback);
    };
  }

  // ================================================================
  // 状态访问
  // ================================================================

  /** 获取当前状态快照 */
  getState(): Readonly<CollabState> {
    return this._state;
  }

  /** Y.Doc 实例 */
  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  /** HocuspocusProvider 实例（高级用途） */
  getProvider(): HocuspocusProvider | null {
    return this.provider;
  }

  /** CC-016: 确认长离线提示，重置标记 */
  acknowledgeLongOffline(): void {
    if (this._state.longOfflineDetected) {
      this.updateState({ longOfflineDetected: false });
    }
  }

  /** 监听状态变更 */
  subscribe(callback: StateChangeCallback): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * 确保 Y.Doc 当前状态已持久化到 IndexedDB。
   * 用于降级前防止未持久化内容丢失（CAP-029）。
   *
   * y-indexeddb 在每次 Y.Doc update 事件时自动写入 IDB，
   * 此方法确保 IDB 已初始化完成且所有排队写入已落盘。
   */
  async flushToIndexedDB(): Promise<void> {
    const idb = this.idbPersistence;
    if (!idb) return;
    try {
      await idb.whenSynced;
      // y-indexeddb 的 _storeUpdate 在 update 事件回调中同步创建 IDB 事务，
      // 此处 yield 一个 microtick 确保任何排队的 IDB 事务完成
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch (err) {
      console.warn("[CollabProvider] flushToIndexedDB failed:", err);
    }
  }

  // ================================================================
  // 内部方法
  // ================================================================

  private setupIndexedDB(): void {
    const idbName = `collab:${this.options.documentName}`;
    try {
      this.idbPersistence = new IndexeddbPersistence(idbName, this.ydoc);
    } catch (err) {
      console.error("[CollabProvider] IndexedDB init failed, proceeding without cache:", err);
      this.updateState({
        idbError: `IndexedDB init failed: ${err instanceof Error ? err.message : String(err)}`,
        isCacheReady: true,
      });
      return;
    }

    this.idbPersistence.on("synced", () => {
      if (this._disconnecting) return;

      // CL-014: 同步完成后检查是否需要 compaction
      this.maybeCompactIndexedDB();

      this.updateState({
        isCacheReady: true,
        hasCachedContent: this.detectCachedContent(),
      });
    });

    this.idbPersistence.whenSynced
      .then(() => {
        const db = (this.idbPersistence as any)?.db as IDBDatabase | undefined;
        if (!db) return;
        db.onerror = (event) => {
          console.error("[CollabProvider] IndexedDB write error:", event);
          this.updateState({
            idbError: "IndexedDB write failed, local cache may be unavailable",
          });
        };
        db.onabort = (event) => {
          console.error("[CollabProvider] IndexedDB transaction aborted:", event);
          this.updateState({
            idbError: "IndexedDB transaction aborted, local cache may be unavailable",
          });
        };
      })
      .catch((err: unknown) => {
        console.error("[CollabProvider] IndexedDB sync failed:", err);
        this.updateState({
          idbError: `IndexedDB sync failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  /**
   * CL-014: 检测 IndexedDB 中累积的 update 条目数，超过阈值时执行 compaction。
   *
   * y-indexeddb 每次 Y.Doc update 都追加写入 IDB，不做主动 compaction。
   * 长期活跃的文档会累积大量小 update 条目，导致 IDB 存储增长和初始同步变慢。
   * 此方法在 IDB synced 后检查条目数，超过阈值时将所有 update 合并为一个完整 state。
   */
  private maybeCompactIndexedDB(): void {
    const idb = this.idbPersistence;
    if (!idb) return;

    const dbSize = (idb as any)?._dbsize as number | undefined;
    if (dbSize == null || dbSize < IDB_COMPACTION_THRESHOLD) return;

    const db = (idb as any)?.db as IDBDatabase | undefined;
    if (!db) return;

    const documentName = this.options.documentName;
    const ydoc = this.ydoc;

    try {
      const fullState = Y.encodeStateAsUpdate(ydoc);

      const storeName = "updates";
      if (!db.objectStoreNames.contains(storeName)) return;

      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      store.clear();
      store.put(fullState);

      tx.oncomplete = () => {
        (idb as any)._dbsize = 1;
        console.log(
          `[CollabProvider] IndexedDB compacted for ${documentName}: ` +
          `${dbSize} updates → 1 (${fullState.byteLength} bytes)`,
        );
      };
      tx.onerror = () => {
        console.warn("[CollabProvider] IndexedDB compaction transaction failed:", tx.error);
      };
    } catch (err) {
      console.warn("[CollabProvider] IndexedDB compaction failed:", err);
    }
  }

  /**
   * CO-38: 通用缓存内容检测 — 遍历 Y.Doc 所有共享类型，
   * 兼容 XmlFragment（TabDoc）、Y.Map（Canvas nodes/edges）、Y.Array（Slide）等。
   */
  private detectCachedContent(): boolean {
    for (const type of this.ydoc.share.values()) {
      if (type instanceof Y.XmlFragment && type.length > 0) return true;
      if (type instanceof Y.Map && type.size > 0) return true;
      if (type instanceof Y.Array && type.length > 0) return true;
      if (type instanceof Y.Text && type.length > 0) return true;
    }
    return false;
  }

  private handleStatelessMessage(payload: string): void {
    try {
      const event = JSON.parse(payload) as StatelessEvent | ForceCloseMessage;

      // COL-023: Server requests token refresh before expiry.
      // 1. Immediately reply with whatever token we have.
      // 2. Set a pending flag so updateToken() (from auth store refresh) also
      //    sends the fresh token to the server.
      // 3. Invoke the onTokenRefreshRequired callback so the consumer can
      //    trigger a proactive JWT refresh from the auth store.
      if (event.type === "token_refresh_required") {
        this._tokenRefreshPending = true;
        const freshToken = this._latestToken;
        if (freshToken && this.provider) {
          this.provider.sendStateless(JSON.stringify({
            type: "token_refresh",
            token: freshToken,
          }));
        }
        try {
          this.options.onTokenRefreshRequired?.();
        } catch (err) {
          console.error("[CollabProvider] onTokenRefreshRequired callback error:", err);
        }
      }

      // 服务端通知即将关闭：暂停重连，避免 thundering herd
      if (event.type === "server_shutdown") {
        this.updateState({ serverShutdown: true });
        try {
          this.options.onServerShutdown?.();
        } catch (err) {
          console.error("[CollabProvider] onServerShutdown callback error:", err);
        }
        setTimeout(() => {
          this.updateState({ serverShutdown: false });
        }, 10_000);
        return;
      }

      if (event.type === "permission_downgrade") {
        this.updateState({ readOnly: true });
      }

      // Server reports persist failure — update state and notify consumer
      if (event.type === "store_failed") {
        this.updateState({ storeFailed: true });
        const msg = (event as unknown as { message?: string }).message;
        if (msg) {
          try {
            this.options.onStoreFailed?.(msg);
          } catch (err) {
            console.error("[CollabProvider] onStoreFailed callback error:", err);
          }
        }
      }

      // 处理 force_close
      if (event.type === "force_close") {
        const fcMsg = event as ForceCloseMessage;

        // document_restored: 服务端因版本恢复而关闭连接。
        // 客户端应丢弃当前 Y.Doc 并重新拉取，而非进入永久 FORCE_CLOSED 终态。
        if (fcMsg.reason === "document_restored") {
          const delay = (fcMsg as { reconnect_delay_ms?: number }).reconnect_delay_ms ?? 0;
          if (delay > 0) {
            setTimeout(() => { this.forceReconnect(); }, delay);
          } else {
            this.forceReconnect();
          }
          return;
        }

        // flush Y.Doc 到 IndexedDB，防止未保存编辑丢失
        this.flushToIndexedDB().catch(() => {});

        this.updateState({
          status: CollabStatus.FORCE_CLOSED,
          connectionStatus: CollabConnectionStatus.FAILED,
          forceCloseMessage: fcMsg,
          lastError: fcMsg.message,
        });
        return;
      }

      // 分发到对应监听器
      const statelessEvent = event as StatelessEvent;
      const typeListeners = this.statelessListeners.get(statelessEvent.type);
      if (typeListeners) {
        for (const listener of typeListeners) {
          try {
            listener(statelessEvent);
          } catch (err) {
            console.error("[CollabProvider] Stateless listener error:", err);
          }
        }
      }

      // 分发到通配符监听器
      for (const listener of this.allStatelessListeners) {
        try {
          listener(statelessEvent);
        } catch (err) {
          console.error("[CollabProvider] Stateless listener error:", err);
        }
      }
    } catch {
      // 非 JSON 消息，忽略
    }
  }

  /** Awareness stale 阈值：心跳 30s × 3 = 90s，允许错过 2 次心跳 */
  private static readonly AWARENESS_STALE_MS = 90_000;

  private parseAwarenessStates(
    states: Array<{ clientId: number; [key: string]: any }>
  ): CollabPeerState[] {
    const myClientId = this.ydoc.clientID;
    const now = Date.now();

    // 按 user.id 去重：同一用户可能因 HMR/重连/多标签产生多个 clientId，
    // 保留 lastActive 最新的一条，避免头像列表和人数统计出现重复
    const bestByUserId = new Map<string, CollabPeerState>();

    for (const state of states) {
      if (state.clientId === myClientId) continue;

      const user = state.user as CollabPeerState["user"] | undefined;
      if (!user?.id) continue;

      const lastActive = state.lastActive as number | undefined;
      if (lastActive && now - lastActive > CollabProvider.AWARENESS_STALE_MS) continue;

      const peer: CollabPeerState = {
        user,
        clientId: state.clientId,
        cursor: state.cursor,
        playhead: state.playhead,
        selectedNodes: Array.isArray(state.selectedNodes) ? state.selectedNodes : undefined,
        lastActive,
      };

      const existing = bestByUserId.get(user.id);
      if (!existing || (lastActive ?? 0) > (existing.lastActive ?? 0)) {
        bestByUserId.set(user.id, peer);
      }
    }

    return Array.from(bestByUserId.values());
  }

  private computePeersFingerprint(peers: CollabPeerState[]): string {
    if (peers.length === 0) return "";
    // CC-014: 仅包含 user info 和 selection，排除 cursor/playhead/lastActive
    // cursor 坐标每帧变化会引发全量重渲染；需要实时 cursor 的消费者应直接订阅 awareness
    return peers
      .map((p) => {
        const u = p.user;
        return `${u.id}:${u.name}:${u.color}:${u.avatar ?? ""}:${u.type ?? ""}|${JSON.stringify(p.selectedNodes) ?? ""}`;
      })
      .sort()
      .join("\n");
  }

  private updateState(patch: Partial<CollabState>): void {
    this._state = { ...this._state, ...patch };

    for (const listener of this.stateListeners) {
      try {
        listener(this._state);
      } catch (err) {
        console.error("[CollabProvider] State listener error:", err);
      }
    }
  }

  private logConnectionEvent(
    event: "provider_create" | "connect_start" | "connect_success" | "connect_error" | "retry" | "watchdog_trigger",
    details: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): void {
    console[level]("[CollabProvider] connection", {
      event,
      documentName: this.options.documentName,
      connectionStatus: this._state.connectionStatus,
      ...details,
    });
  }
}
