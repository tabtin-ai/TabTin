/**
 * WebviewManager — <webview> tag 容器的渲染侧命令式管理器（, flag=webview）
 *
 * 命令式 manager 持有 webview 元素，React 只渲染 slot 占位。
 *
 * 铁律（探针 1 FAIL 实证：re-parent = guest 销毁重建、webContentsId 变化、
 * 内存态丢失）：
 *   1. 每个 webview 元素创建后 append 到**专用稳定层** `#tabtin-webview-layer`
 *      （document.body 直属，创建后永不移动），此后**任何公开 API 都不得
 *      触发 re-append / re-parent**。显示位置一律用 fixed 定位样式同步 slot rect。
 *   2. partition 属性只在创建时（设 src 之前）写入一次，之后绝不修改
 *      （事后改 partition 属性会被 Electron 忽略或引发不一致）。
 *   3. src 属性只在创建时赋值一次触发初始加载；后续导航走主进程
 *      `webview-host:navigate`（webContents.loadURL），不再碰 src。
 *   4. previewable URL（pdf/xlsx/…， / ）：首载 src 不得直写文件
 *      URL——Chromium PDF viewer 会原生崩进程。改写 about:blank，并走
 *      Preview Modal（tryOpenPreviewableDirectUrl）。navigate 侧 Preview Guard
 *      拦不住「设 src 瞬间的首载」。
 *
 * 显隐两档（探针 2 实证）：
 *   - `throttle`（默认，普通切走）：visibility:hidden + 移出视口 → 定时器
 *     节流到 ~1Hz / rAF ~0.1Hz，省资源
 *   - `keepalive`（Agent 后台执行中）：opacity:0 + pointer-events:none + inert
 *     → 不节流（rAF 保持 60Hz）。判定与接入在 webviewHostView.hide（Phase 3
 *     已接：有进行中 run 升 keepalive，run 结束定时复查回落 throttle）。
 *
 * 事件桥：guest 的导航/标题/favicon 事件由主进程 did-attach 后统一经
 * CrawlViewEventManager → `crawl-view:event` 下发（与 WCV 同链路）；renderer
 * 只补主进程收不到的一件事——dom-ready 后 getWebContentsId() 上报完成
 * tabId↔webContentsId 权威绑定。
 */
import { resolveOpenIntent, type OpenIntentHints } from '@shared/open-intent'

export type WebviewHideMode = 'throttle' | 'keepalive'

export interface WebviewEnsureConfig {
  url: string
  profile?: string
  partition?: string
  crawlspaceId?: string
  kind?: string
  isPreview?: boolean
  runId?: string
  openIntentHints?: OpenIntentHints
}

export interface WebviewHostBridge {
  announce: (
    tabId: string,
    options: WebviewEnsureConfig,
  ) => Promise<{ success: boolean; effectivePartition?: string; error?: string }>
  bind: (tabId: string, webContentsId: number) => Promise<{ success: boolean; error?: string }>
  discardAnnounce: (tabId: string) => Promise<{ success: boolean; error?: string }>
  onGuestCrashed?: (callback: (payload: { tabId: string; reason: string; url: string }) => void) => () => void
  onDestroyRequest?: (callback: (payload: { tabId: string }) => void) => () => void
}

export type Rect = { x: number; y: number; width: number; height: number }

/** jsdom 下是 HTMLUnknownElement，真实 Electron renderer 下带 webview 方法 */
export interface WebviewElementLike extends HTMLElement {
  reload?: () => void
  getWebContentsId?: () => number
}

interface WebviewEntry {
  tabId: string
  el: WebviewElementLike
  visibility: 'visible' | WebviewHideMode
  lastRect: Rect | null
  /** lastRect 是否为 born-hidden Agent 临时补的后台逻辑视口。 */
  usesBackgroundRect: boolean
  /** 首次 show 尚未拿到真实 slot rect 时，延迟到测量完成再暴露页面。 */
  pendingVisible: boolean
  slotEl: HTMLElement | null
  resizeObserver: ResizeObserver | null
  syncRafId: number | null
  boundWebContentsId: number | null
  /** dom-ready 至少触发过一次（guest 已 attach） */
  attachedOnce: boolean
  domReadyListener: (() => void) | null
}

