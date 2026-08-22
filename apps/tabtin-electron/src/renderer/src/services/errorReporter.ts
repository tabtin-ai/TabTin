/**
 * 前端错误采集与上报服务
 *
 * 功能：
 * - 全局捕获 window.onerror / unhandledrejection
 * - 面包屑收集（点击、路由、HTTP 请求、console.error）
 * - 批量上报 + 离线缓存（localStorage 队列）
 * - 采样与去重（同一指纹 10s 内不重复上报）
 *
 * 与 Sentry 的分工（，契约见 docs/agent/error-context-schema.md）：
 * `VITE_SENTRY_DSN` 配置时**全局错误捕获交给 Sentry SDK**——本服务不再挂
 * window.onerror / unhandledrejection（双挂会对同一未捕获错误重复上报两条
 * 通道）。面包屑采集、显式 captureError 调用与 /client-errors 通道保留，
 * 供诊断包与业务代码手动上报使用。
 */

import { API_BASE_URL } from '@/config/api'
import { joinApiPath } from '@tabtin/config'
import { getOrCreateDeviceId } from '@/utils/deviceId'

// ── Types ──

export interface Breadcrumb {
  type: string       // click / navigation / http / console / error
  category: string
  message: string
  timestamp: string
  data?: Record<string, unknown>
}

interface ErrorEvent {
  error_type: string
  message: string
  stack_trace: string
  level: string
  source: string
  file: string
  line: number | null
  column: number | null
  breadcrumbs: Breadcrumb[]
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
  locale: string
  extra: Record<string, unknown>
  occurred_at: string
}

// ── Constants ──

const MAX_BREADCRUMBS = 30
const MAX_QUEUE_SIZE = 100
const FLUSH_INTERVAL_MS = 30_000   // 30 秒批量上报
const DEDUP_WINDOW_MS = 10_000     // 同一指纹 10 秒内去重
const STORAGE_KEY = '__tabtin_error_queue'

// ── State ──

let breadcrumbs: Breadcrumb[] = []
let eventQueue: ErrorEvent[] = []
let recentFingerprints = new Map<string, number>()  // fingerprint -> timestamp
let flushTimer: ReturnType<typeof setInterval> | null = null
let installed = false
let sessionId = ''
let deviceId = ''
let deviceInfo: {
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
  locale: string
} = {
  app_version: '',
  electron_version: '',
  os_name: '',
  os_version: '',
  arch: '',
  locale: navigator.language || '',
}

// ── Breadcrumb Collection ──

function addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'>) {
  breadcrumbs.push({
    ...crumb,
    timestamp: new Date().toISOString(),
  })
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs = breadcrumbs.slice(-MAX_BREADCRUMBS)
  }
}

function installClickBreadcrumbs() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (!target) return
    const tag = target.tagName?.toLowerCase() || ''
    const text = (target.textContent || '').trim().slice(0, 60)
    const id = target.id ? `#${target.id}` : ''
    const cls = target.className && typeof target.className === 'string'
      ? `.${target.className.split(' ').slice(0, 2).join('.')}`
      : ''
    addBreadcrumb({
      type: 'click',
      category: 'ui',
      message: `${tag}${id}${cls}${text ? ` "${text}"` : ''}`,
    })
  }, { capture: true, passive: true })
}

function installConsoleBreadcrumbs() {
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    addBreadcrumb({
      type: 'console',
      category: 'console.error',
      message: args.map(a => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }).join(' ').slice(0, 200),
    })
    originalError.apply(console, args)
  }
}

function installNavigationBreadcrumbs() {
  // 监听 popstate（浏览器后退/前进）
  window.addEventListener('popstate', () => {
    addBreadcrumb({
      type: 'navigation',
      category: 'route',
      message: window.location.pathname + window.location.hash,
    })
  })

  // 拦截 pushState/replaceState
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  history.pushState = function (...args) {
    originalPushState.apply(this, args)
    addBreadcrumb({
      type: 'navigation',
      category: 'route',
      message: String(args[2] || window.location.pathname),
    })
  }

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args)
    addBreadcrumb({
      type: 'navigation',
      category: 'route',
      message: String(args[2] || window.location.pathname),
    })
  }
}

