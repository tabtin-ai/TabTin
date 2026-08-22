/**
 * HTML5 DnD 生命周期探针
 *
 * 生产包诊断显示 Windows 有 CloudResourcesDnD dragStart，但无拖影 / 无 drop。
 * 同版本 macOS 正常。
 *
 * 本模块在 window capture 阶段记录 dragstart→drag→dragover→drop→dragend（无 React setState）。
 *
 * toast 处理改由主进程负责：Windows 空 toast **不创建 / 销毁** HWND（非 hide）。
 * 曾在 dragstart / pointerdown 内 sendSync hide，实测会话仍 ~12ms 被 dragend 掐死，
 * 故此处不再调用 setHtml5DragShieldSync，避免同步 IPC 干扰手势。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('Html5DnDProbe')

const MIME_SAMPLE_LIMIT = 8

let installed = false
let sessionId = 0
let activeSession: {
  id: number
  startedAt: number
  dragCount: number
  dragoverCount: number
  sourceConnectedAtStart: boolean | null
} | null = null

function isWindowsHost(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Windows/i.test(navigator.userAgent) || navigator.platform === 'Win32'
}

function sampleMimeTypes(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const types = Array.from(dt.types ?? [])
  return types.slice(0, MIME_SAMPLE_LIMIT)
}

function endSession(reason: string, event?: DragEvent): void {
  if (!activeSession) return
  const elapsedMs = Date.now() - activeSession.startedAt
  log.info('session end', {
    reason,
    sessionId: activeSession.id,
    elapsedMs,
    dragCount: activeSession.dragCount,
    dragoverCount: activeSession.dragoverCount,
    defaultPrevented: event?.defaultPrevented ?? null,
    dropEffect: event?.dataTransfer?.dropEffect ?? null,
    types: sampleMimeTypes(event?.dataTransfer ?? null),
  })
  activeSession = null
}

function onDragStart(event: DragEvent): void {
  sessionId += 1
  const target = event.target
  const sourceConnected =
    target instanceof Node ? target.isConnected : null
  activeSession = {
    id: sessionId,
    startedAt: Date.now(),
    dragCount: 0,
    dragoverCount: 0,
    sourceConnectedAtStart: sourceConnected,
  }
  log.info('session start', {
    sessionId: activeSession.id,
    types: sampleMimeTypes(event.dataTransfer),
    effectAllowed: event.dataTransfer?.effectAllowed ?? null,
    sourceConnected,
    defaultPrevented: event.defaultPrevented,
  })
}

function onDrag(event: DragEvent): void {
  if (!activeSession) return
  activeSession.dragCount += 1
  if (activeSession.dragCount === 1 || activeSession.dragCount === 10) {
    const target = event.target
    log.info('drag pulse', {
      sessionId: activeSession.id,
      dragCount: activeSession.dragCount,
      sourceConnected: target instanceof Node ? target.isConnected : null,
      elapsedMs: Date.now() - activeSession.startedAt,
    })
  }
}

function onDragOver(event: DragEvent): void {
  if (!activeSession) return
  activeSession.dragoverCount += 1
  if (activeSession.dragoverCount === 1) {
    log.info('first dragover', {
      sessionId: activeSession.id,
      defaultPrevented: event.defaultPrevented,
      types: sampleMimeTypes(event.dataTransfer),
      elapsedMs: Date.now() - activeSession.startedAt,
    })
  }
}

function onDrop(event: DragEvent): void {
  endSession('drop', event)
}

function onDragEnd(event: DragEvent): void {
  endSession('dragend', event)
}

function onBlur(): void {
  if (!activeSession) return
  endSession('blur')
}

/**
 * 幂等安装。应在主窗口 renderer 尽早调用（AppGlobalEffects）。
 * 返回卸载函数（测试用）。
 */
export function installHtml5DnDLifecycleProbe(): () => void {
  if (installed || typeof window === 'undefined') {
    return () => {}
  }
  installed = true

  window.addEventListener('dragstart', onDragStart, true)
  window.addEventListener('drag', onDrag, true)
  window.addEventListener('dragover', onDragOver, true)
  window.addEventListener('drop', onDrop, true)
  window.addEventListener('dragend', onDragEnd, true)
  window.addEventListener('blur', onBlur)

  log.info('installed', { windowsHost: isWindowsHost(), shieldMode: 'main-process-hwnd-retire' })

  return () => {
    window.removeEventListener('dragstart', onDragStart, true)
    window.removeEventListener('drag', onDrag, true)
    window.removeEventListener('dragover', onDragOver, true)
    window.removeEventListener('drop', onDrop, true)
    window.removeEventListener('dragend', onDragEnd, true)
    window.removeEventListener('blur', onBlur)
    activeSession = null
    installed = false
  }
}

/** 仅供测试 */
export function __resetHtml5DnDLifecycleProbeForTests(): void {
  activeSession = null
  sessionId = 0
  installed = false
}
