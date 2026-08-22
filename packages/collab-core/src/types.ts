/**
 * @tabtin/collab-core 类型定义
 */

import type * as Y from "yjs";

// ================================================================
// 连接状态机
// ================================================================

/**
 * 协作连接状态
 *
 * initial → connecting → syncing → synced
 *                    ↘ disconnected ↗
 *                          ↓
 *                    force-closed (终态)
 */
export enum CollabStatus {
  /** 初始状态，未连接 */
  INITIAL = "initial",
  /** 正在建立 WebSocket 连接 */
  CONNECTING = "connecting",
  /** WebSocket 已连接，等待首次同步完成 */
  SYNCING = "syncing",
  /** 已同步，正常协作中 */
  SYNCED = "synced",
  /** 连接断开（可重连） */
  DISCONNECTED = "disconnected",
  /** 被服务端强制关闭（不可重连） */
  FORCE_CLOSED = "force-closed",
}

/**
 * WebSocket Provider 的连接生命周期。
 *
 * 与 CollabStatus 的“同步是否可用”语义分离，供 watchdog、诊断日志和恢复策略使用。
 */
export enum CollabConnectionStatus {
  IDLE = "idle",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  RECONNECTING = "reconnecting",
  STUCK_CONNECTING = "stuck-connecting",
  FAILED = "failed",
}

// ================================================================
// Force-Close
// ================================================================

/** WebSocket 关闭码（与 collab-live 一致） */
export enum CloseCode {
  DOCUMENT_NOT_FOUND = 4000,
  AUTH_FAILED = 4001,
  DOCUMENT_ARCHIVED = 4002,
  DOCUMENT_TOO_LARGE = 4003,
  PERMISSION_CHANGED = 4004,
  /** CLB-001: 文档已恢复到指定版本，客户端需丢弃本地 Y.Doc 并重新拉取（不进入永久终态） */
  DOCUMENT_RESTORED = 4005,
  /** Hocuspocus 明确拒绝资源访问；终态，不得自动重连。 */
  PERMISSION_DENIED = 4403,
}

/** 服务端发送的 force_close stateless 消息 */
export interface ForceCloseMessage {
  type: "force_close";
  reason: string;
  code: CloseCode;
  message: string;
  timestamp: string;
  /**
   * CLB-009: 客户端应延迟多少毫秒后再重连。
   * 用于 document_restored 场景：服务端发完 stateless 后还需 ~550ms 完成
   * 关闭连接 + Redis 广播 + unloadDocument，客户端提前重连会拿到旧 Y.Doc。
   */
  reconnect_delay_ms?: number;
}

// ================================================================
// Stateless 事件
// ================================================================

/** Stateless 业务事件 */
export interface StatelessEvent<T = unknown> {
  type: string;
  payload: T;
  sender?: string;
  timestamp?: string;
}

// ================================================================
// Provider 配置
// ================================================================

/** 协作 Provider 配置选项 */
export interface CollabProviderOptions {
  /**
   * 可选的资源运行时键。相同 key 在当前渲染进程内共享 Provider/Y.Doc/物理连接；
   * 不传时保持独占运行时，兼容既有编辑器生命周期。
   */
  sharedRuntimeKey?: string;
  /** collab-live WebSocket URL */
  serverUrl: string;
  /** 文档/房间名称 */
  documentName: string;
  /** 认证 token（JWT） */
  token: string;
  /** 当前用户信息 */
  user: CollabUser;
  /** Y.js fragment 名称，默认 "default" */
  fragmentName?: string;
  /** 是否启用 IndexedDB 本地缓存，默认 true */
  enableIndexedDB?: boolean;
  /** 连接参数（传给 HocuspocusProvider 的 parameters） */
  parameters?: Record<string, string>;
  /** Hocuspocus debounce */
  debounce?: number;
  /**
   * COL-023: Called when the server requests a token refresh.
   * Consumer should refresh the JWT and call updateToken() on the provider.
   */
  onTokenRefreshRequired?: () => void;
  /**
   * Called when the server reports that a persist (store) operation has failed.
   * Consumer can use this to display a toast / banner warning the user.
   */
  onStoreFailed?: (message: string) => void;
  /**
   * Called when the server notifies it is about to shut down (planned maintenance).
   * Consumer can display a "maintenance" banner instead of a generic "offline" indicator.
   */
  onServerShutdown?: () => void;
}

/** 协作用户信息 */
export interface CollabUser {
  id: string;
  name: string;
  color: string;
  /** "user" | "agent" — persist 层统一标准 */
  type?: string;
  avatar?: string;
}

/** Awareness 中其他用户的状态 */
export interface CollabPeerState {
  user: CollabUser;
  /** Yjs awareness clientId — 每个浏览器标签唯一 */
  clientId?: number;
  /** 当前活跃的 cell/block/cursor 位置 */
  cursor?: unknown;
  /** 播放头位置（视频协同等模块使用） */
  playhead?: unknown;
  /** 选中的元素 ID 列表（画布协作等模块使用） */
  selectedNodes?: string[];
  /** 最后活跃时间 */
  lastActive?: number;
}

// ================================================================
// Provider 状态快照
// ================================================================

/** Provider 当前状态快照 */
export interface CollabState {
  /** 连接状态 */
  status: CollabStatus;
  /** Provider 连接生命周期状态 */
  connectionStatus: CollabConnectionStatus;
  /** Y.js 文档实例 */
  ydoc: Y.Doc | null;
  /** 在线协作者列表 */
  peers: CollabPeerState[];
  /** IndexedDB 是否已同步 */
  isCacheReady: boolean;
  /** IndexedDB 中是否有缓存内容 */
  hasCachedContent: boolean;
  /** force-close 消息（如果有） */
  forceCloseMessage: ForceCloseMessage | null;
  /** 最近一次错误消息 */
  lastError: string | null;
  /** IndexedDB 写入/同步错误（非 null 时表示本地缓存不可用） */
  idbError: string | null;
  /** CC-016: 检测到长时间离线后重连 */
  longOfflineDetected: boolean;
  /** Server reported that a persist (store) operation has failed */
  storeFailed: boolean;
  /** 服务端通知即将关闭（计划维护），暂停重连 */
  serverShutdown: boolean;
  /** 服务端已将当前协作连接降级为只读 */
  readOnly: boolean;
  /**
   * HocuspocusProvider 实例世代号。
   * forceRebuildProvider（认证恢复）时递增，Y.Doc 不变；
   * 供编辑器绑定新 CollaborationCursor 做受控 remount。
   */
  providerGeneration: number;
  /**
   * 本轮连接尝试内 CONNECTING watchdog 的连续触发次数。
   * 网络栈坏死时握手永远无回调（ 线上 case），status 恒为 CONNECTING，
   * disconnectTimedOut 计时永不启动——此计数是挂起场景唯一的降级信号。
   * 连接成功（onConnect）时清零。
   */
  watchdogTriggerCount: number;
}

/** 初始状态 */
export const INITIAL_COLLAB_STATE: CollabState = {
  status: CollabStatus.INITIAL,
  connectionStatus: CollabConnectionStatus.IDLE,
  ydoc: null,
  peers: [],
  isCacheReady: false,
  hasCachedContent: false,
  forceCloseMessage: null,
  lastError: null,
  idbError: null,
  longOfflineDetected: false,
  storeFailed: false,
  serverShutdown: false,
  readOnly: false,
  providerGeneration: 0,
  watchdogTriggerCount: 0,
};
