/**
 * 多文件 Skill 发布前的目录收集。
 *
 * Skill 本质是一个目录（SKILL.md + references/ + scripts/ …）。发布时递归遍历
 * 目录，把文本内容收集成后端 publish 需要的 `files: [{ path, content }]`。
 *
 * 与后端 `SkillService._entries_from_publish_files` 契约对齐：
 * - `path` 用相对 skillDir 的 posix 相对路径（无前导 `/`、无 `..`）；
 * - 必须包含 SKILL.md（根或子目录）；
 * - 文本项 `content` 是 UTF-8 文本（`encoding` 省略=默认 text）；
 * - 二进制项 `content` 是 base64 字符串、`encoding: 'base64'`，后端解码原样落盘；
 * - 总大小 ≤ 20MB（二进制按解码后的真实字节数计入预算）。
 *
 * 收集策略：
 * - 文本文件（readFilePreview kind === 'text'）直接收文本；
 * - 二进制资源（kind !== 'text'，如 png / 图标 / 字体）走 readBinaryFile 读全量字节,
 *   base64 编码后随 files[] 上传，保证图片/字体等资源原样带出（不再丢弃）；
 * - 文本单文件 > 2MB 跳过（readFilePreview 截断）；二进制单文件 > 20MB 跳过（按真实字节）；
 * - 累计 > 20MB 的后续文件跳过；
 * - 运行时无 readBinaryFile 能力（旧 preload / 测试桩）时二进制保持「跳过」语义。
 */

import { stripSkillMdFileVersion } from './skillMdUtils'

/** 发布包总大小上限（与后端 `_MAX_EXTRACTED_TOTAL` 对齐）。 */
export const MAX_SKILL_BUNDLE_BYTES = 20 * 1024 * 1024

/** 单文件上限：超过则按「过大」跳过（readFilePreview 会截断，整文无法发布）。 */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024

/**
 * 不进发布包的非隐藏目录名（依赖 / 缓存）。
 * 凡 basename 以 `.` 开头的条目一律跳过，见 {@link shouldIgnoreSkillEntryName}。
 */
export const IGNORED_SKILL_ENTRY_NAMES = new Set(['node_modules', '__pycache__'])

/** 发布收集时是否跳过该目录项（隐藏文件/目录 + 已知脏目录）。 */
export function shouldIgnoreSkillEntryName(name: string): boolean {
  return name.startsWith('.') || IGNORED_SKILL_ENTRY_NAMES.has(name)
}

export interface CollectedSkillFile {
  /** 相对 skillDir 的 posix 路径，如 `SKILL.md` / `references/style.md`。 */
  path: string
  /** 文本项=UTF-8 文本；二进制项=base64 字符串（见 `encoding`）。 */
  content: string
  /** `'base64'` 表示 `content` 是二进制资源的 base64；省略/默认=UTF-8 文本。 */
  encoding?: 'base64'
}

export type SkillFileSkipReason = 'binary' | 'too-large' | 'read-error' | 'bundle-limit'

export interface SkippedSkillFile {
  path: string
  reason: SkillFileSkipReason
}

export interface CollectSkillFilesResult {
  files: CollectedSkillFile[]
  skipped: SkippedSkillFile[]
  totalBytes: number
}

export interface SkillFsDirEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

/** collectSkillFiles 依赖的最小文件系统接口（= window.tabtin.fileSystem 子集，便于单测注入）。 */
export interface SkillFsLike {
  readDir(path: string): Promise<{
    success: boolean
    entries?: SkillFsDirEntry[]
    error?: string
  }>
  readFilePreview(
    path: string,
    options?: { maxBytes?: number },
  ): Promise<{
    success: boolean
    data?: { kind: string; content?: string; size?: number; truncated?: boolean }
    error?: string
  }>
  /** 读取整文件原始字节，用于二进制资源（png/字体…）的 base64 收集。可选：旧 preload 无此能力时二进制按「跳过」处理。 */
  readBinaryFile?(path: string): Promise<{
    success: boolean
    data?: ArrayBuffer
    error?: string
  }>
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length
  }
  // 兜底：无 TextEncoder 环境按 UTF-8 估算。
  return unescape(encodeURIComponent(text)).length
}

/**
 * ArrayBuffer → 标准 base64（无换行）。分块 fromCharCode 避免大 buffer 撑爆调用栈，
 * 与后端 `base64.b64decode` 严格往返（解码字节 === 原始字节）。
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000 // 32KB / 次，远低于 fromCharCode 参数上限
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 按扩展名判定「应当走二进制通道」的资源（图片 / 图标 / 字体 / 压缩包 / 可执行等）。
 *
 * 注意：`svg` 是文本 XML，**不在此列**——它走文本通道直接导入。本判定供导入侧
 * （只有 File 对象、拿不到 readFilePreview 的 kind）做分流；发布侧用 readFilePreview
 * 的 kind 更精确，不依赖扩展名。
 */
const BINARY_SKILL_EXT_RE =
  /\.(png|jpe?g|gif|webp|ico|bmp|mp[34]|wav|ogg|pdf|zip|tar|gz|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat)$/i

export function isLikelyBinaryPath(p: string): boolean {
  return BINARY_SKILL_EXT_RE.test(p)
}

/** 绝对路径 → 相对 rootPath 的 posix 路径；不在 root 下时退回 basename。 */
export function toSkillRelPath(rootPath: string, absPath: string): string {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = absPath.replace(/\\/g, '/')
  if (normalized === root) return ''
  if (normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1)
  }
  return normalized.split('/').filter(Boolean).pop() ?? normalized
}

