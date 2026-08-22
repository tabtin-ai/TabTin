import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { Terminal } from '@xterm/xterm'
import { unregisterTerminalDispose } from './terminalRegistry'
import { createLogger } from '@/utils/logger'

const log = createLogger('TerminalRuntime')

export type TerminalCacheEntry = {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
  cleanup: Array<() => void>
  isSpawned: boolean
  isSpawning: boolean
  spawnOwner?: symbol
  snapshotRestored?: boolean
  liveOutputHydrated?: boolean
  dirtyForSnapshot: boolean
  /** 最近一次成功推送到 PTY 的尺寸；仅在实际调用 resize 后更新 */
  lastSyncedPtySize?: { cols: number; rows: number } | null
  createdAt: number
  onReady?: () => void
  onExit?: (exitCode: number) => void
}

const terminalCache = new Map<string, TerminalCacheEntry>()
const scrollListeners = new Map<string, Set<(atBottom: boolean) => void>>()
const inputWriteQueues = new Map<string, Promise<void>>()
const SNAPSHOT_SCROLLBACK = 1000
const PASTE_CHUNK_MAX_CHARS = 1024
const PASTE_CHUNK_DELAY_MS = 1
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

type XtermPrivateCore = {
  _renderService?: {
    dimensions?: {
      css?: {
        cell?: {
          width?: number
        }
      }
    }
    _renderer?: {
      value?: {
        clearTextureAtlas?: () => void
      }
    }
  }
}

type TerminalWithPrivateCore = Terminal & {
  _core?: XtermPrivateCore
}

export function hasTerminalCacheEntry(sessionId: string): boolean {
  return terminalCache.has(sessionId)
}

export function getTerminalCacheEntry(sessionId: string): TerminalCacheEntry | undefined {
  return terminalCache.get(sessionId)
}

export function setTerminalCacheEntry(sessionId: string, entry: TerminalCacheEntry): void {
  terminalCache.set(sessionId, entry)
}

export function getTerminalSearchAddon(sessionId: string): SearchAddon | null {
  return terminalCache.get(sessionId)?.searchAddon ?? null
}

export function isTerminalAtBottom(sessionId: string): boolean {
  const cached = terminalCache.get(sessionId)
  if (!cached) return true
  const buf = cached.terminal.buffer.active
  return buf.viewportY >= buf.baseY
}

export function scrollTerminalToBottom(sessionId: string): void {
  terminalCache.get(sessionId)?.terminal.scrollToBottom()
}

export function onTerminalScrollChange(
  sessionId: string,
  listener: (atBottom: boolean) => void,
): () => void {
  let set = scrollListeners.get(sessionId)
  if (!set) {
    set = new Set()
    scrollListeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) scrollListeners.delete(sessionId)
  }
}

export function notifyTerminalScrollListeners(sessionId: string, atBottom: boolean): void {
  const listeners = scrollListeners.get(sessionId)
  if (!listeners || listeners.size === 0) return
  listeners.forEach((listener) => listener(atBottom))
}

export const getTerminalSelection = (sessionId: string): string => {
  const cached = terminalCache.get(sessionId)
  if (!cached) return ''
  return cached.terminal.getSelection() || ''
}

export const clearTerminalBuffer = (sessionId: string): void => {
  const cached = terminalCache.get(sessionId)
  if (!cached) return
  cached.terminal.clear()
}

export const focusTerminalSession = (sessionId: string): void => {
  const cached = terminalCache.get(sessionId)
  if (!cached) return
  cached.terminal.focus()
}

/**
 * 检测终端是否处于可渲染状态：
 * - 容器已挂载到 DOM
 * - 非 display:none / visibility:hidden
 * - 容器有实际尺寸（>1px）
 *
 * 对齐 Superset 的 isCurrentTerminalRenderable 模式。
 */
export function isTerminalRenderable(sessionId: string): boolean {
  const cached = terminalCache.get(sessionId)
  if (!cached) return false
  const element = cached.terminal.element
  if (!element || !element.isConnected) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = element.getBoundingClientRect()
  return rect.width > 1 && rect.height > 1
}

