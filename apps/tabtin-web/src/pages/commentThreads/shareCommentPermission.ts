/**
 * 分享页评论权限：仅 comment / edit 可读写评论；view 不请求 threads。
 */

export type ShareDocPermission = 'view' | 'comment' | 'edit' | string

export function canAccessShareComments(permission: ShareDocPermission | null | undefined): boolean {
  return permission === 'comment' || permission === 'edit'
}

export function canEditShareDocument(permission: ShareDocPermission | null | undefined): boolean {
  return permission === 'edit'
}

/** 可评论但不可改正文：需要可选择的只读编辑器 */
export function needsSelectableReadonlyShareEditor(
  permission: ShareDocPermission | null | undefined,
): boolean {
  return permission === 'comment'
}