function installHttpBreadcrumbs() {
  const originalFetch = window.fetch
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method?.toUpperCase() || 'GET'
    let url = ''
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else if (input instanceof Request) url = input.url

    // 不记录错误上报自身的请求
    if (url.includes('/client-errors/report')) {
      return originalFetch.call(this, input, init)
    }

    const shortUrl = url.length > 120 ? url.slice(0, 120) + '...' : url
    const start = Date.now()
    try {
      const resp = await originalFetch.call(this, input, init)
      addBreadcrumb({
        type: 'http',
        category: 'fetch',
        message: `${method} ${shortUrl} → ${resp.status}`,
        data: { duration_ms: Date.now() - start, status: resp.status },
      })
      return resp
    } catch (err) {
      addBreadcrumb({
        type: 'http',
        category: 'fetch',
        message: `${method} ${shortUrl} → FAILED`,
        data: { duration_ms: Date.now() - start, error: String(err) },
      })
      throw err
    }
  }
}

// ── Error Capture ──

function computeFingerprint(errorType: string, stackTrace: string, message: string): string {
  const raw = errorType + (stackTrace
    ? stackTrace.split('\n').filter(l => l.trim()).slice(0, 3).join('')
    : message
  )
  // 简易 hash
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function isDuplicate(fingerprint: string): boolean {
  const now = Date.now()
  const lastSeen = recentFingerprints.get(fingerprint)
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true
  }
  recentFingerprints.set(fingerprint, now)

  // 清理过期记录
  if (recentFingerprints.size > 200) {
    const cutoff = now - DEDUP_WINDOW_MS
    for (const [fp, ts] of recentFingerprints) {
      if (ts < cutoff) recentFingerprints.delete(fp)
    }
  }
  return false
}

/**
 * 浏览器内部 / 跨域 / 无 stack 的"看起来像错误但实际无害"模式名单。
 *
 * 加入名单的事件会被**完全丢弃**（不入队、不上报、不计指纹），相当于这个错误
 * 在前端监控层不存在。只放真正"业界共识为噪声"的模式，不要因为某个真实 bug
 * 烦人就加进来——那会掩盖真问题。
 *
 * 现状治理对象：
 * - ResizeObserver loop * — 浏览器在一帧内反复 ResizeObserver 回调时的内部警告
 *   （Chrome / WebKit 都有），浏览器自己会自动恢复，业界监控（Sentry/Bugsnag）默认忽略。
 *   admindash group  历史悠久（2026-03 起出现 16 次），就是这一类。
 * - Script error. — 跨域脚本错误，浏览器隐藏了所有上下文，留着只是占位噪声。
 * - Non-Error promise rejection captured with value: undefined — 业务侧 reject(undefined)
 *   的样板噪声，没法定位也没法修。
 *
 * **不要**在这里加：
 * - Failed to fetch / Network request failed — 可能是真后端挂了
 * - Centrifugo timeout — 应用层连接问题，应该在 Centrifugo client 自己抑制 console.error
 * - 任何 React/Vue 报错 — 真问题，必须上报
 */
const IGNORED_ERROR_PATTERNS: RegExp[] = [
  /^ResizeObserver loop completed with undelivered notifications/i,
  /^ResizeObserver loop limit exceeded/i,
  /^Script error\.?$/,
  /^Non-Error promise rejection captured with value:?\s*undefined$/i,
]

function shouldIgnoreError(message: string): boolean {
  if (!message) return false
  return IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function captureError(
  errorType: string,
  message: string,
  stackTrace: string = '',
  extra: Record<string, unknown> = {},
  level: string = 'error',
  source: string = 'renderer',
) {
  if (shouldIgnoreError(message)) return
  const fingerprint = computeFingerprint(errorType, stackTrace, message)
  if (isDuplicate(fingerprint)) return

  // 从堆栈中提取文件/行号
  let file = ''
  let line: number | null = null
  let column: number | null = null
  if (stackTrace) {
    const match = stackTrace.match(/at\s+.*?\(?((?:https?|file):\/\/[^:)]+):(\d+):(\d+)\)?/)
      || stackTrace.match(/([\w./\\-]+\.\w+):(\d+):(\d+)/)
    if (match) {
      file = match[1]
      line = parseInt(match[2], 10)
      column = parseInt(match[3], 10)
    }
  }

  const event: ErrorEvent = {
    error_type: errorType.slice(0, 128),
    message: message.slice(0, 4096),
    stack_trace: stackTrace.slice(0, 16384),
    level,
    source,
    file: file.slice(0, 512),
    line,
    column,
    breadcrumbs: [...breadcrumbs],
    ...deviceInfo,
    extra: { session_id: sessionId, device_id: deviceId, ...extra },
    occurred_at: new Date().toISOString(),
  }

  eventQueue.push(event)
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue = eventQueue.slice(-MAX_QUEUE_SIZE)
  }

  // 致命错误立即上报
  if (level === 'fatal') {
    flushErrors()
  }
}

