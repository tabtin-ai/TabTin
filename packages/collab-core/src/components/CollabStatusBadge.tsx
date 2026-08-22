/**
 * CollabStatusBadge — 连接状态指示器
 *
 * 显示当前协作连接状态：🟢已同步 / 🟡同步中 / 🔴离线 / ⛔强制断开
 *
 * Package-level component uses English defaults.
 * Apps layer can supply translated labels via the `labels` prop.
 */

import React from "react";
import { CollabConnectionStatus, CollabStatus } from "../types.js";

export interface CollabStatusBadgeProps {
  status: CollabStatus;
  /**
   * Provider 连接生命周期状态。传入后 STUCK_CONNECTING 会覆盖 CONNECTING
   * 的展示（挂起 ≠ 正常连接中），并参与可点击重连的判定。
   */
  connectionStatus?: CollabConnectionStatus;
  /** 紧凑模式（只显示圆点） */
  compact?: boolean;
  /** Override default English labels with translated strings */
  labels?: Partial<Record<CollabStatus, string>>;
  /** STUCK_CONNECTING 覆盖文案（默认英文） */
  stuckLabel?: string;
  /**
   * 手动重连回调。提供后，CONNECTING / DISCONNECTED / STUCK_CONNECTING
   * 状态下徽标渲染为可点击按钮。回调应重建底层 Provider 并保留 Y.Doc
   * （useCollabProvider().manualReconnect），勿用丢弃本地状态的 forceReconnect。
   */
  onReconnect?: () => void;
  /** 可点击时的 tooltip 提示（默认英文） */
  reconnectHint?: string;
  className?: string;
}

const STATUS_STYLE: Record<
  CollabStatus,
  { color: string; dotColor: string }
> = {
  [CollabStatus.INITIAL]: {
    color: "text-muted-foreground",
    dotColor: "bg-muted-foreground",
  },
  [CollabStatus.CONNECTING]: {
    color: "text-warning",
    dotColor: "bg-warning",
  },
  [CollabStatus.SYNCING]: {
    color: "text-warning",
    dotColor: "bg-warning",
  },
  [CollabStatus.SYNCED]: {
    color: "text-success",
    dotColor: "bg-success",
  },
  [CollabStatus.DISCONNECTED]: {
    color: "text-destructive",
    dotColor: "bg-destructive",
  },
  [CollabStatus.FORCE_CLOSED]: {
    color: "text-destructive",
    dotColor: "bg-destructive",
  },
};

const STUCK_STYLE = {
  color: "text-destructive",
  dotColor: "bg-destructive",
};

const DEFAULT_LABELS: Record<CollabStatus, string> = {
  [CollabStatus.INITIAL]: "Not connected",
  [CollabStatus.CONNECTING]: "Connecting…",
  [CollabStatus.SYNCING]: "Syncing…",
  [CollabStatus.SYNCED]: "Synced",
  [CollabStatus.DISCONNECTED]: "Offline",
  [CollabStatus.FORCE_CLOSED]: "Disconnected",
};

const DEFAULT_STUCK_LABEL = "Connection issue, retrying…";
const DEFAULT_RECONNECT_HINT = "Click to reconnect";

/** 这些状态下允许手动重连（SYNCED/SYNCING 不需要，FORCE_CLOSED 不可重连） */
function canManualReconnect(
  status: CollabStatus,
  connectionStatus?: CollabConnectionStatus,
): boolean {
  if (connectionStatus === CollabConnectionStatus.STUCK_CONNECTING) return true;
  return (
    status === CollabStatus.CONNECTING || status === CollabStatus.DISCONNECTED
  );
}

export const CollabStatusBadge: React.FC<CollabStatusBadgeProps> = ({
  status,
  connectionStatus,
  compact = false,
  labels,
  stuckLabel,
  onReconnect,
  reconnectHint,
  className = "",
}) => {
  const isStuck = connectionStatus === CollabConnectionStatus.STUCK_CONNECTING;
  const style = isStuck ? STUCK_STYLE : STATUS_STYLE[status];
  const label = isStuck
    ? (stuckLabel ?? DEFAULT_STUCK_LABEL)
    : (labels?.[status] ?? DEFAULT_LABELS[status]);
  const isAnimating =
    !isStuck
    && (status === CollabStatus.CONNECTING || status === CollabStatus.SYNCING);
  const clickable = onReconnect != null && canManualReconnect(status, connectionStatus);
  const title = clickable
    ? `${label} — ${reconnectHint ?? DEFAULT_RECONNECT_HINT}`
    : label;

  const content = (
    <>
      <span className="relative flex h-2 w-2">
        {isAnimating && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${style.dotColor} opacity-75`}
          />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${style.dotColor}`}
        />
      </span>
      {!compact && <span>{label}</span>}
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={onReconnect}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded text-body ${style.color} hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${className}`}
        title={title}
        aria-label={title}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-body ${style.color} ${className}`}
      title={title}
    >
      {content}
    </span>
  );
};
