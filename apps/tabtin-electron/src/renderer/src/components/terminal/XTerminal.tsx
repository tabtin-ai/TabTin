/**
 * XTerminal - 基于 xterm.js 的真正终端组件
 *
 * 特性：
 * - 完整的终端体验（ANSI 颜色、光标移动等）
 * - 支持交互式程序
 * - 自动调整大小
 * - 支持复制粘贴
 */

import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { cn } from '@utils/cn'
import '@xterm/xterm/css/xterm.css'
import i18n from '@/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { registerTerminalDispose } from './terminalRegistry'
import { createLogger } from '@/utils/logger'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { shellEscapePath, shellEscapePaths } from '@/utils/shell-escape'
import { ImagePasteToast } from './ImagePasteToast'
import { TerminalDropOverlay } from './TerminalDropOverlay'
import { RestoredOverlay } from './RestoredOverlay'
import {
  cleanupTerminalCacheEntry,
  ensureCharCellDimensions,
  getTerminalCacheEntry,
  hasTerminalCacheEntry,
  isTerminalRenderable,
  notifyTerminalScrollListeners,
  pasteToTerminal,
  refreshTerminalViewport,
  setTerminalCacheEntry,
  syncTerminalPtySize,
  type TerminalCacheEntry,
  writeTerminalInput,
} from './terminalRuntime'

const log = createLogger('XTerminal')

// ── xterm 主题配置 ──────────────────────────────────────

const darkTheme: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

const lightTheme: ITheme = {
  background: '#ffffff',
  foreground: '#383a42',
  cursor: '#383a42',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  selectionForeground: '#383a42',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#4f525e',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const getTerminalTheme = (resolvedTheme: 'light' | 'dark'): ITheme =>
  resolvedTheme === 'dark' ? darkTheme : lightTheme

// 终端字体链：等宽字体本身覆盖不到 emoji / 彩色符号，常见 CLI 的
// 启动 logo 会因此渲染成豆腐块。在等宽字体后追加各平台系统自带的
// emoji 字体作为 fallback，让缺字形的字符落到系统 emoji 字体而非缺字符方块。
// 只引用系统字体名、不打包任何字体文件，避免字体版权问题。
const TERMINAL_FONT_FAMILY =
  'Menlo, Monaco, "Courier New", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace'

const MAX_IMAGE_PASTE_SIZE = 10 * 1024 * 1024 // 10MB

type TabtinPtyBridge = NonNullable<NonNullable<Window['tabtin']>['pty']>

function isAgentTranscriptSession(sessionId: string): boolean {
  return sessionId.startsWith('agent-')
}

function shouldHydrateExistingOutput(sessionId: string, cacheEntry: TerminalCacheEntry): boolean {
  // Agent transcript session 经常在 renderer 打开 tab 前就完成；这类 session
  // 需要从 main 进程 outputBuffer 回放一次。普通用户终端仍主要依赖 snapshot，
  // 避免把面向 LLM 的 cleanOutput 回放路径扩大到交互终端。
  return isAgentTranscriptSession(sessionId)
    && !cacheEntry.liveOutputHydrated
    && !cacheEntry.snapshotRestored
}

function normalizeTranscriptForTerminal(output: string): string {
  return output.replace(/\r?\n/g, '\r\n')
}

function createTerminalCacheEntry(
  resolvedTheme: 'light' | 'dark',
): TerminalCacheEntry {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    fontFamily: TERMINAL_FONT_FAMILY,
    lineHeight: 1.2,
    scrollback: 10000,
    theme: getTerminalTheme(resolvedTheme),
    allowProposedApi: true,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)

  return {
    terminal,
    fitAddon,
    searchAddon,
    serializeAddon,
    cleanup: [],
    isSpawned: false,
    isSpawning: false,
    dirtyForSnapshot: false,
    createdAt: Date.now(),
  }
}