function installErrorBreadcrumbCollectors() {
  // ：与「上报」解耦的现场采集。Sentry 启用时全局上报让位给 Sentry SDK，
  // 但诊断包（breadcrumbs.json）仍需要 uncaught error / unhandledrejection 的
  // 本地记录——否则「客户端静默失败」类问题从诊断包完全看不出来（本次事故
  // 全靠 main.log 的 console 转发才兜住）。addEventListener 与 Sentry 的全局
  // handler 可共存；此处只写内存面包屑，不入上报队列，不会造成双通道重复上报。
  window.addEventListener('error', (e) => {
    addBreadcrumb({
      type: 'error',
      category: 'uncaught',
      message: String(e.message || (e.error as Error | undefined)?.message || 'unknown error').slice(0, 300),
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | undefined
    const stackHead = typeof reason?.stack === 'string'
      ? reason.stack.split('\n').slice(1, 3).join(' | ').trim()
      : ''
    addBreadcrumb({
      type: 'error',
      category: 'unhandledrejection',
      message: String(reason?.message ?? reason ?? 'unknown rejection').slice(0, 300),
      ...(stackHead ? { data: { stack_head: stackHead.slice(0, 300) } } : {}),
    })
  })
}

function installGlobalErrorHandlers() {
  // window.onerror
  window.onerror = (message, source, lineno, colno, error) => {
    const errorType = error?.constructor?.name || 'Error'
    const msg = typeof message === 'string' ? message : String(message)
    const stack = error?.stack || `at ${source || 'unknown'}:${lineno || 0}:${colno || 0}`
    captureError(errorType, msg, stack)
    // 不阻止默认行为
    return false
  }

  // unhandledrejection
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    if (!reason) return
    const errorType = reason?.constructor?.name || 'UnhandledPromiseRejection'
    const message = reason?.message || String(reason)
    const stack = reason?.stack || ''
    captureError(errorType, message, stack)
  })
}

// ── Flush / Upload ──

async function sendToServer(events: ErrorEvent[], useAnonymous: boolean = false, token?: string) {
  const endpoint = useAnonymous ? '/client-errors/report-anonymous' : '/client-errors/report'
  const url = joinApiPath(API_BASE_URL, endpoint)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!useAnonymous && token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    if (window.tabtin?.apiRequest) {
      // 通过主进程代理发送
      await window.tabtin.apiRequest({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify({ events }),
      })
    } else {
      // 降级：preload 尚未就绪 / 浏览器调试模式时直接 fetch。client-errors
      // 端点是 anonymous，无需 token 注入，所以不走 IPC 也不影响功能。
      // keepalive:true 保证 page unload 时仍能完成上报，这是错误上报的关键语义，
      // electronFetch / apiService.request 都不透传 keepalive。
      // eslint-disable-next-line tabtin/no-direct-fetch-in-renderer -- IPC 不可用降级 + 需要 fetch keepalive 语义保证 unload 时仍上报
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events }),
        keepalive: true,
      })
    }
  } catch {
    // 上报失败则保存到 localStorage 等下次重试
    saveToStorage(events)
  }
}

function saveToStorage(events: ErrorEvent[]) {
  try {
    const existing = loadFromStorage()
    const merged = [...existing, ...events].slice(-MAX_QUEUE_SIZE)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // localStorage 满了就放弃
  }
}

function loadFromStorage(): ErrorEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    localStorage.removeItem(STORAGE_KEY)
    return Array.isArray(data) ? data : []
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return []
  }
}

async function flushErrors() {
  // 合并内存队列和 localStorage 缓存
  const stored = loadFromStorage()
  const toSend = [...stored, ...eventQueue]
  eventQueue = []

  if (toSend.length === 0) return

  // 判断是否有 auth token
  // contract W2-β：旧 envelope `{success, token}` 改为 invokeIpc 直接返 `{ token }` 或 throw。
  // 此处静默 fail-soft——errorReporter 是后台错误上报通道，登录态不可用时降级匿名上报，
  // 不应弹 toast 干扰用户（catch 黑洞是有意的）。
  let token: string | undefined
  try {
    if (window.tabtin?.auth?.getAccessToken) {
      const result = await window.tabtin.auth.getAccessToken()
      if (result?.token) {
        token = result.token
      }
    }
  } catch {
    // 静默：无法获取 token 时降级匿名上报（不阻塞错误数据回流）
  }

  await sendToServer(toSend, !token, token)
}

// ── Device Info ──

const PLATFORM_MAP: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

