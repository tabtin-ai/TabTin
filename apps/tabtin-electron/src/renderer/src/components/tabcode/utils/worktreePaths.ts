/**
 * Worktree 路径建议的纯函数（「会话代码根」基础层）。
 *
 * 只负责默认建议路径、以及把绝对路径拆成「父目录 + 短目录名」。
 * 用户改位置后的 dirty 联动属于 UI 层（见 `useWorktreeLocation`）。
 */

/** 与仓库内 `slugifySkillName` 同口径：小写 + 分隔符归一为单个 `-`，去首尾 `-`。 */
export function slugifyBranchForWorktreePath(branch: string): string {
  const source = (branch || '').trim().toLowerCase()
  const cleaned: string[] = []
  for (const ch of source) {
    if (/[a-z0-9-]/.test(ch)) {
      cleaned.push(ch)
    } else if (/[\s_/\\.]/.test(ch)) {
      cleaned.push('-')
    }
  }
  let result = cleaned.join('')
  while (result.includes('--')) {
    result = result.replace('--', '-')
  }
  result = result.replace(/^-+|-+$/g, '')
  return result || 'branch'
}

/** posix 化 + 去尾斜杠，供路径对比复用（如 worktree 冲突避让 / 会话绑定根匹配）。 */
export function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 绝对路径拆成父目录与最后一段目录名（posix 风格；尾部斜杠已忽略）。 */
export function splitParentAndName(path: string): { parent: string; name: string } {
  const normalized = normalizePathForCompare(path)
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return { parent: '', name: normalized }
  return { parent: normalized.slice(0, idx), name: normalized.slice(idx + 1) }
}

/** 目录名不允许带路径分隔符；提交前再 trim。 */
export function sanitizeWorktreeFolderName(name: string): string {
  return name.replace(/[/\\]+/g, '-')
}

/** 拼回绝对路径。目录名为空时返回空串，避免误把 worktree 建在父目录上。 */
export function joinParentAndName(parent: string, name: string): string {
  const normalizedParent = normalizePathForCompare(parent)
  const folderName = sanitizeWorktreeFolderName(name).trim()
  if (!folderName) return ''
  return normalizedParent ? `${normalizedParent}/${folderName}` : folderName
}

export interface SuggestSiblingWorktreePathParams {
  repoRoot: string
  branch: string
  /** 已存在的 worktree 路径（用于避让冲突），无需预先归一化 */
  existingPaths?: string[]
}

/**
 * 默认建议 `<parent>/<repo>-<branch-slug>`，与已存在路径冲突时依次加 `-2`、`-3`…
 */
export function suggestSiblingWorktreePath(params: SuggestSiblingWorktreePathParams): string {
  const { repoRoot, branch, existingPaths = [] } = params
  const { parent, name: repoName } = splitParentAndName(repoRoot)
  const slug = slugifyBranchForWorktreePath(branch)
  const base = parent ? `${parent}/${repoName}-${slug}` : `${repoName}-${slug}`

  const existingSet = new Set(existingPaths.map(normalizePathForCompare))
  if (!existingSet.has(normalizePathForCompare(base))) return base

  let suffix = 2
  while (true) {
    const candidate = `${base}-${suffix}`
    if (!existingSet.has(normalizePathForCompare(candidate))) return candidate
    suffix += 1
  }
}