/**
 * 确保 xterm.js 字符单元尺寸正确。
 * terminal.open() 在脱离 DOM 的容器中调用时会测量出 0x0，
 * 通过 fontSize 切换强制触发 CharSizeService 重新测量。
 *
 * xterm.js >=5.x 内部结构，版本升级时需验证。
 */
export function ensureCharCellDimensions(terminal: Terminal): void {
  try {
    const core = (terminal as TerminalWithPrivateCore)._core
    const cellWidth = core?._renderService?.dimensions?.css?.cell?.width
    if (typeof cellWidth === 'number' && cellWidth <= 0) {
      log.debug('字符单元尺寸为 0，强制重测量')
      const fontSize = terminal.options.fontSize ?? 13
      terminal.options.fontSize = fontSize + 1
      terminal.options.fontSize = fontSize
    }
  } catch (e) {
    log.debug('ensureCharCellDimensions 失败（内部 API 可能已变更）:', e)
  }
}

/**
 * 清除 WebGL/Canvas 渲染器的字形纹理缓存。
 * 终端被遮挡（parkingHost / 其他 tab）后重新显示时调用，
 * 防止字形缓存过期导致渲染异常。
 *
 * 对齐 Superset 的 clearTextureAtlas 模式。
 */
function clearTextureAtlas(terminal: Terminal): void {
  try {
    const core = (terminal as TerminalWithPrivateCore)._core
    core?._renderService?._renderer?.value?.clearTextureAtlas?.()
  } catch {
    // ignore — renderer may not support this
  }
}

const MIN_PTY_COLS = 4
const MIN_PTY_ROWS = 2

/**
 * 把当前 xterm 视口尺寸推给 PTY。
 *
 * 正确性契约：spawn 之后任意时刻都应保证
 * `terminal.cols/rows === stty size`。Portal 从 parking host 迁入可见
 * slot、或 spawn 前 ResizeObserver 已 fit 过但尚未 spawn 时，若只更新
 * 本地「上次尺寸」而不调用 resize，就会留下 80 列 PTY + 96 列渲染的错位。
 */
export function syncTerminalPtySize(
  sessionId: string,
  options: { force?: boolean } = {},
): { cols: number; rows: number } | null {
  const cached = terminalCache.get(sessionId)
  if (!cached?.isSpawned) return null

  const cols = cached.terminal.cols
  const rows = cached.terminal.rows
  if (cols < MIN_PTY_COLS || rows < MIN_PTY_ROWS) return null

  const last = cached.lastSyncedPtySize
  if (!options.force && last && last.cols === cols && last.rows === rows) {
    return last
  }

  const pty = window.tabtin?.pty
  if (!pty?.resize) {
    log.debug('syncTerminalPtySize: PTY bridge 不可用', sessionId)
    return null
  }

  cached.lastSyncedPtySize = { cols, rows }
  try {
    void pty.resize(sessionId, cols, rows)
  } catch (error) {
    log.debug('syncTerminalPtySize: resize 失败', { sessionId, cols, rows, error })
    return null
  }
  return { cols, rows }
}

/**
 * 终端重新可见时调用的完整恢复流程：
 * 1. 清除 WebGL 纹理缓存
 * 2. 确保字符尺寸正确
 * 3. fit 尺寸
 * 4. 全视口 refresh
 * 5. 若 PTY 已 spawn，把新尺寸同步过去
 *
 * 对齐 Superset 的 runReattachRecovery 模式。
 */