function extractOsVersion(platform: string): string {
  try {
    const ua = navigator.userAgent
    if (platform === 'darwin') {
      const m = ua.match(/Mac OS X ([\d_.]+)/)
      if (m) return m[1].replace(/_/g, '.')
    } else if (platform === 'win32') {
      const m = ua.match(/Windows NT ([\d.]+)/)
      if (m) return m[1]
    }
  } catch { /* ignore */ }
  return ''
}

/**
 * 同步采集所有"立刻可拿到"的字段——
 *
 * 关键设计：errorReporter 必须保证 deviceInfo.app_version 在**任何**错误上报时
 * 都不为空，否则后端 SourceMapFile 按 app_version 反混淆会失败。
 *
 * 历史 bug：本函数原来是 async + 单次填充，但 `updater.getAppVersion()` 是 IPC
 * 异步返回，启动期早发的错误（典型如 React  在 layout effect 阶段抛）会在 IPC
 * 返回前就上报，导致 app_version=""。
 *
 * 现在分两步：
 *   1. 模块加载时立刻同步填充——所有字段都用同步可拿到的源（VITE define + window
 *      同步 IPC + UA 解析 + process.versions）
 *   2. async refineDeviceInfoFromIpc() 后台跑，只在 IPC 拿到更精确的 app_version
 *      时才覆盖（其他字段同步源已经够准）
 */
function collectDeviceInfoSync(): void {
  // 关键：renderer 在 sandbox + contextIsolation 模式下**没有** `process` 全局对象，
  // 直接访问 `process.versions?.electron` 会抛 `ReferenceError: process is not defined`，
  // 整个 try block 走 catch，deviceInfo 退化为空，全局错误上报字段全部丢失（包括
  // app_version——vite 注入的版本号设不进去 → refineDeviceInfoFromIpc 用 IPC 的
  // '1.0.0' 覆盖 → 上报版本号与 sourcemap 入库版本不匹配 → 反混淆全失败。
  //
  // 解决：把 process 访问独立 try-catch，且用 typeof 防御 ReferenceError。
  let electronVersion = ''
  try {
    if (typeof process !== 'undefined') {
      electronVersion = process?.versions?.electron || ''
    }
  } catch { /* renderer sandbox 下 process 未定义 */ }

  try {
    const platform = window.tabtin?.getPlatform?.() || ''
    const arch = window.tabtin?.getArch?.() || ''
    // VITE_APP_VERSION 来源：apps/tabtin-electron/.env.<profile>（vite 自动注入到 import.meta.env）。
    // 关键：必须**精确**写 `import.meta.env.VITE_APP_VERSION`（不能加 `?.` 或 `as any`）——
    // vite/esbuild 的 env 注入是字面字符串替换，模式不严格匹配就退化成动态查 __vite_import_meta_env__
    // 对象，从而拿到默认 '1.0.0' 而不是我们配的 '1.0.0-preprod.1'，导致 sourcemap 反混淆失败。
    // 整条链路一致性：.env.localdev/preprod 显式写 VITE_APP_VERSION + run-electron-vite.mjs 自动 --mode +
    // upload-sourcemaps.sh 的 SOURCEMAP_APP_VERSION 必须用同一个值。
    const viteAppVersion: string = import.meta.env.VITE_APP_VERSION || ''

    deviceInfo = {
      app_version: viteAppVersion,
      electron_version: electronVersion,
      os_name: PLATFORM_MAP[platform] || platform,
      os_version: extractOsVersion(platform),
      arch,
      locale: navigator.language || '',
    }
  } catch {
    // 兜底：单字段失败也别让 deviceInfo 保持初始全空——至少把 app_version 设上，
    // 否则 refineDeviceInfoFromIpc 会用 IPC 的版本（preview/dev 模式下 = '1.0.0'）覆盖，
    // sourcemap 反混淆链路在所有错误事件上失效。
    try {
      const viteAppVersion: string = import.meta.env.VITE_APP_VERSION || ''
      if (viteAppVersion && !deviceInfo.app_version) {
        deviceInfo = { ...deviceInfo, app_version: viteAppVersion }
      }
    } catch { /* ignore */ }
  }
}

/**
 * 异步从 IPC 拿到 app_version（fallback 用）。
 *
 * 关键原则：**vite 注入的 VITE_APP_VERSION 是 ground truth**——它与 build 时
 * sourcemap 入库的 app_version 严格绑定。IPC 拿到的是 main 进程
 * `app.getVersion()`（即 packaged 后的 package.json 版本），在 preview 模式下
 * 会是源 package.json 的 '1.0.0'，跟 sourcemap 版本号 '1.0.0-preprod.1' 不匹配。
 *
 * 所以仅在 vite 注入完全为空时（dev mode 没设 VITE_APP_VERSION 等极端兜底场景）
 * 才用 IPC 值。任何情况下 IPC 都不能覆盖 vite 注入。
 */
