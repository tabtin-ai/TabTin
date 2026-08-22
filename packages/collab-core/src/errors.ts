/**
 * 协作错误码规范 + 客户端 Fallback 策略
 *
 * 定义所有协作相关的错误码、用户提示文案、客户端应对策略。
 */

import { CloseCode, CollabStatus } from "./types.js";

// ================================================================
// 错误码定义
// ================================================================

export interface CollabErrorSpec {
  /** 错误码 */
  code: number;
  /** 简短描述 */
  name: string;
  /** 用户可见的提示文案 */
  userMessage: string;
  /** 是否可重连 */
  retryable: boolean;
  /** 客户端应对策略 */
  fallback: FallbackStrategy;
}

export enum FallbackStrategy {
  /** 自动重连（指数退避） */
  AUTO_RECONNECT = "auto_reconnect",
  /** 降级为只读模式 */
  READONLY = "readonly",
  /** 降级为旧同步链路（WS 事件 + HTTP） */
  LEGACY_SYNC = "legacy_sync",
  /** 提示用户刷新 */
  PROMPT_RELOAD = "prompt_reload",
  /** 无动作（终态） */
  NONE = "none",
}

/**
 * 协作错误码规范表
 */
export const COLLAB_ERROR_SPECS: Record<number, CollabErrorSpec> = {
  // ── WebSocket 关闭码（4000-4004） ──
  [CloseCode.DOCUMENT_NOT_FOUND]: {
    code: CloseCode.DOCUMENT_NOT_FOUND,
    name: "DOCUMENT_NOT_FOUND",
    userMessage: "文档不存在或已被删除",
    retryable: false,
    fallback: FallbackStrategy.NONE,
  },
  [CloseCode.AUTH_FAILED]: {
    code: CloseCode.AUTH_FAILED,
    name: "AUTH_FAILED",
    userMessage: "认证失败，请重新登录",
    retryable: false,
    fallback: FallbackStrategy.PROMPT_RELOAD,
  },
  [CloseCode.DOCUMENT_ARCHIVED]: {
    code: CloseCode.DOCUMENT_ARCHIVED,
    name: "DOCUMENT_ARCHIVED",
    userMessage: "文档已归档，进入只读模式",
    retryable: false,
    fallback: FallbackStrategy.READONLY,
  },
  [CloseCode.DOCUMENT_TOO_LARGE]: {
    code: CloseCode.DOCUMENT_TOO_LARGE,
    name: "DOCUMENT_TOO_LARGE",
    userMessage: "文档内容过大，已超过协作限制",
    retryable: false,
    fallback: FallbackStrategy.LEGACY_SYNC,
  },
  [CloseCode.PERMISSION_CHANGED]: {
    code: CloseCode.PERMISSION_CHANGED,
    name: "PERMISSION_CHANGED",
    userMessage: "文档权限已变更，请刷新页面",
    retryable: false,
    fallback: FallbackStrategy.PROMPT_RELOAD,
  },
  [CloseCode.PERMISSION_DENIED]: {
    code: CloseCode.PERMISSION_DENIED,
    name: "PERMISSION_DENIED",
    userMessage: "无权限访问该协作资源",
    retryable: false,
    fallback: FallbackStrategy.NONE,
  },

  // ── 通用网络错误 ──
  1006: {
    code: 1006,
    name: "ABNORMAL_CLOSURE",
    userMessage: "网络连接异常，正在重连...",
    retryable: true,
    fallback: FallbackStrategy.AUTO_RECONNECT,
  },
  1001: {
    code: 1001,
    name: "GOING_AWAY",
    userMessage: "服务器正在重启，稍后自动重连...",
    retryable: true,
    fallback: FallbackStrategy.AUTO_RECONNECT,
  },
  1011: {
    code: 1011,
    name: "INTERNAL_ERROR",
    userMessage: "服务器内部错误，正在重连...",
    retryable: true,
    fallback: FallbackStrategy.AUTO_RECONNECT,
  },
};

/**
 * 根据 WebSocket 关闭码获取错误规范
 */
export function getErrorSpec(code: number): CollabErrorSpec {
  return (
    COLLAB_ERROR_SPECS[code] ?? {
      code,
      name: "UNKNOWN",
      userMessage: "连接断开",
      retryable: true,
      fallback: FallbackStrategy.AUTO_RECONNECT,
    }
  );
}

/**
 * 根据当前状态判断是否应该降级到旧链路
 *
 * 触发条件（任一即可）：
 * 1. FORCE_CLOSED + DOCUMENT_TOO_LARGE → LEGACY_SYNC
 * 2. DISCONNECTED 超过 DISCONNECT_TIMEOUT_MS → 自动降级
 */
export function shouldFallbackToLegacy(
  status: CollabStatus,
  errorCode?: number,
  disconnectTimedOut?: boolean,
): boolean {
  if (disconnectTimedOut) return true;
  if (status === CollabStatus.FORCE_CLOSED && errorCode) {
    const spec = getErrorSpec(errorCode);
    return spec.fallback === FallbackStrategy.LEGACY_SYNC;
  }
  return false;
}
