import type { Rectangle } from 'electron'
import { BrowserWindow, screen } from 'electron'

import type { OverlayPushPayload } from '@shared/overlay/types'

import { createLogger } from '../logger'
import { resolveOverlayPreloadPath, resolveOverlayWindowUrl } from './overlay-url'

const log = createLogger('OverlayWindowManager')

export type OverlayWindowRole = 'modal' | 'toast'

type OverlayWindowOptions = {
  role: OverlayWindowRole
  /** toast：无卡片时整窗穿透；有卡片时贴尺寸收窗并捕获点击（见 setToastStackSize）。 */
  ignoreMouseEvents: boolean
  /** toast：常驻显示；modal：按需 show/hide。 */
  alwaysVisible: boolean
}

type SyncReason = 'move' | 'resize' | 'show'

const BOUNDS_ALIGN_TOLERANCE_PX = 1

function boundsAligned(a: Rectangle, b: Rectangle, tolerance = BOUNDS_ALIGN_TOLERANCE_PX): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/**
 * 透明子 BrowserWindow 浮层层（方案 Y）。
 *
 * 为什么用独立子窗口而非 overlay WebContentsView：主窗口内的 child WebContentsView
 * 透明合成需主窗口 transparent（否则恒白），且无鼠标穿透、bounds 收缩有 0×0 自举与
 * 坐标系死结（toast 因此恒不可见，见 ）。独立 transparent 子 BrowserWindow
 * 由 OS 合成、永远在 parent 之上，且支持 setIgnoreMouseEvents 真穿透。
 *
 * 两个实例：
 *   - modal：半透明蒙层 + 捕获点击，承载全局搜索 / 确认框（按需 show/hide）。
 *   - toast：透明无蒙层，常驻顶部。无卡片时整窗穿透；有卡片时按 renderer 上报尺寸
 *     收成顶栏小窗并捕获点击（与 modal compact 同源，不依赖悬停命中穿透，见  复发）。
 *
 * Windows/Linux：子窗不会随父窗移动（Electron platform notice），需手动同步。
 * 拖动期避免每帧绝对 setBounds（易与 Win32 合成打架、闪到原点，见拖窗闪烁 issue）；
 * move 用相对位移，resize/show/compact/hug 再走完整 setBounds。
 */
export class OverlayWindowManager {
  private window: BrowserWindow | null = null
  private parent: BrowserWindow | null = null
  private isDev = false
  private rendererUrl?: string
  private isReady = false
  private pendingMessages: OverlayPushPayload[] = []
  /** 当前是否处于提示型（贴角小窗）显示模式；影响 syncBounds 的定位策略。 */
  private isCompact = false
  /** 提示型小窗尺寸，由 renderer 上报卡片实际大小；给个安全默认避免首帧 0×0。 */
  private compactSize = { width: 360, height: 260 }
  /**
   * 提示型小窗的锚区（相对父窗口内容区左上角的矩形）：小窗贴其**右上角**。
   * 通常传浏览器网页视图的 bounds，让卡片落在网页视图右上角，而不是整窗右上角
   * （整窗右上角会盖到右侧聊天面板）。为空时退化为整块父内容。
   */
  private compactAnchor: { x: number; y: number; width: number; height: number } | null = null
  /** 提示型小窗距锚区边缘的间距。 */
  private static readonly COMPACT_SCREEN_GAP = 12
  /**
   * toast 贴卡片模式：非 null 时窗口缩到该尺寸并取消穿透（关闭钮可点）。
   * null = 恢复铺满父内容 + 整窗穿透。
   */
  private toastStackSize: { width: number; height: number } | null = null
  /**
   * Windows：空 toast 全屏穿透 HWND 会打断 OLE HTML5 拖拽。
   * 默认 true；win32 在 did-finish-load 后置 false，有卡片/push 再打开。
   * macOS 始终保持常驻。
   */
  private toastContentVisible = true
  /**
   * HTML5 拖拽会话期间强制藏起 toast 子窗（含有可见卡片时），
   * 避免 Win32 OLE 命中顶层穿透窗导致 dragstart 后会话立刻取消。
   */
  private html5DragShield = false
  /** 上一帧父窗内容区原点，供 move 相对位移同步。 */
  private lastParentOrigin: { x: number; y: number } | null = null

