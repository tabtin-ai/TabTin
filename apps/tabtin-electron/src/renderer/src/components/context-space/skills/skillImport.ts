/**
 * 导入侧：把一批文件按 SKILL.md 所在目录拆成多个独立 skill，并把每个 skill 物化到本地。
 *
 * 背景：一个仓库可能打包多个 skill（如 nature-skills 的 `skills/nature-<slug>/SKILL.md`，
 * 11 个各自独立的 skill）。导入要按「每个含 SKILL.md 的目录 = 一个 skill」拆开，
 * 分别导入为独立 skill。
 *
 * 另外，`POST /skills/import` 只把文件写到后端 Django 沙箱，**不落本地 platform-data**
 * （Agent 实际读的根），导致导入后「列表里有、点开报『无法打开 Skill 目录』」的空壳。
 * `materializeImportedSkill` 在导入成功后把 files 写进本地 skill 目录，闭合这个缺口。
 */

import { joinPath, getParentPath } from '@components/shared/file-utils'
import { ensureSkillMdName } from './skillMdUtils'
import { shouldIgnoreSkillEntryName } from './skillPublishFiles'

export interface ImportFileEntry {
  /** posix 相对路径（相对所选文件夹根）。 */
  path: string
  /** 文本=UTF-8；二进制=base64（见 encoding）。 */
  content: string
  /** `'base64'` 表示 content 是二进制资源的 base64；省略=文本。 */
  encoding?: 'base64'
}

export interface SkillImportGroup {
  /** 该 skill 的展示名（SKILL.md 父目录最后一段；根 skill 用 fallback）。 */
  name: string
  /** 该 skill 的文件，path 已重写为相对该 skill 根（SKILL.md 落在组根）。 */
  files: ImportFileEntry[]
}

function isSkillMdPath(p: string): boolean {
  return p === 'SKILL.md' || p.endsWith('/SKILL.md')
}

/** 取 SKILL.md 所在的 skill 根（相对路径前缀，根 skill 为 ''）。 */
function skillRootOf(skillMdPath: string): string {
  if (skillMdPath === 'SKILL.md') return ''
  return skillMdPath.slice(0, -'/SKILL.md'.length)
}

/**
 * 相对路径任一段是脏目录 / 隐藏项时跳过（对齐发布收集与后端 bundle 校验）。
 * 例：`node_modules/pkg/index.js`、`__pycache__/x.pyc`、`.DS_Store`。
 */
export function isIgnoredSkillImportPath(relPath: string): boolean {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some(part => shouldIgnoreSkillEntryName(part))
}

/**
 * 按 SKILL.md 所在目录把文件分组成多个独立 skill。
 *
 * - 每个含 SKILL.md 的目录 = 一个 skill；该目录下的文件归该组，path 重写为相对组根。
 * - 更深的 skill 根优先认领文件，避免父 skill 吞掉子 skill 的文件。
 * - 不归属任何 skill 根的文件（README / 共享目录如 `_shared`）被忽略——独立 skill
 *   不跨目录带（`_shared` 这类共享资源是已知限制，引用可能断）。
 * - 单 skill（只有一个 SKILL.md）→ 返回单组，与旧行为一致。
 * - 没有任何 SKILL.md → 返回空数组（调用方据此报错）。
 */
