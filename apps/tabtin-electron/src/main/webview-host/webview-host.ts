/**
 * webview-host — <webview> tag 容器的主进程宿主（, Phase 2）
 *
 * 职责：
 *   1. will-attach-webview 白名单裁决（策略在 attach-policy.ts 纯函数层）
 *      —— 无条件安装（不受 feature flag 控制），同时覆盖 Tin 沙箱 guest。
 *   2. announce/attach/bind 三段配对（pending-guests.ts）——只在
 *      flag=webview（TABTIN_BROWSER_CONTAINER）时接受 announce。
 *   3. 配对成功后的能力装配：ViewFactory.adoptWebviewGuest（VSR / RunSession /
 *      Workspace / ResourceDetection / 反检测 / 资源拦截 / popup 接管）+
 *      CrawlViewEventManager 事件桥（与 WCV 同一 crawl-view:event 链路，
 *      renderer 不重复监听导航事件，避免与 ViewStateRegistry 双写冲突）。
 *   4. guest 崩溃 → 通知 renderer WebviewManager 执行 webview.reload()
 *      恢复（探针 4：session 级状态保留）。
 *   5. guest 销毁（renderer 移除元素 / 主窗口 reload）→ 反注册收敛；
 *      主进程主动 destroyView → 广播 destroy-request 让 renderer 移除元素。
 */

import { app, session, webContents as webContentsModule, BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '../logger'
import { guardedHandle } from '../utils/guarded-handle'
import { getMainWindow } from '../window-manager'
import { handleBlockedPreviewLoad, installPreviewGuardWillNavigate } from '../blocked-preview-load'
import type { OpenIntentHints } from '../../shared/open-intent'
import { resolveBrowserContainerMode } from '../../shared/browser-container-mode'
import { isAllowedLocalFileUrl } from '../crawl-view/utils'
import {
  evaluateWillAttachWebview,
  type AttachParams,
  type AttachPolicyConfig,
} from './attach-policy'
import { PendingGuestRegistry, type AnnouncedGuestConfig } from './pending-guests'

const log = createLogger('WebviewHost')

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

const registry = new PendingGuestRegistry()
/** tabId → guest webContentsId（装配完成的 guest） */
const assembledGuests = new Map<string, number>()
/**
 * ：webview 模式下 crawlspace:create-view 不建影子 WCV（ 根治），
 * `localPreviewRoot` 无处落——由该 IPC 在登记 hub 元数据时先寄存到这里，
 * announce 时取走（放进 AnnouncedGuestConfig / finalConfig）。取走即删；
 * crash 重建等重复 announce 场景由已收养条目的 view config 兜底恢复。
 */
const pendingLocalPreviewRoots = new Map<string, string>()

/** crawlspace:create-view（webview 分支）寄存本地 HTML 预览的放行根。 */
export function registerWebviewLocalPreviewRoot(tabId: string, root: string): void {
  if (!tabId || !root) return
  pendingLocalPreviewRoots.set(tabId, root)
}
/**
 * wcId → 暂存的 popup 请求。guest 一挂载就装了 deny-first 守卫，但配对
 * （tabId↔guest 绑定）尚未完成时无法解析该开哪个工作区标签——先暂存，
 * 装配完成后 flush，避免 window.open 落空或退回独立窗。
 */
const pendingPopups = new Map<number, Array<{ url: string; frameName?: string }>>()
/** 已订阅 view:destroyed 广播桥的 ViewFactory 实例（防重复订阅） */
const destroyBridgeAttached = new WeakSet<object>()

function normalizeOpenIntentHints(raw: unknown): OpenIntentHints | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const hints = raw as Record<string, unknown>
  return {
    ...(typeof hints.filename === 'string' && hints.filename ? { filename: hints.filename } : {}),
    ...(typeof hints.mimeType === 'string' && hints.mimeType ? { mimeType: hints.mimeType } : {}),
    ...(typeof hints.assetId === 'string' && hints.assetId ? { assetId: hints.assetId } : {}),
  }
}

