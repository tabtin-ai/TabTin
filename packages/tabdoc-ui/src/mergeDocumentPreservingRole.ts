import type { TabdocDocument } from './api-client'

/**
 * 写接口偶发不回填 ``current_user_role``。前端分享门控
 * ``canManage = role in {owner,admin}`` 只认该字段；整对象替换时若丢掉角色，
 * 所有者会看到「你的权限不足以邀请或修改协作者」。
 *
 * 当 next 缺角色而 prev 仍有时保留 prev；next 显式带来新角色则采用 next。
 */
export function mergeDocumentPreservingRole(
  prev: TabdocDocument | null | undefined,
  next: TabdocDocument,
): TabdocDocument {
  const nextRole = next.current_user_role
  if (nextRole != null) {
    return next
  }
  const prevRole = prev?.current_user_role
  if (prevRole != null) {
    return { ...next, current_user_role: prevRole }
  }
  return next
}
