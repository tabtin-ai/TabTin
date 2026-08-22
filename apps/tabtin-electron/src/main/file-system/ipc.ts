import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import type { Stats } from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getBundledRipgrepPath } from './ripgrep-bundle-path'
import { resolveSpacesRoot, resolveDataRoot, computeSkillContentHash, matchSensitivePath } from '@tabtin/terminal-core'
import { resolveSpaceWorkspaceRoot, resolveOrganizationSkillsDir } from '@tabtin/agent-runtime'
import { checkHardlinePath } from '@tabtin/security-policy'
import { sanitizePathSegment } from '../utils/path-sanitize'
import { resolveDefaultWorkspaceDirectoryName } from '../app-identity'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import { TokenManager } from '../auth'
import type { FsWatchEvent } from '@shared/fs-watch-types'
import { TEXT_PREVIEW_FILENAMES } from '@shared/text-preview-contract'
import { normalizeSchemelessWebHref } from '@shared/normalize-web-href'
import type {
  ReplaceInFilesEdit,
  ReplaceInFilesRequest,
  ReplaceInFilesResponse,
  RipgrepSearchByteRange,
  RipgrepSearchOptions,
  RipgrepSearchRange,
  RipgrepSearchReplacement,
  RipgrepSearchResult,
} from '@shared/ripgrep-search-types'
import {
  RIPGREP_DEFAULT_PER_FILE_MAX_COUNT,
  hasUnicodeUppercase,
} from '@shared/ripgrep-search-types'

const log = createLogger('FileSystemIPC')
import { shouldPreviewUnknownFileAsText } from './unknown-file-preview'
import {
  renderOfficePreview,
  renderOfficePreviewBuffer,
  supportsRenderedOfficePreview,
} from './office-preview-renderer'
import {
  getDefaultPathAccessChecker,
  type PathAccessAction,
} from '../security/path-access-checker'

/**
 * IPC handler 函数签名。
 *
 * **注意**：handler **不要**自己做 sender 校验——
 * - 通过 `registerFileSystemIpcHandlers()` 注册时，guardedHandle 会包一层
 * - 通过 ipc-lazy stub 注册时，stub 会包一层
 * 所以 handler 函数本身保持纯净的业务逻辑。
 *
 * 路径权限治理 Wave 2 起，所有 fs:* / shell:* IPC handler 共享单一
 * `path-access-checker`（消费当前 session 的 v3
 * `WorkspaceSnapshot.allowedPaths`），与 LLM 工具链路（tabcode-adapter →
 * action-tools）走同一份权限单源。
 *
 * 老模型一并退役：`isPathAllowed` / `getShellAllowedDirs` /
 * `getEffectiveDenyReadPaths/Write` / `updateSpaceDenyPaths`（O8 死代码）/
 * `matchDenyPattern`（O9 重复实现，git-ipc.ts 也有一份）。
 */
type FileSystemIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/**
 * 把 path-access-checker 的判定结果转成 IPC envelope。
 *
 * 与原 isPathAllowed 返回 boolean 后调用方拼 message 字符串相比，新实现
 * 让错误信息**带原因码 + actionable 文案**——用户从 UI 看到拒绝时能定位
 * 到具体怎么解（"在 TabFolder 打开" / "调整 Agent Security 设置"）。
 *
 * **初始化失败容错**（2026-05 加）：`getDefaultPathAccessChecker()` 内部
 * lazy require `electron` / `@tabtin/terminal-core`。如果主进程 bundle 走
 * 到了「ESM context 里 require 未定义」（例如 path-access-checker.ts 漏写
 * `createRequire(import.meta.url)`、或者 packaged 后某个间接依赖在 walkSync
 * 之类的代码里裸调 `__require`）这条 ReferenceError 会一路冒泡到 IPC catch
 * 里，最后把 `'require is not defined'` / `'Dynamic require of "fs" is not
 * supported'` 这类底层堆栈 message 直接 leak 给用户的文件树 UI。
 *
 * 这里把初始化抛错单独拦下，给用户一条 actionable 文案（重启应用），
 * 同时打到主进程日志里供开发者定位。业务拒绝（路径越权 / 红线 / sensitive）
 * 不变，仍走原文案链路。
 */
function checkAndFormat(
  filePath: string,
  action: PathAccessAction,
): { ok: true } | { ok: false; error: string } {
  let checker
  try {
    checker = getDefaultPathAccessChecker()
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    log.error('path-access-checker 初始化失败，拒绝本次 IPC：', detail)
    return {
      ok: false,
      error: '权限服务初始化失败，请重启应用。如反复出现请截图本提示并联系开发者。',
    }
  }
  const result = checker.check(filePath, action)
  if (result.allowed) return { ok: true }
  return { ok: false, error: result.reason?.message ?? 'access denied' }
}

const execFileAsync = promisify(execFile)

const APP_ASAR_SEGMENT_RE = /app\.asar(?=[\\/])/
const RIPGREP_EXEC_OPTIONS = {
  maxBuffer: 5 * 1024 * 1024,
  timeout: 15000,
  encoding: 'utf8' as BufferEncoding,
} as const
const RIPGREP_FALLBACK_ERROR_CODES = new Set(['EFTYPE', 'ENOENT', 'ENOTDIR'])
const RIPGREP_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.venv', 'venv', 'coverage', '.next', '.nuxt', '.cache',
]
/** 文件名遍历上限；测试可临时调低以复现 pathMatchesTruncated。 */
export const ripgrepPathSearchConfig = {
  maxEntries: 20_000,
}
const MAX_REPLACE_EDITS = 500
const MAX_REPLACE_FILES = 100
const MAX_REPLACE_TEXT_BYTES = 64 * 1024
const MAX_REPLACE_PAYLOAD_BYTES = 2 * 1024 * 1024
const MAX_REPLACE_FILE_BYTES = 50 * 1024 * 1024
type RipgrepExecOutput = { stdout: string; stderr: string }
type ParsedRipgrepSubmatch = {
  start: number
  end: number
  matchText?: string
  replacement?: string
}

const ripgrepControllers = new Map<string, AbortController>()

function resolveRipgrepExecutablePath(): string {
  const candidate = getBundledRipgrepPath() || 'rg'
  if (APP_ASAR_SEGMENT_RE.test(candidate)) {
    return candidate.replace(APP_ASAR_SEGMENT_RE, 'app.asar.unpacked')
  }
  return candidate
}

function describeRipgrepExecError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function shouldRetryWithSystemRipgrep(error: unknown, attemptedCommand: string): boolean {
  if (attemptedCommand === 'rg') return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RIPGREP_FALLBACK_ERROR_CODES.has(code)
}

function isRipgrepSearchOutcomeError(error: unknown): boolean {
  const execError = error as {
    code?: number | string
    stdout?: string
    stderr?: string
  } | undefined
  return execError?.code === 1
    || execError?.code === 2
    || (execError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof execError.stdout === 'string')
}

async function execRipgrep(args: string[], signal?: AbortSignal): Promise<RipgrepExecOutput> {
  const bundledCommand = resolveRipgrepExecutablePath()
  const execOptions = {
    ...RIPGREP_EXEC_OPTIONS,
    ...(signal ? { signal } : {}),
  }
  try {
    return await execFileAsync(bundledCommand, args, execOptions) as RipgrepExecOutput
  } catch (error) {
    if (!shouldRetryWithSystemRipgrep(error, bundledCommand)) throw error

    try {
      return await execFileAsync('rg', args, execOptions) as RipgrepExecOutput
    } catch (fallbackError) {
      if (isRipgrepSearchOutcomeError(fallbackError)) throw fallbackError

      const message = [
        `bundled ripgrep failed (${bundledCommand}: ${describeRipgrepExecError(error)})`,
        `system ripgrep fallback failed (rg: ${describeRipgrepExecError(fallbackError)})`,
      ].join('; ')
      const combined = new Error(message) as NodeJS.ErrnoException
      combined.code = 'RIPGREP_EXEC_FAILED'
      throw combined
    }
  }
}

function isRipgrepAbortError(error: unknown, signal?: AbortSignal): boolean {
  const execError = error as { code?: number | string; name?: string }
  return signal?.aborted === true
    || execError?.code === 'ABORT_ERR'
    || execError?.name === 'AbortError'
}

function createRipgrepAbortError(): Error & { code: string } {
  const error = new Error('ripgrep search canceled') as Error & { code: string }
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function byteOffsetToCharOffset(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, 'utf8')
  const safeOffset = Math.max(0, Math.min(byteOffset, bytes.length))
  return bytes.subarray(0, safeOffset).toString('utf8').length
}

function escapeFixedRipgrepReplacement(value: string): string {
  // rg 的 replacement 语法把 `$1` 解释成捕获组；固定字符串搜索没有捕获组，
  // 因此必须把用户输入的 dollar 加倍，才能让 replacement.text 保持字面量。
  return value.replaceAll('$', () => '$$')
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer
  if (sample.includes(0)) return true
  let suspiciousBytes = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) suspiciousBytes++
  }
  return sample.length > 0 && suspiciousBytes / sample.length > 0.1
}

function getErrorType(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code) return code
  return error instanceof Error ? error.name : typeof error
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function normalizeSearchLine(text: string): string {
  return text.replace(/\r?\n$/, '')
}

function firstStderrLine(stderr: unknown): string {
  const firstLine = String(stderr || '').trim().split(/\r?\n/, 1)[0]?.trim()
  return firstLine || '正则表达式无效，请检查语法。'
}

function isRegexSyntaxError(stderr: unknown): boolean {
  const message = String(stderr || '').toLocaleLowerCase()
  return /(?:regex|regular expression)\s+(?:parse|syntax)\s+error/.test(message)
}

function isUnicodeWordCharacter(value: string): boolean {
  return /^[\p{L}\p{N}_]$/u.test(value)
}

function isWholeWordMatch(name: string, start: number, end: number): boolean {
  const before = Array.from(name.slice(0, start)).at(-1)
  const after = Array.from(name.slice(end)).at(0)
  return (!before || !isUnicodeWordCharacter(before))
    && (!after || !isUnicodeWordCharacter(after))
}

function findFixedStringMatch(
  name: string,
  pattern: string,
  matchCase?: boolean,
  wholeWord = false,
): { start: number; end: number } | null {
  const caseSensitive = matchCase ?? hasUnicodeUppercase(pattern)
  if (caseSensitive) {
    let start = name.indexOf(pattern)
    while (start >= 0) {
      const end = start + pattern.length
      if (!wholeWord || isWholeWordMatch(name, start, end)) return { start, end }
      start = name.indexOf(pattern, start + Math.max(1, pattern.length))
    }
    return null
  }

  // Lowercasing a Unicode code point may expand to multiple code units. Keep
  // a folded-to-original boundary map so the returned range still slices name.
  let foldedName = ''
  const foldedStarts: number[] = []
  const foldedEnds: number[] = []
  for (let offset = 0; offset < name.length;) {
    const codePoint = name.codePointAt(offset)
    if (codePoint == null) break
    const original = String.fromCodePoint(codePoint)
    const end = offset + original.length
    const folded = original.toLocaleLowerCase()
    foldedName += folded
    for (let index = 0; index < folded.length; index++) {
      foldedStarts.push(offset)
      foldedEnds.push(end)
    }
    offset = end
  }

  const foldedPattern = pattern.toLocaleLowerCase()
  let foldedStart = foldedName.indexOf(foldedPattern)
  while (foldedStart >= 0) {
    const foldedEnd = foldedStart + foldedPattern.length
    const start = foldedStarts[foldedStart]
    const end = foldedEnds[foldedEnd - 1]
    if (!wholeWord || isWholeWordMatch(name, start, end)) return { start, end }
    foldedStart = foldedName.indexOf(foldedPattern, foldedStart + Math.max(1, foldedPattern.length))
  }
  return null
}