function ensureTerminalCacheEntry(
  sessionId: string,
  pty: TabtinPtyBridge,
): TerminalCacheEntry {
  const cached = getTerminalCacheEntry(sessionId)
  if (cached) return cached

  log.debug('创建新终端实例:', sessionId)
  traceTabRestore('terminal:createCacheEntry', { sessionId })
  const cacheEntry = createTerminalCacheEntry(useUIStore.getState().resolvedTheme)
  const { terminal } = cacheEntry

  setTerminalCacheEntry(sessionId, cacheEntry)
  registerTerminalDispose(sessionId, () => cleanupTerminalCacheEntry(sessionId))

  const notifyScrollState = () => {
    const buf = terminal.buffer.active
    notifyTerminalScrollListeners(sessionId, buf.viewportY >= buf.baseY)
  }
  const onScrollDisposable = terminal.onScroll(notifyScrollState)
  cacheEntry.cleanup.push(() => onScrollDisposable.dispose())

  const dataDisposable = terminal.onData((data) => {
    void writeTerminalInput(sessionId, data)
  })

  // P2-10: 用 rAF 聚合写入，避免 cat 大文件时每条 IPC 消息都触发 terminal.write()
  let writeChunks: string[] = []
  let writeRafId: number | null = null
  const flushWriteBuffer = () => {
    writeRafId = null
    if (writeChunks.length === 0) return
    const currentCache = getTerminalCacheEntry(sessionId)
    if (!currentCache) { writeChunks = []; return }
    currentCache.terminal.write(writeChunks.join(''))
    writeChunks = []
  }
  const unsubData = pty.onData(sessionId, (data: string) => {
    const currentCache = getTerminalCacheEntry(sessionId)
    if (!currentCache) return
    writeChunks.push(data)
    currentCache.dirtyForSnapshot = true
    if (writeRafId === null) {
      writeRafId = requestAnimationFrame(flushWriteBuffer)
    }
  })

  const unsubExit = pty.onExit(sessionId, (exitCode: number) => {
    const currentCache = getTerminalCacheEntry(sessionId)
    if (!currentCache) return
    currentCache.terminal.write(
      `\r\n\x1b[90m[${i18n.t('terminal:status.processExited', { code: exitCode })}]\x1b[0m\r\n`,
    )
    currentCache.onExit?.(exitCode)
  })

  cacheEntry.cleanup.push(() => dataDisposable.dispose())
  cacheEntry.cleanup.push(unsubData)
  // P2-10: 清理 write buffer 的 rAF
  cacheEntry.cleanup.push(() => {
    if (writeRafId !== null) { cancelAnimationFrame(writeRafId); writeRafId = null }
    writeChunks = []
  })
  cacheEntry.cleanup.push(unsubExit)

  return cacheEntry
}

interface XTerminalProps {
  sessionId: string
  cwd?: string
  spaceId?: string
  className?: string
  onReady?: () => void
  onExit?: (exitCode: number) => void
}