let cachedPolicy: AttachPolicyConfig | null = null
function getPolicy(): AttachPolicyConfig {
  if (!cachedPolicy) {
    const tinSandboxRoot = join(app.getPath('userData'), 'tin-sandboxes')
    cachedPolicy = {
      tinSandboxRoot,
      // 防冒用：只有 prepareSandbox 真实落盘过的 tin 实例目录才认
      // （instanceId 已在 attach-policy 层做严格 UUID 校验，无路径注入风险）
      isKnownTinInstance: (instanceId) => {
        try {
          return existsSync(join(tinSandboxRoot, instanceId))
        } catch {
          return false
        }
      },
      // ：浏览器 guest 的 file:// src 受限放行——落在某个活跃预览根
      // （announce 时从 view config 恢复的 Space 工作目录）内才放行，并叠加
      // realpath 加固。闭包每次实时读 registry，故 policy 对象可安全缓存。
      isAllowedBrowserFileSrc: (src) =>
        registry.getAllPendingLocalPreviewRoots().some((root) => isAllowedLocalFileUrl(src, root)),
    }
  }
  return cachedPolicy
}

function isWebviewContainerEnabled(): boolean {
  return resolveBrowserContainerMode() === 'webview'
}

// ---------------------------------------------------------------------------
// 1. attach 守卫（无条件安装）
// ---------------------------------------------------------------------------

/**
 * 在主窗口 webContents 上安装 will-attach / did-attach 守卫。
 * 必须在 renderer 加载前调用（createMainWindow 内同步执行）。
 */
export function installWebviewAttachGuards(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let decision: ReturnType<typeof evaluateWillAttachWebview>
    try {
      decision = evaluateWillAttachWebview(
        webPreferences as Record<string, unknown>,
        params as AttachParams,
        getPolicy(),
      )
    } catch (err) {
      // 策略自身异常一律 fail-closed
      event.preventDefault()
      log.warn('will-attach-webview 策略评估异常，已拒绝 attach:', err)
      return
    }

    if (decision.action === 'deny') {
      event.preventDefault()
      log.warn('will-attach-webview 拒绝:', {
        reason: decision.reason,
        src: typeof (params as AttachParams).src === 'string' ? (params as AttachParams).src!.slice(0, 200) : undefined,
        partition: (params as AttachParams).partition,
      })
      return
    }

    for (const key of decision.stripKeys) {
      delete (webPreferences as Record<string, unknown>)[key]
    }
    Object.assign(webPreferences as Record<string, unknown>, decision.enforceWebPreferences)
    log.debug?.('will-attach-webview 放行:', { guestKind: decision.guestKind, partition: (params as AttachParams).partition })
  })

  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    try {
      handleDidAttach(guestContents)
    } catch (err) {
      log.warn('did-attach-webview 处理异常（不影响 attach）:', err)
    }
  })

  log.info('webview attach 守卫已安装（will-attach 白名单 + did-attach 配对）')
}

function handleDidAttach(guest: WebContents): void {
  // 无论容器模式：任何 webview guest 一挂载就装 deny-first 弹窗守卫，
  // 杜绝 allowpopups 的默认行为——Electron 缺省会为 window.open / target=_blank
  // 开一扇独立 BrowserWindow（社区共识：handler 必须在 guest 出现即挂，晚挂
  // 就漏默认行为）。Tin guest 已在 attach-policy 禁用 allowpopups，此守卫对其
  // 是无害 no-op。必须同步、先于任何 return。
  installGuestPopupGuard(guest)

  if (!isWebviewContainerEnabled()) {
    // flag=wcv：不存在 announce，did-attach 只可能来自 Tin 沙箱等非浏览器 guest，
    // will-attach 已完成 harden，弹窗守卫已装，这里无事可做。
    return
  }
  // 防串号：只有「同 session 的 pending 候选恰好一个」才在 did-attach 配对；
  // 0 个（Tin guest / announce 未到）或多个（同 partition 多 tab 并发）都
  // 留给 bind（renderer dom-ready 后按 tabId↔webContentsId 权威绑定）兜底。
  const sole = registry.takeSolePendingBySession(guest.session)
  if (!sole) {
    log.debug?.('did-attach 无唯一 pending 候选，等待 bind 兜底', { wcId: guest.id })
    return
  }
  void pairGuest(sole, guest, 'did-attach')
}

// ---------------------------------------------------------------------------
// 1b. 弹窗守卫（deny-first + 转工作区标签）
// ---------------------------------------------------------------------------