export interface WebviewManagerDeps {
  document?: Document
  bridge?: WebviewHostBridge | null
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

const LAYER_ID = 'tabtin-webview-layer'
/** 节流档隐藏时的视口外停靠位（探针 2：离屏 + visibility:hidden 均节流） */
const PARKED_OFFSCREEN_PX = -10000
/** 从未显示过的 Agent 后台页面使用稳定桌面视口，保证坐标输入与截图有渲染面。 */
const AGENT_BACKGROUND_RECT: Rect = { x: 0, y: 0, width: 1280, height: 720 }

function defaultBridge(): WebviewHostBridge | null {
  if (typeof window === 'undefined') return null
  const host = (window as unknown as { tabtin?: { webviewHost?: WebviewHostBridge } }).tabtin?.webviewHost
  return host ?? null
}

export class WebviewManager {
  private readonly entries = new Map<string, WebviewEntry>()
  private readonly inFlightEnsures = new Map<string, Promise<{ created: boolean }>>()
  /** ensure 完成前登记的 slot（announce 异步窗口内 syncTo 先到）*/
  private readonly pendingSlots = new Map<string, HTMLElement>()
  private readonly doc: Document
  private readonly bridge: WebviewHostBridge | null
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>
  private layerEl: HTMLElement | null = null
  /** 拖拽分隔条等场景的鼠标穿透（对齐 WCV 的 setIgnoreMouseEventsForAttached） */
  private mousePassthrough = false
  private windowResizeListener: (() => void) | null = null
  private unsubscribeGuestCrashed: (() => void) | null = null
  private unsubscribeDestroyRequest: (() => void) | null = null

  constructor(deps: WebviewManagerDeps = {}) {
    this.doc = deps.document ?? document
    this.bridge = deps.bridge !== undefined ? deps.bridge : defaultBridge()
    this.log = deps.logger ?? console

    // 全局事件桥：guest crash → 元素 reload 恢复；主进程销毁 → 移除元素
    if (this.bridge?.onGuestCrashed) {
      this.unsubscribeGuestCrashed = this.bridge.onGuestCrashed(({ tabId, reason }) => {
        this.log.warn(`[WebviewManager] guest crashed (${reason})，执行 webview.reload() 恢复:`, tabId)
        this.reloadGuest(tabId)
      })
    }
    if (this.bridge?.onDestroyRequest) {
      this.unsubscribeDestroyRequest = this.bridge.onDestroyRequest(({ tabId }) => {
        this.destroy(tabId)
      })
    }
  }

  // -------------------------------------------------------------------------
  // 稳定层
  // -------------------------------------------------------------------------

