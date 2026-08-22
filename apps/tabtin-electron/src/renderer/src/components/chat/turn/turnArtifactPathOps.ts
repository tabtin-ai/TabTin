/**
 * 本轮产物 path 账本 —— 工作区相对路径过滤 + 轮末净算用的时序操作。
 *
 * ：各通道入账路径必须先 canonicalize，再以小写 key 净算；
 * 否则 `./foo`（write_file）与 `foo`（shell file_history）无法抵消，
 * 已删采集 JSON 仍会挂在产物卡上。
 */
import { stripShellPathQuotes, TEMP_DIR_SEGMENTS } from '../../../services/localFileResourceResolver'

/** 轮内路径时序操作：create/modify（deleted=false）加、delete 减（跨 write/edit/delete/shell/local_file）。 */
export interface FileHistoryOp {
  path: string
  deleted: boolean
  artifactId: string
  /** local_file rich 带来的已知体积；shell/write 路径通常未知。 */
  fileSize?: number
}

export function basename(path?: string | null): string | null {
  if (!path) return null
  const cleaned = stripShellPathQuotes(path)
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? null
}

export function diffFileHref(filePath: string): string {
  const cleaned = canonicalizeArtifactRelativePath(filePath) ?? stripShellPathQuotes(filePath)
  const params = new URLSearchParams({ hint: 'tabfiles' })
  const title = basename(cleaned)
  if (title) params.set('title', title)
  return `tabtin://resource/file/${encodeURIComponent(cleaned)}?${params.toString()}`
}

/**
 * 把各通道原始路径收成统一的工作区相对路径（POSIX、无 `./`、无越界 `..`）。
 * 绝对路径 / `~` / Windows 盘符 / 越界 → null（不入账）。
 */
export function canonicalizeArtifactRelativePath(input: string): string | null {
  const cleaned = stripShellPathQuotes(String(input ?? '')).trim()
  if (!cleaned) return null
  if (
    cleaned.startsWith('/')
    || cleaned.startsWith('~')
    || /^[a-zA-Z]:[\\/]/.test(cleaned)
  ) {
    return null
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)) {
    // 拒 scheme（file: / tabtin: 等），只收工作区相对路径
    return null
  }

  const segments = cleaned.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (out.length === 0) return null
  return out.join('/')
}

/**
 * 终端命令触碰的文件是否算「交付物」：
 * 排除临时目录首段（打开链路同样拒收）、隐藏文件/目录段（.agent-drafts 等
 * 过程产物）、无扩展名文件（local_file 打开协议要求扩展名）。
 */
export function isDeliverableRelativePath(p: string): boolean {
  const canonical = canonicalizeArtifactRelativePath(p) ?? p.replace(/\\/g, '/')
  const segments = canonical.split('/').filter(Boolean)
  if (segments.length === 0) return false
  const first = segments[0]!.toLowerCase()
  if (TEMP_DIR_SEGMENTS.has(first)) return false
  if (segments.some((seg) => seg.startsWith('.'))) return false
  const filename = segments[segments.length - 1]!
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return false
  return true
}

/** 按时序加/减 path ops，返回本轮结束仍存在的操作。 */
export function survivingFileHistoryOps(ops: FileHistoryOp[]): FileHistoryOp[] {
  const surviving = new Map<string, FileHistoryOp>()
  for (const op of ops) {
    const canonical = canonicalizeArtifactRelativePath(op.path) ?? op.path
    const key = canonical.toLowerCase()
    if (op.deleted) {
      surviving.delete(key)
      continue
    }
    const prev = surviving.get(key)
    surviving.set(key, {
      ...op,
      path: canonical,
      // 后到的 write/shell 常无体积；保留此前 local_file 带来的 fileSize。
      fileSize: typeof op.fileSize === 'number' ? op.fileSize : prev?.fileSize,
    })
  }
  return [...surviving.values()]
}
