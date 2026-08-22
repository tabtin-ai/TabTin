/**
 * Terminal IPC Handlers
 *
 * PTY 模式：交互式终端（xterm.js + node-pty）
 */

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { resolveInteractiveTerminalCwd } from './interactive-cwd'
import {
  getPtyManager,
  type AgentSessionClosedInfo,
  type PaneStatusEvent,
  type PtySpawnOptions,
} from './PtyManager'
import { PtyEventRouter, type PtyScopedEventType } from './PtyEventRouter'
import { webContents } from 'electron'
import { guardedHandle, guardedOn } from '../utils/guarded-handle'
import { guardedSyncOn } from './ipc-sync-guard'
import { saveClipboardImage, cleanupExpiredImages, type PasteImageParams } from './clipboard-image'
import {
  saveAllSnapshots,
  saveAllSnapshotsAsync,
  loadSnapshot,
  loadManifest,
  deleteSnapshot,
  clearAllSnapshotsAsync,
  isValidSnapshot,
  listAutoCheckpoints,
  type TerminalSnapshot,
} from './snapshot'
import { normalizeSize } from '@tabtin/pty-core'
import { resolvePtyManagerBridge } from '@tabtin/action-tools/runtime'
import { createLogger } from '../logger'

const log = createLogger('TerminalIPC')

let ptyManagerCleanup: (() => void) | null = null

// ── IPC 参数校验工具 (EM-3) ──

function validateNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid parameter: ${name} must be a non-empty string`)
  }
  return value
}

function validatePositiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new Error(`Invalid parameter: ${name} must be a positive integer`)
  }
  return value
}

function validateOptionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return validatePositiveInt(value, name)
}

function validateStringData(value: unknown, name: string, maxLength: number = 1024 * 1024): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid parameter: ${name} must be a string`)
  }
  if (value.length > maxLength) {
    throw new Error(`Invalid parameter: ${name} exceeds maximum length of ${maxLength}`)
  }
  return value
}