async function refineDeviceInfoFromIpc(): Promise<void> {
  try {
    if (!window.tabtin?.updater?.getAppVersion) return
    if (deviceInfo.app_version) return  // vite 已注入，不用 IPC 覆盖
    const ipcVersion = await window.tabtin.updater.getAppVersion()
    if (ipcVersion) {
      deviceInfo = { ...deviceInfo, app_version: ipcVersion }
    }
  } catch { /* ignore */ }
}

// ── Public API ──

/**
 * 初始化错误采集服务（应在应用启动时调用一次）
 */
export function initErrorReporter() {
  if (installed) return
  installed = true

  // 生成本次会话 ID
  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36)

  // device_id 延迟解析（syncDeviceFingerprint 在 bootstrap 中晚于本函数调用）
  setTimeout(() => {
    try {
      deviceId = getOrCreateDeviceId()
    } catch {
      // ignore
    }
  }, 2000)

  // 同步 init 设备信息——立刻让 deviceInfo.app_version 等关键字段就位，
  // 后续 async refine 只用来修正 IPC 才能拿到的更精确值。
  // 这是为了避免启动期早发错误（典型 React ）上报时字段全空。
  collectDeviceInfoSync()
  void refineDeviceInfoFromIpc()

  // 安装面包屑收集
  installClickBreadcrumbs()
  installConsoleBreadcrumbs()
  installNavigationBreadcrumbs()
  installHttpBreadcrumbs()
  installErrorBreadcrumbCollectors()

  // 安装全局错误捕获——Sentry 启用时让位（见模块头注释），避免同一未捕获
  // 错误在 Sentry 与 /client-errors 各报一条。
  if (!(import.meta.env.VITE_SENTRY_DSN || '').trim()) {
    installGlobalErrorHandlers()
  }

  // 定时批量上报（先清理旧 timer，HMR 安全）
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = setInterval(flushErrors, FLUSH_INTERVAL_MS)

  // 页面关闭/刷新前真正 flush——之前只调 saveToStorage 把事件压在 localStorage，
  // 等下次启动 30s tick 才发，导致用户复现错误后立刻刷新就再也看不到上报。
  // sendToServer 内部已用 fetch keepalive，能保证 unload 期间完成上报。
  // 双保险：flush 失败的事件 sendToServer 会自动 saveToStorage 走 retry 链路。
  window.addEventListener('beforeunload', () => {
    if (eventQueue.length > 0) {
      void flushErrors()
    }
  })
  // visibilitychange 是更可靠的 unload 信号（macOS 上 cmd+q 不一定触发 beforeunload）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && eventQueue.length > 0) {
      void flushErrors()
    }
  })
}

/**
 * 手动上报一个错误（供 ErrorBoundary 等场景使用）
 */
export function reportError(
  error: Error | string,
  extra: Record<string, unknown> = {},
  level: 'error' | 'warning' | 'fatal' = 'error',
) {
  if (typeof error === 'string') {
    captureError('ManualReport', error, '', extra, level)
  } else {
    captureError(
      error.constructor?.name || 'Error',
      error.message || String(error),
      error.stack || '',
      extra,
      level,
    )
  }
}

/**
 * 手动添加一条面包屑
 */
export function addErrorBreadcrumb(
  type: string,
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  addBreadcrumb({ type, category, message, data })
}

/**
 * 立即上报所有缓存的错误（用于测试或关键时刻）
 */
export { flushErrors }

// ── 诊断包只读快照 ──
// 供「客户端诊断日志导出」收集出错前的现场，均返回内存状态副本，不改动上报队列。

/** 最近的操作面包屑（点击 / 路由 / HTTP / console.error）。 */
export function getBreadcrumbsSnapshot(): Breadcrumb[] {
  return [...breadcrumbs]
}

/** 内存中尚未 flush 的错误事件队列（不含已落 localStorage 的待重试项，避免副作用）。 */
export function getRecentErrorsSnapshot(): ErrorEvent[] {
  return [...eventQueue]
}

/** 当前会话与设备快照（版本 / 平台 / 架构 / locale / 会话 / 设备指纹）。 */
export function getClientContextSnapshot(): {
  session_id: string
  device_id: string
} & typeof deviceInfo {
  return {
    session_id: sessionId,
    device_id: deviceId,
    ...deviceInfo,
  }
}