function shouldSkipPathNameSearchEntry(entry: fs.Dirent): boolean {
  if (entry.isSymbolicLink()) return true
  if (entry.name.startsWith('.')) return true
  return RIPGREP_EXCLUDES.includes(entry.name)
}

async function collectPathNameMatches(
  root: string,
  pattern: string,
  limit: number,
  options: {
    signal?: AbortSignal
    matchCase?: boolean
    wholeWord?: boolean
  } = {},
): Promise<{ results: RipgrepSearchResult[]; truncated: boolean }> {
  if (limit <= 0) return { results: [], truncated: false }

  const results: RipgrepSearchResult[] = []
  const stack = [root]
  let visited = 0

  const maxEntries = ripgrepPathSearchConfig.maxEntries
  while (stack.length > 0 && results.length < limit && visited < maxEntries) {
    if (options.signal?.aborted) throw createRipgrepAbortError()
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      if (options.signal?.aborted) throw createRipgrepAbortError()
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
      if (options.signal?.aborted) throw createRipgrepAbortError()
    } catch (error) {
      if (isRipgrepAbortError(error, options.signal)) throw error
      log.debug('文件名搜索跳过不可读目录', {
        errorName: error instanceof Error ? error.name : typeof error,
      })
      continue
    }

    for (const entry of entries) {
      if (options.signal?.aborted) throw createRipgrepAbortError()
      if (visited >= maxEntries || results.length >= limit) break
      visited += 1

      if (shouldSkipPathNameSearchEntry(entry)) continue

      const entryPath = path.join(dir, entry.name)
      const isDirectory = entry.isDirectory()
      const match = findFixedStringMatch(
        entry.name,
        pattern,
        options.matchCase,
        options.wholeWord,
      )
      if (match) {
        results.push({
          file: entryPath,
          line: 0,
          column: match.start,
          text: entry.name,
          matchText: entry.name.slice(match.start, match.end),
          ranges: [{ start: match.start, end: match.end }],
          isDirectory,
          matchKind: 'path',
        })
      }

      if (isDirectory) {
        stack.push(entryPath)
      }
    }
  }

  return {
    results,
    truncated: stack.length > 0 || visited >= maxEntries,
  }
}

// RP-017: concurrency limiter for ripgrep searches
const MAX_RIPGREP_CONCURRENT = 4

class RipgrepSemaphore {
  private queue: Array<{
    resolve: () => void
    reject: (error: Error) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []
  private running = 0
  constructor(private max: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw createRipgrepAbortError()
    if (this.running < this.max) {
      this.running++
      return
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      }
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(createRipgrepAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  release(): void {
    this.running--
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!
      if (waiter.signal?.aborted) {
        waiter.onAbort && waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(createRipgrepAbortError())
        continue
      }
      waiter.onAbort && waiter.signal?.removeEventListener('abort', waiter.onAbort)
      this.running++
      waiter.resolve()
      return
    }
  }
}

const ipcRipgrepSemaphore = new RipgrepSemaphore(MAX_RIPGREP_CONCURRENT)

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)
  } catch {
    return false
  }
}


type FileSystemEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number | null
}

type FilePreviewKind = 'text' | 'image' | 'pdf' | 'doc' | 'docx' | 'xlsx' | 'pptx' | 'video' | 'audio' | 'binary'

const OFFICE_EXTENSIONS: Record<string, FilePreviewKind> = {
  '.doc': 'doc',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
}

const DEFAULT_PREVIEW_BYTES = 512 * 1024
const MAX_BINARY_FILE_BYTES = 50 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 150
const FILE_SYSTEM_WRITE_PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])
const FILE_SYSTEM_WRITE_PERMISSION_ERROR_PATTERN =
  /\b(EACCES|EPERM|EROFS)\b|permission denied|operation not permitted|read-only file system/i
const FILE_SYSTEM_WRITE_PERMISSION_MESSAGE =
  '当前目录没有写入权限，无法完成本次文件操作。请修改目录权限，或选择可写目录。'

/**
 * 永远不发 watch 事件的目录段（按路径的任一段精确匹配）。
 *
 * 动机（dogfood "node_modules 风暴"）：fs.watch recursive 模式会监听整棵树，
 * 用户在终端跑 `pnpm install` 之类一次性创建上万子目录时，main 端 IPC
 * 流量会爆炸（即使前端按 expanded 过滤掉，IPC 序列化 / 跨进程拷贝 / JS
 * 主线程 dispatch 的成本都已发生，MacBook Air 上风扇会转）。
 *
 * 这里在 dispatch 入口直接按 path 段过滤——这些目录用户视图层基本永远
 * 不会展开（就算展开了刷新得点手动按钮），不会自动 reload 的代价远小于
 * 一直发事件的代价。
 *
 * 不在 fs.watch 调用层禁掉是因为 Node 的 watch 不支持 ignored 选项；
 * 改用 chokidar 之类的库代价大、收益不成比例。前端层过滤已经够用。
 */
const WATCH_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '.pytest_cache',
  '.tox',
  'coverage',
])

function isIgnoredWatchPath(filename: string | undefined): boolean {
  if (!filename) return false
  // recursive 模式下 filename 是相对 root 的相对路径（"a/b/c.txt"）。
  // 任一段命中黑名单即丢弃——譬如 "node_modules/foo/bar.js" 会被丢，
  // 而项目根的 "node_modules.md" 这种用户文件不会误伤（精确段匹配）。
  for (const segment of filename.split('/')) {
    if (WATCH_IGNORED_SEGMENTS.has(segment)) return true
  }
  return false
}

function getErrnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : ''
}

function formatFileSystemWriteError(error: unknown): { code?: string; error: string } {
  const code = getErrnoCode(error)
  const message = error instanceof Error ? error.message : String(error)
  if (
    FILE_SYSTEM_WRITE_PERMISSION_ERROR_CODES.has(code) ||
    FILE_SYSTEM_WRITE_PERMISSION_ERROR_PATTERN.test(message)
  ) {
    return { code: 'FS_PERMISSION_DENIED', error: FILE_SYSTEM_WRITE_PERMISSION_MESSAGE }
  }

  return code ? { code, error: message } : { error: message }
}

const TEXT_EXTENSIONS = new Set([
  // 文档 / 数据
  '.txt', '.md', '.markdown', '.rst', '.adoc',
  '.json', '.jsonc', '.json5', '.jsonl', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.plist', '.svg',
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  // Web
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.vue', '.svelte', '.astro',
  // 后端 / 系统
  '.py', '.pyi', '.pyw',
  '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
  '.cs', '.fs', '.fsx',
  '.rb', '.php', '.lua', '.perl', '.pl', '.pm',
  '.swift', '.m', '.mm',
  '.r', '.R', '.jl',
  '.ex', '.exs', '.erl', '.hrl',
  '.zig', '.nim', '.v', '.d',
  // Shell / DevOps
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1',
  '.dockerfile',
  // 配置 / 杂项
  '.lock', '.log', '.diff', '.patch',
  '.gitignore', '.gitattributes', '.gitmodules',
  '.editorconfig', '.prettierrc', '.eslintrc',
  '.npmrc', '.nvmrc', '.babelrc',
  '.graphql', '.gql', '.proto', '.sql',
  '.tf', '.hcl',
])

// 无扩展名但常见的文本文件名
const TEXT_FILENAMES = new Set<string>(TEXT_PREVIEW_FILENAMES)

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov',
])

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
])


const isTextFile = (ext: string, filePath?: string) => {
  if (TEXT_EXTENSIONS.has(ext)) return true
  // 无扩展名或扩展名不在列表中，按文件名匹配
  if (filePath) {
    const name = path.basename(filePath)
    if (TEXT_FILENAMES.has(name)) return true
  }
  return false
}

const resolveEntry = async (dirPath: string, name: string, isDirectory: boolean): Promise<FileSystemEntry> => {
  const entryPath = path.join(dirPath, name)
  try {
    const stat = await fsPromises.stat(entryPath)
    return {
      name,
      path: entryPath,
      isDirectory,
      size: stat.size,
      modifiedAt: stat.mtimeMs
    }
  } catch {
    return {
      name,
      path: entryPath,
      isDirectory,
      size: 0,
      modifiedAt: null
    }
  }
}

const readPartialText = async (filePath: string, maxBytes: number) => {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const previewSize = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(previewSize)
    await handle.read(buffer, 0, previewSize, 0)
    return {
      text: buffer.toString('utf8'),
      size,
      truncated: size > maxBytes
    }
  } finally {
    await handle.close()
  }
}

const readBinaryBase64 = async (filePath: string, maxBytes: number) => {
  const stat = await fsPromises.stat(filePath)
  if (stat.size > maxBytes) {
    return { content: '', size: stat.size, truncated: true }
  }
  const buffer = await fsPromises.readFile(filePath)
  return {
    content: buffer.toString('base64'),
    size: stat.size,
    truncated: false
  }
}

/**
 * 列目录（stat 补全 + 目录优先排序）。**不做**路径权限判定——调用方
 * （`fs:readDir` IPC / 远程文件浏览 bridge）各自先过自己的闸门再进来。
 */
export async function listDirEntriesSorted(resolved: string): Promise<FileSystemEntry[]> {
  const entries = await fsPromises.readdir(resolved, { withFileTypes: true })
  const mapped = await Promise.all(
    entries.map(entry => resolveEntry(resolved, entry.name, entry.isDirectory()))
  )
  mapped.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
  return mapped
}

export interface FilePreviewPayloadOptions {
  maxBytes?: number
  /**
   * 仅远程 RPC 传入：启用图片 base64 内联，并以此为字节上限。
   * 超过 → kind='binary' + truncated（远端 UI 显示「过大」）。
   * 本机 IPC 不传——图片只回 path，由渲染进程走 tabtin-file://。
   */
  imageMaxBytes?: number
}

/**
 * 构建文件预览 payload（kind 分类 + 按类读取）。**不做**路径权限判定——
 * 调用方先过闸门。抽取自原 `fs:readFilePreview` handler，行为不变。
 */