  /** 专用稳定层：body 直属，创建后永不移动；层自身不拦截事件 */
  private ensureLayer(): HTMLElement {
    if (this.layerEl && this.layerEl.isConnected) return this.layerEl
    const existing = this.doc.getElementById(LAYER_ID)
    if (existing) {
      this.layerEl = existing
      return existing
    }
    const layer = this.doc.createElement('div')
    layer.id = LAYER_ID
    layer.style.position = 'fixed'
    layer.style.left = '0'
    layer.style.top = '0'
    layer.style.width = '0'
    layer.style.height = '0'
    layer.style.pointerEvents = 'none'
    layer.style.zIndex = '10'
    this.doc.body.appendChild(layer)
    this.layerEl = layer
    return layer
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  has(tabId: string): boolean {
    return this.entries.has(tabId)
  }

  /**
   * 幂等创建：已存在直接返回（绝不重设 partition / src / 重新 append）。
   *
   * 创建协议：announce（主进程校验 + 归一化 partition + session 准备）→
   * 创建元素（属性在设 src 前全部设好，src 最后）→ append 到稳定层。
   */
  ensure(tabId: string, cfg: WebviewEnsureConfig): Promise<{ created: boolean }> {
    if (this.entries.has(tabId)) {
      return Promise.resolve({ created: false })
    }
    const inflight = this.inFlightEnsures.get(tabId)
    if (inflight) return inflight

    const creation = this.createEntry(tabId, cfg).finally(() => {
      this.inFlightEnsures.delete(tabId)
    })
    this.inFlightEnsures.set(tabId, creation)
    return creation
  }

  private async createEntry(tabId: string, cfg: WebviewEnsureConfig): Promise<{ created: boolean }> {
    if (!this.bridge) {
      throw new Error('[WebviewManager] webviewHost bridge 不可用（preload 未注入）')
    }
    const ack = await this.bridge.announce(tabId, cfg)
    if (!ack?.success) {
      throw new Error(ack?.error || '[WebviewManager] announce 被主进程拒绝')
    }
    // announce 是异步的——等待期间可能已有并发路径完成创建
    if (this.entries.has(tabId)) {
      return { created: false }
    }

    const el = this.doc.createElement('webview') as WebviewElementLike

    // ── 属性顺序纪律：partition 及其余属性必须在 src 之前全部设好 ──
    const effectivePartition = ack.effectivePartition ?? ''
    if (effectivePartition) {
      el.setAttribute('partition', effectivePartition)
    }
    // popup 由主进程 guest setWindowOpenHandler deny + 转产品 tab；
    // 需要 allowpopups 让 window.open 到达 handler 而不是被静默吞掉
    el.setAttribute('allowpopups', '')
    el.setAttribute('data-tabtin-webview', tabId)

    // 基础样式：fixed 定位由 syncTo/setRect 驱动；创建时先停靠视口外
    el.style.position = 'fixed'
    el.style.left = `${PARKED_OFFSCREEN_PX}px`
    el.style.top = `${PARKED_OFFSCREEN_PX}px`
    el.style.width = '0px'
    el.style.height = '0px'
    el.style.visibility = 'hidden'
    el.style.pointerEvents = 'none'

    // src 最后：赋值即触发 guest 创建与初始加载。
    // previewable 文件 URL 必须落 about:blank：否则 Chromium 内置
    // PDF viewer 会在 guest 首载时原生崩掉整个进程；后续 navigate Guard 来不及拦。
    const openIntent = resolveOpenIntent({
      url: cfg.url,
      ...cfg.openIntentHints,
    })
    const initialSrc = openIntent.kind === 'preview' ? 'about:blank' : cfg.url
    el.setAttribute('src', initialSrc)
    if (openIntent.kind === 'preview') {
      this.log.warn('[WebviewManager] upstream preview routing missed previewable URL', {
        tabId,
        previewKind: openIntent.previewKind,
      })
      void import('@/components/chat/preview/assetPreviewResolver')
        .then(({ tryOpenPreviewableDirectUrl }) => {
          tryOpenPreviewableDirectUrl(cfg.url, {
            filename: cfg.openIntentHints?.filename,
            mimeType: cfg.openIntentHints?.mimeType,
            fileId: cfg.openIntentHints?.assetId,
          })
        })
        .catch((error: unknown) => {
          this.log.warn('[WebviewManager] Preview Modal fallback failed', {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }

    const entry: WebviewEntry = {
      tabId,
      el,
      visibility: 'throttle',
      lastRect: null,
      usesBackgroundRect: false,
      pendingVisible: false,
      slotEl: null,
      resizeObserver: null,
      syncRafId: null,
      boundWebContentsId: null,
      attachedOnce: false,
      domReadyListener: null,
    }

    // dom-ready → 上报 webContentsId 完成权威绑定（每次页面加载都会触发，
    // 天然充当 bind 失败后的重试点）
    const onDomReady = (): void => {
      entry.attachedOnce = true
      this.bindGuest(entry)
    }
    el.addEventListener('dom-ready', onDomReady)
    entry.domReadyListener = onDomReady

    // 唯一一次 append：此后任何 API 不得再移动该元素（防 re-parent 铁律）
    this.ensureLayer().appendChild(el)

    this.entries.set(tabId, entry)
    this.ensureWindowResizeListener()

    // ensure 异步窗口内先登记的 slot，此刻补挂
    const pendingSlot = this.pendingSlots.get(tabId)
    if (pendingSlot) {
      this.pendingSlots.delete(tabId)
      this.syncTo(tabId, pendingSlot)
    }
    return { created: true }
  }

  private bindGuest(entry: WebviewEntry): void {
    if (!this.bridge) return
    if (typeof entry.el.getWebContentsId !== 'function') return
    let wcId: number
    try {
      wcId = entry.el.getWebContentsId()
    } catch {
      return
    }
    if (entry.boundWebContentsId === wcId) return
    void this.bridge
      .bind(entry.tabId, wcId)
      .then((result) => {
        if (result?.success) {
          entry.boundWebContentsId = wcId
        } else {
          this.log.warn('[WebviewManager] bind 被拒绝:', entry.tabId, result?.error)
        }
      })
      .catch((err) => {
        this.log.warn('[WebviewManager] bind 失败（等待下次 dom-ready 重试）:', entry.tabId, err)
      })
  }

  /** 销毁：移除元素（guest 随之销毁，主进程经 destroyed 事件反注册） */
  destroy(tabId: string): void {
    this.pendingSlots.delete(tabId)
    const entry = this.entries.get(tabId)
    if (!entry) return
    this.detachSlot(entry)
    if (entry.domReadyListener) {
      entry.el.removeEventListener('dom-ready', entry.domReadyListener)
      entry.domReadyListener = null
    }
    entry.el.remove()
    this.entries.delete(tabId)

    // 元素从未 attach（bind 未发生）→ 主进程 pending announce 需要显式清理
    if (!entry.attachedOnce && this.bridge) {
      void this.bridge.discardAnnounce(tabId).catch(() => { /* 尽力而为 */ })
    }
    if (this.entries.size === 0) {
      this.teardownWindowResizeListener()
    }
  }

  /** guest 崩溃恢复：元素级 reload 重建 guest 进程（session 态保留） */
  reloadGuest(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    try {
      entry.el.reload?.()
    } catch (err) {
      this.log.warn('[WebviewManager] reload 失败:', tabId, err)
    }
  }

  // -------------------------------------------------------------------------
  // 几何同步
  // -------------------------------------------------------------------------

  /**
   * 让 webview 的 fixed 定位持续跟随 slot 元素的 rect。
   * ResizeObserver + rAF 节流；窗口 resize 走 manager 级共享监听。
   * 可在 ensure 完成前调用（slot 先登记，元素就绪后生效）。
   */
  syncTo(tabId: string, slotEl: HTMLElement): void {
    const entry = this.entries.get(tabId)
    if (!entry) {
      // 元素尚未创建（announce 在途）：登记 slot，createEntry 完成后补挂
      this.pendingSlots.set(tabId, slotEl)
      return
    }
    if (entry.slotEl === slotEl && entry.resizeObserver) {
      this.requestSync(tabId)
      return
    }
    this.detachSlot(entry)
    entry.slotEl = slotEl
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.requestSync(tabId))
      observer.observe(slotEl)
      entry.resizeObserver = observer
    }
    this.requestSync(tabId)
  }

  /** rAF 合帧的重新测量（布局事件 / 面板开合等外部触发点调用） */
  requestSync(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || !entry.slotEl) return
    if (entry.syncRafId != null) return
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: FrameRequestCallback): number => setTimeout(() => fn(0), 16) as unknown as number
    entry.syncRafId = schedule(() => {
      entry.syncRafId = null
      this.measureAndApply(entry)
    })
  }

  /**
   * 显式 rect——**单位必须是 renderer CSS px**（webview 是 DOM 元素）。
   * 不要把 getElementViewBounds 的 ViewBounds（×zoomFactor 的窗口坐标）
   * 传进来：zoom ≠ 1 时会与 rAF 测量交替写入导致抖动（2026-07-17 已修）。
   * 生产路径一律走 syncTo/requestSync 自测量；本方法保留给测试注入几何。
   */
  setRect(tabId: string, rect: Rect): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    entry.lastRect = rect
    entry.usesBackgroundRect = false
    this.applyRect(entry)
  }