/**
 * 装 deny-first 弹窗守卫：guest 内 window.open / target=_blank 一律 deny
 * （绝不开独立 BrowserWindow），能解析所属 tabId 就转工作区新标签（与 WCV
 * 的 ensureCrawlspaceWindowOpenHandler 同产品语义），解析不到（配对未完成）
 * 就暂存，装配完成后 flush。adoptWebviewGuest 会用 ensureCrawlspaceWindowOpenHandler
 * 覆盖为带 tabId 的正式版——两者同为 deny + 转标签，仅最后一次生效，无双开。
 */
function installGuestPopupGuard(guest: WebContents): void {
  guest.setWindowOpenHandler((details) => {
    void routeGuestPopup(guest, details.url, details.frameName)
    return { action: 'deny' }
  })
  guest.once('destroyed', () => {
    pendingPopups.delete(guest.id)
  })
}

async function routeGuestPopup(guest: WebContents, url: string, frameName?: string): Promise<void> {
  if (!url) return
  const tabId = registry.getTabIdByWebContentsId(guest.id)
  if (!tabId) {
    // 配对未完成：tabId 尚不可解析，暂存等 flush（宁可延后，绝不退回独立窗）
    const queue = pendingPopups.get(guest.id) ?? []
    queue.push({ url, frameName })
    pendingPopups.set(guest.id, queue)
    log.warn('guest popup 暂存（配对未完成，装配后补发）:', { wcId: guest.id })
    return
  }
  openGuestPopupInTab(tabId, url, frameName)
}

function openGuestPopupInTab(tabId: string, url: string, frameName?: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  void import('../crawlspace/open-in-tab')
    .then(({ openUrlInWorkspaceTab }) => {
      openUrlInWorkspaceTab({ url, viewId: tabId, mainWindow: win, title: frameName || undefined })
    })
    .catch((err) => log.warn('openUrlInWorkspaceTab 失败:', { tabId, err }))
}

/** guest 装配完成后补发暂存期间的 popup（tabId 此时已可解析） */
function flushPendingPopups(wcId: number, tabId: string): void {
  const queue = pendingPopups.get(wcId)
  if (!queue || queue.length === 0) return
  pendingPopups.delete(wcId)
  for (const { url, frameName } of queue) {
    openGuestPopupInTab(tabId, url, frameName)
  }
}

// ---------------------------------------------------------------------------
// 2. 配对 + 装配
// ---------------------------------------------------------------------------

async function pairGuest(
  announced: AnnouncedGuestConfig,
  guest: WebContents,
  source: 'did-attach' | 'bind',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { tabId } = announced

  if (guest.isDestroyed()) {
    return { ok: false, error: 'guest webContents 已销毁' }
  }

  const binding = registry.registerBinding({ tabId, webContentsId: guest.id, session: guest.session })
  if (!binding.ok) {
    log.warn('guest 绑定被拒:', { tabId, source, reason: binding.reason })
    return { ok: false, error: binding.reason }
  }

  try {
    await assembleGuest(announced, guest)
    log.info('webview guest 配对 + 装配完成:', { tabId, wcId: guest.id, source })
    return { ok: true }
  } catch (err) {
    registry.releaseBinding(tabId)
    const message = err instanceof Error ? err.message : String(err)
    log.error('webview guest 装配失败:', { tabId, source, error: message })
    return { ok: false, error: message }
  }
}