export function hasSkillMd(files: ReadonlyArray<{ path: string }>): boolean {
  return files.some(f => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
}

function normalizeCollectedText(rel: string, content: string): string {
  return rel === 'SKILL.md' || rel.endsWith('/SKILL.md')
    ? stripSkillMdFileVersion(content)
    : content
}

/**
 * 递归收集 skillDir 下的文本文件成发布用 files[]。
 *
 * @param rootPath skill 目录绝对路径
 * @param fs       文件系统接口（运行时传 window.tabtin.fileSystem）
 * @param overrides 绝对路径 → 最新编辑缓冲内容；命中则用内存内容（保证发布的是用户刚保存的版本）
 */
export async function collectSkillFiles(
  rootPath: string,
  fs: SkillFsLike,
  overrides?: Record<string, string>,
): Promise<CollectSkillFilesResult> {
  const files: CollectedSkillFile[] = []
  const skipped: SkippedSkillFile[] = []
  let totalBytes = 0
  const overrideMap = overrides ?? {}

  const pushWithinBudget = (
    rel: string,
    content: string,
    byteSize: number,
    encoding?: 'base64',
  ): void => {
    // 文本单文件上限 2MB（readFilePreview 截断约束）；二进制资源（字体/大图）放宽到
    // 整包预算 20MB，与导入侧一致——避免「导入进来的大资源一发布就被悄悄丢弃」。
    const perFileCap = encoding === 'base64' ? MAX_SKILL_BUNDLE_BYTES : MAX_SKILL_FILE_BYTES
    if (byteSize > perFileCap) {
      skipped.push({ path: rel, reason: 'too-large' })
      return
    }
    if (totalBytes + byteSize > MAX_SKILL_BUNDLE_BYTES) {
      skipped.push({ path: rel, reason: 'bundle-limit' })
      return
    }
    totalBytes += byteSize
    files.push(
      encoding === 'base64'
        ? { path: rel, content, encoding }
        : { path: rel, content },
    )
  }

  // 二进制资源：读全量字节 → base64 → 随 files[] 上传（encoding='base64'）。
  const collectBinary = async (
    rel: string,
    absPath: string,
    knownSize?: number,
  ): Promise<void> => {
    // 读盘前先用 readFilePreview 报告的 size 做粗筛，避免把超大文件整个读进内存。
    if (typeof knownSize === 'number' && knownSize > MAX_SKILL_BUNDLE_BYTES) {
      skipped.push({ path: rel, reason: 'too-large' })
      return
    }
    const readBin = fs.readBinaryFile
    if (!readBin) {
      // 运行时无二进制读取能力（旧 preload / 测试桩）→ 保持原「跳过」语义。
      skipped.push({ path: rel, reason: 'binary' })
      return
    }
    let bin: Awaited<ReturnType<NonNullable<SkillFsLike['readBinaryFile']>>>
    try {
      bin = await readBin(absPath)
    } catch {
      skipped.push({ path: rel, reason: 'read-error' })
      return
    }
    if (!bin?.success || !bin.data) {
      skipped.push({ path: rel, reason: 'read-error' })
      return
    }
    const byteSize = bin.data.byteLength
    if (byteSize > MAX_SKILL_BUNDLE_BYTES) {
      skipped.push({ path: rel, reason: 'too-large' })
      return
    }
    pushWithinBudget(rel, arrayBufferToBase64(bin.data), byteSize, 'base64')
  }

  // 收集顺序排序：SKILL.md 最优先（必备文件，绝不能因 20MB 预算被挤掉），
  // 再普通文件，最后子目录；同档按名称稳定排序。
  const entryRank = (e: SkillFsDirEntry): number => {
    if (!e.isDirectory && e.name === 'SKILL.md') return 0
    if (!e.isDirectory) return 1
    return 2
  }

  const walk = async (dirPath: string): Promise<void> => {
    const res = await fs.readDir(dirPath)
    if (!res?.success || !res.entries) return
    const entries = [...res.entries].sort((a, b) => {
      const ra = entryRank(a)
      const rb = entryRank(b)
      if (ra !== rb) return ra - rb
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (shouldIgnoreSkillEntryName(entry.name)) continue
      if (entry.isDirectory) {
        await walk(entry.path)
        continue
      }
      const rel = toSkillRelPath(rootPath, entry.path)
      if (!rel) continue

      const override = overrideMap[entry.path]
      if (typeof override === 'string') {
        // overrides 是编辑器内存里的文本缓冲，始终按文本处理。
        const content = normalizeCollectedText(rel, override)
        pushWithinBudget(rel, content, utf8ByteLength(content))
        continue
      }

      let preview: Awaited<ReturnType<SkillFsLike['readFilePreview']>>
      try {
        preview = await fs.readFilePreview(entry.path, { maxBytes: MAX_SKILL_FILE_BYTES })
      } catch {
        skipped.push({ path: rel, reason: 'read-error' })
        continue
      }
      if (!preview?.success || !preview.data) {
        skipped.push({ path: rel, reason: 'read-error' })
        continue
      }
      const data = preview.data
      if (data.kind !== 'text') {
        // 真二进制：走 base64 全量收集（不再丢弃图片/字体等资源）。
        await collectBinary(rel, entry.path, data.size)
        continue
      }
      if (data.truncated || (typeof data.size === 'number' && data.size > MAX_SKILL_FILE_BYTES)) {
        skipped.push({ path: rel, reason: 'too-large' })
        continue
      }
      const content = normalizeCollectedText(rel, data.content ?? '')
      pushWithinBudget(rel, content, utf8ByteLength(content))
    }
  }

  await walk(rootPath)
  return { files, skipped, totalBytes }
}
