/**
 * 是否把 space.id 遗留 canvas 一次性拷进 conversation / desktop 等独立 scope。
 *
 * 升级兼容：独立 scope 从未初始化（undefined）时，可从执行 Space 的旧布局迁移，
 * 避免画布瞬间消失。
 *
 * ：用户关光独立 scope 后 key 会留下 `[]`。旧守卫用 `?.length` 把空数组当成
 * 「未迁移」，切组织 remount 时又把 space 画布灌回来 → 已关标签复活。
 * 因此「已有条目（含故意为空）」一律不再回灌；若本会话已有显式关闭修订，
 * 即使 key 尚未落盘也禁止回灌。
 */
export function shouldMigrateLegacyCanvasGroups(params: {
  isSameScope: boolean
  scopedCanvasGroups: unknown[] | undefined
  legacyCanvasGroups: unknown[] | undefined
  explicitCloseRevision?: number
}): boolean {
  if (params.isSameScope) return false
  // undefined = 从未初始化；[] = 已初始化且用户关光，禁止再拷
  if (params.scopedCanvasGroups !== undefined) return false
  if (!params.legacyCanvasGroups?.length) return false
  if ((params.explicitCloseRevision ?? 0) > 0) return false
  return true
}