  private measureAndApply(entry: WebviewEntry): void {
    if (!entry.slotEl || !entry.slotEl.isConnected) return
    const domRect = entry.slotEl.getBoundingClientRect()
    if (domRect.width <= 0 || domRect.height <= 0) return
    entry.lastRect = {
      x: Math.round(domRect.x),
      y: Math.round(domRect.y),
      width: Math.round(domRect.width),
      height: Math.round(domRect.height),
    }
    entry.usesBackgroundRect = false
    if (entry.pendingVisible) {
      this.reveal(entry)
      return
    }
    this.applyRect(entry)
  }

  private applyRect(entry: WebviewEntry): void {
    if (!entry.lastRect) return
    // throttle 档隐藏时元素停靠视口外，rect 只记账不落样式（show 时恢复）
    if (entry.visibility === 'throttle') return
    entry.el.style.left = `${entry.lastRect.x}px`
    entry.el.style.top = `${entry.lastRect.y}px`
    entry.el.style.width = `${entry.lastRect.width}px`
    entry.el.style.height = `${entry.lastRect.height}px`
  }

  private detachSlot(entry: WebviewEntry): void {
    entry.resizeObserver?.disconnect()
    entry.resizeObserver = null
    entry.slotEl = null
    if (entry.syncRafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(entry.syncRafId)
      entry.syncRafId = null
    }
  }