export function refreshTerminalViewport(sessionId: string): void {
  const cached = terminalCache.get(sessionId)
  if (!cached) return
  try {
    clearTextureAtlas(cached.terminal)
    ensureCharCellDimensions(cached.terminal)
    cached.fitAddon.fit()
    const rows = cached.terminal.rows
    if (rows > 0) {
      cached.terminal.refresh(0, rows - 1)
    }
    syncTerminalPtySize(sessionId)
  } catch {
    // ignore — terminal may have been disposed
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function enqueueTerminalInput(
  sessionId: string,
  write: () => Promise<void>,
): Promise<void> {
  const previous = inputWriteQueues.get(sessionId) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(write)

  inputWriteQueues.set(sessionId, task)
  return task.finally(() => {
    if (inputWriteQueues.get(sessionId) === task) {
      inputWriteQueues.delete(sessionId)
    }
  })
}

const takePasteChunk = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value
  }

  let end = maxChars
  const lastCharCode = value.charCodeAt(end - 1)
  if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
    end -= 1
  }
  return value.slice(0, Math.max(1, end))
}

export function buildTerminalPasteSegments(
  text: string,
  options: {
    bracketedPasteMode?: boolean
    maxChunkChars?: number
  } = {},
): string[] {
  if (!text) {
    return []
  }

  const maxChunkChars = options.maxChunkChars ?? PASTE_CHUNK_MAX_CHARS
  const segments: string[] = []
  let remaining = text

  if (options.bracketedPasteMode) {
    segments.push(BRACKETED_PASTE_START)
  }

  while (remaining.length > 0) {
    const chunk = takePasteChunk(remaining, maxChunkChars)
    segments.push(chunk)
    remaining = remaining.slice(chunk.length)
  }

  if (options.bracketedPasteMode) {
    segments.push(BRACKETED_PASTE_END)
  }

  return segments
}

async function writePasteSegments(sessionId: string, segments: string[]): Promise<void> {
  const pty = window.tabtin?.pty
  if (!pty) {
    log.warn('pasteToTerminal: PTY bridge 不可用', sessionId)
    return
  }

  for (let index = 0; index < segments.length; index += 1) {
    // ER-3: session dispose 后立即中止，避免写入已销毁 PTY
    if (!terminalCache.has(sessionId)) {
      log.debug('writePasteSegments: session 已销毁，中止粘贴', { sessionId, segmentIndex: index })
      return
    }
    // contract W2-β: pty.write 走 IPC `pty:write` (LEGACY_HANDLERS)，返
    // raw `{success, error?}`。失败仅 log + 中止后续段（fail-soft，避免对已坏掉的
    // PTY 继续写入）；不弹 toast 是因为粘贴体验上"半段写入"用户已能看到结果。
    try {
      const writeRes = await pty.write(sessionId, segments[index])
      if (!writeRes.success) {
        log.warn('pasteToTerminal: PTY 写入失败', { sessionId, segmentIndex: index })
        return
      }
    } catch (error) {
      log.warn('pasteToTerminal: PTY 写入异常', { sessionId, segmentIndex: index, error })
      return
    }
    if (index < segments.length - 1) {
      await wait(PASTE_CHUNK_DELAY_MS)
    }
  }
}

export const writeTerminalInput = (sessionId: string, data: string): Promise<void> => {
  if (!terminalCache.has(sessionId) || !data) {
    return Promise.resolve()
  }

  return enqueueTerminalInput(sessionId, async () => {
    if (!terminalCache.has(sessionId)) {
      return
    }

    const pty = window.tabtin?.pty
    if (!pty) {
      log.warn('writeTerminalInput: PTY bridge 不可用', sessionId)
      return
    }

    try {
      const writeRes = await pty.write(sessionId, data)
      if (!writeRes.success) {
        log.warn('writeTerminalInput: PTY 写入失败', { sessionId })
      }
    } catch (error) {
      log.warn('writeTerminalInput: PTY 写入异常', { sessionId, error })
    }
  })
}

export const pasteToTerminal = (sessionId: string, text: string): Promise<void> => {
  const cached = terminalCache.get(sessionId)
  if (!cached || !text) {
    return Promise.resolve()
  }

  const shouldUseBracketedPaste =
    cached.terminal.modes.bracketedPasteMode &&
    !cached.terminal.options.ignoreBracketedPasteMode

  const segments = buildTerminalPasteSegments(text, {
    bracketedPasteMode: shouldUseBracketedPaste,
  })
  if (segments.length === 0) {
    return Promise.resolve()
  }

  return enqueueTerminalInput(sessionId, () => writePasteSegments(sessionId, segments))
}

