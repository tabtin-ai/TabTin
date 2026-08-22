/**
 * useOfflineReplay — 通用重连回放 Hook
 *
 * 监听协作连接从 offline → online 的状态变化，
 * 自动将离线期间缓存的操作回放到 Y.Doc。
 *
 * 各模块保留自己的 PendingXxxWrite 类型和 replayXxx 实现，
 * 只复用本 Hook 提供的「监听重连 + 调用 replay」流程。
 *
 * @example
 * ```ts
 * const pendingRef = useRef<PendingTableWrite[]>([])
 *
 * useOfflineReplay({
 *   isOnline,
 *   ydoc: collab.ydoc,
 *   pendingRef,
 *   replay: replayPendingTableWrites,
 * })
 * ```
 */

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type * as Y from "yjs";

export interface UseOfflineReplayOptions<T> {
  /** 协作连接是否在线（SYNCED 或 SYNCING） */
  isOnline: boolean;
  /** Y.Doc 实例，null 时跳过回放 */
  ydoc: Y.Doc | null;
  /** 离线期间缓存的操作队列 */
  pendingRef: MutableRefObject<T[]>;
  /**
   * 将缓存的操作回放到 Y.Doc。
   * 由各模块提供具体实现（如 replayPendingTableWrites）。
   */
  replay: (ydoc: Y.Doc, ops: T[]) => void;
}

export function useOfflineReplay<T>({
  isOnline,
  ydoc,
  pendingRef,
  replay,
}: UseOfflineReplayOptions<T>): void {
  const prevOnlineRef = useRef(isOnline);
  const replayRef = useRef(replay);
  replayRef.current = replay;

  useEffect(() => {
    const wasOffline = !prevOnlineRef.current;
    prevOnlineRef.current = isOnline;

    if (!wasOffline || !isOnline || !ydoc) return;

    const pending = pendingRef.current;
    if (pending.length === 0) return;

    const snapshot = [...pending];
    try {
      replayRef.current(ydoc, snapshot);
      pendingRef.current = [];
    } catch (err) {
      console.error("[useOfflineReplay] replay failed, pending ops preserved for retry:", err);
    }
  }, [isOnline, ydoc, pendingRef]);
}