export function registerTerminalIpcHandlers(): void {
  const ptyManager = getPtyManager()
  const eventRouter = new PtyEventRouter()
  const trackedWebContentsIds = new Set<number>()

  const syncAllDataSubscriptions = (): void => {
    for (const sessionId of ptyManager.getAllSessionIds()) {
      ptyManager.setRendererDataSubscription(sessionId, eventRouter.hasSubscribers('data', sessionId))
    }
  }

  const trackSender = (sender: Electron.WebContents): void => {
    if (trackedWebContentsIds.has(sender.id)) return
    trackedWebContentsIds.add(sender.id)
    sender.once('destroyed', () => {
      eventRouter.removeWebContents(sender.id)
      trackedWebContentsIds.delete(sender.id)
      syncAllDataSubscriptions()
    })
  }

  const subscribeSessionEvent = (
    eventType: PtyScopedEventType,
    sender: Electron.WebContents,
    scopeId?: string,
  ): void => {
    trackSender(sender)
    eventRouter.subscribe(eventType, sender.id, scopeId)
    if (eventType === 'data') {
      syncAllDataSubscriptions()
    }
  }

  const unsubscribeSessionEvent = (
    eventType: PtyScopedEventType,
    sender: Electron.WebContents,
    scopeId?: string,
  ): void => {
    eventRouter.unsubscribe(eventType, sender.id, scopeId)
    if (eventType === 'data') {
      syncAllDataSubscriptions()
    }
  }

  /**
   * 清理已销毁的 webContents：从 eventRouter 和 trackedWebContentsIds 中移除，
   * 并同步 data 订阅状态（确保 PTY 不再向死链发送数据）。
   */
  const evictDeadWebContents = (wcId: number): void => {
    eventRouter.removeWebContents(wcId)
    trackedWebContentsIds.delete(wcId)
    syncAllDataSubscriptions()
  }

  /**
   * 按 eventType+scopeId 查找订阅者并转发，清理途中发现的死链 webContents。
   */
  const forwardToSubscribers = (
    eventType: PtyScopedEventType,
    scopeId: string,
    sendTo: (target: Electron.WebContents) => void,
  ): void => {
    const targetIds = eventRouter.getSubscriberIds(eventType, scopeId)
    for (const wcId of targetIds) {
      const target = webContents.fromId(wcId)
      if (!target || target.isDestroyed()) {
        evictDeadWebContents(wcId)
        continue
      }
      // EM-14: webContents 可能在 isDestroyed 检查后、send 前被销毁，
      // 用 try-catch 捕获异常并清理已销毁的 subscriber
      try {
        sendTo(target)
      } catch (error) {
        log.warn(`send failed for webContents ${wcId}, evicting:`, error)
        evictDeadWebContents(wcId)
      }
    }
  }

  // ========== PTY 模式（交互式终端）==========

  guardedHandle('pty:spawn', (_event: IpcMainInvokeEvent, sessionId: unknown, options?: PtySpawnOptions) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    const sanitizedOptions = { ...options }
    let homeDir: string | undefined
    try {
      homeDir = app.getPath('home')
    } catch {
      // app 尚未 ready 等极端情况：留空交给 PtyManager.resolveCwd 链兜底。
    }
    // Phase 4（PRD §1.5）：终端是全局桌面资源。renderer 对「桌面入口」的新终端不传 cwd
    // （执行型终端才显式带 Space working_dir），这里兜底落到用户主目录这个稳定的本地沙箱
    // —— 而不是 resolveCwd 的 process.cwd() 兜底（打包后可能是应用安装目录）。
    // ：如果传入的 Space working_dir 已被删除/卸载，不把坏 cwd 交给 PTY
    // 造成 Windows 终端面板打开即退出；回退 home 并在日志里留下原始路径。
    const cwdResolution = resolveInteractiveTerminalCwd(sanitizedOptions.cwd, homeDir)
    sanitizedOptions.cwd = cwdResolution.cwd
    if (cwdResolution.fallbackFrom) {
      log.warn(
        `pty:spawn cwd unreachable (${cwdResolution.fallbackReason}): ` +
          `${cwdResolution.fallbackFrom}; falling back to ${cwdResolution.cwd ?? '<default>'}`,
      )
    }
    // Phase 4：无显式 spaceId 的用户终端 = 桌面终端，不绑任何执行 Space。标记
    // noSpaceBinding 让 PtyManager 不从全局 env 兜底注入活跃 Space（否则桌面终端
    // shell 内 tabtin CLI 会静默落到当前活跃 Space）。执行型终端显式带 spaceId、不置标志。
    if (!sanitizedOptions.spaceId) {
      sanitizedOptions.noSpaceBinding = true
    }
    log.info(
      `spawn: session=${validId}, cwd=${sanitizedOptions.cwd ?? '<default>'}, ` +
        `spaceId=${sanitizedOptions.spaceId ?? 'none'}, noSpaceBinding=${!!sanitizedOptions.noSpaceBinding}, ` +
        `envKeys=${sanitizedOptions.env ? Object.keys(sanitizedOptions.env).length : 0}`,
    )
    const success = ptyManager.spawn(validId, sanitizedOptions)
    if (success) {
      ptyManager.setRendererDataSubscription(validId, eventRouter.hasSubscribers('data', validId))
    }
    return { success }
  })

  guardedHandle('pty:write', (_event: IpcMainInvokeEvent, sessionId: unknown, data: unknown) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    const validData = validateStringData(data, 'data')
    const success = ptyManager.write(validId, validData)
    return { success }
  })

  guardedHandle('pty:resize', (_event: IpcMainInvokeEvent, sessionId: unknown, cols: unknown, rows: unknown) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    const validCols = validateOptionalPositiveInt(cols, 'cols')
    const validRows = validateOptionalPositiveInt(rows, 'rows')
    const size = normalizeSize(validCols, validRows)
    log.debug('resize:', validId, size.cols, size.rows)
    const success = ptyManager.resize(validId, size.cols, size.rows)
    return { success }
  })

  guardedHandle('pty:kill', (_event: IpcMainInvokeEvent, sessionId: unknown) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    log.info('kill:', validId)
    const success = ptyManager.kill(validId)
    return { success }
  })

  guardedHandle('pty:agent-kill', async (_event: IpcMainInvokeEvent, sessionId: unknown) => {
    try {
      const validId = validateNonEmptyString(sessionId, 'sessionId')
      if (!validId.startsWith('agent-')) {
        log.warn('agent-kill rejected: non-agent sessionId')
        return { success: false }
      }
      const bridge = resolvePtyManagerBridge()
      if (!bridge?.killAgentSession) {
        log.warn('agent-kill: PtyManagerBridge unavailable')
        return { success: false }
      }
      log.info('agent-kill:', validId)
      // 显式 kill 信号：让前台 ShellCap poll 循环确定性退出等待（不赌进程死亡
      // 检测的竞态窗口）。设在 killAgentSession 之前，保证下一轮 poll 一定读到。
      ;(bridge as { requestKillAgentSession?: (sessionId: string) => boolean })
        .requestKillAgentSession?.(validId)
      await bridge.killAgentSession(validId, 'SIGTERM')
      ;(bridge as { notifyAgentSessionUserInterrupted?: (sessionId: string) => boolean })
        .notifyAgentSessionUserInterrupted?.(validId)
      return { success: true }
    } catch (error) {
      log.error('agent-kill failed:', error)
      return { success: false }
    }
  })

  guardedHandle('pty:agent-detach', (_event: IpcMainInvokeEvent, sessionId: unknown) => {
    try {
      const validId = validateNonEmptyString(sessionId, 'sessionId')
      if (!validId.startsWith('agent-')) {
        log.warn('agent-detach rejected: non-agent sessionId')
        return { success: false }
      }
      const bridge = resolvePtyManagerBridge() as {
        requestDetachAgentSession?: (sessionId: string) => boolean
      } | null
      if (!bridge?.requestDetachAgentSession) {
        log.warn('agent-detach: PtyManagerBridge unavailable')
        return { success: false }
      }
      log.info('agent-detach:', validId)
      return { success: bridge.requestDetachAgentSession(validId) }
    } catch (error) {
      log.error('agent-detach failed:', error)
      return { success: false }
    }
  })

  guardedHandle('pty:has', (_event: IpcMainInvokeEvent, sessionId: unknown) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    return { exists: ptyManager.has(validId) }
  })

  guardedHandle('pty:list', () => {
    return { sessions: ptyManager.getAllSessionIds() }
  })

  // ── 事件订阅 / 取消订阅 ──

  guardedOn('pty:subscribe-data', (event, sessionId?: string) => {
    subscribeSessionEvent('data', event.sender, sessionId)
  })

  guardedOn('pty:unsubscribe-data', (event, sessionId?: string) => {
    unsubscribeSessionEvent('data', event.sender, sessionId)
  })

  guardedOn('pty:subscribe-exit', (event, sessionId?: string) => {
    subscribeSessionEvent('exit', event.sender, sessionId)
  })

  guardedOn('pty:unsubscribe-exit', (event, sessionId?: string) => {
    unsubscribeSessionEvent('exit', event.sender, sessionId)
  })

  guardedOn('pty:subscribe-agent-session-created', (event, spaceId?: string) => {
    subscribeSessionEvent('agent-session-created', event.sender, spaceId)
  })

  guardedOn('pty:unsubscribe-agent-session-created', (event, spaceId?: string) => {
    unsubscribeSessionEvent('agent-session-created', event.sender, spaceId)
  })

  guardedOn('pty:subscribe-agent-session-closed', (event, spaceId?: string) => {
    subscribeSessionEvent('agent-session-closed', event.sender, spaceId)
  })

  guardedOn('pty:unsubscribe-agent-session-closed', (event, spaceId?: string) => {
    unsubscribeSessionEvent('agent-session-closed', event.sender, spaceId)
  })

  // P1-H (WP2)：'agent-session-title' IPC 通道已退役（agent-bridge.ts L168-174
  // 硬契约 — D3 每次命令独立 session 后标题在 created 时一次定死，
  // emitTitleIfNeeded + onAgentSessionTitle 一并删除）。

  guardedOn('pty:subscribe-auto-respond-triggered', (event, spaceId?: string) => {
    subscribeSessionEvent('auto-respond-triggered', event.sender, spaceId)
  })

  guardedOn('pty:unsubscribe-auto-respond-triggered', (event, spaceId?: string) => {
    unsubscribeSessionEvent('auto-respond-triggered', event.sender, spaceId)
  })

  // ── PtyManager 事件 → 渲染进程转发 ──

  // RT-4 R3：per-session data 攒批节流——减少高频小 chunk 的 IPC 广播放大。
  // PtyManager.onData 仍每 chunk appendToOutputBuffer（保 cursor / marker 检测
  // 及时），这里只合并"广播到 renderer"：攒满 DATA_FLUSH_BYTES 立即 flush（洪流
  // 路径，保证持续输出也会定量 flush、不被 debounce 无限推迟），否则
  // DATA_FLUSH_DEBOUNCE_MS（~1 帧）后 flush 尾巴。xterm 按字节流渲染，合并不影响
  // 显示；onPtyExit 前强制 flush 保证 data 早于 exit 到达 renderer（顺序不变）。
  const DATA_FLUSH_BYTES = 4096
  const DATA_FLUSH_DEBOUNCE_MS = 16
  const dataBatches = new Map<string, { chunks: string[]; bytes: number; timer: ReturnType<typeof setTimeout> | null }>()

  const flushDataBatch = (sessionId: string): void => {
    const batch = dataBatches.get(sessionId)
    if (!batch) return
    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    if (batch.chunks.length === 0) return
    const merged = batch.chunks.join('')
    batch.chunks = []
    batch.bytes = 0
    forwardToSubscribers('data', sessionId, t => t.send('pty:data', sessionId, merged))
  }

  const onPtyData = (sessionId: string, data: string) => {
    let batch = dataBatches.get(sessionId)
    if (!batch) {
      batch = { chunks: [], bytes: 0, timer: null }
      dataBatches.set(sessionId, batch)
    }
    batch.chunks.push(data)
    batch.bytes += data.length
    if (batch.bytes >= DATA_FLUSH_BYTES) {
      flushDataBatch(sessionId)
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => flushDataBatch(sessionId), DATA_FLUSH_DEBOUNCE_MS)
    }
  }
  ptyManager.on('data', onPtyData)

  const onPtyExit = (sessionId: string, exitCode: number, signal?: number) => {
    // RT-4 R3：exit 前 flush 残留 data 批，保证 data 早于 exit 到达 renderer。
    flushDataBatch(sessionId)
    dataBatches.delete(sessionId)
    forwardToSubscribers('exit', sessionId, t => t.send('pty:exit', sessionId, exitCode, signal))
  }
  ptyManager.on('exit', onPtyExit)

  // P1-B (WP2)：payload 加 `description` 字段透传到 renderer Tab title fallback
  // 链（agent-bridge.ts hook L96-98）。本 schema 与 bridge 旧 schema emit 字面一致。
  // L-WP6-1：补 `command` 字段—— hook 中间级 fallback 用 command.split('\n')[0]
  // .trim().slice(0, 60) 作 tab title，让 dogfood「连跑 3 条命令」能区分。
  // 4 件套人控路径 `PtyManager.spawnAgentSession` emit 时不传 command（无 LLM
  // 命令上下文），所以本字段在 IPC payload 上是可选 — hook 端有完整三级 fallback
  // 兜底（空时退化到 `Agent Terminal · {sessionId 后 6 位}`）。
  const onAgentSessionCreated = (info: {
    sessionId: string
    spaceId: string
    threadId: string | null
    cwd: string
    description?: string | null
    command?: string | null
  }) => {
    forwardToSubscribers('agent-session-created', info.spaceId, t => t.send('pty:agent-session-created', info))
  }
  ptyManager.on('agent-session-created', onAgentSessionCreated)

  const onAgentSessionClosed = (info: AgentSessionClosedInfo) => {
    forwardToSubscribers('agent-session-closed', info.spaceId, t => t.send('pty:agent-session-closed', info))
  }
  ptyManager.on('agent-session-closed', onAgentSessionClosed)

  const onAutoRespondTriggered = (info: {
    sessionId: string; spaceId: string | null;
    pattern: string; responseLength: number; timestamp: number
  }) => {
    forwardToSubscribers('auto-respond-triggered', info.spaceId ?? '', (target) => {
      target.send('pty:auto-respond-triggered', info)
    })
  }
  ptyManager.on('auto-respond-triggered', onAutoRespondTriggered)

  // ========== PTY 输出读取（给 LLM Agent 使用）==========

  guardedHandle('pty:readOutput', (_event: IpcMainInvokeEvent, sessionId: unknown, options?: { tail?: unknown }) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    const validTail = validateOptionalPositiveInt(options?.tail, 'tail')
    const result = ptyManager.getSessionOutput(validId, validTail != null ? { tail: validTail } : undefined)
    if (result) {
      return { success: true, ...result, ...result.metadata }
    }
    return { success: false, error: { message: `Session ${validId} not found`, code: 'NOT_FOUND' } }
  })

  guardedHandle('pty:listWithStatus', (_event: IpcMainInvokeEvent, spaceId?: string) => {
    return { success: true, sessions: ptyManager.getAllSessionsWithStatus(spaceId) }
  })

  guardedHandle('pty:releaseThreadSession', (_event: IpcMainInvokeEvent, threadId: unknown) => {
    const validId = validateNonEmptyString(threadId, 'threadId')
    ptyManager.releaseThreadSession(validId)
    return { success: true }
  })

  // ========== 图片粘贴（T3）==========

  guardedHandle('pty:paste-image', async (_event: IpcMainInvokeEvent, params: PasteImageParams) => {
    log.info('paste-image:', params.mimeType, params.spaceId)
    return saveClipboardImage(params)
  })

  cleanupExpiredImages().catch((err) => {
    log.warn('清理过期图片失败:', err)
  })

  // ========== Pane 运行状态（T7）==========

  guardedHandle('pty:getPaneStatuses', () => {
    return { success: true, statuses: ptyManager.getAllPaneStatuses() }
  })

  const onPaneStatus = (event: PaneStatusEvent) => {
    // S6-B1: 精确路由 — 避免多窗口状态污染
    const session = ptyManager.getSession(event.sessionId)
    if (session?.spaceId) {
      forwardToSubscribers('agent-session-created', session.spaceId,
        t => t.send('pty:pane-status', event))
    } else {
      forwardToSubscribers('data', event.sessionId,
        t => t.send('pty:pane-status', event))
    }
  }
  ptyManager.on('pane-status', onPaneStatus)

  // ========== 冷启动快照（T8）==========

  const filterValidSnapshots = (input: unknown[]): TerminalSnapshot[] =>
    input.filter(isValidSnapshot)

  guardedHandle('pty:snapshot-save', async (_event: IpcMainInvokeEvent, snapshots: unknown) => {
    if (!Array.isArray(snapshots)) return { success: false, error: 'invalid params' }
    const valid = filterValidSnapshots(snapshots)
    if (valid.length === 0) return { success: true, saved: 0, failed: snapshots.length }
    const result = await saveAllSnapshotsAsync(valid)
    return { success: true, ...result }
  })

  // pty:snapshot-save-sync 是 beforeunload 兜底快照（renderer 退出前最后
  // 一次同步保存，时间窗口内 invoke 走不通才用 sendSync）。同步 IPC 的
  // envelope 包装见 `terminal/ipc-sync-guard.ts` 文件头注释。
  // listener throw 会被 helper 自动转成 `errResponse('INTERNAL_ERROR', ...)`。
  guardedSyncOn('pty:snapshot-save-sync', (_event, snapshots: unknown) => {
    if (!Array.isArray(snapshots)) {
      throw new Error('invalid params: snapshots must be an array')
    }
    const valid = filterValidSnapshots(snapshots)
    if (valid.length === 0) {
      return { saved: 0, failed: snapshots.length }
    }
    return saveAllSnapshots(valid)
  })

  guardedHandle('pty:snapshot-load', (_event: IpcMainInvokeEvent, sessionId: unknown, currentSize?: { cols: number; rows: number }) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    const snapshot = loadSnapshot(validId, currentSize)
    return { success: true, snapshot }
  })

  guardedHandle('pty:snapshot-manifest', () => {
    const manifest = loadManifest()
    return { success: true, manifest }
  })

  guardedHandle('pty:snapshot-delete', (_event: IpcMainInvokeEvent, sessionId: unknown) => {
    const validId = validateNonEmptyString(sessionId, 'sessionId')
    deleteSnapshot(validId)
    return { success: true }
  })

  guardedHandle('pty:snapshot-clear', async () => {
    await clearAllSnapshotsAsync()
    return { success: true }
  })

  // ========== Auto Checkpoint（Agent 命令执行前自动快照） ==========

  guardedHandle('pty:auto-checkpoints-list', async (_event: IpcMainInvokeEvent, sessionId?: string) => {
    const checkpoints = await listAutoCheckpoints(sessionId)
    return { success: true, checkpoints }
  })

  const onAutoCheckpointSaved = (info: { sessionId: string; spaceId?: string; capturedAt: number }) => {
    // S6-B1: 精确路由 — 与 pane-status 同策略
    if (info.spaceId) {
      forwardToSubscribers('agent-session-created', info.spaceId,
        t => t.send('pty:auto-checkpoint-saved', info))
    } else {
      forwardToSubscribers('data', info.sessionId,
        t => t.send('pty:auto-checkpoint-saved', info))
    }
  }
  ptyManager.on('auto-checkpoint-saved', onAutoCheckpointSaved)

  ptyManagerCleanup = () => {
    ptyManager.off('data', onPtyData)
    ptyManager.off('exit', onPtyExit)
    ptyManager.off('agent-session-created', onAgentSessionCreated)
    ptyManager.off('agent-session-closed', onAgentSessionClosed)
    ptyManager.off('auto-respond-triggered', onAutoRespondTriggered)
    ptyManager.off('pane-status', onPaneStatus)
    ptyManager.off('auto-checkpoint-saved', onAutoCheckpointSaved)
  }

  log.info('✅ 已注册 PTY handlers')
}

