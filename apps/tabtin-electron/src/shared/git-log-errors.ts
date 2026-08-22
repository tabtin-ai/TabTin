/**
 * git log 失败分类：供 main IPC 与 renderer 空态共用。
 */

export type GitLogFailureReason =
  | 'invalid_cwd'
  | 'path_not_found'
  | 'permission_denied'
  | 'git_error'

/** 零提交仓库时 git log 的典型 stderr，应映射为空列表而非 UI 错误。 */
export function isEmptyRepositoryLogError(message: string): boolean {
  const lower = message.toLowerCase()
  // 仅匹配明确「尚无提交」类文案；勿把任意 unknown revision 当成空仓。
  if (lower.includes('does not have any commits yet')) return true
  if (lower.includes('your current branch') && lower.includes('does not have any commits')) {
    return true
  }
  if (lower.includes("bad default revision 'head'") || lower.includes('bad default revision "head"')) {
    return true
  }
  // 部分 git 版本：fatal: bad default revision 'HEAD'
  if (/bad default revision ['"]head['"]/i.test(message)) return true
  return false
}