  constructor(private readonly options: OverlayWindowOptions) {}

  configure(config: { isDev: boolean; rendererUrl?: string }): void {
    this.isDev = config.isDev
    this.rendererUrl = config.rendererUrl
  }

  init(parent: BrowserWindow): void {
    if (this.parent === parent && !parent.isDestroyed()) {
      return
    }
    this.unbindParent()
    this.parent = parent
    this.lastParentOrigin = null
    // 仍监听 move：Windows/Linux 必须跟；macOS 系统已跟随，handler 内早退。
    parent.on('move', this.handleParentMove)
    parent.on('resize', this.handleParentResize)
    parent.on('closed', this.handleParentClosed)
    // Windows toast：空全屏子 HWND 即使 hide 也会打断 OLE（ 续）。
    // 无卡片时不创建窗口；有推送 / setToastContentVisible(true) 再懒创建。
    if (this.options.alwaysVisible && process.platform === 'win32') {
      this.toastContentVisible = false
    } else {
      this.ensureWindow()
    }
    this.rememberParentOrigin()
  }

  private pendingShow = false
  private parentFocusListener: (() => void) | null = null

  /**
   * modal：显示。toast 常驻，无需调用。
   *
   * 两种模式：
   * - **阻塞型（compact=false，默认）**：全屏铺满 + 抢焦点 + 捕获点击。承载确认框
   *   / 全局搜索 / 保存密码条——半透明蒙层 + 键盘交互 + Esc。父窗口当前未聚焦时
   *   延后到父窗口重新获焦再显示（避免应用不在前台时抢焦点）。
   * - **提示型（compact=true）**：窗口收缩到卡片大小、贴父窗口右上角、`showInactive`
   *   不抢焦点。这样卡片本身可点（窗口捕获 + acceptFirstMouse），而卡片以外的整个
   *   屏幕不被窗口覆盖 → 底层网页照常可点、可输入。尺寸由 `setCompactSize` 按
   *   renderer 上报的卡片实际大小设定（走确认框那条验证过的"捕获=可点"可靠路径，
   *   不用鼠标穿透）。因不抢焦点，无需延后显示。
   */
  show(compact = false): void {
    if (this.options.alwaysVisible) {
      return
    }
    const win = this.ensureWindow()
    if (!win) {
      return
    }
    this.isCompact = compact
    if (compact) {
      // 提示型：不抢焦点，直接贴角显示，无需走父窗口聚焦延后逻辑。
      this.clearDeferredShow()
      this.applyCompactBounds()
      win.showInactive()
      return
    }
    // 阻塞型：需抢焦点。父窗口未聚焦时延后到其重新获焦再显示。
    const parent = this.parent
    if (parent && !parent.isDestroyed() && !parent.isFocused()) {
      this.scheduleDeferredShow()
      return
    }
    this.performShow()
  }

  /** 提示型模式下，按 renderer 上报的卡片尺寸调整窗口大小并重新定位。 */
  setCompactSize(size: { width: number; height: number }): void {
    this.compactSize = {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    }
    if (this.isCompact) {
      this.applyCompactBounds()
    }
  }

  /** 设置提示型小窗锚区（相对父窗口内容区）。传浏览器网页视图 bounds 即贴其右上角。 */
  setCompactAnchor(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.compactAnchor = rect
    if (this.isCompact) {
      this.applyCompactBounds()
    }
  }