  private ensureWindowResizeListener(): void {
    if (this.windowResizeListener || typeof window === 'undefined') return
    this.windowResizeListener = () => {
      for (const tabId of this.entries.keys()) {
        this.requestSync(tabId)
      }
    }
    window.addEventListener('resize', this.windowResizeListener)
  }

  private teardownWindowResizeListener(): void {
    if (!this.windowResizeListener || typeof window === 'undefined') return
    window.removeEventListener('resize', this.windowResizeListener)
    this.windowResizeListener = null
  }

  // -------------------------------------------------------------------------
  // 显隐两档
  // -------------------------------------------------------------------------

  show(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    entry.pendingVisible = true
    // 临时后台视口绝不能直接暴露给用户；优先同步测量已经挂上的真实 slot。
    if (entry.usesBackgroundRect) this.measureAndApply(entry)
    if (entry.usesBackgroundRect) {
      this.requestSync(tabId)
      return
    }
    this.reveal(entry)
    // slot 可能在隐藏期间挪过位置，恢复后补一拍测量
    this.requestSync(tabId)
  }

  private reveal(entry: WebviewEntry): void {
    entry.pendingVisible = false
    entry.visibility = 'visible'
    entry.el.style.visibility = ''
    entry.el.style.opacity = ''
    entry.el.style.pointerEvents = this.mousePassthrough ? 'none' : 'auto'
    entry.el.removeAttribute('inert')
    if (entry.lastRect) {
      entry.el.style.left = `${entry.lastRect.x}px`
      entry.el.style.top = `${entry.lastRect.y}px`
      entry.el.style.width = `${entry.lastRect.width}px`
      entry.el.style.height = `${entry.lastRect.height}px`
    }
  }