export async function buildFilePreviewPayload(
  resolved: string,
  options?: FilePreviewPayloadOptions,
): Promise<{ success: boolean; data?: Record<string, unknown>; code?: string; error?: string }> {
  const stat = await fsPromises.stat(resolved)
  if (stat.isDirectory()) {
    return { success: false, code: 'EISDIR', error: 'path is a directory' }
  }

  const ext = path.extname(resolved).toLowerCase()
  const maxBytes = Math.max(1, options?.maxBytes ?? DEFAULT_PREVIEW_BYTES)
  const inlineImageMaxBytes =
    options?.imageMaxBytes === undefined ? undefined : Math.max(1, options.imageMaxBytes)
  let kind: FilePreviewKind = 'binary'
  let mime: string | undefined

  if (ext === '.pdf') {
    kind = 'pdf'
    mime = 'application/pdf'
  } else if (OFFICE_EXTENSIONS[ext]) {
    kind = OFFICE_EXTENSIONS[ext]
  } else if (IMAGE_MIME_BY_EXT[ext]) {
    kind = 'image'
    mime = IMAGE_MIME_BY_EXT[ext]
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    kind = 'video'
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    kind = 'audio'
  } else if (isTextFile(ext, resolved)) {
    kind = 'text'
  } else if (await shouldPreviewUnknownFileAsText(resolved, stat.size)) {
    kind = 'text'
  }

  if (kind === 'text') {
    const result = await readPartialText(resolved, maxBytes)
    return {
      success: true,
      data: {
        kind,
        content: result.text,
        size: result.size,
        truncated: result.truncated
      }
    }
  }

  if (kind === 'pdf') {
    return {
      success: true,
      data: {
        kind,
        path: resolved,
        size: stat.size,
        truncated: false,
        mime
      }
    }
  }

  if (kind === 'doc' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    return {
      success: true,
      data: {
        kind,
        path: resolved,
        size: stat.size,
        truncated: false,
      }
    }
  }

  if (kind === 'image') {
    // 本机：与 PDF/音视频一致，只回 path，避免整图 base64 过 IPC。
    if (inlineImageMaxBytes === undefined) {
      return {
        success: true,
        data: {
          kind,
          path: resolved,
          size: stat.size,
          truncated: false,
          mime,
        },
      }
    }
    // 远程：结果经 WS，必须内联 base64，并受通道体积约束。
    const result = await readBinaryBase64(resolved, inlineImageMaxBytes)
    if (result.truncated) {
      return {
        success: true,
        data: {
          kind: 'binary',
          size: result.size,
          truncated: true,
        },
      }
    }
    return {
      success: true,
      data: {
        kind,
        content: result.content,
        size: result.size,
        truncated: false,
        mime,
      },
    }
  }

  if (kind === 'video' || kind === 'audio') {
    return {
      success: true,
      data: {
        kind,
        path: resolved,
        size: stat.size,
        truncated: false,
      }
    }
  }

  return {
    success: true,
    data: {
      kind: 'binary',
      size: stat.size,
      truncated: false
    }
  }
}

type PendingEvent = {
  eventType: string
  /** 实际变化文件的绝对路径；filename 为空（OS 队列溢出）时为 undefined */
  fullPath?: string
  /**
   * true 表示 OS 层文件系统事件队列溢出，前端必须重扫所有已展开目录。
   * 详见 fs:watch handler 内的 isGlobal 注释。
   */
  isGlobal: boolean
}

type WatchEntry = {
  watcher: fs.FSWatcher
  sender: Electron.WebContents
  senderId: number
  /** 监听的根目录绝对路径 */
  rootPath: string
  timer: NodeJS.Timeout | null
  destroyHandler: () => void
  /**
   * 防抖期间按"父目录"分桶收集事件——每个父目录只保留 burst 中的最后一条
   * 事件（type/fullPath）。flush 时遍历 Map 一次发多条 payload。
   *
   * 旧实现是单一 lastEvent，子目录里多个文件同时变只能发一条；前端按
   * dirPath（=root）判断是否刷新，导致用户在子目录新增文件后侧边栏不更新，
   * 必须手动点刷新——根因就在这里。
   */
  pendingByParent: Map<string, PendingEvent>
}

const watchers = new Map<string, WatchEntry>()

/**
 * 单 sender（单 WebContents / 单窗口）持有的 watchId 集合——按 sender 分桶
 * 限流，防止某个失控 renderer 把全局上限吃光让别的窗口饿死。
 *
 * 重度多 Space dogfood 用户场景测算：10 Space × 平均 5 watcher/Space = 50。
 * 单 sender 上限 80 给一倍 headroom，全局 200 兜底（macOS fs.watch 系统级
 * ~256，Linux inotify_max_user_watches 通常 8192+，200 都不会触系统限制）。
 */
const watchersBySender = new Map<number, Set<string>>()

const MAX_WATCHERS_GLOBAL = 200
const MAX_WATCHERS_PER_SENDER = 80

const buildWatchId = () =>
  `watch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function cleanupWatcher(watchId: string): void {
  const entry = watchers.get(watchId)
  if (!entry) return
  entry.watcher.close()
  if (entry.timer) {
    clearTimeout(entry.timer)
  }
  try {
    entry.sender.removeListener('destroyed', entry.destroyHandler)
  } catch {
    // sender already destroyed
  }
  watchers.delete(watchId)

  const senderBucket = watchersBySender.get(entry.senderId)
  if (senderBucket) {
    senderBucket.delete(watchId)
    if (senderBucket.size === 0) watchersBySender.delete(entry.senderId)
  }
}

const SKILLS_README_CONTENT = `# 本地 Skill（Local Skills）

在此目录中创建自定义 Skill，Agent 会自动发现并使用它们。

## 快速开始

1. 新建一个文件夹，文件夹名即为 Skill ID（英文、小写、用连字符分隔），例如 \`my-tool\`
2. 在文件夹中创建 \`SKILL.md\` 文件，这是 Skill 的说明文档

完成后目录结构如下：

\`\`\`
skills/
  my-tool/
    SKILL.md      ← Skill 文档（必须）
    ...           ← 其他资源文件（可选）
\`\`\`

## SKILL.md 格式

\`\`\`markdown
---
name: 我的工具
description: 一句话描述这个 Skill 做什么
version: 1.0.0
---

# 我的工具

详细说明 Agent 应该如何使用这个 Skill。

## 使用场景

当用户需要……时，使用本 Skill。

## 使用方法

1. 第一步……
2. 第二步……
\`\`\`

### Frontmatter 字段说明

| 字段 | 说明 |
|------|------|
| \`name\` | Skill 显示名称 |
| \`description\` | 简短描述，用于 Agent 判断是否使用该 Skill |
| \`version\` | 版本号（可选） |

## 工作原理

- Agent 会扫描此目录下的所有子文件夹
- 每个包含 \`SKILL.md\` 的子文件夹会被识别为一个 Skill
- 当用户的请求与 Skill 描述匹配时，Agent 会读取 \`SKILL.md\` 获取详细指令
- 修改后自动生效，无需重启
`

// ── Handler 实现 ───────────────────────────────────────────────────────────
//
// 每个 handler 都是纯业务逻辑，**不做** sender 校验（由 guardedHandle 或
// ipc-lazy stub 统一处理）。模块级状态（watchers Map、spaceDenyXxxPaths
// 等）保持在文件顶部声明的位置，handler 通过闭包共享。

/**
 * 解析当前登录用户的 userId（ 新布局 skills 落盘必须字段）。
 * 字段兼容与 ElectronAgentHost.resolveSkillUserId 同源（id / user_id / userId
 * 三种字段名）；未认证时返回 undefined，调用方须显式失败，不允许静默落到
 * legacy `_unscoped` / platform-data 目录。
 */