/**
 * 仅解除 DOM 绑定、清理 UI 状态。
 * Terminal 实例和 PTY 数据订阅保持活跃，适用于 Portal 卸载等临时脱离 DOM 的场景。
 */
export const detachTerminalSession = (sessionId: string): void => {
  const cached = terminalCache.get(sessionId)
  if (!cached) return
  log.debug('detachTerminalSession: 移除 DOM', sessionId)
  const element = cached.terminal.element
  if (element?.parentElement) {
    element.remove()
  }
}

/**
 * 终端 cache 的实际清理实现：dispose Terminal 实例、取消 PTY 订阅、清理 cache。
 * 由 terminalRegistry.destroyTerminalSession 间接调用（通过 registerTerminalDispose 注册的回调）。
 * 外部消费者应统一使用 terminalRegistry.destroyTerminalSession 作为入口。
 */
export const cleanupTerminalCacheEntry = (sessionId: string): void => {
  const cached = terminalCache.get(sessionId)
  if (!cached) {
    log.debug('cleanupTerminalCacheEntry: 缓存不存在', sessionId)
    return
  }
  log.debug('cleanupTerminalCacheEntry: 清理终端', sessionId)
  cached.cleanup.forEach((fn) => fn())
  cached.cleanup = []
  cached.terminal.dispose()
  terminalCache.delete(sessionId)
  scrollListeners.delete(sessionId)
  inputWriteQueues.delete(sessionId)
  unregisterTerminalDispose(sessionId)
}

export function isTerminalDirtyForSnapshot(sessionId: string): boolean {
  return terminalCache.get(sessionId)?.dirtyForSnapshot ?? false
}

export function serializeTerminalSnapshot(sessionId: string, cwd: string): {
  sessionId: string
  ansiOutput: string
  cwd: string
  cols: number
  rows: number
  scrollbackLines: number
  capturedAt: number
} | null {
  const cached = terminalCache.get(sessionId)
  if (!cached) return null
  try {
    const ansiOutput = cached.serializeAddon.serialize({ scrollback: SNAPSHOT_SCROLLBACK })
    if (!ansiOutput.trim()) return null
    cached.dirtyForSnapshot = false
    return {
      sessionId,
      ansiOutput,
      cwd,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
      scrollbackLines: SNAPSHOT_SCROLLBACK,
      capturedAt: Date.now(),
    }
  } catch (err) {
    log.warn('序列化终端快照失败:', sessionId, err)
    return null
  }
}

export function restoreTerminalSnapshot(
  sessionId: string,
  ansiOutput: string,
): boolean {
  const cached = terminalCache.get(sessionId)
  if (!cached || cached.snapshotRestored) return false
  try {
    cached.terminal.write(ansiOutput)
    cached.snapshotRestored = true
    return true
  } catch (err) {
    log.warn('恢复终端快照失败:', sessionId, err)
    return false
  }
}

export function getAllCachedSessionIds(): string[] {
  return Array.from(terminalCache.keys())
}

const ORPHAN_GC_INTERVAL_MS = 60_000
const ORPHAN_GRACE_PERIOD_MS = 30_000

export function startOrphanSessionGC(
  getActiveSessionIds: () => Set<string>,
): () => void {
  const timer = setInterval(() => {
    const active = getActiveSessionIds()
    const now = Date.now()
    for (const [sessionId, entry] of terminalCache) {
      if (!active.has(sessionId) && now - entry.createdAt > ORPHAN_GRACE_PERIOD_MS) {
        log.warn('GC orphan terminal session:', sessionId)
        cleanupTerminalCacheEntry(sessionId)
      }
    }
  }, ORPHAN_GC_INTERVAL_MS)
  return () => clearInterval(timer)
}