  /**
   * throttle：visibility:hidden + 移出视口（Chromium 节流，省资源）——普通切走。
   * keepalive：opacity:0 + pointer-events:none + inert（不节流，rAF 60Hz）——
   *   Agent 后台执行中的页面。判定与接入在 webviewHostView.hide（Phase 3 已接）。
   */
  hide(tabId: string, mode: WebviewHideMode = 'throttle'): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    entry.pendingVisible = false
    entry.visibility = mode
    if (mode === 'throttle') {
      entry.el.style.visibility = 'hidden'
      entry.el.style.opacity = ''
      entry.el.style.pointerEvents = 'none'
      entry.el.removeAttribute('inert')
      entry.el.style.left = `${PARKED_OFFSCREEN_PX}px`
      entry.el.style.top = `${PARKED_OFFSCREEN_PX}px`
    } else {
      entry.el.style.visibility = ''
      entry.el.style.opacity = '0'
      entry.el.style.pointerEvents = 'none'
      entry.el.setAttribute('inert', '')
      // keepalive 保持原位与尺寸（保证 rAF/渲染管线不被节流）
      if (entry.lastRect) this.applyRectForce(entry)
    }
  }

  /**
   * 让从未显示过的 Agent 页面在后台保持可交互渲染。
   *
   * born-hidden 元素没有 slot，也没有 lastRect；仅切 keepalive 仍会保留创建时
   * 的 0×0，CDP 能读 DOM 却无法可靠命中鼠标、焦点和截图。这里仅在缺少
   * 几何时补稳定逻辑视口；已经显示过的页面继续沿用真实 slot rect。
   */
  keepAliveHidden(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    if (!entry.lastRect) {
      entry.lastRect = { ...AGENT_BACKGROUND_RECT }
      entry.usesBackgroundRect = true
    }
    this.hide(tabId, 'keepalive')
  }

  /**
   * 鼠标穿透（对齐 WCV 的 setIgnoreMouseEventsForAttached）：分隔条 / 画布
   * 拖拽期间 <webview> 会吞掉 mousemove/mouseup（guest 独立收事件，宿主
   * document 收不到），导致拖拽一进 webview 区域就冻住、松不开。开启期间
   * 对所有可见 guest 置 pointer-events:none，让事件落回宿主 DOM。
   */
  setMousePassthrough(enabled: boolean): void {
    if (this.mousePassthrough === enabled) return
    this.mousePassthrough = enabled
    for (const entry of this.entries.values()) {
      if (entry.visibility !== 'visible') continue
      entry.el.style.pointerEvents = enabled ? 'none' : 'auto'
    }
  }

  private applyRectForce(entry: WebviewEntry): void {
    if (!entry.lastRect) return
    entry.el.style.left = `${entry.lastRect.x}px`
    entry.el.style.top = `${entry.lastRect.y}px`
    entry.el.style.width = `${entry.lastRect.width}px`
    entry.el.style.height = `${entry.lastRect.height}px`
  }

  // -------------------------------------------------------------------------
  // 观测 / 测试辅助
  // -------------------------------------------------------------------------

  getElementForTesting(tabId: string): WebviewElementLike | null {
    return this.entries.get(tabId)?.el ?? null
  }

  getLayerForTesting(): HTMLElement | null {
    return this.layerEl
  }

  getVisibility(tabId: string): 'visible' | WebviewHideMode | null {
    return this.entries.get(tabId)?.visibility ?? null
  }

  disposeForTesting(): void {
    for (const tabId of Array.from(this.entries.keys())) {
      this.destroy(tabId)
    }
    this.unsubscribeGuestCrashed?.()
    this.unsubscribeDestroyRequest?.()
    this.layerEl?.remove()
    this.layerEl = null
  }
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let singleton: WebviewManager | null = null

export function getWebviewManager(): WebviewManager {
  if (!singleton) {
    singleton = new WebviewManager()
  }
  return singleton
}

export function __resetWebviewManagerForTesting(): void {
  singleton?.disposeForTesting()
  singleton = null
}
