import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

import type { OverlayPushPayload } from '@shared/overlay/types'

import { guardedSyncOn } from '../terminal/ipc-sync-guard'
import { guardedHandle, guardedOn } from '../utils/guarded-handle'
import { getIMWindow } from '../window-manager'
import { createModalSourceTracker, type ModalSource } from './modal-source-tracker'
import { getModalWindowManager, getToastWindowManager } from './overlay-window-manager'

export const OVERLAY_IPC_CHANNELS = [
  'overlay:push',
  'overlay:ready',
  'overlay:confirm-result',
  'overlay:update-prompt-action',
  'overlay:global-search-closed',
  'overlay:navigate-search-result',
  'overlay:notification-action',
  'overlay:notification-closed',
  'overlay:sync-theme',
  'overlay:sync-locale',
  'overlay:focus',
  'overlay:set-modal-source-open',
  'overlay:set-hint-size',
  'overlay:set-toast-ignore-mouse-events',
  'overlay:get-toast-cursor-client-point',
  'overlay:set-toast-stack-size',
  'overlay:set-toast-content-visible',
  'overlay:set-html5-drag-shield-sync',
] as const

export function registerOverlayIpc(getMainWindow: () => BrowserWindow | null): void {
  const modalWindow = getModalWindowManager()
  const toastWindow = getToastWindowManager()
  const modalSources = createModalSourceTracker({
    show: (compact) => modalWindow.show(compact),
    hide: () => modalWindow.hide(),
  })

  guardedHandle('overlay:push', (_event, rawPayload: unknown) => {
    const payload = rawPayload as OverlayPushPayload
    // toast → 透明穿透 toast 子窗口；全屏模态 / 通知面板 → 半透明 modal 子窗口。
    if (payload.type === 'toast' || payload.type === 'toast-control') {
      toastWindow.push(payload)
      return { success: true }
    }
    if (payload.type === 'global-search') {
      modalWindow.push(payload)
      modalSources.setOpen('global-search', payload.open)
      return { success: true }
    }
    if (payload.type === 'confirm') {
      modalWindow.push(payload)
      modalSources.setOpen('confirm', true)
      return { success: true }
    }
    if (payload.type === 'update-prompt') {
      modalWindow.push(payload)
      modalSources.setOpen('update-prompt', payload.open)
      return { success: true }
    }
    if (payload.type === 'notification') {
      modalWindow.push(payload)
      modalSources.setOpen('notification', payload.open)
      return { success: true }
    }
    // ：只刷新列表缓存，不改 show/hide（勿走 setOpen）
    if (payload.type === 'notification-refresh') {
      modalWindow.push(payload)
      return { success: true }
    }
    return { success: true }
  })

  guardedOn('overlay:ready', (event) => {
    const modalContents = modalWindow.getWebContents()
    if (modalContents && event.sender === modalContents) {
      modalWindow.markReady()
      return
    }
    const toastContents = toastWindow.getWebContents()
    if (toastContents && event.sender === toastContents) {
      toastWindow.markReady()
    }
  })

  /**
   * 子窗口 → 主 renderer 转发样板：校验来自 modal 子窗口 → 转发同名 channel 给主 renderer
   * 执行（store/query/mutation/导航都在主窗口）→ 可选关闭 modal 子窗口。
   */
  const forwardModalToMain = (channel: string, { closeSource }: { closeSource?: ModalSource } = {}) => {
    guardedOn(channel, (event, rawPayload: unknown) => {
      const modalContents = modalWindow.getWebContents()
      if (!modalContents || event.sender !== modalContents) {
        return
      }
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, rawPayload)
      }
      if (closeSource) {
        modalSources.setOpen(closeSource, false)
      }
    })
  }

  forwardModalToMain('overlay:confirm-result', { closeSource: 'confirm' })
  forwardModalToMain('overlay:update-prompt-action')
  forwardModalToMain('overlay:global-search-closed', { closeSource: 'global-search' })
  forwardModalToMain('overlay:navigate-search-result', { closeSource: 'global-search' })
  forwardModalToMain('overlay:notification-action') // mark-all-read 等不关面板，由 notification-closed 控制
  forwardModalToMain('overlay:notification-closed', { closeSource: 'notification' })

  // 主 renderer 广播主题快照 → 转发给 toast / modal 两子窗口，以及独立的私信
  // 窗口（都是独立 renderer，需要镜像主窗口主题）。
  guardedOn('overlay:sync-theme', (event, rawSnapshot: unknown) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return
    }
    const targets = [
      modalWindow.getWebContents(),
      toastWindow.getWebContents(),
      getIMWindow()?.webContents ?? null,
    ]
    for (const wc of targets) {
      if (wc && !wc.isDestroyed()) {
        wc.send('overlay:sync-theme', rawSnapshot)
      }
    }
  })

  // 主 renderer 广播当前界面语言 → 转发给 toast / modal / 独立私信窗口。
  guardedOn('overlay:sync-locale', (event, rawLocale: unknown) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return
    }
    const targets = [
      modalWindow.getWebContents(),
      toastWindow.getWebContents(),
      getIMWindow()?.webContents ?? null,
    ]
    for (const wc of targets) {
      if (wc && !wc.isDestroyed()) {
        wc.send('overlay:sync-locale', rawLocale)
      }
    }
  })

  guardedHandle('overlay:focus', () => {
    modalWindow.focus()
    return { success: true }
  })

  // renderer 驱动 modal 子窗口 show/hide。
  //
  // 背景：像"保存密码条""自动填充建议"这类浮层，数据由主进程被动推送到 modal
  // 子窗口 webContents（各自的 `credential-vault:*` channel），但**显隐**得由
  // renderer 按"当前是否有可见内容"来驱动——所以需要 renderer → main 的开关。
  //
  // 通用化：所有这类浮层共用本 channel，避免每加一个就新开一条 IPC。
  // **安全边界**：renderer 只能开关自己拥有的 source；confirm / global-search /
  // update-prompt / notification 由主进程自身管理，白名单挡掉，防 renderer 乱设。
  const RENDERER_CONTROLLABLE_SOURCES = new Set<ModalSource>(['save-password', 'autofill-suggest'])
  guardedHandle('overlay:set-modal-source-open', (_event, args: unknown) => {
    const { source, open } = (args ?? {}) as { source?: unknown; open?: unknown }
    if (typeof source !== 'string' || !RENDERER_CONTROLLABLE_SOURCES.has(source as ModalSource)) {
      return { success: false, error: 'invalid-or-forbidden-source' }
    }
    modalSources.setOpen(source as ModalSource, Boolean(open))
    return { success: true }
  })

  // 提示型浮层（自动填充建议）上报卡片实际尺寸 → 主进程据此把贴角小窗调整到
  // 刚好覆盖卡片。renderer 用 ResizeObserver 在卡片尺寸变化时调用。
  guardedHandle('overlay:set-hint-size', (_event, args: unknown) => {
    const { width, height } = (args ?? {}) as { width?: unknown; height?: unknown }
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      return { success: false, error: 'invalid-size' }
    }
    modalWindow.setCompactSize({ width, height })
    return { success: true }
  })

  // toast 子窗口：指针落在卡片上时取消穿透，离开后恢复（ 关闭钮可点）。
  // 仅接受 toast webContents 调用，避免主窗口 / modal 误改穿透态。
  // 贴卡片收窗启用后主路径不再依赖本 channel（见 set-toast-stack-size）。
  guardedHandle('overlay:set-toast-ignore-mouse-events', (event, args: unknown) => {
    const toastContents = toastWindow.getWebContents()
    if (!toastContents || event.sender !== toastContents) {
      return { success: false, error: 'forbidden-sender' }
    }
    const ignore = (args as { ignore?: unknown } | null)?.ignore
    if (typeof ignore !== 'boolean') {
      return { success: false, error: 'invalid-ignore' }
    }
    toastWindow.setIgnoreMouseEvents(ignore)
    return { success: true }
  })

  // toast 刚出现时指针可能已停在卡片上（无 mousemove）；供 renderer 主动命中同步。
  guardedHandle('overlay:get-toast-cursor-client-point', (event) => {
    const toastContents = toastWindow.getWebContents()
    if (!toastContents || event.sender !== toastContents) {
      return { success: false, error: 'forbidden-sender' }
    }
    const point = toastWindow.getCursorClientPoint()
    if (!point) {
      return { success: false, error: 'no-window' }
    }
    return { success: true, data: point }
  })

  // toast 贴卡片：上报栈尺寸 → 主进程收成顶栏小窗并捕获点击（关闭钮主路径）。
  // size 为 null / 缺省宽高 → 恢复全屏穿透。仅 toast webContents。
  guardedHandle('overlay:set-toast-stack-size', (event, args: unknown) => {
    const toastContents = toastWindow.getWebContents()
    if (!toastContents || event.sender !== toastContents) {
      return { success: false, error: 'forbidden-sender' }
    }
    if (args == null) {
      toastWindow.setToastStackSize(null)
      return { success: true }
    }
    const { width, height } = args as { width?: unknown; height?: unknown }
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return { success: false, error: 'invalid-size' }
    }
    toastWindow.setToastStackSize({ width, height })
    return { success: true }
  })

  // toast overlay renderer：有/无可见卡片（Windows 空窗隐藏，保 OLE DnD）。
  guardedHandle('overlay:set-toast-content-visible', (event, args: unknown) => {
    const toastContents = toastWindow.getWebContents()
    if (!toastContents || event.sender !== toastContents) {
      return { success: false, error: 'forbidden-sender' }
    }
    const visible = (args as { visible?: unknown } | null)?.visible
    if (typeof visible !== 'boolean') {
      return { success: false, error: 'invalid-visible' }
    }
    toastWindow.setToastContentVisible(visible)
    return { success: true }
  })

  // 主 renderer HTML5 dragstart：同步藏起 toast，OLE DoDragDrop 前必须完成。
  guardedSyncOn('overlay:set-html5-drag-shield-sync', (event, args: unknown) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('forbidden-sender')
    }
    const active = (args as { active?: unknown } | null)?.active
    if (typeof active !== 'boolean') {
      throw new Error('invalid-active')
    }
    toastWindow.setHtml5DragShield(active)
    return { success: true }
  })
}

export function unregisterOverlayIpc(): void {
  for (const _channel of OVERLAY_IPC_CHANNELS) {
    // guardedHandle/guardedOn register via ipcMain - cleanup handled by ipc-registry
  }
}

export function isOverlayRendererEvent(event: IpcMainInvokeEvent): boolean {
  const modalContents = getModalWindowManager().getWebContents()
  const toastContents = getToastWindowManager().getWebContents()
  return Boolean(
    (modalContents && event.sender === modalContents) ||
      (toastContents && event.sender === toastContents),
  )
}
