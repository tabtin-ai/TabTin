export interface SharedTableAccessInput {
  shareType: string
  permission: string
  requiresLogin?: boolean
  isAuthenticated: boolean
}

export interface SharedTableAccess {
  requiresLogin: boolean
  useWorkspace: boolean
  canOpenRecordDetail: boolean
  canComment: boolean
  canEdit: boolean
  showLoginToEdit: boolean
}

/**
 * 公开分享权限到 Web 展示能力的唯一映射。
 *
 * comment/edit 都是登录后协作；view 即使访问者已登录，也不暴露评论入口。
 */
export function resolveSharedTableAccess({
  shareType,
  permission,
  requiresLogin = false,
  isAuthenticated,
}: SharedTableAccessInput): SharedTableAccess {
  const collaborativePermission = permission === 'comment' || permission === 'edit'
  // requiresLogin 是旧契约里“协作动作需要登录”的兼容字段；data 的读取仍公开。
  const readRequiresLogin = shareType === 'organization'
    || (shareType !== 'data' && requiresLogin)
  const loginRequired = readRequiresLogin && !isAuthenticated
  const canComment = isAuthenticated && collaborativePermission
  const canEdit = isAuthenticated && permission === 'edit'
  const showLoginToEdit = shareType === 'data'
    && permission === 'edit'
    && !isAuthenticated

  return {
    requiresLogin: loginRequired,
    // comment 分享本身是授权边界，不应该被折算成普通 Table ACL。
    // 只有 edit 分享进入依赖完整表格 store/API 的工作台。
    useWorkspace: canEdit,
    canOpenRecordDetail: canComment,
    canComment,
    canEdit,
    showLoginToEdit,
  }
}