  private applyCompactBounds(): void {
    const win = this.window
    const parent = this.parent
    if (!win || win.isDestroyed() || !parent || parent.isDestroyed()) {
      return
    }
    const p = parent.getContentBounds()
    const gap = OverlayWindowManager.COMPACT_SCREEN_GAP
    const { width, height } = this.compactSize
    // 锚区相对父内容左上角；无锚区则用整块父内容。贴锚区右上角。
    const a = this.compactAnchor ?? { x: 0, y: 0, width: p.width, height: p.height }
    let x = p.x + a.x + a.width - width - gap
    let y = p.y + a.y + gap
    // 兜底 clamp：别跑出父窗口内容范围。
    x = Math.max(p.x + gap, Math.min(x, p.x + p.width - width - gap))
    y = Math.max(p.y + gap, Math.min(y, p.y + p.height - height - gap))
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    this.rememberParentOrigin(p)
  }

  hide(): void {
    if (this.options.alwaysVisible) {
      return
    }
    this.isCompact = false
    this.clearDeferredShow()
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide()
    }
  }

  private performShow(): void {
    this.clearDeferredShow()
    const win = this.window
    if (!win || win.isDestroyed()) {
      return
    }
    this.syncBounds('show')
    win.show()
    win.focus()
  }

  private scheduleDeferredShow(): void {
    if (this.pendingShow) {
      return
    }
    this.pendingShow = true

    const parent = this.parent
    if (!parent || parent.isDestroyed()) {
      this.pendingShow = false
      return
    }

    this.parentFocusListener = () => {
      this.parentFocusListener = null
      this.pendingShow = false
      if (this.window && !this.window.isDestroyed()) {
        this.performShow()
      }
    }
    parent.once('focus', this.parentFocusListener)
  }

  private clearDeferredShow(): void {
    this.pendingShow = false
    const parent = this.parent
    if (parent && !parent.isDestroyed() && this.parentFocusListener) {
      parent.removeListener('focus', this.parentFocusListener)
      this.parentFocusListener = null
    }
  }

  push(payload: OverlayPushPayload): void {
    const win = this.ensureWindow()
    if (!win) {
      return
    }
    if (this.options.alwaysVisible && !win.isDestroyed()) {
      // 有推送内容时视为可见（Windows 空窗默认隐藏，需重新呈现）。
      this.toastContentVisible = true
      this.applyToastPresentation()
    }
    if (!this.isReady) {
      this.pendingMessages.push(payload)
      return
    }
    win.webContents.send('overlay:push', payload)
  }

  /**
   * toast 是否有可见卡片。Windows 上无卡片时销毁子窗（非 hide），避免 OLE DnD 被顶层 HWND 打断。
   * macOS 忽略此开关（常驻穿透窗与 NSDragging 兼容）。
   */
  setToastContentVisible(visible: boolean): void {
    if (!this.options.alwaysVisible) {
      return
    }
    if (this.toastContentVisible === visible) {
      return
    }
    this.toastContentVisible = visible
    this.applyToastPresentation()
  }

  /**
   * HTML5 拖拽会话屏蔽：active 时撤掉 toast HWND；结束后按内容可见性恢复。
   * 仅作有可见 toast 时的兜底；空窗已走懒创建 / 销毁路径，renderer 侧默认不再 sync IPC。
   */
  setHtml5DragShield(active: boolean): void {
    if (!this.options.alwaysVisible) {
      return
    }
    if (this.html5DragShield === active) {
      return
    }
    this.html5DragShield = active
    this.applyToastPresentation()
  }

  private shouldPresentToast(): boolean {
    // html5DragShield 仅由 Windows renderer 武装；主进程再钉死非 win32，防误用。
    if (process.platform === 'win32' && this.html5DragShield) {
      return false
    }
    if (process.platform === 'win32' && !this.toastContentVisible) {
      return false
    }
    return true
  }

  /** Windows toast：不呈现时销毁 HWND；其它平台仅 hide。 */
  private retireUnpresentedToastWindow(): void {
    const win = this.window
    if (!win || win.isDestroyed()) {
      this.window = null
      this.isReady = false
      return
    }
    if (process.platform === 'win32' && this.options.alwaysVisible) {
      log.info(`[${this.options.role}] destroy toast HWND (Win32 OLE DnD guard)`)
      try {
        win.close()
      } catch {
        /* ignore */
      }
      this.window = null
      this.isReady = false
      return
    }
    win.hide()
  }

  private applyToastPresentation(): void {
    if (!this.shouldPresentToast()) {
      this.retireUnpresentedToastWindow()
      return
    }
    const win = this.ensureWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    this.syncBounds('show')
    if (!win.isVisible()) {
      win.showInactive()
    }
  }

  markReady(): void {
    this.isReady = true
    const queue = [...this.pendingMessages]
    this.pendingMessages = []
    for (const payload of queue) {
      this.push(payload)
    }
  }

  focus(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus()
    }
  }

  /**
   * toast 贴卡片：按栈尺寸收窗并捕获点击；传 null 恢复全屏穿透。
   * 仅 toast（alwaysVisible）有效；与 modal `setCompactSize` 同思路。
   */
  setToastStackSize(size: { width: number; height: number } | null): void {
    if (!this.options.alwaysVisible) {
      return
    }
    if (size == null) {
      this.toastStackSize = null
    } else {
      this.toastStackSize = {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      }
    }
    this.applyToastStackBounds()
  }

  /**
   * toast 子窗口按命中区动态切换穿透（ 过渡期兜底）。
   * 贴卡片收窗期间由 `setToastStackSize` 接管，忽略本调用，避免又被设回穿透。
   * 始终带 `forward: true`，以便离开命中区后仍能收到 mousemove 再恢复穿透。
   */
  setIgnoreMouseEvents(ignore: boolean): void {
    if (!this.options.ignoreMouseEvents) {
      return
    }
    if (this.toastStackSize) {
      return
    }
    const win = this.window
    if (!win || win.isDestroyed()) {
      return
    }
    win.setIgnoreMouseEvents(ignore, { forward: true })
  }

  /**
   * toast 贴卡片上限。超出则拒绝收窗捕获，避免透明层盖住主窗口导致全局点不动。
   * （曾用 viewport 100vw 误报接近全屏尺寸。）
   */
  private static readonly TOAST_HUG_MAX_WIDTH = 480
  private static readonly TOAST_HUG_MAX_HEIGHT = 360

  private restoreToastPassthrough(parentContent?: Rectangle): void {
    const win = this.window
    const parent = this.parent
    if (!win || win.isDestroyed() || !parent || parent.isDestroyed()) {
      return
    }
    const p = parentContent ?? parent.getContentBounds()
    if (!boundsAligned(win.getBounds(), p)) {
      win.setBounds(p)
    }
    if (this.options.ignoreMouseEvents) {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
    this.rememberParentOrigin(p)
  }

  private applyToastStackBounds(): void {
    const win = this.window
    const parent = this.parent
    if (!win || win.isDestroyed() || !parent || parent.isDestroyed()) {
      return
    }
    const p = parent.getContentBounds()
    if (!this.toastStackSize) {
      this.restoreToastPassthrough(p)
      return
    }

    const width = Math.min(
      this.toastStackSize.width,
      OverlayWindowManager.TOAST_HUG_MAX_WIDTH,
      Math.max(1, p.width),
    )
    const height = Math.min(
      this.toastStackSize.height,
      OverlayWindowManager.TOAST_HUG_MAX_HEIGHT,
      Math.max(1, p.height),
    )
    // 尺寸仍接近父窗 → 视为误报，绝不取消穿透。
    if (
      width >= p.width - 8 ||
      height >= p.height - 8 ||
      width * height > p.width * p.height * 0.25
    ) {
      log.warn(
        `[${this.options.role}] refuse toast hug capture: size=${width}x${height} parent=${p.width}x${p.height}`,
      )
      this.toastStackSize = null
      this.restoreToastPassthrough(p)
      return
    }

    let x = p.x + Math.round((p.width - width) / 2)
    let y = p.y
    x = Math.max(p.x, Math.min(x, p.x + Math.max(0, p.width - width)))
    y = Math.max(p.y, Math.min(y, p.y + Math.max(0, p.height - height)))
    const next = { x: Math.round(x), y: Math.round(y), width, height }
    if (!boundsAligned(win.getBounds(), next)) {
      win.setBounds(next)
    }
    win.setIgnoreMouseEvents(false)
    this.rememberParentOrigin(p)
  }

  /**
   * 当前指针相对 toast 内容区的 client 坐标。
   * toast 刚出现时指针可能静止在卡片上，renderer 收不到 mousemove，需主动查一次。
   */
  getCursorClientPoint(): { clientX: number; clientY: number } | null {
    const win = this.window
    if (!win || win.isDestroyed()) {
      return null
    }
    const point = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    return {
      clientX: point.x - bounds.x,
      clientY: point.y - bounds.y,
    }
  }

  getWebContents() {
    return this.window?.webContents ?? null
  }

  destroy(): void {
    this.clearDeferredShow()
    this.unbindParent()
    if (this.window && !this.window.isDestroyed()) {
      this.window.close()
    }
    this.window = null
    this.parent = null
    this.lastParentOrigin = null
    this.toastStackSize = null
    this.toastContentVisible = true
    this.html5DragShield = false
    this.isReady = false
    this.pendingMessages = []
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }
    const parent = this.parent
    if (!parent || parent.isDestroyed()) {
      log.warn(`[${this.options.role}] ensureWindow: no parent`)
      return null
    }
    const bounds = parent.getContentBounds()
    const win = new BrowserWindow({
      parent,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      // Windows 透明窗缺此色时 reposition 易露残影
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: !this.options.ignoreMouseEvents,
      // macOS：未激活窗口的第一次点击默认只用于激活窗口、不下发到内容。提示型
      // 浮层用 showInactive 显示（不抢焦点），必须 acceptFirstMouse 让用户第一次
      // 点卡片按钮就生效，否则"点了没反应"。
      acceptFirstMouse: true,
      show: false,
      webPreferences: {
        preload: resolveOverlayPreloadPath(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: [
          '--tabtin-overlay-renderer=1',
          `--tabtin-overlay-role=${this.options.role}`,
        ],
      },
    })
    win.setMenuBarVisibility(false)
    if (this.options.ignoreMouseEvents) {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
    this.window = win
    this.isReady = false
    this.pendingMessages = []
    this.rememberParentOrigin(bounds)

    const url = resolveOverlayWindowUrl(this.options.role, this.isDev, this.rendererUrl)
    log.info(`[${this.options.role}] loading:`, url)
    void win.webContents.loadURL(url).catch((error) => {
      log.error(`[${this.options.role}] load failed:`, error)
    })

    if (this.options.alwaysVisible) {
      // toast：加载完成后按 shouldPresent 呈现或退休 HWND。
      win.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return
        this.applyToastPresentation()
      })
    }

    return win
  }

  private handleParentMove = (): void => {
    // macOS：子窗相对父窗位置由系统保持，再 setPosition 反而可能抖。
    if (process.platform === 'darwin') {
      this.rememberParentOrigin()
      return
    }
    this.syncBounds('move')
  }

  private handleParentResize = (): void => {
    this.syncBounds('resize')
  }

  /**
   * 同步子窗与父内容区。
   * - move：相对位移（全尺寸与 compact 均适用；避免每帧绝对 setBounds 闪原点）
   * - resize / show：完整 setBounds；compact 走贴角绝对定位
   */
  private syncBounds = (reason: SyncReason = 'show'): void => {
    const win = this.window
    const parent = this.parent
    if (!win || win.isDestroyed() || !parent || parent.isDestroyed()) {
      return
    }
    // HTML5 拖拽屏蔽 / Windows 空 toast：不跟父窗挪位置，避免误 show。
    if (this.options.alwaysVisible && !this.shouldPresentToast()) {
      this.rememberParentOrigin()
      return
    }
    // 隐藏的 modal：拖动/缩放时不必跟（否则拖一次窗 toast+modal 各打一遍 bounds）。
    // show 路径必须同步——此时窗尚未 show()，不能用 isVisible 早退。
    if (reason !== 'show' && !this.options.alwaysVisible && !win.isVisible()) {
      this.rememberParentOrigin()
      return
    }

    if (this.isCompact) {
      if (reason === 'move') {
        this.syncByParentDelta(win, parent.getContentBounds())
        return
      }
      this.applyCompactBounds()
      return
    }

    // toast 贴卡片：父窗 move 用相对位移；resize/show 重新按栈尺寸贴顶居中。
    if (this.options.alwaysVisible && this.toastStackSize) {
      if (reason === 'move') {
        this.syncByParentDelta(win, parent.getContentBounds())
        return
      }
      this.applyToastStackBounds()
      return
    }

    const rect = parent.getContentBounds()

    if (reason === 'move') {
      this.syncByParentDelta(win, rect)
      return
    }

    // toast 全屏态：即使 bounds 已对齐，也必须保证穿透，避免错误 hug 后卡在捕获态。
    if (this.options.alwaysVisible && this.options.ignoreMouseEvents && !this.toastStackSize) {
      this.restoreToastPassthrough(rect)
      return
    }

    if (boundsAligned(win.getBounds(), rect)) {
      this.rememberParentOrigin(rect)
      return
    }
    win.setBounds(rect)
    this.rememberParentOrigin(rect)
  }

  private syncByParentDelta(win: BrowserWindow, parentContent: Rectangle): void {
    const prev = this.lastParentOrigin
    this.rememberParentOrigin(parentContent)
    if (!prev) {
      // 尚无基准：绝对对齐。toast 贴卡片时绝不能撑回父内容全尺寸。
      if (this.options.alwaysVisible && this.toastStackSize) {
        this.applyToastStackBounds()
        return
      }
      if (!boundsAligned(win.getBounds(), parentContent)) {
        win.setBounds(parentContent)
      }
      return
    }

    const dx = parentContent.x - prev.x
    const dy = parentContent.y - prev.y
    if (dx === 0 && dy === 0) {
      return
    }

    // 父内容原点突然从远处跳到 (0,0)：视为 getContentBounds 毛刺，跳过本帧避免闪到原点。
    // 用户慢慢拖到原点时 jump 很小，仍正常跟。
    const jump = Math.hypot(parentContent.x - prev.x, parentContent.y - prev.y)
    if (parentContent.x === 0 && parentContent.y === 0 && jump > 50) {
      log.warn(
        `[${this.options.role}] skip move sync: parent content origin glitched to 0,0 (prev=${prev.x},${prev.y} jump=${Math.round(jump)})`,
      )
      this.lastParentOrigin = prev
      return
    }

    const current = win.getBounds()
    win.setPosition(current.x + dx, current.y + dy)
  }

  private rememberParentOrigin(bounds?: Rectangle): void {
    const parent = this.parent
    if (!parent || parent.isDestroyed()) {
      return
    }
    const rect = bounds ?? parent.getContentBounds()
    this.lastParentOrigin = { x: rect.x, y: rect.y }
  }

  private unbindParent(): void {
    const parent = this.parent
    if (parent && !parent.isDestroyed()) {
      parent.removeListener('move', this.handleParentMove)
      parent.removeListener('resize', this.handleParentResize)
      parent.removeListener('closed', this.handleParentClosed)
    }
    this.lastParentOrigin = null
  }

  private handleParentClosed = (): void => {
    this.destroy()
  }
}

let modalWindowManagerSingleton: OverlayWindowManager | null = null
let toastWindowManagerSingleton: OverlayWindowManager | null = null

export function getModalWindowManager(): OverlayWindowManager {
  if (!modalWindowManagerSingleton) {
    modalWindowManagerSingleton = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
  }
  return modalWindowManagerSingleton
}

export function getToastWindowManager(): OverlayWindowManager {
  if (!toastWindowManagerSingleton) {
    toastWindowManagerSingleton = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
  }
  return toastWindowManagerSingleton
}

export function resetOverlayWindowManagersForTests(): void {
  modalWindowManagerSingleton?.destroy()
  toastWindowManagerSingleton?.destroy()
  modalWindowManagerSingleton = null
  toastWindowManagerSingleton = null
}