async function assembleGuest(announced: AnnouncedGuestConfig, guest: WebContents): Promise<void> {
  const { tabId } = announced
  const { getViewFactory } = await import('../view-factory')
  const viewFactory = getViewFactory()

  await viewFactory.adoptWebviewGuest(
    tabId,
    guest,
    announced.finalConfig as Parameters<typeof viewFactory.adoptWebviewGuest>[2],
  )
  installPreviewGuardWillNavigate(
    guest,
    getMainWindow,
    'webview-host.will-navigate',
    () => normalizeOpenIntentHints(
      (announced.finalConfig as { metadata?: { openIntentHints?: unknown } } | undefined)
        ?.metadata
        ?.openIntentHints,
    ),
  )

  // 事件桥：主进程统一收 guest 导航/标题/favicon 等事件 → crawl-view:event
  // （与 WCV 完全同链路；renderer 侧不再自行监听 webview DOM 事件转发，
  // 避免与 ViewStateRegistry 既有事件流双写冲突）
  try {
    const { getCrawlViewEventManager } = await import('../crawl-view-events')
    getCrawlViewEventManager()?.attach({ webContents: guest }, tabId)
  } catch (err) {
    log.warn('CrawlViewEventManager 绑定失败（事件桥缺失，非致命）:', { tabId, err })
  }

  // guest crash → 通知 renderer 用 webview.reload() 恢复（探针 4 结论：
  // 主进程对死 guest loadURL 不可靠，元素级 reload 才会重建 guest 进程，
  // session 级状态保留；常规 crash 下 webContents 对象与 id 不变，绑定保留）
  guest.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown'
    log.warn('webview guest render-process-gone:', { tabId, reason })
    sendToMainWindow('webview-host:guest-crashed', {
      tabId,
      reason,
      url: guest.isDestroyed() ? '' : guest.getURL(),
    })
  })

  // guest 销毁（renderer 移除元素 / 主窗口 reload / 极端 crash 形态）→ 反注册收敛。
  // 同时广播 destroy-request 让 renderer 移除元素：常规路径（renderer 主动
  // destroy）manager 已无该 entry、no-op；极端路径（guest 死了但元素还在，
  // 例如 crash 后 Electron 重建 webContents）促使 renderer 清元素，下一轮
  // show 重新 announce 重建，避免僵尸元素挂着未纳管的 guest。
  guest.once('destroyed', () => {
    registry.releaseBinding(tabId)
    assembledGuests.delete(tabId)
    void viewFactory.destroyView(tabId, { force: true }).catch((err) => {
      log.warn('guest destroyed 后 destroyView 失败:', { tabId, err })
    })
    sendToMainWindow('webview-host:destroy-request', { tabId })
  })

  assembledGuests.set(tabId, guest.id)
  // 补发配对未完成期间暂存的 popup（此时 tabId↔guest 已绑定，可解析）
  flushPendingPopups(guest.id, tabId)
  ensureViewFactoryDestroyBridge(viewFactory)
}

/**
 * 主进程主动销毁（crawlspace closeView / LRU 清理等）时，元素还挂在 renderer
 * DOM 里 —— 广播 destroy-request 让 WebviewManager 移除元素，guest 进程才
 * 真正释放。guest 已死触发的 destroyView 不会进入此分支（assembledGuests
 * 已在 destroyed 监听里先行删除）。
 */
function ensureViewFactoryDestroyBridge(viewFactory: object & {
  on: (event: 'view:destroyed', listener: (data: { id: string }) => void) => unknown
}): void {
  if (destroyBridgeAttached.has(viewFactory)) return
  destroyBridgeAttached.add(viewFactory)
  viewFactory.on('view:destroyed', ({ id }) => {
    if (!assembledGuests.has(id)) return
    assembledGuests.delete(id)
    registry.releaseBinding(id)
    sendToMainWindow('webview-host:destroy-request', { tabId: id })
  })
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    log.warn('发送 renderer 事件失败:', { channel, err })
  }
}

// ---------------------------------------------------------------------------
// 3. IPC（announce / bind / navigate / discard）
// ---------------------------------------------------------------------------

export interface WebviewAnnounceOptions {
  url: string
  profile?: string
  partition?: string
  crawlspaceId?: string
  kind?: string
  isPreview?: boolean
  runId?: string
  openIntentHints?: OpenIntentHints
}

const KNOWN_PROFILES = new Set(['user-tab', 'agent-workspace', 'background-task', 'temporary-preview'])

let ipcRegistered = false

/**
 * 注册 webview-host:* IPC。与 crawl-view:* 同期注册
 * （deferred-init-crawlspace 的 CrawlView 管线初始化内）。
 */