async function resolveCurrentUserId(): Promise<string | undefined> {
  const userInfo = (await TokenManager.getUserInfo()) as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const raw = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

/**
 * 确保 Space 的 workspace + 用户级 skills 目录就位。
 *
 * ** 硬切后行为**：
 *   - workspace 目录（`{spacesRoot}/{wt}/spaces/{sp}/`）：创建空目录，这是
 *     用户的工作区，Agent 的 ShellCap cwd 默认值；
 *   - skills 目录改走新布局 `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`
 *     （`resolveOrganizationSkillsDir`）：创建 + 写 README.md，让 Agent 有地方
 *     放技能；**不再**落 legacy `{platformDataRoot}/{wt}/spaces/{sp}/skills/`；
 *   - **不再**在 workspace 下创建 `conversations/` 占位（那是平台数据）。
 *
 * 返回值：
 *   - `path` = workspace 绝对路径（历史 API，renderer 打开用户文件夹用）
 *   - `skillsPath` = skills 目录绝对路径（renderer 打开 skills 文件夹用）
 *   - `dataRoot` / `userId` = 新布局路径拼装所需字段，供 renderer 自行拼
 *     会话归档路径（见 `buildSessionReferenceClipboardText.ts`），取代
 *     旧的 `platformDataPath`。
 *
 * userId / organizationId 缺失时直接失败返回（ 硬切：新布局 skills
 * 路径禁止 `_unscoped`）。用户可见 workspace 目录仍走 legacy `spaces/` 根，
 * 缺 organizationId 时该段仍可能落到 `_unscoped`（与 skills 硬切解耦）。
 */
const ensureSpaceSandboxImpl = async (spaceId: string, organizationId?: string) => {
  try {
    if (!spaceId) {
      return { success: false, error: 'spaceId is required' }
    }
    const safeId = sanitizePathSegment(spaceId)
    const safeWtId = organizationId ? sanitizePathSegment(organizationId) : undefined

    const workspacePath = resolveSpaceWorkspaceRoot(resolveSpacesRoot(), safeWtId, safeId)
    if (!fs.existsSync(workspacePath)) {
      await fsPromises.mkdir(workspacePath, { recursive: true })
    }

    const userId = await resolveCurrentUserId()
    if (!userId) {
      return { success: false, error: '未登录，无法确定 Skills 目录归属（缺少 userId）' }
    }
    if (!safeWtId) {
      return {
        success: false,
        error: '缺少 organizationId，无法确定 Skills 目录归属（ hard-cut）',
      }
    }

    const dataRoot = resolveDataRoot()
    const skillsPath = resolveOrganizationSkillsDir(dataRoot, userId, safeWtId)
    if (!fs.existsSync(skillsPath)) {
      await fsPromises.mkdir(skillsPath, { recursive: true })
    }
    const readmePath = path.join(skillsPath, 'README.md')
    if (!fs.existsSync(readmePath)) {
      await fsPromises.writeFile(readmePath, SKILLS_README_CONTENT, 'utf8')
    }

    return {
      success: true,
      path: workspacePath,
      skillsPath,
      dataRoot,
      userId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

/**
 * 把 Space 显示名归一成单层文件夹名（保留中英文/数字，剔除文件系统非法字符）。
 *
 * 与 `sanitizePathSegment`（面向 UUID/slug，会丢中文）不同：这里要的是用户在
 * Finder 里认得出的名字，所以只删 `/ \ : * ? " < > |`、控制字符与首尾点/空白，
 * 折叠多余空白。归一后为空时回退到「工作区」。
 */
export function sanitizeSpaceDirName(rawName: string): string {
  const cleaned = (rawName || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  return cleaned || '工作区'
}

type EnsureDefaultAgentDirInput = string | {
  agentName?: string | null
  spaceName?: string | null
  organizationName?: string | null
}

function normalizeDefaultAgentDirInput(input: EnsureDefaultAgentDirInput): {
  spaceName: string
  organizationName: string
} {
  if (typeof input === 'string') {
    return { spaceName: input, organizationName: '' }
  }
  return {
    spaceName: input.spaceName || input.agentName || 'Space',
    organizationName: input.organizationName || '',
  }
}

/**
 * fs:ensureDefaultAgentDir — 解析并创建默认 Space 的工作目录
 * `~/TabTin/<团队名>/<Space名>`。
 *
 * 产品语义：新建 / 进入未设目录的 Space 时，不再立「前往设置」
 * 墙，而是在 home 下创建一个用户可见的默认文件夹。collision-safe：
 * 同团队同名目录已存在时追加 `-2/-3…`，避免不同 Space 共用一个根。
 */
export const ensureDefaultAgentDirImpl = async (input: EnsureDefaultAgentDirInput) => {
  try {
    const { spaceName, organizationName } = normalizeDefaultAgentDirInput(input)
    const home = app.getPath('home')
    // production 保持历史 `~/TabTin`；Preprod / Dev / Local 各自用产品名
    // 分根，避免两套安装包把不同 Device 的 Workspace 指到同一目录树。
    const root = path.join(home, resolveDefaultWorkspaceDirectoryName())
    const parent = organizationName
      ? path.join(root, sanitizeSpaceDirName(organizationName))
      : root
    const baseName = sanitizeSpaceDirName(spaceName)

    await fsPromises.mkdir(parent, { recursive: true })

    // 不能先 exists 再 mkdir：两套包并发首建时会同时选中同一路径。
    // 让 mkdir({recursive:false}) 成为抢占点，只有 EEXIST 才探测下一个后缀。
    for (let index = 1; index <= 99; index++) {
      const name = index === 1 ? baseName : `${baseName}-${index}`
      const target = path.join(parent, name)
      if (!target.startsWith(parent + path.sep)) {
        return { success: false, error: 'resolved path escaped default parent' }
      }
      try {
        await fsPromises.mkdir(target)
        return { success: true, path: target }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    return { success: false, error: 'too many default dirs with the same name' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

type ReplaceEditWithResolvedFile = ReplaceInFilesEdit & { resolvedFile: string }

function applyReplaceEditsToBuffer(
  buffer: Buffer,
  edits: ReplaceEditWithResolvedFile[],
): { ok: true; buffer: Buffer } | { ok: false; reason: string } {
  const ordered = [...edits].sort((left, right) => (
    left.byteStart - right.byteStart || left.byteEnd - right.byteEnd
  ))
  let previous: ReplaceEditWithResolvedFile | undefined
  for (const edit of ordered) {
    const expected = Buffer.from(edit.expectedText, 'utf8')
    if (
      !Number.isSafeInteger(edit.byteStart)
      || !Number.isSafeInteger(edit.byteEnd)
      || edit.byteStart < 0
      || edit.byteEnd < edit.byteStart
      || edit.byteEnd > buffer.length
      || edit.byteEnd - edit.byteStart !== expected.length
    ) {
      return { ok: false, reason: 'invalid_range' }
    }
    if (!buffer.subarray(edit.byteStart, edit.byteEnd).equals(expected)) {
      return { ok: false, reason: 'stale_file' }
    }
    if (
      previous
      && (
        previous.byteEnd > edit.byteStart
        || (previous.byteStart === edit.byteStart && previous.byteEnd === edit.byteEnd)
      )
    ) {
      return { ok: false, reason: 'overlapping_edits' }
    }
    previous = edit
  }

  let next = buffer
  for (const edit of [...ordered].reverse()) {
    const replacement = Buffer.from(edit.replacement, 'utf8')
    next = Buffer.concat([
      next.subarray(0, edit.byteStart),
      replacement,
      next.subarray(edit.byteEnd),
    ])
  }
  return { ok: true, buffer: next }
}

function invalidReplaceRequest(reason: string): ReplaceInFilesResponse {
  return { success: false, files: [], totalReplacements: 0, error: reason }
}

const MAX_RIPGREP_RESULTS = 2000
const MAX_GLOB_LENGTH = 200
/** Main-process reservation prevents two renderer panels overwriting the same file. */
const replaceInFlightPaths = new Set<string>()

/**
 * Channel→handler 映射。**新增/删除 channel 时必须同步更新
 * `apps/tabtin-electron/src/main/ipc-lazy.ts` 中 FileSystemIPC 的 channels
 * 列表**，否则新 channel 不会被 stub 注册，又会出现 race condition。
 */
export const fileSystemHandlers = {
  /**
   * 轻量探针：路径是否存在（以及是不是目录）。
   *
   * 设计动机：renderer 端 TabCode 等需要在 mount 时判断"项目根路径还在
   * 吗"，但又不需要读目录内容（用 fs:readDir 就要读+排序）。这里仅 stat
   * 一次，零内容回传，零业务副作用。
   *
   * 安全：因 stat 只暴露布尔信号、不返路径下的内容，且 path 必须先 resolve
   * 防 traversal，不强制走 path-access-checker boundary —— TabCode 项目目录
   * 刚被用户在 UI 选中、还没推到 main snapshot 时也得能 stat（典型：renderer
   * 加载列表时探针历史最近项目的存活性）。
   *
   * Wave 2 第一轮 Review N1 修复：仍要拦红线 + 敏感路径黑名单——避免
   * 任何 renderer 代码（含潜在的 cross-frame 攻击面）通过此 IPC 探测
   * `/etc/shadow` / `~/.ssh/id_rsa` 之类 path 是否存在。boundary 不查（保
   * 留"未授权先 stat"语义），但红线 + matchSensitivePath 永不放过。
   */
  'fs:pathExists': async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, exists: false, error: 'path is required' }
      }
      const resolved = path.resolve(targetPath)
      // 红线 + 敏感路径黑名单（不查 boundary）—— 防探测攻击面
      if (checkHardlinePath(resolved, 'file').hit || matchSensitivePath(resolved)) {
        return { success: false, exists: false, error: 'access denied: path is protected' }
      }
      const stat = await fsPromises.stat(resolved)
      return {
        success: true,
        exists: true,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true, exists: false, isDirectory: false, isFile: false }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, exists: false, error: message }
    }
  },

  /**
   * 解析路径的物理真实路径（realpath）。用于目录唯一性判定：symlink / junction /
   * subst 盘符映射写法各异但指向同一物理目录时，realpath 后可收敛成同一字符串。
   *
   * 安全：与 fs:pathExists 同源——只回传 canonical 路径字符串，不读目录内容；
   * 仍拦红线 + 敏感路径黑名单，防探测攻击面。路径不存在（realpath 抛错）时
   * 回退到 path.resolve 结果，让上层仍能做字符串级归一化。
   */
  'fs:realpath': async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(targetPath)
      if (checkHardlinePath(resolved, 'file').hit || matchSensitivePath(resolved)) {
        return { success: false, error: 'access denied: path is protected' }
      }
      const real = await fsPromises.realpath(resolved).catch(() => resolved)
      return { success: true, path: real }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'fs:readDir': async (_event: IpcMainInvokeEvent, dirPath: string) => {
    try {
      if (!dirPath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(dirPath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const mapped = await listDirEntriesSorted(resolved)
      return { success: true, entries: mapped }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'fs:readFilePreview': async (_event: IpcMainInvokeEvent, filePath: string, options?: { maxBytes?: number }) => {
    try {
      if (!filePath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      return await buildFilePreviewPayload(resolved, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'fs:renderOfficePreview': async (_event: IpcMainInvokeEvent, filePath: string) => {
    try {
      if (!filePath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      if (!supportsRenderedOfficePreview(resolved)) {
        return { success: false, error: 'unsupported office preview format' }
      }
      const stat = await fsPromises.stat(resolved)
      if (stat.isDirectory()) {
        return { success: false, code: 'EISDIR', error: 'path is a directory' }
      }
      if (stat.size > MAX_BINARY_FILE_BYTES) {
        return {
          success: false,
          error: `file too large for office preview (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_BINARY_FILE_BYTES / 1024 / 1024}MB)`,
        }
      }

      const data = await renderOfficePreview(resolved, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
      return { success: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('fs:renderOfficePreview failed', {
        name: filePath ? path.basename(filePath) : undefined,
        error: message,
      })
      const runtimeCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      const code = runtimeCode.startsWith('OFFICE_RUNTIME_')
        ? runtimeCode
        : /LibreOffice|soffice|pdftoppm|renderer unavailable/i.test(message)
        ? 'OFFICE_PREVIEW_RENDERER_UNAVAILABLE'
        : undefined
      return { success: false, ...(code ? { code } : {}), error: message }
    }
  },

  'fs:renderOfficePreviewData': async (
    _event: IpcMainInvokeEvent,
    input: { fileName?: string; data?: ArrayBuffer | Uint8Array },
  ) => {
    try {
      const fileName = typeof input?.fileName === 'string'
        ? path.basename(input.fileName)
        : ''
      const data = input?.data
      if (!fileName || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        return { success: false, error: 'fileName and binary data are required' }
      }
      if (!supportsRenderedOfficePreview(fileName)) {
        return { success: false, error: 'unsupported office preview format' }
      }
      if (data.byteLength > MAX_BINARY_FILE_BYTES) {
        return {
          success: false,
          error: `file too large for office preview (${(data.byteLength / 1024 / 1024).toFixed(1)}MB, max ${MAX_BINARY_FILE_BYTES / 1024 / 1024}MB)`,
        }
      }

      const rendered = await renderOfficePreviewBuffer(fileName, data)
      return { success: true, data: rendered }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const runtimeCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      const code = runtimeCode.startsWith('OFFICE_RUNTIME_')
        ? runtimeCode
        : /LibreOffice|soffice|pdftoppm|renderer unavailable/i.test(message)
        ? 'OFFICE_PREVIEW_RENDERER_UNAVAILABLE'
        : undefined
      return { success: false, ...(code ? { code } : {}), error: message }
    }
  },

  'fs:writeFile': async (_event: IpcMainInvokeEvent, filePath: string, content: string) => {
    try {
      if (!filePath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'write')
      if (!access.ok) {
        log.warn('fs:writeFile 被拒绝', { name: path.basename(resolved), reason: access.error })
        return { success: false, error: access.error }
      }
      try {
        const stat = await fsPromises.stat(resolved)
        if (stat.isDirectory()) {
          return { success: false, error: 'path is a directory' }
        }
      } catch {
        // 文件不存在则继续创建
      }
      await fsPromises.writeFile(resolved, content ?? '', 'utf8')
      // 覆盖写文件：记录 basename + 字节数（不打路径全文/内容）
      log.info('fs:writeFile 完成', { name: path.basename(resolved), bytes: (content ?? '').length })
      return { success: true }
    } catch (error) {
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:writeFile 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:replaceInFiles': async (
    _event: IpcMainInvokeEvent,
    input: ReplaceInFilesRequest,
  ): Promise<ReplaceInFilesResponse> => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return invalidReplaceRequest('replace request must be an object')
      }
      const { rootPath, edits } = input
      if (typeof rootPath !== 'string' || !rootPath.trim()) {
        return invalidReplaceRequest('rootPath is required')
      }
      if (rootPath.length > 4096 || !path.isAbsolute(rootPath) || !Array.isArray(edits)) {
        return invalidReplaceRequest('invalid rootPath or edits')
      }
      if (edits.length > MAX_REPLACE_EDITS) {
        return invalidReplaceRequest(`too many edits (max ${MAX_REPLACE_EDITS})`)
      }
      const payloadBytes = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8')
      if (payloadBytes > MAX_REPLACE_PAYLOAD_BYTES) {
        return invalidReplaceRequest(`replace payload too large (max ${MAX_REPLACE_PAYLOAD_BYTES} bytes)`)
      }

      const rootResolved = path.resolve(rootPath)
      const rootAccess = checkAndFormat(rootResolved, 'write')
      if (!rootAccess.ok) {
        log.warn('fs:replaceInFiles 根目录被拒绝', { reason: 'permission_denied' })
        return invalidReplaceRequest(rootAccess.error)
      }
      const rootStat = await fsPromises.stat(rootResolved)
      if (!rootStat.isDirectory()) return invalidReplaceRequest('rootPath must be a directory')
      const canonicalRoot = await fsPromises.realpath(rootResolved)
      const canonicalRootAccess = checkAndFormat(canonicalRoot, 'write')
      if (!canonicalRootAccess.ok) {
        log.warn('fs:replaceInFiles 真实根目录被拒绝', { reason: 'permission_denied' })
        return invalidReplaceRequest(canonicalRootAccess.error)
      }

      const grouped = new Map<string, ReplaceEditWithResolvedFile[]>()
      let totalTextBytes = 0
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
          return invalidReplaceRequest('invalid edit')
        }
        if (
          typeof edit.file !== 'string'
          || edit.file.length === 0
          || edit.file.length > 4096
          || typeof edit.expectedText !== 'string'
          || typeof edit.replacement !== 'string'
          || !Number.isSafeInteger(edit.byteStart)
          || !Number.isSafeInteger(edit.byteEnd)
        ) {
          return invalidReplaceRequest('invalid edit fields')
        }
        const expectedBytes = Buffer.byteLength(edit.expectedText, 'utf8')
        const replacementBytes = Buffer.byteLength(edit.replacement, 'utf8')
        totalTextBytes += expectedBytes + replacementBytes
        if (
          expectedBytes > MAX_REPLACE_TEXT_BYTES
          || replacementBytes > MAX_REPLACE_TEXT_BYTES
          || totalTextBytes > MAX_REPLACE_PAYLOAD_BYTES
        ) {
          return invalidReplaceRequest('replace text is too large')
        }
        const resolvedFile = path.resolve(rootResolved, edit.file)
        const normalizedEdit: ReplaceEditWithResolvedFile = { ...edit, resolvedFile }
        const fileEdits = grouped.get(resolvedFile) ?? []
        fileEdits.push(normalizedEdit)
        grouped.set(resolvedFile, fileEdits)
      }
      if (grouped.size > MAX_REPLACE_FILES) {
        return invalidReplaceRequest(`too many files (max ${MAX_REPLACE_FILES})`)
      }

      // Resolve all targets before reserving, then reserve the complete canonical
      // set atomically (synchronously) before any per-file read/write awaits.
      // Skip outside-root / missing paths here: realpath(ENOENT) would abort the
      // whole batch before per-file outside_root / stale_file handling runs.
      const canonicalFiles = new Map<string, string>()
      for (const resolvedFile of grouped.keys()) {
        if (!isPathInside(rootResolved, resolvedFile)) continue
        try {
          canonicalFiles.set(resolvedFile, await fsPromises.realpath(resolvedFile))
        } catch {
          // Missing or unresolvable target; the per-file loop reports stale_file.
        }
      }
      const canonicalTargets = Array.from(canonicalFiles.values())
      if (canonicalTargets.some(target => replaceInFlightPaths.has(target))) {
        return {
          success: false,
          status: 'failed',
          files: canonicalTargets.map(file => ({
            file,
            status: 'skipped' as const,
            replacementCount: 0,
            reason: 'replace_in_progress',
          })),
          totalReplacements: 0,
          error: 'replace_in_progress',
        }
      }
      canonicalTargets.forEach(target => replaceInFlightPaths.add(target))
      try {
        log.info('fs:replaceInFiles 开始', {
          fileCount: grouped.size,
          editCount: edits.length,
        })
        const files: ReplaceInFilesResponse['files'] = []
        let totalReplacements = 0
        for (const [resolvedFile, fileEdits] of grouped) {
        const name = path.basename(resolvedFile)
        if (!isPathInside(rootResolved, resolvedFile)) {
          files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'outside_root' })
          log.warn('fs:replaceInFiles 跳过越界路径', { name, reason: 'outside_root' })
          continue
        }
        const access = checkAndFormat(resolvedFile, 'write')
        if (!access.ok) {
          files.push({ file: resolvedFile, status: 'failed', replacementCount: 0, reason: 'permission_denied' })
          log.warn('fs:replaceInFiles 文件写权限拒绝', { name, reason: 'permission_denied' })
          continue
        }
        try {
          const canonicalFile = canonicalFiles.get(resolvedFile)
          if (!canonicalFile) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'stale_file' })
            continue
          }
          if (!isPathInside(canonicalRoot, canonicalFile)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'outside_root' })
            log.warn('fs:replaceInFiles 跳过越界路径', { name, reason: 'outside_root' })
            continue
          }
          const canonicalAccess = checkAndFormat(canonicalFile, 'write')
          if (!canonicalAccess.ok) {
            files.push({ file: resolvedFile, status: 'failed', replacementCount: 0, reason: 'permission_denied' })
            log.warn('fs:replaceInFiles 真实文件写权限拒绝', { name, reason: 'permission_denied' })
            continue
          }
          const stat = await fsPromises.stat(canonicalFile)
          if (!stat.isFile()) {
            files.push({ file: resolvedFile, status: 'failed', replacementCount: 0, reason: 'not_regular_file' })
            log.warn('fs:replaceInFiles 目标不是普通文件', { name, reason: 'not_regular_file' })
            continue
          }
          if (stat.size > MAX_REPLACE_FILE_BYTES) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'file_too_large' })
            log.warn('fs:replaceInFiles 跳过超大文件', { name, reason: 'file_too_large' })
            continue
          }
          const current = await fsPromises.readFile(canonicalFile)
          if (isBinaryBuffer(current)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'binary_file' })
            log.warn('fs:replaceInFiles 跳过二进制文件', { name, reason: 'binary_file' })
            continue
          }
          const applied = applyReplaceEditsToBuffer(current, fileEdits)
          if (!applied.ok) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: applied.reason })
            log.warn('fs:replaceInFiles 文件校验未通过', { name, reason: applied.reason })
            continue
          }
          if (isBinaryBuffer(applied.buffer)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'binary_output' })
            log.warn('fs:replaceInFiles 拒绝二进制输出', { name, reason: 'binary_output' })
            continue
          }
          // 最后一刻再次 realpath + boundary 校验，并使用该 canonical 路径写回。
          // 这仍无法消除 realpath、校验和 writeFile 之间极端的 symlink 竞态；
          // 按要求保持直接 writeFile，不使用 temp+rename，调用方仍依赖 expectedText
          // 校验与 checkpoint 降低风险。
          const finalCanonicalFile = await fsPromises.realpath(canonicalFile)
          if (!isPathInside(canonicalRoot, finalCanonicalFile)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'outside_root' })
            log.warn('fs:replaceInFiles 最终路径越界', { name, reason: 'outside_root' })
            continue
          }
          const finalAccess = checkAndFormat(finalCanonicalFile, 'write')
          if (!finalAccess.ok) {
            files.push({ file: resolvedFile, status: 'failed', replacementCount: 0, reason: 'permission_denied' })
            log.warn('fs:replaceInFiles 最终写权限拒绝', { name, reason: 'permission_denied' })
            continue
          }
          const finalStat = await fsPromises.stat(finalCanonicalFile)
          if (!sameFileIdentity(stat, finalStat)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'stale_file' })
            log.warn('fs:replaceInFiles 文件 identity 已变化', { name, reason: 'stale_file' })
            continue
          }
          // 重新读取并复核 expected byte ranges，避免读取后到写回前的内容变化被覆盖。
          const latest = await fsPromises.readFile(finalCanonicalFile)
          const latestApplied = applyReplaceEditsToBuffer(latest, fileEdits)
          if (!latestApplied.ok) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'stale_file' })
            log.warn('fs:replaceInFiles 写回前内容已变化', { name, reason: 'stale_file' })
            continue
          }
          if (isBinaryBuffer(latestApplied.buffer)) {
            files.push({ file: resolvedFile, status: 'skipped', replacementCount: 0, reason: 'binary_output' })
            continue
          }
          await fsPromises.writeFile(finalCanonicalFile, latestApplied.buffer)
          files.push({
            file: resolvedFile,
            status: 'success',
            replacementCount: fileEdits.length,
          })
          totalReplacements += fileEdits.length
          log.info('fs:replaceInFiles 文件完成', {
            name,
            replacementCount: fileEdits.length,
          })
        } catch (error) {
          const reason = getErrorType(error)
          files.push({ file: resolvedFile, status: 'failed', replacementCount: 0, reason })
          log.error('fs:replaceInFiles 文件失败', { name, errorType: reason })
        }
      }
        log.info('fs:replaceInFiles 完成', {
          fileCount: files.length,
          successCount: files.filter((file) => file.status === 'success').length,
          totalReplacements,
        })
        const successCount = files.filter((file) => file.status === 'success').length
        const status = successCount === files.length
          ? 'complete'
          : successCount > 0
            ? 'partial'
            : 'failed'
        return {
          success: status !== 'failed',
          status,
          files,
          totalReplacements,
        }
      } finally {
        canonicalTargets.forEach(target => replaceInFlightPaths.delete(target))
      }
    } catch (error) {
      const errorType = getErrorType(error)
      log.error('fs:replaceInFiles 失败', { errorType })
      return {
        success: false,
        files: [],
        totalReplacements: 0,
        error: errorType,
      }
    }
  },

  'fs:ensureSpaceSandbox': async (_event: IpcMainInvokeEvent, spaceId: string, organizationId?: string) => {
    return ensureSpaceSandboxImpl(spaceId, organizationId)
  },

  'fs:ensureDefaultAgentDir': async (_event: IpcMainInvokeEvent, input: EnsureDefaultAgentDirInput) => {
    return ensureDefaultAgentDirImpl(input)
  },

  /**
   * fs:lookupSpaceSandbox — 只查不建版的 sandbox 探测。
   *
   * 用途：PRD 第二轮 working_dir = Agent 文件夹合并后，存量 Space 可能在
   * `<spacesRoot>/<organizationId>/<spaceId>/` 留有旧 sandbox 数据。前端
   * ProfileWorkingDirForm 在"未设置 working_dir"状态时调用，看是否能引导
   * 用户一键导入旧路径作为 working_dir。
   *
   * 关键差异 vs `fs:ensureSpaceSandbox`：**不 mkdir**，符合 PRD §2.4
   * "TabTin 挂载物理实在，但不创造物理实在"。
   *
   * 返回 hasContent=true 表示目录存在且非空（有用户数据值得迁移）；
   * exists=true / hasContent=false 是空目录历史残留，迁移意义不大。
   */
  'fs:lookupSpaceSandbox': async (
    _event: IpcMainInvokeEvent,
    spaceId: string,
    organizationId?: string,
  ) => {
    try {
      if (!spaceId) {
        return { success: false, error: 'spaceId is required' }
      }
      const safeId = sanitizePathSegment(spaceId)
      const safeWtId = organizationId ? sanitizePathSegment(organizationId) : undefined
      const workspacePath = resolveSpaceWorkspaceRoot(resolveSpacesRoot(), safeWtId, safeId)

      // PRD §10 第二轮：本 IPC 只在 ProfileWorkingDirForm "未设置 working_dir" 状态下被调用,
      // 用于探测旧 sandbox 是否值得提示用户导入。即便 workspacePath 是平台自有 spacesRoot 下的
      // 子目录,也要走 path-access-checker——避免 spacesRoot 被改/被 symlink 到敏感位置时 IPC 成为
      // 任意目录探测面。
      const access = checkAndFormat(workspacePath, 'read')
      if (!access.ok) {
        return { success: false, error: access.error }
      }

      const exists = fs.existsSync(workspacePath)
      let hasContent = false
      if (exists) {
        try {
          const entries = await fsPromises.readdir(workspacePath)
          // 过滤掉 .DS_Store / Thumbs.db / 以 . 开头的隐藏文件 / Skills 目录占位 README
          // —— 仅 macOS 默认就会留 .DS_Store,会让 hasContent 永远为 true,导入按钮永远显示。
          const visibleEntries = entries.filter(name => {
            if (name.startsWith('.')) return false
            if (name === 'Thumbs.db' || name === 'desktop.ini') return false
            return true
          })
          hasContent = visibleEntries.length > 0
        } catch {
          hasContent = false
        }
      }
      return { success: true, path: workspacePath, exists, hasContent }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  /**
   * fs:watch — 启动一个递归 / 非递归的目录监听。
   *
   * **跨平台 fs.watch recursive 行为**：
   *   - **macOS**：FSEvents 后端，单 stream 监听整棵树，开销低
   *   - **Windows**：ReadDirectoryChangesW 后端，原生支持 recursive
   *   - **Linux**：Node 20.5.0+ 起 stable，更早版本 throw
   *     `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`；Electron 主进程 Node 版本
   *     满足要求。inotify 监听数受 `inotify_max_user_watches` 限制，
   *     超 8000 watcher 时可能触线（typical 设置 8192+）
   *
   * 这里不做平台分支处理（throw 会被 catch 转成 envelope error 返前端，
   * 前端 fail-soft 并 telemetry 上报）。
   *
   * **限流**：单 sender 80 + 全局 200。触线返 envelope error 同时上报
   * telemetry，前端 useFolderWatch 会写到 `window.__TABTIN_FS_WATCH_TELEMETRY__`
   * 便于 dogfood 期定位。
   */
  'fs:watch': async (event: IpcMainInvokeEvent, dirPath: string, options?: { recursive?: boolean }) => {
    try {
      if (!dirPath) {
        return { success: false, error: 'path is required' }
      }
      const sender = event.sender
      const senderId = sender.id
      if (watchers.size >= MAX_WATCHERS_GLOBAL) {
        return { success: false, error: `watcher limit reached (global max ${MAX_WATCHERS_GLOBAL})` }
      }
      const senderBucket = watchersBySender.get(senderId)
      if (senderBucket && senderBucket.size >= MAX_WATCHERS_PER_SENDER) {
        return { success: false, error: `watcher limit reached (per-sender max ${MAX_WATCHERS_PER_SENDER})` }
      }
      const resolved = path.resolve(dirPath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const stat = await fsPromises.stat(resolved)
      if (!stat.isDirectory()) {
        return { success: false, error: 'path is not a directory' }
      }
      const watchId = buildWatchId()

      const emitRootLost = () => {
        const entry = watchers.get(watchId)
        if (!entry || entry.sender.isDestroyed()) {
          cleanupWatcher(watchId)
          return
        }
        const payload: FsWatchEvent = {
          watchId,
          parentDir: entry.rootPath,
          rootPath: entry.rootPath,
          eventType: 'rename',
          isGlobal: true,
          isRootLost: true,
        }
        try {
          entry.sender.send('fs:watch-event', payload)
        } catch {
          // sender gone
        }
        cleanupWatcher(watchId)
      }

      const watcher = fs.watch(resolved, { recursive: Boolean(options?.recursive) }, (eventType, filename) => {
        const entry = watchers.get(watchId)
        if (!entry) return
        if (entry.sender.isDestroyed()) {
          cleanupWatcher(watchId)
          return
        }

        const filenameStr = filename?.toString()

        // dogfood "node_modules 风暴"修复：用户在 watch 根下跑 pnpm install
        // 等批量操作时 Node fs.watch 会推上万条事件。直接在入口丢弃，避免
        // IPC + 防抖 Map + flush 链路全部空跑。
        if (isIgnoredWatchPath(filenameStr)) return

        const fullPath = filenameStr
          ? path.join(entry.rootPath, filenameStr)
          : undefined
        // recursive 模式下 filename 是相对 root 的相对路径（"subdir/foo.txt"），
        // path.dirname 取出实际的父目录。
        //
        // **isGlobal 语义**：filename 为空 = OS 文件系统层 overflow（macOS
        // FSEvents `kFSEventStreamEventFlagMustScanSubDirs` / Linux inotify
        // `IN_Q_OVERFLOW`），此时 main 端拿不到具体变化路径，只能告诉前端
        // "整棵树需要重扫"。前端收到 isGlobal=true 必须遍历自己 cache 的
        // 全部已展开目录都重读，否则深层子目录的变化会漏掉（只刷根目录
        // 不够——子目录里的新文件还是看不见）。
        const isGlobal = !filenameStr
        const parentDir = fullPath ? path.dirname(fullPath) : entry.rootPath
        const previous = entry.pendingByParent.get(parentDir)
        const mergedIsGlobal = Boolean(previous?.isGlobal || isGlobal)
        entry.pendingByParent.set(parentDir, {
          // rename 代表目录项集合可能变化，后续 change 不能把这层语义降级，
          // 否则 renderer 不会重建该目录的搜索索引。
          eventType: previous?.eventType === 'rename' || eventType === 'rename'
            ? 'rename'
            : String(eventType),
          fullPath: mergedIsGlobal ? undefined : fullPath,
          isGlobal: mergedIsGlobal,
        })

        if (entry.timer) return
        entry.timer = setTimeout(() => {
          entry.timer = null
          const events = [...entry.pendingByParent.entries()]
          entry.pendingByParent.clear()

          // 根目录被 Finder 改名/删除后，部分平台仍会推事件但路径已失效。
          // flush 前探测一次：不存在则发 rootLost，避免前端对旧路径静默 readDir。
          void fsPromises.stat(entry.rootPath).then(
            (st) => {
              const live = watchers.get(watchId)
              if (!live) return
              if (!st.isDirectory()) {
                emitRootLost()
                return
              }
              for (const [parent, ev] of events) {
                const payload: FsWatchEvent = {
                  watchId,
                  parentDir: parent,
                  rootPath: live.rootPath,
                  eventType: ev.eventType || 'change',
                  fullPath: ev.fullPath,
                  isGlobal: ev.isGlobal,
                }
                try {
                  live.sender.send('fs:watch-event', payload)
                } catch {
                  cleanupWatcher(watchId)
                  return
                }
              }
            },
            (err: NodeJS.ErrnoException) => {
              if (err?.code === 'ENOENT') {
                emitRootLost()
                return
              }
              const live = watchers.get(watchId)
              if (!live) return
              for (const [parent, ev] of events) {
                const payload: FsWatchEvent = {
                  watchId,
                  parentDir: parent,
                  rootPath: live.rootPath,
                  eventType: ev.eventType || 'change',
                  fullPath: ev.fullPath,
                  isGlobal: ev.isGlobal,
                }
                try {
                  live.sender.send('fs:watch-event', payload)
                } catch {
                  cleanupWatcher(watchId)
                  return
                }
              }
            },
          )
        }, WATCH_DEBOUNCE_MS)
      })

      watcher.on('error', (err) => {
        log.warn('fs:watch error — treating as root lost', {
          name: path.basename(resolved),
          error: err instanceof Error ? err.message : String(err),
        })
        emitRootLost()
      })

      const destroyHandler = () => {
        cleanupWatcher(watchId)
      }

      watchers.set(watchId, {
        watcher,
        sender,
        senderId,
        rootPath: resolved,
        timer: null,
        destroyHandler,
        pendingByParent: new Map(),
      })

      let bucket = watchersBySender.get(senderId)
      if (!bucket) {
        bucket = new Set()
        watchersBySender.set(senderId, bucket)
      }
      bucket.add(watchId)

      sender.once('destroyed', destroyHandler)

      return { success: true, watchId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'fs:unwatch': async (event: IpcMainInvokeEvent, watchId: string) => {
    const entry = watchers.get(watchId)
    if (entry && entry.senderId !== event.sender.id) {
      return { success: false, error: 'access denied: watcher owned by another sender' }
    }
    cleanupWatcher(watchId)
    return { success: true }
  },

  'fs:readBinaryFile': async (_event: IpcMainInvokeEvent, filePath: string) => {
    try {
      if (!filePath) return { success: false, error: 'path is required' }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const stat = await fsPromises.stat(resolved)
      if (stat.size > MAX_BINARY_FILE_BYTES) {
        return {
          success: false,
          error: `file too large for binary read (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_BINARY_FILE_BYTES / 1024 / 1024}MB)`,
        }
      }
      const buffer = await fsPromises.readFile(resolved)
      return { success: true, data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'fs:writeBinaryFile': async (_event: IpcMainInvokeEvent, filePath: string, base64Data: string) => {
    try {
      if (!filePath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'write')
      if (!access.ok) {
        log.warn('fs:writeBinaryFile 被拒绝', { name: path.basename(resolved), reason: access.error })
        return { success: false, error: access.error }
      }
      const buffer = Buffer.from(base64Data, 'base64')
      await fsPromises.writeFile(resolved, buffer)
      log.info('fs:writeBinaryFile 完成', { name: path.basename(resolved), bytes: buffer.byteLength })
      return { success: true }
    } catch (error) {
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:writeBinaryFile 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:createDir': async (_event: IpcMainInvokeEvent, dirPath: string) => {
    try {
      if (!dirPath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(dirPath)
      const access = checkAndFormat(resolved, 'write')
      if (!access.ok) {
        log.warn('fs:createDir 被拒绝', { name: path.basename(resolved), reason: access.error })
        return { success: false, error: access.error }
      }
      // 禁止在「父目录已不存在」时用 recursive mkdir 悄悄复活整段旧路径
      //（Finder 改名后对幽灵 parent 新建文件夹会重建旧树，迷惑用户）。
      const parentDir = path.dirname(resolved)
      if (parentDir && parentDir !== resolved) {
        try {
          const parentStat = await fsPromises.stat(parentDir)
          if (!parentStat.isDirectory()) {
            return {
              success: false,
              error: 'parent path is not a directory',
              code: 'ENOTDIR',
            }
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'ENOENT') {
            return {
              success: false,
              error: 'parent directory does not exist',
              code: 'ENOENT',
            }
          }
          throw err
        }
      }
      await fsPromises.mkdir(resolved, { recursive: true })
      log.info('fs:createDir 完成', { name: path.basename(resolved) })
      return { success: true }
    } catch (error) {
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:createDir 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:rename': async (_event: IpcMainInvokeEvent, oldPath: string, newPath: string) => {
    try {
      if (!oldPath || !newPath) {
        return { success: false, error: 'both oldPath and newPath are required' }
      }
      const resolvedOld = path.resolve(oldPath)
      const resolvedNew = path.resolve(newPath)
      const accessOld = checkAndFormat(resolvedOld, 'write')
      if (!accessOld.ok) {
        log.warn('fs:rename 被拒绝(源)', { name: path.basename(resolvedOld), reason: accessOld.error })
        return { success: false, error: accessOld.error }
      }
      const accessNew = checkAndFormat(resolvedNew, 'write')
      if (!accessNew.ok) {
        log.warn('fs:rename 被拒绝(目标)', { name: path.basename(resolvedNew), reason: accessNew.error })
        return { success: false, error: accessNew.error }
      }
      try {
        await fsPromises.stat(resolvedNew)
        return { success: false, error: 'target path already exists' }
      } catch { /* target does not exist — proceed */ }
      await fsPromises.rename(resolvedOld, resolvedNew)
      // 移动/重命名（可能跨目录，覆盖前已挡）：记录 basename 便于回溯
      log.info('fs:rename 完成', { from: path.basename(resolvedOld), to: path.basename(resolvedNew) })
      return { success: true }
    } catch (error) {
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:rename 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:deleteDir': async (_event: IpcMainInvokeEvent, dirPath: string) => {
    try {
      if (!dirPath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(dirPath)
      const access = checkAndFormat(resolved, 'delete')
      if (!access.ok) {
        log.warn('fs:deleteDir 被拒绝', { name: path.basename(resolved), reason: access.error })
        return { success: false, error: access.error }
      }
      // 递归删除目录（不可逆）：删前 warn 留痕，删后确认
      log.warn('fs:deleteDir 开始递归删除', { name: path.basename(resolved) })
      await fsPromises.rm(resolved, { recursive: true, force: true })
      log.info('fs:deleteDir 完成', { name: path.basename(resolved) })
      return { success: true }
    } catch (error) {
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:deleteDir 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:deleteFile': async (_event: IpcMainInvokeEvent, filePath: string) => {
    try {
      if (!filePath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(filePath)
      const access = checkAndFormat(resolved, 'delete')
      if (!access.ok) {
        log.warn('fs:deleteFile 被拒绝', { name: path.basename(resolved), reason: access.error })
        return { success: false, error: access.error }
      }
      await fsPromises.unlink(resolved)
      // 删除文件（不可逆）
      log.info('fs:deleteFile 完成', { name: path.basename(resolved) })
      return { success: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return { success: true }
      const formatted = formatFileSystemWriteError(error)
      log.error('fs:deleteFile 失败', {
        code: formatted.code,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, ...formatted }
    }
  },

  'fs:ripgrepSearch': async (_event: IpcMainInvokeEvent, options: RipgrepSearchOptions) => {
    let requestId: string | undefined
    let controller: AbortController | undefined
    try {
      const {
        cwd,
        pattern,
        glob,
        includePathMatches,
        includeGlobs = [],
        excludeGlob,
        excludeGlobs = [],
        matchCase,
        wholeWord,
        includeIgnored,
        searchPath,
      } = options
      requestId = typeof options.requestId === 'string' && options.requestId.trim()
        ? options.requestId.trim()
        : undefined
      const rawMax = options.maxResults == null ? NaN : Number(options.maxResults)
      const maxResults = Number.isFinite(rawMax) ? Math.max(1, Math.min(rawMax, MAX_RIPGREP_RESULTS)) : 200
      const rawMaxCount = options.maxCount == null ? NaN : Number(options.maxCount)
      const perFileMaxCount = Number.isFinite(rawMaxCount)
        ? Math.max(1, Math.min(rawMaxCount, MAX_RIPGREP_RESULTS))
        : RIPGREP_DEFAULT_PER_FILE_MAX_COUNT
      if (!cwd || !pattern) {
        return { success: false, error: 'cwd and pattern are required', results: [] }
      }
      if (typeof pattern !== 'string' || pattern.length > 500) {
        return { success: false, error: 'pattern too long (max 500 characters)', results: [] }
      }
      if (searchPath != null && (typeof searchPath !== 'string' || searchPath.length > 4096)) {
        return { success: false, error: 'searchPath invalid', results: [] }
      }
      if (glob != null && (typeof glob !== 'string' || glob.length > MAX_GLOB_LENGTH)) {
        return { success: false, error: `glob too long (max ${MAX_GLOB_LENGTH} characters)`, results: [] }
      }
      if (
        excludeGlob != null
        && (typeof excludeGlob !== 'string' || excludeGlob.length > MAX_GLOB_LENGTH)
      ) {
        return { success: false, error: `glob too long (max ${MAX_GLOB_LENGTH} characters)`, results: [] }
      }
      const hasInvalidGlobList = (
        (Array.isArray(includeGlobs) && includeGlobs.some(value => typeof value !== 'string'))
        || (Array.isArray(excludeGlobs) && excludeGlobs.some(value => typeof value !== 'string'))
        || (!Array.isArray(includeGlobs) && includeGlobs !== undefined)
        || (!Array.isArray(excludeGlobs) && excludeGlobs !== undefined)
      )
      if (hasInvalidGlobList) {
        return { success: false, error: 'glob lists must be arrays of strings', results: [] }
      }
      const includeGlobValues = [
        ...(glob ? [glob] : []),
        ...(Array.isArray(includeGlobs) ? includeGlobs : []),
      ].filter((value): value is string => value.trim().length > 0)
      const excludeGlobValues = [
        ...(excludeGlob ? [excludeGlob] : []),
        ...(Array.isArray(excludeGlobs) ? excludeGlobs : []),
      ].filter((value): value is string => value.trim().length > 0)
      if (
        [...includeGlobValues, ...excludeGlobValues].some(value => value.length > MAX_GLOB_LENGTH)
      ) {
        return { success: false, error: `glob too long (max ${MAX_GLOB_LENGTH} characters)`, results: [] }
      }
      if (requestId && requestId.length > 128) {
        return { success: false, error: 'requestId too long', results: [] }
      }
      if (options.replace != null && typeof options.replace !== 'string') {
        return { success: false, error: 'replace must be a string', results: [] }
      }
      if (
        typeof options.replace === 'string'
        && Buffer.byteLength(options.replace, 'utf8') > MAX_REPLACE_TEXT_BYTES
      ) {
        return {
          success: false,
          error: `replace too long (max ${MAX_REPLACE_TEXT_BYTES} bytes)`,
          results: [],
        }
      }
      const resolved = path.resolve(cwd)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error, results: [] }

      let searchTarget = resolved
      if (typeof searchPath === 'string' && searchPath.trim()) {
        const resolvedSearchPath = path.isAbsolute(searchPath)
          ? path.resolve(searchPath)
          : path.resolve(resolved, searchPath)
        if (!isPathInside(resolved, resolvedSearchPath) && resolvedSearchPath !== resolved) {
          return { success: false, error: 'searchPath outside cwd', results: [] }
        }
        const searchAccess = checkAndFormat(resolvedSearchPath, 'read')
        if (!searchAccess.ok) return { success: false, error: searchAccess.error, results: [] }
        searchTarget = resolvedSearchPath
      }
      const isSingleFileSearch = searchTarget !== resolved

      const isRegex = options.isRegex ?? options.useRegex ?? false
      const rgReplacement = options.replace == null
        ? undefined
        : isRegex
          ? options.replace
          : escapeFixedRipgrepReplacement(options.replace)
      const args = [
        '--json',
        matchCase === true
          ? '--case-sensitive'
          : matchCase === false
            ? '--ignore-case'
            : '--smart-case',
        ...(isRegex ? [] : ['--fixed-strings']),
        ...(wholeWord ? ['--word-regexp'] : []),
        ...(includeIgnored ? ['--no-ignore'] : []),
        ...(rgReplacement !== undefined ? ['--replace', rgReplacement] : []),
        // 普通搜索保留既有预览上限；替换搜索必须拿到完整文件匹配，
        // 否则“全部替换”会静默漏掉被 max-count/max-filesize 截断的命中。
        ...(rgReplacement === undefined ? [
          '--max-count', String(perFileMaxCount),
          // rg 15.x 的 --max-filesize 只接受数字 + K/M/G（不带 B）；
          // 之前传 '1MB' 会报 "invalid format for size '1MB'"，整个搜索直接挂。
          '--max-filesize', '1M',
        ] : []),
        '--max-columns', '300',
        '--max-columns-preview',
      ]

      // 单文件「加载更多」跳过目录护栏/用户 exclude，避免已展示文件被二次过滤掉。
      if (!isSingleFileSearch) {
        for (const include of includeGlobValues) {
          args.push('--glob', include)
        }

        for (const ex of RIPGREP_EXCLUDES) {
          args.push('--glob', `!${ex}`)
        }
        for (const exclude of excludeGlobValues) {
          args.push('--glob', `!${exclude.replace(/^!/, '')}`)
        }
      }

      args.push('--', pattern, searchTarget)

      requestId = requestId || undefined
      if (requestId) {
        ripgrepControllers.get(requestId)?.abort()
        controller = new AbortController()
        ripgrepControllers.set(requestId, controller)
      }
      log.info('fs:ripgrepSearch 开始', {
        requestId: requestId ? requestId.slice(-12) : undefined,
        patternLength: pattern.length,
        isRegex,
        matchCase: matchCase ?? 'smart',
        wholeWord: Boolean(wholeWord),
        includeIgnored: Boolean(includeIgnored),
        hasReplacement: rgReplacement !== undefined,
      })

      // RP-017: concurrency control
      let acquired = false
      await ipcRipgrepSemaphore.acquire(controller?.signal)
      acquired = true
      let stdout = ''
      let truncatedByBuffer = false
      let invalidPattern: string | undefined
      try {
        try {
          const result = await execRipgrep(args, controller?.signal)
          stdout = result.stdout
        } catch (err: unknown) {
          if (isRipgrepAbortError(err, controller?.signal)) throw err
          const execErr = err as {
            code?: number | string
            stdout?: string
            stderr?: string
          }
          if (execErr.code === 1) {
            stdout = ''
          } else if (
            execErr.code === 2
            && isRegex
            && isRegexSyntaxError(execErr.stderr)
          ) {
            invalidPattern = firstStderrLine(execErr.stderr)
          } else if (execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && execErr.stdout) {
            stdout = execErr.stdout
            truncatedByBuffer = true
          } else {
            throw err
          }
        }
      } finally {
        if (acquired) ipcRipgrepSemaphore.release()
      }

      if (invalidPattern) {
        log.warn('fs:ripgrepSearch 正则无效', {
          requestId: requestId ? requestId.slice(-12) : undefined,
        })
        return {
          success: false,
          error: invalidPattern,
          errorCode: 'invalid_pattern',
          results: [],
        }
      }

      const results: RipgrepSearchResult[] = []
      const binaryFiles = new Set<string>()

      const lines = stdout.split('\n').filter(Boolean)
      let currentFile = ''

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'begin' && parsed.data?.path?.text) {
            currentFile = parsed.data.path.text
          } else if (
            parsed.type === 'end'
            && parsed.data
            && parsed.data.binary_offset != null
          ) {
            const binaryFile = parsed.data.path?.text || currentFile
            if (binaryFile) binaryFiles.add(binaryFile)
          } else if (parsed.type === 'match' && parsed.data) {
            const d = parsed.data
            if (results.length >= maxResults) continue
            const rawText: string = d.lines?.text ?? ''
            const text = normalizeSearchLine(rawText)
            const absoluteOffset = Number(d.absolute_offset)
            const submatches: ParsedRipgrepSubmatch[] = Array.isArray(d.submatches)
              ? d.submatches
                .map((submatch: {
                  start?: unknown
                  end?: unknown
                  match?: { text?: unknown }
                  replacement?: { text?: unknown }
                }): ParsedRipgrepSubmatch => ({
                  start: Number(submatch.start),
                  end: Number(submatch.end),
                  matchText: typeof submatch.match?.text === 'string'
                    ? submatch.match.text
                    : undefined,
                  replacement: typeof submatch.replacement?.text === 'string'
                    ? submatch.replacement.text
                    : undefined,
                }))
                .filter((range: ParsedRipgrepSubmatch) =>
                  Number.isFinite(range.start)
                  && Number.isFinite(range.end)
                  && range.start >= 0
                  && range.end >= range.start,
                )
              : []
            if (submatches.length === 0) continue
            const ranges: RipgrepSearchRange[] = submatches.map((range: RipgrepSearchRange) => ({
              start: byteOffsetToCharOffset(rawText, range.start),
              end: byteOffsetToCharOffset(rawText, range.end),
            }))
            const firstRange = ranges[0]
            const firstByteRange: RipgrepSearchByteRange | undefined =
              Number.isFinite(absoluteOffset)
                ? {
                    start: absoluteOffset + submatches[0].start,
                    end: absoluteOffset + submatches[0].end,
                  }
                : undefined
            const replacements: RipgrepSearchReplacement[] | undefined =
              rgReplacement !== undefined && Number.isFinite(absoluteOffset)
                ? submatches.map((submatch: ParsedRipgrepSubmatch, index: number) => ({
                    byteRange: {
                      start: absoluteOffset + submatch.start,
                      end: absoluteOffset + submatch.end,
                    },
                    range: ranges[index],
                    matchText: submatch.matchText
                      ?? text.slice(ranges[index].start, ranges[index].end),
                    ...(submatch.replacement !== undefined
                      ? { replacement: submatch.replacement }
                      : { replacementError: 'missing_preview' as const }),
                  }))
                : undefined
            results.push({
              file: currentFile || d.path?.text || '',
              line: d.line_number ?? 0,
              column: firstRange.start,
              text,
              matchText: text.slice(firstRange.start, firstRange.end),
              matchKind: 'content',
              ranges,
              byteRange: firstByteRange,
              ...(replacements ? {
                replacements,
                replacement: replacements[0]?.replacement,
                ...(replacements.some((replacement) => replacement.replacementError)
                  ? { replacementError: 'missing_preview' as const }
                  : {}),
              } : {}),
            })
          }
        } catch (error) {
          log.warn('fs:ripgrepSearch 跳过异常 JSON 行', {
            requestId: requestId ? requestId.slice(-12) : undefined,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      for (const result of results) {
        if (binaryFiles.has(result.file)) result.isBinary = true
      }

      if (controller?.signal.aborted) throw createRipgrepAbortError()
      // 追加路径名结果前先固定内容截断：路径扫描未完成不得污染替换门禁。
      const contentResultCount = results.length
      const contentTruncated = truncatedByBuffer || contentResultCount >= maxResults
      let pathMatchesTruncated = false
      if (
        includePathMatches
        && !isRegex
        && includeGlobValues.length === 0
        && excludeGlobValues.length === 0
        && !includeIgnored
        && results.length < maxResults
      ) {
        // 文件名遍历没有 ripgrep 的 ignore 文件解析器；includeIgnored=true
        // 时宁可不混入未经同等过滤的 path 结果，也不返回错误的文件名命中。
        const pathMatches = await collectPathNameMatches(
          resolved,
          pattern,
          maxResults - results.length,
          { signal: controller?.signal, matchCase, wholeWord },
        )
        if (controller?.signal.aborted) throw createRipgrepAbortError()
        pathMatchesTruncated = pathMatches.truncated
        const contentMatchedFiles = new Set(results.map(result => path.resolve(result.file)))
        results.push(...pathMatches.results.filter(
          result => !contentMatchedFiles.has(path.resolve(result.file)),
        ))
      }

      return {
        success: true,
        results,
        contentTruncated,
        pathMatchesTruncated,
        // 旧字段：任一维度未完整。替换门禁应改看 contentTruncated。
        truncated: contentTruncated || pathMatchesTruncated || results.length >= maxResults,
      }
    } catch (error) {
      if (isRipgrepAbortError(error, controller?.signal)) {
        log.info('fs:ripgrepSearch 已取消', {
          requestId: requestId ? requestId.slice(-12) : undefined,
        })
        return { success: false, canceled: true, results: [] }
      }
      const errCode = (error as NodeJS.ErrnoException)?.code
      if (errCode === 'ENOENT') {
        log.error('fs:ripgrepSearch 找不到 rg', { requestId: requestId?.slice(-12) })
        return {
          success: false,
          error: 'ripgrep (rg) is not installed. Please install it: brew install ripgrep',
          results: [],
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      log.error('fs:ripgrepSearch 失败', {
        requestId: requestId ? requestId.slice(-12) : undefined,
        errorCode: errCode,
        errorName: error instanceof Error ? error.name : typeof error,
      })
      return { success: false, error: message, results: [] }
    } finally {
      if (requestId && controller && ripgrepControllers.get(requestId) === controller) {
        ripgrepControllers.delete(requestId)
      }
    }
  },
  'fs:ripgrepSearchCancel': async (_event: IpcMainInvokeEvent, requestId: string) => {
    try {
      if (typeof requestId !== 'string' || !requestId.trim()) {
        return { success: false, error: 'requestId is required' }
      }
      const normalizedRequestId = requestId.trim()
      const controller = ripgrepControllers.get(normalizedRequestId)
      if (!controller) return { success: true, canceled: false }
      controller.abort()
      log.info('fs:ripgrepSearchCancel 已请求', {
        requestId: normalizedRequestId.slice(-12),
      })
      return { success: true, canceled: true }
    } catch (error) {
      log.error('fs:ripgrepSearchCancel 失败', {
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, error: '无法取消搜索' }
    }
  },

  'shell:openPath': async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      if (!targetPath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(targetPath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const result = await shell.openPath(resolved)
      if (result) {
        // shell.openPath 返回错误字符串，空字符串表示成功
        return { success: false, error: result }
      }
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'shell:openExternal': async (_event: IpcMainInvokeEvent, targetUrl: string) => {
    try {
      const url = normalizeSchemelessWebHref(String(targetUrl || '').trim())
      if (!url) {
        return { success: false, error: 'url is required' }
      }
      if (!isSafeExternalUrl(url)) {
        log.warn('shell:openExternal blocked', {
          hasScheme: /^[a-z][a-z0-9+.-]*:/i.test(url),
        })
        return { success: false, error: 'blocked: only http/https/mailto URLs are allowed' }
      }
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'shell:showItemInFolder': async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      if (!targetPath) {
        return { success: false, error: 'path is required' }
      }
      const resolved = path.resolve(targetPath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      shell.showItemInFolder(resolved)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },

  'clipboard:writeFile': async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      if (!targetPath) return { success: false, error: 'path is required' }
      const resolved = path.resolve(targetPath)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const info = await fsPromises.stat(resolved)
      if (!info.isFile()) return { success: false, error: 'path is not a file' }
      const { copyLocalFileToClipboard } = await import('../clipboard-media')
      await copyLocalFileToClipboard(resolved)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  'fs:computeSkillContentHash': async (_event: IpcMainInvokeEvent, skillDir: string) => {
    try {
      if (!skillDir) {
        return { success: false, error: 'skillDir is required' }
      }
      const resolved = path.resolve(skillDir)
      const access = checkAndFormat(resolved, 'read')
      if (!access.ok) return { success: false, error: access.error }
      const hash = await computeSkillContentHash(resolved)
      return { success: true, hash }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  },
} satisfies Record<string, FileSystemIpcHandler>

// ── Register / Unregister ──────────────────────────────────────────────────
//
// 生产路径走 ipc-lazy.ts 的 stub，**不会**调用下面的 register 函数。这里
// 保留是给两类场景：
// 1. 单元测试 / 集成测试：在 beforeEach 直接挂 handler，跳过 stub 体系
// 2. EAGER 模式（TABTIN_EAGER_IPC=1）：现在改成 stub 触发 import 同步等完
//    所以也不再调用这里。但保留向后兼容。

export function registerFileSystemIpcHandlers(): void {
  // 防御：可能与 ipc-lazy stub 冲突，先 remove 再 handle
  for (const channel of Object.keys(fileSystemHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const [channel, handler] of Object.entries(fileSystemHandlers)) {
    guardedHandle(channel, handler as FileSystemIpcHandler)
  }
}

export function unregisterFileSystemIpcHandlers(): void {
  for (const channel of Object.keys(fileSystemHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const controller of ripgrepControllers.values()) controller.abort()
  ripgrepControllers.clear()
  for (const watchId of [...watchers.keys()]) {
    cleanupWatcher(watchId)
  }
}
