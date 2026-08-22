/** 当前渲染进程内，每张表只能由一个交互 surface 代表本机广播光标。 */
const activeSurfaceByTable = new Map<string, string>()

export function claimTableSurfaceAwareness(tableId: string, surfaceId: string): void {
  activeSurfaceByTable.set(tableId, surfaceId)
}

/** 返回 true 表示调用方仍是 owner，应当清除 Provider 上的本机光标。 */
export function releaseTableSurfaceAwareness(tableId: string, surfaceId: string): boolean {
  if (activeSurfaceByTable.get(tableId) !== surfaceId) return false
  activeSurfaceByTable.delete(tableId)
  return true
}

export function resetTableSurfaceAwarenessForTests(): void {
  activeSurfaceByTable.clear()
}