export function groupFilesBySkill(
  files: ImportFileEntry[],
  fallbackName: string,
): SkillImportGroup[] {
  const roots = [...new Set(
    files.filter(f => isSkillMdPath(f.path)).map(f => skillRootOf(f.path)),
  )]
  if (roots.length === 0) return []

  // 深度降序：先让更深的 skill 根认领，父根（含 '')最后捡剩余。
  const sortedRoots = roots.sort((a, b) => b.length - a.length)
  const claimed = new Set<string>()
  const groups: SkillImportGroup[] = []

  for (const root of sortedRoots) {
    const prefix = root === '' ? '' : `${root}/`
    const groupFiles: ImportFileEntry[] = []
    for (const f of files) {
      if (claimed.has(f.path)) continue
      if (root !== '' && !f.path.startsWith(prefix)) continue
      claimed.add(f.path)
      const rel = root === '' ? f.path : f.path.slice(prefix.length)
      if (isIgnoredSkillImportPath(rel)) continue
      groupFiles.push({ ...f, path: rel })
    }
    const name = root === '' ? fallbackName : (root.split('/').filter(Boolean).pop() || fallbackName)
    groups.push({ name, files: groupFiles })
  }

  return groups.sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillImportFsLike {
  writeFile(path: string, content: string): Promise<{ success: boolean; error?: string }>
  writeBinaryFile(path: string, base64Data: string): Promise<{ success: boolean; error?: string }>
  createDir(path: string): Promise<{ success: boolean; error?: string }>
}

/** 从 skill 目录路径取最后一段作为唯一 slug（与后端 `_resolve_unique_slug` 目录名对齐）。 */
export function skillDirCanonicalSlug(skillDir: string): string {
  const parts = skillDir.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

/**
 * `fs:createDir` 要求父目录已存在（禁止 recursive 复活幽灵路径）。
 * 物化时必须从 skill 根往下逐段建齐中间目录，不能只建叶子父目录。
 */
export function collectMaterializeDirChain(skillDir: string, fileRelPath: string): string[] {
  const skillNorm = skillDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const parent = getParentPath(joinPath(skillNorm, fileRelPath)).replace(/\\/g, '/')
  if (!parent || parent === skillNorm) return []
  if (parent === '/' || !parent.startsWith(`${skillNorm}/`)) {
    return parent ? [parent] : []
  }
  const rel = parent.slice(skillNorm.length + 1)
  const dirs: string[] = []
  let current = skillNorm
  for (const part of rel.split('/').filter(Boolean)) {
    current = `${current}/${part}`
    dirs.push(current)
  }
  return dirs
}

/**
 * 把一个 skill 的 files 物化到本地 skill 目录（`skillDir` 由 `skill:resolve-path` 得到）。
 *
 * 先建齐所有子目录，再逐个写文件：文本走 writeFile，二进制（encoding=base64）走
 * writeBinaryFile（IPC 层接受 base64 字符串、原样解码落盘）。任一文件写失败抛错。
 *
 * 写 SKILL.md 时会把顶层 `name` 改成目录名（唯一 slug），避免导入撞名后
 * frontmatter 仍写原名、Agent 索引与斜杠命令对不上。
 */
export async function materializeImportedSkill(
  fs: SkillImportFsLike,
  skillDir: string,
  files: ImportFileEntry[],
  options?: { canonicalSlug?: string },
): Promise<void> {
  const writableFiles = files.filter(f => !isIgnoredSkillImportPath(f.path))
  const dirs = new Set<string>()
  dirs.add(skillDir)
  for (const f of writableFiles) {
    for (const dir of collectMaterializeDirChain(skillDir, f.path)) {
      dirs.add(dir)
    }
  }
  // 先建 skill 根目录，再按浅目录优先建子目录，避免 SKILL.md 单文件导入时父目录不存在。
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
    const res = await fs.createDir(d)
    if (!res?.success) {
      throw new Error(res?.error || `创建目录失败: ${d}`)
    }
  }
  const canonicalSlug = (options?.canonicalSlug?.trim() || skillDirCanonicalSlug(skillDir)).trim()
  for (const f of writableFiles) {
    const abs = joinPath(skillDir, f.path)
    let content = f.content
    if (
      f.encoding !== 'base64'
      && canonicalSlug
      && (f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
    ) {
      content = ensureSkillMdName(content, canonicalSlug)
    }
    const res = f.encoding === 'base64'
      ? await fs.writeBinaryFile(abs, content)
      : await fs.writeFile(abs, content)
    if (!res?.success) {
      throw new Error(res?.error || `写入失败: ${f.path}`)
    }
  }
}

/**
 * 批量导入成功后，对每个 skill 依次执行「导入后启用」。
 * 以前只启用了第一个；调用方必须传完整列表，不能只传 [0]。
 */
export async function enableAllImportedSkills<T>(
  items: Array<{ key: string; payload: T }>,
  enableOne: (payload: T, key: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    if (!item.key) continue
    await enableOne(item.payload, item.key)
  }
}

export { mapSkillImportError } from './mapSkillImportError'
