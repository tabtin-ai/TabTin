import { parseResourcePointer } from '@tabtin/resource-router'
import type { OpenResourceTabParams, ResourcePointer } from '@tabtin/resource-router'
import { localFilePreviewRegistry } from '@components/shared/file-preview/localFilePreviewRegistry'
import { isFileRecordId } from '@components/chat/preview/resolveOssFileAccessUrl'

/**
 * 可打开的本地文件类型 = 前端预览能力，由 localFilePreviewRegistry 注册式定义。
 * 与生成端（agent-runtime ArtifactFormatRegistry）解耦：新增可预览类型只需在
 * registry 注册一项，本文件无需改动。
 */
const unsupportedOpenMessage = () =>
  `当前只支持打开 ${localFilePreviewRegistry.extensions().join(' / ')} 本地产物`

export interface PathExistsResult {
  success: boolean
  exists: boolean
  isFile?: boolean
  isDirectory?: boolean
  size?: number
  mtimeMs?: number
  error?: string
}

export interface ResolveLocalFileResourceOptions {
  pointer: ResourcePointer
  workingDir: string | null | undefined
  pathExists?: (absolutePath: string) => Promise<PathExistsResult>
}

export interface ResolvedLocalFilePath {
  relativePath: string
  filename: string
  workingDir: string
  absolutePath: string
  stat?: PathExistsResult
}

/** 临时目录首段：这些路径不当交付物（打开链路拒收，产物聚合也跳过）。 */
export const TEMP_DIR_SEGMENTS: ReadonlySet<string> = new Set(['tmp', 'temp', '.tmp', '.temp'])

export function shouldResolveAsLocalFile(pointer: ResourcePointer): boolean {
  if (pointer.scheme !== 'tabtin' || pointer.type !== 'file') return false
  //  / ：FileRecord UUID / 显式 oss_file 走 OSS 预览，不走 working_dir
  if (pointer.meta?.['artifact_kind'] === 'oss_file') return false
  const normalizedId = normalizeLocalPath(pointer.id)
  if (isFileRecordId(normalizedId) || isFileRecordId(pointer.id)) return false
  if (pointer.hint === 'tabfiles') return true
  if (pointer.meta?.['artifact_kind'] === 'local_file') return true
  return localFilePreviewRegistry.getByPath(normalizedId) != null
}

/** 相对路径是否落在前端预览白名单（与 resolveLocalFileResource 闸门一致）。 */
export function isLocalFilePreviewSupported(relativePath: string): boolean {
  return localFilePreviewRegistry.getByPath(relativePath) != null
}

/** href 是否指向执行设备工作目录内的本地文件（云端 doc/table/oss 资源返回 false）。 */
export function isLocalFileArtifactHref(href: string): boolean {
  try {
    return shouldResolveAsLocalFile(parseResourcePointer(href))
  } catch {
    return false
  }
}

/** 本地产物但落在预览白名单之外（dmg / zip / 可执行等）——应降级系统应用打开。 */
export function isUnsupportedLocalArtifactHref(href: string): boolean {
  try {
    const pointer = parseResourcePointer(href)
    if (!shouldResolveAsLocalFile(pointer)) return false
    return !isLocalFilePreviewSupported(normalizeLocalPath(pointer.id))
  } catch {
    return false
  }
}

/** 本地 HTML 产物——走内嵌浏览器渲染，而非 TabFiles 源码预览。 */
export function isLocalHtmlArtifactHref(href: string): boolean {
  try {
    const pointer = parseResourcePointer(href)
    if (!shouldResolveAsLocalFile(pointer)) return false
    const id = normalizeLocalPath(pointer.id).toLowerCase()
    return id.endsWith('.html') || id.endsWith('.htm')
  } catch {
    return false
  }
}

export async function resolveLocalFileResource(
  opts: ResolveLocalFileResourceOptions,
): Promise<OpenResourceTabParams | null> {
  const { pointer } = opts
  if (!shouldResolveAsLocalFile(pointer)) return null

  const relativePath = normalizeRelativeArtifactPath(pointer.id)
  const format = localFilePreviewRegistry.getByPath(relativePath)
  if (!format) {
    throw new Error(unsupportedOpenMessage())
  }
  const fileType = format.fileType

  const resolvedPath = await resolveLocalFilePath(opts)
  if (!resolvedPath) return null
  const { workingDir, absolutePath, filename, stat } = resolvedPath
  const refreshedAt = Date.now()
  const refreshToken = buildLocalFileRefreshToken(absolutePath, stat, refreshedAt)
  return {
    type: 'file',
    id: relativePath,
    title: typeof pointer.meta?.['title'] === 'string' ? pointer.meta['title'] : filename,
    meta: {
      ...(pointer.meta ?? {}),
      artifact_kind: 'local_file',
      file_type: fileType,
      relative_path: relativePath,
      filename,
      working_dir: workingDir,
      absolute_path: absolutePath,
      path: absolutePath,
      source: 'working_dir',
      local_file_refresh_token: refreshToken,
      local_file_refreshed_at: refreshedAt,
    },
  }
}

