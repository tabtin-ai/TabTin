import { useState, useRef, useEffect, useCallback } from 'react';
import { toast } from '@tabtin/smartsheet-ui';
import { useTableCollabStore } from '@stores/useTableCollabStore';
import type { CollabPeerState } from '@tabtin/collab-core';
import type { UseDataGridCollabBridgeResult } from '../controller/useDataGridCollabBridge';
import {
  claimTableSurfaceAwareness,
  releaseTableSurfaceAwareness,
} from '../tableSurfaceAwareness';

export interface UseDataGridCollabSyncUIInput {
  collabBridge: UseDataGridCollabBridgeResult;
  selectedTableId: string | null;
  fields: ReadonlyArray<{ id: string; name: string }>;
  surfaceId: string;
  isSurfaceActive: boolean;
  publishRuntimeControls: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export type DisconnectPhase = 'none' | 'connecting' | 'disconnected' | 'restored';

export interface UseDataGridCollabSyncUIResult {
  disconnectPhase: DisconnectPhase;
  disconnectSeconds: number;
  handleForceReconnect: () => void;
  handleCollabCellFocus: (selState: {
    activeCell?: { rowId?: string; field?: string } | null;
  }) => void;
}

export function useDataGridCollabSyncUI(
  input: UseDataGridCollabSyncUIInput,
): UseDataGridCollabSyncUIResult {
  const {
    collabBridge,
    selectedTableId,
    fields,
    surfaceId,
    isSurfaceActive,
    publishRuntimeControls,
    t,
  } = input;

  // ── 同步协作 Presence 到全局 store（供 TablePaneHeader 等消费） ──
  const syncPresence = useTableCollabStore((state) => state.syncPresence);
  useEffect(() => {
    syncPresence({
      tableId: selectedTableId ?? null,
      status: collabBridge.collab.status,
      connectionStatus: collabBridge.collab.connectionStatus,
      isOnline: collabBridge.collab.isOnline,
      isFallback: collabBridge.collab.isFallback,
      syncModeReason: collabBridge.collab.syncModeReason ?? null,
      isTruncated: collabBridge.collab.isTruncated,
      peers: collabBridge.collab.peers,
      // 徽标手动重连走 manualReconnect（重建 Provider 保留 Y.Doc），
      // 勿用 forceReconnect（丢弃语义，供 checkpoint 恢复场景）。
      reconnectFn: collabBridge.collab.manualReconnect,
    });
  }, [
    selectedTableId,
    collabBridge.collab.status,
    collabBridge.collab.connectionStatus,
    collabBridge.collab.isOnline,
    collabBridge.collab.isFallback,
    collabBridge.collab.syncModeReason,
    collabBridge.collab.isTruncated,
    collabBridge.collab.peers,
    collabBridge.collab.manualReconnect,
    syncPresence,
  ]);

  // ── 通过 awareness 订阅实时光标更新（绕过 fingerprint 节流） ──
  const syncPeerCursors = useTableCollabStore((state) => state.syncPeerCursors);
  useEffect(() => {
    if (collabBridge.collab.isFallback) {
      console.debug('[CollabCursor] awareness subscription skipped: collab is in fallback mode')
      return
    }
    if (!selectedTableId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestPeers: CollabPeerState[] | null = null;

    const flush = () => {
      timer = null;
      if (latestPeers && selectedTableId) {
        syncPeerCursors(selectedTableId, latestPeers);
      }
    };

    const unsub = collabBridge.collab.subscribeAwareness((peers) => {
      latestPeers = peers;
      if (!timer) {
        timer = setTimeout(flush, 150);
      }
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [selectedTableId, collabBridge.collab.subscribeAwareness, collabBridge.collab.isFallback, syncPeerCursors]);

  // ── 协作断连/重连三阶段 ──
  // connecting: 断连 0-3s，轻量提示
  // disconnected: 断连 >3s，计时器 + 重连按钮 + 安心文案
  // restored: 重连后 3s 淡出
  const [disconnectPhase, setDisconnectPhase] = useState<DisconnectPhase>('none');
  const [disconnectSeconds, setDisconnectSeconds] = useState(0);
  const prevIsConnectedRef = useRef(collabBridge.isConnected);
  const disconnectStartRef = useRef<number | null>(null);

  useEffect(() => {
    // 预期权限降级（如字段可见性 REST 投影）：不是断连，勿展示重连 banner
    if (collabBridge.collab.isFallback) {
      prevIsConnectedRef.current = collabBridge.isConnected;
      disconnectStartRef.current = null;
      setDisconnectSeconds(0);
      setDisconnectPhase('none');
      return;
    }

    const prev = prevIsConnectedRef.current;
    prevIsConnectedRef.current = collabBridge.isConnected;

    if (collabBridge.isConnected) {
      const hadVisibleDisconnect = disconnectPhase === 'disconnected';
      disconnectStartRef.current = null;
      setDisconnectSeconds(0);

      if (!prev && hadVisibleDisconnect) {
        setDisconnectPhase('restored');
        const restoredTimer = setTimeout(() => setDisconnectPhase('none'), 3000);
        return () => clearTimeout(restoredTimer);
      }
      setDisconnectPhase('none');
      return;
    }

    disconnectStartRef.current = Date.now();
    setDisconnectPhase('connecting');

    const escalateTimer = setTimeout(() => {
      setDisconnectPhase('disconnected');
    }, 3000);

    const tickInterval = setInterval(() => {
      if (disconnectStartRef.current) {
        setDisconnectSeconds(Math.floor((Date.now() - disconnectStartRef.current) / 1000));
      }
    }, 1000);

    return () => {
      clearTimeout(escalateTimer);
      clearInterval(tickInterval);
    };
  }, [collabBridge.isConnected, collabBridge.collab.isFallback, disconnectPhase]);

  const handleForceReconnect = useCallback(() => {
    collabBridge.collab.forceReconnect();
  }, [collabBridge.collab.forceReconnect]);

  // ── 同步协作 Undo/Redo 到全局 store ──
  const syncUndoRedo = useTableCollabStore((state) => state.syncUndoRedo);
  useEffect(() => {
    if (!publishRuntimeControls) return
    if (collabBridge.collab.isFallback) {
      console.debug('[CollabCursor] syncUndoRedo skipped: collab is in fallback mode')
      return
    }
    syncUndoRedo({
      tableId: selectedTableId,
      canUndo: collabBridge.collab.collabCanUndo,
      canRedo: collabBridge.collab.collabCanRedo,
      undoFn: collabBridge.collab.collabUndo,
      redoFn: collabBridge.collab.collabRedo,
      subscribeStackEvent: collabBridge.collab.onUndoManagerEvent,
    });
  }, [
    collabBridge.collab.isFallback,
    collabBridge.collab.collabCanUndo,
    collabBridge.collab.collabCanRedo,
    collabBridge.collab.collabUndo,
    collabBridge.collab.collabRedo,
    collabBridge.collab.onUndoManagerEvent,
    selectedTableId,
    syncUndoRedo,
    publishRuntimeControls,
  ]);

  // ── 并发编辑检测（LWW 温和提示） ──
  const lastConcurrentWarningRef = useRef<string | null>(null);
  const checkConcurrentEdit = useCallback(
    (recordId: string, fieldId: string) => {
      if (!selectedTableId) return;
      const peerCursors =
        useTableCollabStore.getState().tables[selectedTableId]?.peerCursors ?? [];
      const conflicting = peerCursors.find(
        (pc) => pc.recordId === recordId && pc.fieldId === fieldId,
      );
      if (!conflicting) {
        lastConcurrentWarningRef.current = null;
        return;
      }
      const key = `${conflicting.userId}:${recordId}:${fieldId}`;
      if (lastConcurrentWarningRef.current === key) return;
      lastConcurrentWarningRef.current = key;
      toast({
        title: t('table:collab.concurrentEditWarning', { user: conflicting.userName }),
        duration: 3000,
      });
    },
    [selectedTableId, t],
  );

  const clearOwnedCellFocus = useCallback(() => {
    if (!selectedTableId) return;
    if (!releaseTableSurfaceAwareness(selectedTableId, surfaceId)) return;
    collabBridge.collab.broadcastCellFocus(null, null, surfaceId);
  }, [collabBridge.collab.broadcastCellFocus, selectedTableId, surfaceId]);

  useEffect(() => {
    if (!isSurfaceActive) clearOwnedCellFocus();
    return clearOwnedCellFocus;
  }, [clearOwnedCellFocus, isSurfaceActive]);

  // ── 选中 cell 时广播 Awareness（Presence 光标） ──
  const handleCollabCellFocus = useCallback(
    (selState: { activeCell?: { rowId?: string; field?: string } | null }) => {
      if (collabBridge.collab.isFallback) {
        console.debug('[CollabCursor] broadcastCellFocus skipped: collab is in fallback mode')
        return
      }
      if (!isSurfaceActive) {
        clearOwnedCellFocus();
        return;
      }
      const cell = selState?.activeCell;
      if (cell?.rowId && cell?.field) {
        const matchedField = fields.find((f) => f.name === cell.field);
        const fieldId = matchedField?.id ?? cell.field;
        if (selectedTableId) {
          claimTableSurfaceAwareness(selectedTableId, surfaceId);
        }
        collabBridge.collab.broadcastCellFocus(cell.rowId, fieldId, surfaceId);
        checkConcurrentEdit(cell.rowId, fieldId);
      } else {
        clearOwnedCellFocus();
      }
    },
    [
      collabBridge.collab.isFallback,
      collabBridge.collab.broadcastCellFocus,
      clearOwnedCellFocus,
      fields,
      isSurfaceActive,
      checkConcurrentEdit,
      selectedTableId,
      surfaceId,
    ],
  );

  return {
    disconnectPhase,
    disconnectSeconds,
    handleForceReconnect,
    handleCollabCellFocus,
  };
}
