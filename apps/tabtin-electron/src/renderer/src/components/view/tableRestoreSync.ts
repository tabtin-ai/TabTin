export type TableRestoreSyncMode = 'resync' | 'force_close' | 'failed' | 'none'

/**
 * 服务端 resync 已把恢复结果增量广播到当前 Y.Doc，再 forceReconnect 会重复重建
 * 协作状态，并可能让重连过程中的空快照把刚刷新的行从本地 store 移除。
 *
 * 旧版后端没有返回 sync_mode，继续按原行为重连，保证向后兼容。
 */
export function shouldForceReconnectAfterTableRestore(
  syncMode: TableRestoreSyncMode | string | undefined,
): boolean {
  return syncMode !== 'resync' && syncMode !== 'none'
}