export const XTerminal: React.FC<XTerminalProps> = ({
  sessionId,
  cwd,
  spaceId,
  className,
  onReady,
  onExit
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isSpawnedRef = useRef(false)
  const resolvedTheme = useUIStore(s => s.resolvedTheme)

  // ER-16: 用 useRef 存储回调，避免回调变化触发 effect 重跑
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // ── 快照恢复提示 ──
  const [showRestoredOverlay, setShowRestoredOverlay] = useState(false)
  const hideRestoredOverlay = useCallback(() => setShowRestoredOverlay(false), [])

  // ── 图片粘贴 & 文件拖放状态 ──
  const [isDragging, setIsDragging] = useState(false)
  const [pasteToast, setPasteToast] = useState<{ path: string; status: 'saving' | 'saved' | 'error'; message?: string } | null>(null)
  const dragCounterRef = useRef(0)

  // 初始化或复用终端
  useEffect(() => {
    if (!containerRef.current) return

    const pty = window.tabtin?.pty
    if (!pty) {
      log.error(i18n.t('terminal:errors.ptyUnavailable'))
      return
    }

    log.debug('useEffect 触发:', sessionId, {
      hasCached: hasTerminalCacheEntry(sessionId),
      containerRef: !!containerRef.current
    })
    traceTabRestore('terminal:mount', {
      sessionId,
      cwd: cwd ?? null,
      spaceId: spaceId ?? null,
      hasCached: hasTerminalCacheEntry(sessionId),
    })

    const cacheEntry = ensureTerminalCacheEntry(sessionId, pty)

    // ER-16: 通过 ref 间接调用最新回调，避免回调变化导致 effect 重跑
    cacheEntry.onReady = () => onReadyRef.current?.()
    cacheEntry.onExit = (code: number) => onExitRef.current?.(code)

    terminalRef.current = cacheEntry.terminal
    fitAddonRef.current = cacheEntry.fitAddon
    isSpawnedRef.current = cacheEntry.isSpawned

    // 挂载到 DOM（复用已有 terminal 元素）
    const element = cacheEntry.terminal.element
    if (element && element.parentElement !== containerRef.current) {
      log.debug('移动 terminal element 到新容器:', sessionId)
      containerRef.current.appendChild(element)
    } else if (!element) {
      log.debug('首次 open terminal:', sessionId)
      cacheEntry.terminal.open(containerRef.current)
    } else {
      log.debug('terminal element 已在正确容器:', sessionId)
    }

    // Copy 优化：复制时去除每行行尾空白
    const container = containerRef.current
    let cancelled = false
    const mountToken = Symbol(sessionId)
    const copyHandler = (e: ClipboardEvent) => {
      const current = getTerminalCacheEntry(sessionId)
      const selection = current?.terminal.getSelection()
      if (!selection) return
      const trimmed = selection
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', trimmed)
        e.preventDefault()
      } else {
        void navigator.clipboard?.writeText(trimmed).catch(() => {})
      }
    }
    container.addEventListener('copy', copyHandler)

    const waitForNextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    // ：原本这里还有 `|| !container.isConnected`，意图是"容器脱离文档 = 过期挂载就别 spawn"。
    // 但终端是 TerminalPortal 先在 parking host（脱离文档，isConnected=false）里挂载、再 appendChild
    // 停靠到可见 slot——「移动 DOM」不触发 React 重挂载，spawn effect 不会重跑。于是切到终端时
    // spawnPty 在 parking 阶段被这条误判为 stale 直接 abort，停靠后再不 re-spawn → PTY 永不创建、
    // 终端只剩光标、输入全部「会话不存在」。crash 已在主进程 host 层根治（subprocess），这条防御
    // 既无必要又有害，去掉。真正的过期判定靠 `cancelled`（effect cleanup）与 cacheEntry 身份即可；
    // 无布局时 spawn 仍安全（hasLayout 门控跳过 fit、用默认 cols/rows，停靠后 ResizeObserver 再 fit）。
    const isStaleMount = () =>
      cancelled
      || getTerminalCacheEntry(sessionId) !== cacheEntry
    const abortSpawnIfStale = () => {
      if (!isStaleMount()) return false
      if (!cacheEntry.isSpawned && cacheEntry.spawnOwner === mountToken) {
        cacheEntry.isSpawning = false
        cacheEntry.spawnOwner = undefined
      }
      traceTabRestore('terminal:spawnPty:stale-abort', { sessionId })
      return true
    }
    const waitForSpawnSlot = async () => {
      while (cacheEntry.isSpawning && !cacheEntry.isSpawned && !isSpawnedRef.current) {
        await waitForNextFrame()
        if (abortSpawnIfStale()) return false
      }
      return true
    }

    /**
     * spawn / 复用成功后强制把当前视口推给 PTY。
     * 异步 spawn 期间终端可能已从 parking(约 80 列)迁到可见 slot(约 96 列)；
     * 若只用 spawn 瞬间的 cols/rows，或 spawn 前 ResizeObserver 记过尺寸却没 resize，
     * 就会出现 xterm 与 stty cols 不一致。
     */
    const syncViewportToPtyAfterSpawn = () => {
      if (abortSpawnIfStale()) return
      try {
        ensureCharCellDimensions(cacheEntry.terminal)
        cacheEntry.fitAddon.fit()
      } catch {
        // fit 失败不阻塞；仍尝试按当前 terminal.cols/rows 同步
      }
      syncTerminalPtySize(sessionId, { force: true })
    }

    // 初始 fit：若容器已连接则立即执行，否则依赖 ResizeObserver 自动触发
    if (container.isConnected) {
      requestAnimationFrame(() => {
        if (!cancelled) refreshTerminalViewport(sessionId)
      })
    }

    // 创建 pty 会话（含快照恢复）
    const spawnPty = async () => {
      if (cacheEntry.isSpawned || isSpawnedRef.current) return
      // React Activity/StrictMode 会出现 mount → cleanup → remount。先等一帧，
      // 让已过期的第一次 mount 有机会 cleanup，避免 stale effect 继续触发
      // pty.has/snapshot/spawn 这类主进程 IPC。
      await waitForNextFrame()
      if (abortSpawnIfStale()) return
      if (!(await waitForSpawnSlot())) return
      if (cacheEntry.isSpawned || isSpawnedRef.current) return
      cacheEntry.isSpawning = true
      cacheEntry.spawnOwner = mountToken

      // 检查容器是否有实际布局尺寸（>= 40px）。
      // parking host 中或布局未完成时容器可能极小，此时 fit() 会计算出
      // 错误的 cols/rows，导致快照尺寸比较误判和 ANSI 内容在错误列宽下被处理。
      const containerRect = container.getBoundingClientRect()
      const hasLayout = containerRect.width >= 40 && containerRect.height >= 40

      if (hasLayout) {
        try {
          ensureCharCellDimensions(cacheEntry.terminal)
          cacheEntry.fitAddon.fit()
        } catch {
          // fit 失败不阻塞 spawn，后续 ResizeObserver 会再次触发
        }
      }

      // 有布局时用 fit 结果比较快照尺寸；无布局时跳过比较直接恢复
      const snapshotSize = hasLayout
        ? { cols: cacheEntry.terminal.cols, rows: cacheEntry.terminal.rows }
        : undefined

      const cols = cacheEntry.terminal.cols
      const rows = cacheEntry.terminal.rows
      traceTabRestore('terminal:spawnPty:start', {
        sessionId,
        cwd: cwd ?? null,
        hasLayout,
        cols,
        rows,
        snapshotSize: snapshotSize ?? null,
      })

      let agentSessionExistsBeforeSnapshot: boolean | null = null
      if (isAgentTranscriptSession(sessionId)) {
        try {
          agentSessionExistsBeforeSnapshot = Boolean((await pty.has(sessionId))?.exists)
          if (abortSpawnIfStale()) return
        } catch {
          agentSessionExistsBeforeSnapshot = null
        }
      }

      // 尝试恢复快照（冷启动恢复 T8）
      if (!cacheEntry.snapshotRestored && pty.snapshotLoad && agentSessionExistsBeforeSnapshot !== true) {
        try {
          const snapshotResult = await pty.snapshotLoad(sessionId, snapshotSize)
          if (abortSpawnIfStale()) return
          traceTabRestore('terminal:snapshotLoad:result', {
            sessionId,
            success: Boolean(snapshotResult?.success),
            hasSnapshot: Boolean(snapshotResult?.snapshot),
            sizeMismatch: Boolean(snapshotResult?.snapshot?.sizeMismatch),
          })
          if (snapshotResult?.success && snapshotResult.snapshot) {
            const snap = snapshotResult.snapshot
            if (snap.sizeMismatch) {
              // W2-F4: 软校验 — 尺寸不匹配时仍恢复输出，避免用户丢失历史
              if (snap.ansiOutput) {
                cacheEntry.terminal.write(snap.ansiOutput)
              }
              if (!isAgentTranscriptSession(sessionId)) {
                cacheEntry.terminal.write(
                  `\r\n\x1b[33m[${i18n.t('terminal:restore.sizeMismatch', '快照尺寸略有差异，已尝试恢复（显示可能略有错位）')}]\x1b[0m\r\n`,
                )
              }
              cacheEntry.snapshotRestored = true
              setShowRestoredOverlay(true)
              // 恢复后触发 resize 适配当前尺寸
              try {
                ensureCharCellDimensions(cacheEntry.terminal)
                cacheEntry.fitAddon.fit()
              } catch { /* ignore */ }
              log.info('终端快照尺寸不匹配但仍恢复:', sessionId)
              if (!isAgentTranscriptSession(sessionId)) {
                pty.snapshotDelete?.(sessionId).catch(() => {})
              }
            } else if (snap.ansiOutput) {
              cacheEntry.terminal.write(snap.ansiOutput)
              cacheEntry.terminal.write(
                `\r\n\x1b[90m[${i18n.t('terminal:restore.restored')}]\x1b[0m\r\n`,
              )
              cacheEntry.snapshotRestored = true
              setShowRestoredOverlay(true)
              log.info('终端快照已恢复:', sessionId)
              // 清理已使用的快照
              if (!isAgentTranscriptSession(sessionId)) {
                pty.snapshotDelete?.(sessionId).catch(() => {})
              }
            }
          }
        } catch (err) {
          log.warn('加载终端快照失败:', sessionId, err)
          traceTabRestore('terminal:snapshotLoad:error', { sessionId, error: String(err) })
        }
      }

      // 先检查会话是否已存在（可能是 StrictMode 重新挂载）
      const existsResult = agentSessionExistsBeforeSnapshot != null
        ? { exists: agentSessionExistsBeforeSnapshot }
        : await pty.has(sessionId)
      if (abortSpawnIfStale()) return
      if (existsResult.exists) {
        cacheEntry.isSpawned = true
        cacheEntry.isSpawning = false
        cacheEntry.spawnOwner = undefined
        isSpawnedRef.current = true
        log.debug('PTY 会话已存在，复用:', sessionId)
        traceTabRestore('terminal:ptyExists', { sessionId, cols, rows })
        if (shouldHydrateExistingOutput(sessionId, cacheEntry) && pty.readOutput) {
          try {
            const replay = await pty.readOutput(sessionId, undefined)
            const currentCache = getTerminalCacheEntry(sessionId)
            if (currentCache === cacheEntry && replay?.success && replay.output) {
              currentCache.terminal.write(normalizeTranscriptForTerminal(replay.output))
              currentCache.dirtyForSnapshot = true
            }
            cacheEntry.liveOutputHydrated = true
          } catch (err) {
            log.warn('读取已有 Agent 终端输出失败:', sessionId, err)
            cacheEntry.liveOutputHydrated = true
          }
        }
        syncViewportToPtyAfterSpawn()
        cacheEntry.onReady?.()
        return
      }

      if (isAgentTranscriptSession(sessionId)) {
        cacheEntry.isSpawned = true
        cacheEntry.isSpawning = false
        cacheEntry.spawnOwner = undefined
        isSpawnedRef.current = true
        cacheEntry.terminal.options.disableStdin = true
        if (!cacheEntry.snapshotRestored) {
          cacheEntry.terminal.write(
            `\x1b[90m[${i18n.t('terminal:restore.agentTranscriptUnavailable', '这条 Agent 终端记录已不在当前进程中，聊天卡片仍保留了命令输出。')}]\x1b[0m\r\n`,
          )
        }
        traceTabRestore('terminal:agentTranscriptReadonly', {
          sessionId,
          cwd: cwd ?? null,
          snapshotRestored: Boolean(cacheEntry.snapshotRestored),
        })
        cacheEntry.onReady?.()
        return
      }

      // Phase 4：显式传 spaceId（真实执行 Space）消除 renderer/主进程口径不一致——
      // 主进程据此设置 shell 的 TABTIN_SPACE_ID。桌面沙箱终端 spaceId 为空 → 不注入 Space。
      const result = await pty.spawn(sessionId, {
        cols,
        rows,
        ...(cwd ? { cwd } : {}),
        ...(spaceId ? { spaceId } : {}),
      })
      if (abortSpawnIfStale()) return
      if (result.success) {
        cacheEntry.isSpawned = true
        cacheEntry.isSpawning = false
        cacheEntry.spawnOwner = undefined
        isSpawnedRef.current = true
        log.info('PTY 会话已创建:', sessionId)
        traceTabRestore('terminal:ptySpawned', { sessionId, cwd: cwd ?? null, spaceId: spaceId ?? null, cols, rows })
        syncViewportToPtyAfterSpawn()
        cacheEntry.onReady?.()
      } else {
        // 再次检查是否已存在（可能在 spawn 期间被创建）
        const recheckResult = await pty.has(sessionId)
        if (abortSpawnIfStale()) return
        if (recheckResult.exists) {
          cacheEntry.isSpawned = true
          cacheEntry.isSpawning = false
          cacheEntry.spawnOwner = undefined
          isSpawnedRef.current = true
          log.debug('PTY 会话在 spawn 期间已创建:', sessionId)
          traceTabRestore('terminal:ptyExistsAfterSpawnRace', { sessionId, cols, rows })
          syncViewportToPtyAfterSpawn()
          cacheEntry.onReady?.()
        } else {
          cacheEntry.isSpawning = false
          cacheEntry.spawnOwner = undefined
          cacheEntry.terminal.write(`\x1b[31m${i18n.t('terminal:errors.createSessionFailed')}\x1b[0m\r\n`)
          traceTabRestore('terminal:ptySpawnFailed', { sessionId, cwd: cwd ?? null, cols, rows })
        }
      }
    }

    spawnPty()

    // 清理：保留终端实例，仅释放当前挂载的监听器
    return () => {
      log.debug('useEffect cleanup:', sessionId)
      cancelled = true
      // StrictMode/Activity 修复：cleanup 不直接重置 isSpawning。
      // 过期 spawnPty 会在 await 边界用 mountToken 判定并释放自己的锁；
      // 新的 active mount 会等待旧锁释放后继续复用或创建 PTY。
      container.removeEventListener('copy', copyHandler)
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [cwd, sessionId, spaceId])

  // ── 图片粘贴拦截 ──
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((toast: typeof pasteToast, durationMs = 2500) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setPasteToast(toast)
    if (toast) {
      toastTimerRef.current = setTimeout(() => {
        setPasteToast(null)
        toastTimerRef.current = null
      }, durationMs)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const pty = window.tabtin?.pty
    if (!pty) return

    const readFileAsBase64 = (file: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const commaIdx = dataUrl.indexOf(',')
          resolve(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl)
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      let imageItem: DataTransferItem | null = null
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          imageItem = item
          break
        }
      }

      if (!imageItem) {
        const text = e.clipboardData?.getData('text/plain')
        if (!text) return

        e.preventDefault()
        e.stopPropagation()
        await pasteToTerminal(sessionId, text)
        return
      }

      e.preventDefault()
      e.stopPropagation()

      const file = imageItem.getAsFile()
      if (!file) return

      if (file.size > MAX_IMAGE_PASTE_SIZE) {
        showToast({
          path: '',
          status: 'error',
          message: i18n.t('terminal:imagePaste.tooLarge', { size: Math.round(file.size / 1024 / 1024) }),
        })
        return
      }

      showToast({ path: '', status: 'saving' }, 10000)

      try {
        const base64 = await readFileAsBase64(file)

        // contract W2-β: pty.pasteImage 走 IPC `pty:paste-image`（LEGACY_HANDLERS），
        // 返 raw `{success, filePath?, error?}`。这里业务双分支（成功 paste / 失败 toast），
        // 不适合一刀切转 throw（catch 已经覆盖 throw 路径）—— 重命名变量避开字面 result.success。
        const pasteRes = await pty.pasteImage({
          imageBase64: base64,
          mimeType: imageItem.type,
          spaceId,
        })

        if (pasteRes.success && pasteRes.filePath) {
          const escaped = shellEscapePath(pasteRes.filePath)
          await pasteToTerminal(sessionId, escaped + ' ')
          showToast({ path: pasteRes.filePath, status: 'saved' })
        } else {
          showToast({
            path: '',
            status: 'error',
            message: pasteRes.error || i18n.t('terminal:imagePaste.failed'),
          })
        }
      } catch (err) {
        log.error('图片粘贴失败:', err)
        showToast({
          path: '',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    wrapper.addEventListener('paste', handlePaste, true)
    return () => {
      wrapper.removeEventListener('paste', handlePaste, true)
    }
  }, [sessionId, spaceId, showToast])

  // 监听主题变化，动态更新终端配色
  useEffect(() => {
    const theme = getTerminalTheme(resolvedTheme)
    const terminal = getTerminalCacheEntry(sessionId)?.terminal
    if (!terminal) return
    terminal.options.theme = theme
    // 刷新整个视口让配色立即生效
    const rows = terminal.rows
    if (rows > 0) {
      terminal.refresh(0, rows - 1)
    }
  }, [resolvedTheme, sessionId])

  // 监听容器大小变化（对齐 Superset 的 setupResizeHandlers + ResizeObserver 模式）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!window.tabtin?.pty) return

    const MIN_PX = 40
    const MIN_COLS = 4
    const MIN_ROWS = 2

    // P2-09: 用 rAF 节流 ResizeObserver，每帧最多调一次 fit()
    let resizeRafId: number | null = null

    const doResize = () => {
      resizeRafId = null
      if (fitAddonRef.current && terminalRef.current) {
        try {
          const rect = container.getBoundingClientRect()
          if (rect.width < MIN_PX || rect.height < MIN_PX) return

          ensureCharCellDimensions(terminalRef.current)
          fitAddonRef.current.fit()
          const cols = terminalRef.current.cols
          const rows = terminalRef.current.rows
          if (cols < MIN_COLS || rows < MIN_ROWS) return

          // spawn 前只 fit，不记「已同步尺寸」——避免挡住 spawn 后的强制 resize
          if (isSpawnedRef.current) {
            syncTerminalPtySize(sessionId)
          }
        } catch {
          // ignore
        }
      }
    }

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- XTerminal 通过 Portal 跨 SpaceActivity 子树复用，是否工作由 isTerminalRenderable/active session 控制。
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId === null) {
        resizeRafId = requestAnimationFrame(doResize)
      }
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
    }
  }, [sessionId])

  // 重新可见恢复（对齐 Superset 的 scheduleReattachRecovery 模式）
  useEffect(() => {
    const THROTTLE_MS = 120
    let lastRecoveryAt = 0
    let pendingFrame: number | null = null
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null

    const runRecovery = () => {
      if (document.hidden) return
      if (!isTerminalRenderable(sessionId)) return

      // refresh 内已 fit + syncTerminalPtySize；force 再推一次，
      // 覆盖「本地尺寸未变但 PTY 仍停在 parking 列数」的竞态。
      refreshTerminalViewport(sessionId)
      if (isSpawnedRef.current) {
        syncTerminalPtySize(sessionId, { force: true })
      }
    }

    const scheduleRecovery = () => {
      if (pendingFrame !== null) return
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null
        const now = Date.now()
        if (now - lastRecoveryAt < THROTTLE_MS) {
          const remaining = THROTTLE_MS - (now - lastRecoveryAt)
          pendingTimeout = setTimeout(() => {
            pendingTimeout = null
            scheduleRecovery()
          }, remaining + 1)
          return
        }
        lastRecoveryAt = now
        runRecovery()
      })
    }

    const handleVisibilityChange = () => {
      if (!document.hidden) scheduleRecovery()
    }
    const handleWindowFocus = () => scheduleRecovery()

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- XTerminal Portal 需要监听全局可见性恢复，回调内用 isTerminalRenderable 过滤非当前终端。
    document.addEventListener('visibilitychange', handleVisibilityChange)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- XTerminal Portal 需要监听窗口重新聚焦，回调内用 isTerminalRenderable 过滤非当前终端。
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
      if (pendingTimeout !== null) clearTimeout(pendingTimeout)
    }
  }, [sessionId])

  // 聚焦终端
  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  // ── 文件拖放处理 ──

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length === 0) {
      const textPath = e.dataTransfer.getData('text/plain')
      if (textPath) {
        const escaped = shellEscapePath(textPath)
        await pasteToTerminal(sessionId, escaped + ' ')
        showToast({ path: textPath, status: 'saved' })
      }
      return
    }

    const paths: string[] = []
    for (const file of Array.from(files)) {
      const path = window.electron?.webUtils?.getPathForFile?.(file) ?? (file as { readonly path?: string }).path
      if (path) {
        paths.push(path)
      }
    }

    if (paths.length > 0) {
      const escaped = shellEscapePaths(paths)
      await pasteToTerminal(sessionId, escaped + ' ')
      showToast({
        path: paths.length === 1 ? paths[0] : `${paths.length} files`,
        status: 'saved',
      })
    } else {
      showToast({
        path: '',
        status: 'error',
        message: i18n.t('terminal:dragDrop.pathError', { defaultValue: 'Cannot read file path' }),
      })
    }
  }, [sessionId, showToast])

  return (
    <div
      ref={wrapperRef}
      className={cn('w-full h-full relative', className)}
      style={{ backgroundColor: resolvedTheme === 'dark' ? '#1e1e1e' : '#ffffff' }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={containerRef}
        className="w-full h-full"
        onClick={focusTerminal}
      />
      <RestoredOverlay
        visible={showRestoredOverlay}
        onHide={hideRestoredOverlay}
      />
      {isDragging && <TerminalDropOverlay />}
      {pasteToast && (
        <ImagePasteToast
          status={pasteToast.status}
          path={pasteToast.path}
          message={pasteToast.message}
        />
      )}
    </div>
  )
}