export function registerWebviewHostIpcHandlers(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  guardedHandle('webview-host:announce', async (_event, tabId: string, options: WebviewAnnounceOptions) => {
    try {
      if (!isWebviewContainerEnabled()) {
        return { success: false, error: 'webview container disabled (TABTIN_BROWSER_CONTAINER!=webview)' }
      }
      if (!tabId || typeof tabId !== 'string') {
        return { success: false, error: 'tabId is required' }
      }
      if (!options || typeof options.url !== 'string' || !options.url) {
        return { success: false, error: 'url is required' }
      }
      const profile = options.profile ?? 'user-tab'
      if (!KNOWN_PROFILES.has(profile)) {
        return { success: false, error: `unknown profile: ${profile}` }
      }
      if (registry.getBinding(tabId)) {
        return { success: false, error: `tab 已绑定 guest，禁止重复 announce: ${tabId}` }
      }

      const { getViewFactory } = await import('../view-factory')
      // ：webview 容器下「本地 HTML 产物预览」的 file:// 放行根，两个来源：
      //   1. crawlspace:create-view（webview 分支）寄存的 pendingLocalPreviewRoots
      //      ——主路径（该分支不建影子 WCV，root 无 view config 可落），取走即删；
      //   2. 已有 view 条目的 config.localPreviewRoot——crash 重建 / flag 切换
      //      遗留 WCV 条目等重复 announce 场景的兜底。
      const pendingRoot = pendingLocalPreviewRoots.get(tabId)
      if (pendingRoot) pendingLocalPreviewRoots.delete(tabId)
      const recoveredPreviewRoot = pendingRoot
        || getViewFactory().getViewState(tabId)?.config?.localPreviewRoot
        || undefined
      const { effectivePartition, finalConfig } = await getViewFactory().prepareWebviewGuestSession({
        profile: profile as import('../view-factory').ViewProfile,
        id: tabId,
        url: options.url,
        partition: options.partition,
        runId: options.runId,
        ...(recoveredPreviewRoot ? { localPreviewRoot: recoveredPreviewRoot } : {}),
        metadata: {
          ...(options.crawlspaceId ? { crawlspaceId: options.crawlspaceId } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.isPreview !== undefined ? { isPreview: options.isPreview } : {}),
          ...(options.openIntentHints ? { openIntentHints: options.openIntentHints } : {}),
          source: 'webview-tag',
          createdBy: 'WebviewManager',
        },
      })

      const expectedSession = effectivePartition
        ? session.fromPartition(effectivePartition)
        : session.defaultSession

      registry.announce(
        {
          tabId,
          effectivePartition,
          expectedSession,
          url: options.url,
          finalConfig,
          ...(recoveredPreviewRoot ? { localPreviewRoot: recoveredPreviewRoot } : {}),
          announcedAt: Date.now(),
        },
        (msg) => log.warn(msg),
      )

      log.info('webview guest announce 登记:', { tabId, effectivePartition, profile })
      return { success: true, effectivePartition }
    } catch (error: any) {
      log.error('announce 失败:', { tabId, error: error?.message })
      return { success: false, error: error?.message || String(error) }
    }
  })

  guardedHandle('webview-host:bind', async (event, tabId: string, webContentsId: number) => {
    try {
      if (!isWebviewContainerEnabled()) {
        return { success: false, error: 'webview container disabled' }
      }
      if (!tabId || typeof webContentsId !== 'number') {
        return { success: false, error: 'tabId / webContentsId is required' }
      }

      // 幂等：同一 guest 重复 bind（dom-ready 可能多次触发）直接成功
      if (assembledGuests.get(tabId) === webContentsId) {
        return { success: true, already: true }
      }

      const guest = webContentsModule.fromId(webContentsId)
      if (!guest || guest.isDestroyed()) {
        return { success: false, error: `guest webContents 不存在: ${webContentsId}` }
      }
      if (guest.getType() !== 'webview') {
        return { success: false, error: `webContents ${webContentsId} 不是 webview guest` }
      }
      // 防伪造：guest 必须挂在发送者（主窗口 renderer）之下
      if (!guest.hostWebContents || guest.hostWebContents.id !== event.sender.id) {
        return { success: false, error: 'guest 宿主与请求发送者不一致' }
      }

      const existingBinding = registry.getBinding(tabId)
      if (existingBinding) {
        if (existingBinding.webContentsId === webContentsId) {
          // did-attach 已配对成功，bind 只是确认
          return { success: true, already: true }
        }
        // 崩溃恢复边角：若 Electron 在 crash 后重建了 guest webContents
        // （常规 render-process-gone → reload 复用同一 webContents，见探针 4；
        // 此分支兜"重建"形态），旧绑定已死则释放，否则拒绝（防串号）。
        const oldWc = webContentsModule.fromId(existingBinding.webContentsId)
        if (oldWc && !oldWc.isDestroyed()) {
          return { success: false, error: `tab 已绑定另一存活 guest（${existingBinding.webContentsId}）` }
        }
        log.warn('旧 guest 已死，释放 stale 绑定:', { tabId, staleWcId: existingBinding.webContentsId })
        registry.releaseBinding(tabId)
        assembledGuests.delete(tabId)
      }

      const pending = registry.getPending(tabId)
      if (!pending) {
        // 旧 guest 已死且无 pending announce（destroyView 已收敛）：
        // 要求 renderer 移除元素重建（下一轮 show 会重新 announce）
        return { success: false, error: `无 pending announce: ${tabId}`, code: 'rebind-requires-recreate' }
      }
      // 防串号：guest 实际 session 必须与 announce 声明一致
      if (guest.session !== pending.expectedSession) {
        log.warn('bind 拒绝：guest session 与 announce 不一致', { tabId, webContentsId })
        return { success: false, error: 'guest partition 与 announce 声明不一致' }
      }

      registry.takePendingByTabId(tabId)
      const result = await pairGuest(pending, guest, 'bind')
      if (!result.ok) {
        return { success: false, error: result.error }
      }
      return { success: true }
    } catch (error: any) {
      log.error('bind 失败:', { tabId, error: error?.message })
      return { success: false, error: error?.message || String(error) }
    }
  })

  guardedHandle('webview-host:navigate', async (_event, tabId: string, url: string, options?: { expectedPartition?: string }) => {
    try {
      if (!isWebviewContainerEnabled()) {
        return { success: false, error: 'webview container disabled' }
      }
      if (!tabId || typeof url !== 'string' || !url) {
        return { success: false, error: 'tabId / url is required' }
      }
      const { getViewFactory } = await import('../view-factory')
      const viewFactory = getViewFactory()

      // 任务锁优先级最高：Agent 采集 Run 进行中的活跃 view 不被地址栏/重复
      // show 打断。必须先于 stale-container 判定——若影子 WCV 恰被 active run
      // 占用，先返回 stale-container 会让渲染侧重建 guest、adopt 时销毁该 WCV
      // 打断任务；这里先跳过，run 结束后下一次导航再触发自愈收敛。
      const { checkViewTaskLock } = await import('../crawl-view/view-display')
      if (checkViewTaskLock(tabId)) {
        return { success: true, skipped: 'task-lock' }
      }

      //  防脱钩自愈：本通道只服务 <webview> guest。若权威条目是 WCV
      // （未迁移路径抢建的「影子视图」），导航会打进用户看不见的那份——地址栏
      // 变了页面不动。返回 stale-container 让渲染侧销毁元素重建（重建走
      // announce → bind → adopt，adopt 会销毁影子条目、guest 接管权威）。
      const state = viewFactory.getViewState(tabId)
      if (state && state.containerKind !== 'webview-tag') {
        log.warn('navigate 拒绝：权威条目是 WCV 影子容器，要求渲染侧重建 guest:', {
          tabId,
          source: state.config?.metadata?.source || state.config?.metadata?.createdBy,
        })
        return { success: false, code: 'stale-container', error: `view ${tabId} 由 WCV 影子容器占用` }
      }

      // ── partition 不一致 = 用户改了 env 绑定（ Phase 3）──
      //
      // <webview> 的 partition 属性只能在创建时设定，事后改无效——重建必须由
      // renderer 销毁元素后用新 partition 重走 announce → bind → adopt。语义
      // 对齐 WCV 的 crawl-view:show partition-rebuild 协议：
      //   - run 进行中不打断（设置页 toast 承诺"进行中的任务用旧环境跑完"），
      //     返回 skipped 让地址栏回滚，run 结束后下一次 show 自然收敛；
      //   - 无 run → 广播 partition-rebuilt（复用 usePartitionRebuildToast 的
      //     "已切换到新登录环境" toast），返回 partition-mismatch 让 renderer
      //     走与 stale-container 同一条重建路径。广播先于重建完成：重建失败
      //     时 show 会向调用方返回 error（UI 有错误态兜底），不会静默。
      //   - 比较口径与 WCV 相同：renderer 原样传 store 的 partition，与
      //     finalConfig.partition 字面比较。
      const expectedPartition = options?.expectedPartition
      const currentPartition = state?.config?.partition
      if (expectedPartition && currentPartition && expectedPartition !== currentPartition) {
        const { getRunSessionManager } = await import('../run-session/RunSessionManager')
        const runManager = getRunSessionManager()
        const activeRunId = runManager.getRunIdByView(tabId)
        if (activeRunId && runManager.getRun(activeRunId)) {
          log.info('partition 不一致但 view 绑定 active run，延迟到 run 结束后重建:', {
            tabId, currentPartition, expectedPartition, activeRunId,
          })
          return { success: true, skipped: 'partition-rebuild-deferred', deferred: 'run-in-progress' }
        }
        log.info('partition 不一致，要求渲染侧销毁元素并以新 partition 重建 guest:', {
          tabId, oldPartition: currentPartition, newPartition: expectedPartition,
        })
        // 广播口径与 WCV ipc-handlers 一致：发给所有窗口（多窗口形态都弹 toast）
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          try {
            win.webContents.send('crawl-view:partition-rebuilt', {
              tabId,
              oldPartition: currentPartition,
              newPartition: expectedPartition,
              reason: 'env-binding-changed',
            })
          } catch (sendErr) {
            log.warn('广播 partition-rebuilt 失败（单个窗口）:', sendErr)
          }
        }
        return { success: false, code: 'partition-mismatch', error: `view ${tabId} partition 已变更（env 绑定切换）` }
      }

      const wc = viewFactory.getWebContents(tabId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: `view not found: ${tabId}` }
      }

      const { validateNavigationUrl } = await import('../crawl-view/utils')
      const navConfig = viewFactory.getViewState(tabId)?.config
      const allowPrivateHostNavigation = navConfig?.allowPrivateHostNavigation === true
      // ：与 WCV 对称——view config 带 localPreviewRoot 时受限放行落在该
      // 目录内的 file://（切 tab / 重新 show 的本地 HTML 预览导航），其余 file:// 仍拒。
      const allowLocalFileRoot = navConfig?.localPreviewRoot || undefined
      const check = validateNavigationUrl(url, { allowPrivateHostNavigation, allowLocalFileRoot })
      if (!check.ok) {
        return { success: false, error: check.error || 'navigation blocked' }
      }

      const normalize = (u: string): string => {
        try { return new URL(u).href.replace(/\/$/, '') } catch { return u }
      }
      if (normalize(wc.getURL() || '') === normalize(url)) {
        return { success: true, skipped: 'same-url' }
      }

      const { guardLoadURL } = await import('../../shared/guard-load-url')
      const hints = normalizeOpenIntentHints(state?.config?.metadata?.openIntentHints)
      const previewGuard = guardLoadURL({ url, ...hints, source: 'webview-host:navigate' })
      if (previewGuard.action === 'block-preview') {
        log.info('Preview Guard 阻止 loadURL（软成功，已发 Preview fallback）', {
          tabId, url, previewKind: previewGuard.intent.previewKind,
        })
        handleBlockedPreviewLoad({
          url,
          source: 'webview-host:navigate',
          intent: previewGuard.intent,
          mainWindow: getMainWindow(),
          ...hints,
        })
        // ：fallback 已发出 → 对调用方视为软成功，避免 CrawlViewError /
        // Agent 工具链把「改走 Preview」当成 show/navigate 失败。
        return {
          success: true,
          skipped: 'preview-required',
          code: 'PREVIEW_REQUIRED',
          intent: previewGuard.intent,
        }
      }

      try {
        await wc.loadURL(url)
      } catch (error: any) {
        if (error?.code !== 'ERR_ABORTED') throw error
      }
      return { success: true }
    } catch (error: any) {
      log.error('navigate 失败:', { tabId, error: error?.message })
      return { success: false, error: error?.message || String(error) }
    }
  })

  guardedHandle('webview-host:discard-announce', async (_event, tabId: string) => {
    try {
      if (!tabId) return { success: false, error: 'tabId is required' }
      registry.discardPending(tabId)
      pendingLocalPreviewRoots.delete(tabId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  log.info('webview-host IPC 已注册（announce / bind / navigate / discard-announce）')
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

export function __resetWebviewHostForTesting(): void {
  registry.clearForTesting()
  assembledGuests.clear()
  pendingLocalPreviewRoots.clear()
  cachedPolicy = null
}

export function __getPendingGuestRegistryForTesting(): PendingGuestRegistry {
  return registry
}