export async function resolveLocalFilePath(
  opts: ResolveLocalFileResourceOptions,
): Promise<ResolvedLocalFilePath | null> {
  const { pointer } = opts
  if (!shouldResolveAsLocalFile(pointer)) return null

  const relativePath = normalizeRelativeArtifactPath(pointer.id)
  const workingDir = normalizeWorkingDir(opts.workingDir)
  const absolutePath = joinInsideWorkingDir(workingDir, relativePath)
  let stat: PathExistsResult | undefined

  if (opts.pathExists) {
    try {
      stat = await opts.pathExists(absolutePath)
    } catch (err) {
      throw new Error(`文件已删除或不可用：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!stat.success) {
      throw new Error(stat.error || '文件已删除或不可用')
    }
    if (!stat.exists || stat.isDirectory || stat.isFile === false) {
      throw new Error('文件已删除或不可用')
    }
  }

  return {
    relativePath,
    filename: basename(relativePath),
    workingDir,
    absolutePath,
    stat,
  }
}

export function normalizeLocalPath(input: string): string {
  const raw = String(input ?? '').replace(/\\/g, '/')
  const drive = raw.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? ''
  const absoluteRoot = drive ? '' : (raw.startsWith('/') ? '/' : '')
  const prefix = drive || absoluteRoot
  let rest = raw.slice(prefix.length)
  if (drive && rest.startsWith('/')) rest = rest.slice(1)

  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!prefix) {
        parts.push(segment)
      }
      continue
    }
    parts.push(segment)
  }

  const normalizedRest = parts.join('/')
  if (drive) return normalizedRest ? `${drive}/${normalizedRest}` : `${drive}/`
  if (absoluteRoot) return normalizedRest ? `/${normalizedRest}` : '/'
  return normalizedRest
}

/**
 * 剥掉 LLM / 正文链接误带的 shell 路径引号。
 * 成对包裹与孤立首/尾 `"` / `'` 都会去掉。
 */
export function stripShellPathQuotes(input: string): string {
  let s = String(input ?? '').trim()
  if (
    s.length >= 2
    && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim()
  }
  while (s.startsWith('"') || s.startsWith("'")) s = s.slice(1)
  while (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1)
  return s.trim()
}

export function isAbsoluteLocalPath(input: string): boolean {
  const normalized = String(input ?? '').replace(/\\/g, '/')
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
}

function normalizeRelativeArtifactPath(input: string): string {
  const raw = stripShellPathQuotes(String(input ?? '').trim())
  if (!raw) throw new Error('文件路径不可用')
  if (isAbsoluteLocalPath(raw)) throw new Error('只支持 Agent 工作目录内的相对路径')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    throw new Error('只支持 Agent 工作目录内的相对路径')
  }

  const normalized = normalizeLocalPath(raw)
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error('文件路径不可用')
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('文件路径不可用')
  }
  const firstSegment = normalized.split('/')[0]?.toLowerCase()
  if (firstSegment && TEMP_DIR_SEGMENTS.has(firstSegment)) {
    throw new Error('不支持打开临时目录里的本地产物')
  }
  return normalized
}

function normalizeWorkingDir(workingDir: string | null | undefined): string {
  if (!workingDir) {
    throw new Error('需要先设置或创建 Agent 工作目录')
  }
  const normalized = normalizeLocalPath(workingDir)
  if (!normalized || !isAbsoluteLocalPath(normalized)) {
    throw new Error('需要先设置或创建 Agent 工作目录')
  }
  return normalized
}

function joinInsideWorkingDir(workingDir: string, relativePath: string): string {
  const absolutePath = normalizeLocalPath(`${workingDir}/${relativePath}`)
  if (absolutePath !== workingDir && !absolutePath.startsWith(`${workingDir}/`)) {
    throw new Error('文件路径不可用')
  }
  return absolutePath
}

function basename(input: string): string {
  return input.split('/').filter(Boolean).pop() || input
}

function buildLocalFileRefreshToken(
  absolutePath: string,
  stat: PathExistsResult | undefined,
  fallbackMtimeMs: number,
): string {
  const size = Number.isFinite(stat?.size) ? stat?.size : 'unknown'
  const mtime = Number.isFinite(stat?.mtimeMs) ? stat?.mtimeMs : fallbackMtimeMs
  return `${absolutePath}:${size}:${mtime}`
}