export function unregisterTerminalIpcHandlers(): void {
  // SA-10: 先移除 ptyManager 上的事件监听器，防止旧 handler 残留
  if (ptyManagerCleanup) {
    ptyManagerCleanup()
    ptyManagerCleanup = null
  }

  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:write')
  ipcMain.removeHandler('pty:resize')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:agent-kill')
  ipcMain.removeHandler('pty:agent-detach')
  ipcMain.removeHandler('pty:has')
  ipcMain.removeHandler('pty:list')
  ipcMain.removeHandler('pty:readOutput')
  ipcMain.removeHandler('pty:listWithStatus')
  ipcMain.removeHandler('pty:releaseThreadSession')
  ipcMain.removeHandler('pty:paste-image')
  ipcMain.removeHandler('pty:getPaneStatuses')
  ipcMain.removeHandler('pty:snapshot-save')
  ipcMain.removeHandler('pty:snapshot-load')
  ipcMain.removeHandler('pty:snapshot-manifest')
  ipcMain.removeHandler('pty:snapshot-delete')
  ipcMain.removeHandler('pty:snapshot-clear')
  ipcMain.removeHandler('pty:auto-checkpoints-list')
  ipcMain.removeAllListeners('pty:subscribe-data')
  ipcMain.removeAllListeners('pty:unsubscribe-data')
  ipcMain.removeAllListeners('pty:subscribe-exit')
  ipcMain.removeAllListeners('pty:unsubscribe-exit')
  ipcMain.removeAllListeners('pty:subscribe-agent-session-created')
  ipcMain.removeAllListeners('pty:unsubscribe-agent-session-created')
  ipcMain.removeAllListeners('pty:subscribe-agent-session-closed')
  ipcMain.removeAllListeners('pty:unsubscribe-agent-session-closed')
  ipcMain.removeAllListeners('pty:subscribe-auto-respond-triggered')
  ipcMain.removeAllListeners('pty:unsubscribe-auto-respond-triggered')
  ipcMain.removeAllListeners('pty:snapshot-save-sync')

  log.info('⏹️ 已移除所有 terminal handlers')
}
