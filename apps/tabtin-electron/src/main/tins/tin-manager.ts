/**
 * TinManager - Tin 智能微应用管理器
 *
 * 职责：
 * 1. 维护当前 Space 中安装的 TinInstance 列表
 * 2. 监听浏览器导航事件，匹配激活规则
 * 3. 管理 Tin 沙箱的生命周期（创建/销毁/切换）
 * 4. 通过 IPC 与渲染进程通信，驱动 Tin 面板 UI
 */

import { BrowserWindow, ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
import { logger } from '../utils/logger'
import { guardedHandle } from '../utils/guarded-handle'
import { matchActivationRules, type PageContext } from './activation-matcher'
import { prepareSandbox, cleanupSandbox } from './tin-sandbox'
import { disposeTinBridge } from './tin-bridge'
import { UUID_RE, type TinInstance, type TinActivationState } from './types'

const TAG = 'TinManager'

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_URL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * EI-5: 渲染进程传入的 TinDefinition 中可执行内容字段白名单外的字段列表。
 * 这些字段应由主进程直接从后端获取，不信任渲染器提供的值。
 */
const SENSITIVE_TIN_FIELDS = [
  'content_script',
  'panel_html',
  'background_script',
  'agent_instructions',
] as const

function sanitizeInstancesFromRenderer(instances: TinInstance[]): TinInstance[] {
  if (!Array.isArray(instances)) return []
  return instances.map((inst) => {
    if (!inst?.tin) return inst
    const sanitizedTin = { ...inst.tin }
    for (const field of SENSITIVE_TIN_FIELDS) {
      if (field in sanitizedTin) {
        delete (sanitizedTin as Record<string, unknown>)[field]
        logger.debug(TAG, `Stripped sensitive field '${field}' from Tin '${sanitizedTin.name}' (renderer input)`)
      }
    }
    return { ...inst, tin: sanitizedTin }
  })
}

export class TinManager {
  private mainWindow: BrowserWindow | null = null
  private instances: TinInstance[] = []
  private activationStates: Map<string, TinActivationState> = new Map()
  private currentPageContext: PageContext = { url: '', title: '' }
  private webviewContentsIds: Map<string, number> = new Map()
  private disposed = false
  private evaluationTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.registerIpcHandlers()
  }

  // ── 初始化 ────────────────────────────────────

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    logger.info(TAG, 'TinManager initialized')
  }

  /** 主窗口替换（多窗口 / 重建时） */
  setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    logger.info(TAG, 'TinManager rebound to new window')
  }

  isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    this.disposed = true
    if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer)
      this.evaluationTimer = null
    }
    this.activationStates.clear()
    this.instances = []
    this.webviewContentsIds.clear()

    const channels = [
      'tins:get-activation-states',
      'tins:toggle-panel',
      'tins:set-instances',
      'tins:get-page-context',
      'tins:get-resolved-variables',
      'tins:prepare-sandbox',
      'tins:cleanup-sandbox',
      'tins:sync-page-context',
      'tins:register-webview',
      'tins:unregister-webview',
    ]
    for (const ch of channels) {
      try { ipcMain.removeHandler(ch) } catch { /* already removed */ }
    }

    disposeTinBridge()

    logger.info(TAG, 'TinManager disposed')
  }

  // ── 实例管理 ───────────────────────────────────

  setInstances(instances: TinInstance[]): void {
    const newIds = new Set(instances.map((i) => i.id))
    const oldIds = new Set(this.instances.map((i) => i.id))

    for (const id of oldIds) {
      if (!newIds.has(id)) {
        this.activationStates.delete(id)
        this.webviewContentsIds.delete(id)
        cleanupSandbox(id).catch((e) => {
          logger.warn(TAG, `Failed to cleanup sandbox on evict: ${id}`, e)
        })
        logger.debug(TAG, `Evicted instance cleaned up: ${id}`)
      }
    }

    this.instances = instances
    logger.info(TAG, `Loaded ${instances.length} Tin instances`)
    this.evaluateActivation()
  }

  addInstance(instance: TinInstance): void {
    const idx = this.instances.findIndex((i) => i.id === instance.id)
    if (idx >= 0) {
      this.instances[idx] = instance
    } else {
      this.instances.push(instance)
    }
    this.evaluateActivation()
  }

  removeInstance(instanceId: string): void {
    this.instances = this.instances.filter((i) => i.id !== instanceId)
    this.activationStates.delete(instanceId)
    this.webviewContentsIds.delete(instanceId)

    cleanupSandbox(instanceId).catch((e) => {
      logger.warn(TAG, `Failed to cleanup sandbox on remove: ${instanceId}`, e)
    })

    this.notifyActivationChange()
  }

  // ── 页面导航事件处理 ──────────────────────────

  onPageNavigate(context: PageContext, source: 'crawl-view' | 'renderer-sync' = 'crawl-view'): void {
    this.currentPageContext = context
    logger.debug(TAG, `Page navigated: ${context.url} [source=${source}]`)
    this.scheduleEvaluation()
  }

  onPageTitleUpdate(title: string): void {
    this.currentPageContext.title = title
    this.scheduleEvaluation()
  }

  onPageLanguageDetected(language: string): void {
    this.currentPageContext.language = language
    this.scheduleEvaluation()
  }

  private scheduleEvaluation(): void {
    if (this.evaluationTimer) clearTimeout(this.evaluationTimer)
    this.evaluationTimer = setTimeout(() => {
      this.evaluationTimer = null
      this.evaluateActivation()
    }, 100)
  }

  // ── 激活规则评估 ──────────────────────────────

  private evaluateActivation(): void {
    if (this.disposed || !this.currentPageContext.url) return

    let changed = false

    for (const instance of this.instances) {
      if (!instance.is_enabled || instance.tin.status !== 'active') continue

      const wasActive = this.activationStates.get(instance.id)?.isActive ?? false
      let isMatch = false
      try {
        isMatch = matchActivationRules(
          instance.tin.activation_rules,
          this.currentPageContext,
          (instance.tin.activation_match as 'any' | 'all') || 'any'
        )
      } catch (err) {
        logger.error(TAG, `Activation match error for ${instance.tin.name}:`, err)
      }

      if (isMatch && !wasActive) {
        this.activationStates.set(instance.id, {
          instanceId: instance.id,
          tinId: instance.tin_id,
          name: instance.tin.name,
          isActive: true,
          activatedAt: Date.now(),
          panelVisible: instance.tin.activation_mode === 'auto'
        })
        changed = true
        logger.info(TAG, `Tin activated: ${instance.tin.name} (${instance.id})`)
      } else if (!isMatch && wasActive) {
        const prevState = this.activationStates.get(instance.id)
        if (!prevState) continue
        this.activationStates.set(instance.id, {
          ...prevState,
          isActive: false,
          panelVisible: false
        })
        changed = true
        logger.info(TAG, `Tin deactivated: ${instance.tin.name} (${instance.id})`)
      }
    }

    // pinned instances 始终保持激活
    for (const instance of this.instances) {
      if (instance.pinned && instance.is_enabled) {
        const state = this.activationStates.get(instance.id)
        if (!state?.isActive) {
          this.activationStates.set(instance.id, {
            instanceId: instance.id,
            tinId: instance.tin_id,
            name: instance.tin.name,
            isActive: true,
            activatedAt: Date.now(),
            panelVisible: false
          })
          changed = true
        }
      }
    }

    if (changed) {
      this.notifyActivationChange()
    }
  }

  // ── 面板控制 ───────────────────────────────────

  togglePanel(instanceId: string, visible?: boolean): void {
    const state = this.activationStates.get(instanceId)
    if (!state) return

    state.panelVisible = visible ?? !state.panelVisible
    this.notifyActivationChange()
  }

  // ── 变量解析 ───────────────────────────────────

  private getResolvedVariables(instance: TinInstance): Record<string, unknown> {
    const schema = instance.tin.variables_schema || {}
    const userVars = instance.user_variables || {}
    const resolved: Record<string, unknown> = {}

    for (const [key, def] of Object.entries(schema)) {
      resolved[key] = userVars[key] ?? def.default ?? null
    }

    return resolved
  }

  // ── IPC 通信 ──────────────────────────────────

  private registerIpcHandlers(): void {
    guardedHandle('tins:get-activation-states', () => {
      if (this.disposed) return []
      return Array.from(this.activationStates.values())
    })

    guardedHandle('tins:toggle-panel', (_event: IpcMainInvokeEvent, instanceId: string, visible?: boolean) => {
      if (this.disposed) return
      if (!UUID_RE.test(instanceId)) return
      this.togglePanel(instanceId, visible)
    })

    guardedHandle('tins:set-instances', (_event: IpcMainInvokeEvent, instances: TinInstance[]) => {
      if (this.disposed) return
      const sanitized = sanitizeInstancesFromRenderer(instances)
      this.setInstances(sanitized)
    })

    guardedHandle('tins:get-page-context', () => {
      if (this.disposed) return { url: '', title: '' }
      return this.currentPageContext
    })

    guardedHandle('tins:get-resolved-variables', (_event: IpcMainInvokeEvent, instanceId: string) => {
      if (this.disposed) return {}
      if (!UUID_RE.test(instanceId)) return {}
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return {}
      return this.getResolvedVariables(instance)
    })

    guardedHandle('tins:prepare-sandbox', (_event: IpcMainInvokeEvent, instanceId: string) => {
      if (this.disposed) return null
      if (!UUID_RE.test(instanceId)) return null
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return null
      return prepareSandbox({
        instanceId,
        panelHtml: instance.tin.panel_html || '',
        variables: this.getResolvedVariables(instance),
        pageContext: { ...this.currentPageContext },
      })
    })

    guardedHandle('tins:cleanup-sandbox', (_event: IpcMainInvokeEvent, instanceId: string) => {
      if (this.disposed) return
      if (!UUID_RE.test(instanceId)) return
      cleanupSandbox(instanceId)
    })

    guardedHandle('tins:sync-page-context', (_event: IpcMainInvokeEvent, context: { url: string; title: string }) => {
      if (this.disposed) return
      if (!context?.url || typeof context.url !== 'string') return
      if (!isAllowedUrl(context.url)) {
        logger.warn(TAG, `Rejected sync-page-context with disallowed URL protocol: ${context.url}`)
        return
      }
      const title = typeof context.title === 'string' ? context.title.slice(0, 1024) : ''
      this.onPageNavigate({ url: context.url, title }, 'renderer-sync')
    })

    guardedHandle('tins:register-webview', (_event: IpcMainInvokeEvent, instanceId: string, contentsId: number) => {
      if (this.disposed) return
      if (!UUID_RE.test(instanceId) || typeof contentsId !== 'number') return
      this.webviewContentsIds.set(instanceId, contentsId)
      logger.debug(TAG, `Registered webview for ${instanceId} (contentsId=${contentsId})`)
    })

    guardedHandle('tins:unregister-webview', (_event: IpcMainInvokeEvent, instanceId: string) => {
      if (this.disposed) return
      if (!UUID_RE.test(instanceId)) return
      this.webviewContentsIds.delete(instanceId)
      logger.debug(TAG, `Unregistered webview for ${instanceId}`)
    })
  }

  private notifyActivationChange(): void {
    this.sendToRenderer('tins:activation-changed', {
      states: Array.from(this.activationStates.values())
    })
  }

  private sendToRenderer(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  // ── 公共查询方法（供 TinBridge 等外部使用）──

  getPageContext(): PageContext {
    return { ...this.currentPageContext }
  }

  findInstance(instanceId: string): TinInstance | undefined {
    return this.instances.find((i) => i.id === instanceId)
  }

  resolveVariables(instance: TinInstance): Record<string, unknown> {
    return this.getResolvedVariables(instance)
  }

  emitToRenderer(channel: string, data: unknown): void {
    this.sendToRenderer(channel, data)
  }

  emitToTinWebview(instanceId: string, channel: string, ...args: unknown[]): void {
    const contentsId = this.webviewContentsIds.get(instanceId)
    if (contentsId == null) return
    try {
      const wc = webContents.fromId(contentsId)
      if (wc && !wc.isDestroyed()) {
        wc.send(channel, ...args)
      } else {
        this.webviewContentsIds.delete(instanceId)
      }
    } catch {
      this.webviewContentsIds.delete(instanceId)
    }
  }

  broadcastToActiveTinWebviews(channel: string, ...args: unknown[]): void {
    for (const [instanceId] of this.webviewContentsIds) {
      const state = this.activationStates.get(instanceId)
      if (state?.isActive) {
        this.emitToTinWebview(instanceId, channel, ...args)
      }
    }
  }

  // ── 当前状态查询 ──────────────────────────────

  getActiveInstances(): TinInstance[] {
    const activeIds = new Set(
      Array.from(this.activationStates.values())
        .filter((s) => s.isActive)
        .map((s) => s.instanceId)
    )
    return this.instances.filter((i) => activeIds.has(i.id))
  }

  getActivationState(instanceId: string): TinActivationState | undefined {
    return this.activationStates.get(instanceId)
  }
}

let tinManager: TinManager | null = null
let tinManagerCreating = false

export function getTinManager(): TinManager {
  if (tinManager && !tinManager.isDisposed()) {
    return tinManager
  }
  if (tinManagerCreating) {
    // Concurrent call while constructor is running; return existing (possibly disposed) ref
    // or create a fresh one after the flag clears. In practice the constructor is synchronous,
    // so this guard prevents double handler registration from recursive / concurrent calls.
    if (tinManager) return tinManager
  }
  tinManagerCreating = true
  try {
    tinManager = new TinManager()
  } finally {
    tinManagerCreating = false
  }
  return tinManager
}

export function initTinManager(mainWindow: BrowserWindow): TinManager {
  const manager = getTinManager()
  manager.init(mainWindow)
  return manager
}

export function disposeTinManagerSingleton(): void {
  if (tinManager) {
    tinManager.dispose()
    tinManager = null
  }
}
