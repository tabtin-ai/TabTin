/**
 * 主进程错误采集与上报服务
 *
 * 功能：
 * - 批量上报（队列 + 每 30s 刷新）
 * - 去重（同一 error_type + message 10s 内不重复上报）
 * - fatal 级别立即刷新
 * - 最大队列 50 条
 * - 使用 Node.js http/https 发送（不依赖 app ready 的 net.request）
 */

import { randomUUID } from 'crypto'
import http from 'http'
import https from 'https'
import os from 'os'
import { app } from 'electron'
import { API_BASE_URL } from '../config/api.js'
import { TokenManager } from '../auth.js'
import { joinApiPath } from '@tabtin/config'
import { createLogger } from '../logger'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import { captureClientError } from '../sentry'

const log = createLogger('MainErrorReporter')

// ── Types ──

interface ErrorEvent {
  error_type: string
  message: string
  stack_trace: string
  level: string
  source: string
  file: string
  line: number | null
  column: number | null
  breadcrumbs: Array<{ type: string; category: string; message: string; timestamp: string; data?: Record<string, unknown> }>
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
  locale: string
  extra: Record<string, unknown>
  occurred_at: string
  // 客户端去重键。main 进程没有 sendBeacon 双路径，但 flushErrors 失败 retry 链路
  // 在"请求送达 + 响应中断"的弱网场景下会让同一条 fatal 被后端创建多份 event。
  // 加 dedup_key 让后端 partial unique 兜住 retry 重发——与 renderer 共用同一套
  // 后端去重契约。
  dedup_key?: string
}

// ── Constants ──

const MAX_QUEUE_SIZE = 50
const FLUSH_INTERVAL_MS = 30_000     // 30 秒批量上报
const DEDUP_WINDOW_MS = 10_000       // 同一指纹 10 秒内去重

// ── State ──

let eventQueue: ErrorEvent[] = []
let recentFingerprints = new Map<string, number>()
let flushTimer: ReturnType<typeof setInterval> | null = null
let installed = false
let consecutiveFailures = 0
let sessionId = ''

// ── Breadcrumbs ──

let mainBreadcrumbs: Array<{ type: string; category: string; message: string; timestamp: string; data?: Record<string, unknown> }> = []
const MAIN_MAX_BREADCRUMBS = 20

function addMainBreadcrumb(type: string, category: string, message: string, data?: Record<string, unknown>) {
  mainBreadcrumbs.push({ type, category, message, timestamp: new Date().toISOString(), data })
  if (mainBreadcrumbs.length > MAIN_MAX_BREADCRUMBS) {
    mainBreadcrumbs = mainBreadcrumbs.slice(-MAIN_MAX_BREADCRUMBS)
  }
}

// ── Device Info (collected once) ──

/**
 * 构建期注入的 VITE_APP_VERSION（与 renderer 同源 SSOT）。
 *
 * 由 scripts/build-packaged-app.sh 顶部派生 RESOLVED_APP_VERSION，
 * export 给 vite，esbuild 在 main bundle 编译时把这里替换成字面量。
 *
 * 与运行时权威 `app.getVersion()` 应严格相等——后者是 packaged 后
 * package.json#version（被 electron-builder 用 extraMetadata.version 写入）。
 * 启动时 `assertVersionConsistency()` 做一次比对，不一致即上报致命事件。
 *
 * 关键：必须**精确**写 `import.meta.env.VITE_APP_VERSION`（不能加 `?.`、`as any`、
 * cast 等）——esbuild 的 env 注入是 AST 模式严格匹配的字面字符串替换，模式不严格
 * 匹配就退化成动态查 `__vite_import_meta_env__` 对象，scripts/build-packaged-app.sh
 * 的 step 1.1 grep 校验会失去意义。类型声明在 src/types/import-meta-env.d.ts。
 *
 * 关于 `|| ''`：与 renderer errorReporter.ts:503/518 风格一致。类型上虽然
 * d.ts 把 VITE_APP_VERSION 声为非 optional 的 string，但 esbuild 注入失败时
 * 仍可能拿到 undefined（理论极端情况，build script step 1.1 兜得住），
 * 这里是 runtime defensive，不是 cast，不影响 AST 字面量替换。
 */
const BUILD_TIME_APP_VERSION: string = import.meta.env.VITE_APP_VERSION || ''

function getDeviceInfo() {
  const platformMap: Record<string, string> = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux',
  }
  return {
    app_version: app.getVersion(),
    electron_version: process.versions.electron || '',
    os_name: platformMap[os.platform()] || os.platform(),
    os_version: os.release(),
    arch: os.arch(),
    locale: app.getLocale?.() || '',
  }
}

/**
 * 启动时校验 build-time VITE_APP_VERSION 与运行时 app.getVersion() 一致。
 *
 * **仅 packaged build 才跑这条契约**——dev / preview 工作流下 build_time 与 runtime
 * 必然不同源（典型 case：开发者跑 `pnpm build:mac:preprod` 把 main bundle 注入
 * `1.0.0-preprod.1`，再切回 `pnpm preview:packaged --skipBuild` 复用同一个 out/，
 * 此时 `app.getVersion()` 从源 package.json 读 `1.0.0`），无条件跑会每次 preview
 * 都向 preprod 后端推一条假 fatal，污染 admindash。这条 SSOT 契约只对 packaged
 * 产物有意义。
 *
 * Packaged 模式下不一致原因常
 *   - 开发者手工改了 deploy 目录的 package.json 但没重 build vite
 *   - electron-builder --config.extraMetadata.version 与 build 脚本顶部 RESOLVED_APP_VERSION 漂移
 *   - 远古 dev cache 没清干净（pnpm build:workspace 缓存命中）
 *
 * 不一致不阻断启动（产品取舍：用户机器上版本号自检失败也能继续用），
 * 但是版本号机制最重要的"可观测性"——本地 log.error 没人翻，所以**主动 captureError
 * 一条 fatal 上报到 admindash**，把"反混淆链路已断"的信号送出。
 *
 * 注意：mismatch 本身意味着反混淆可能不可用——把 build_time / runtime 两个版本值
 * 都塞进 extra，让 admindash 即便反混淆失败也能从 raw event 看到根因。
 */
function assertVersionConsistency(): void {
  // dev / preview 守卫：放过非 packaged 启动（与 main-app.ts 用 is.dev 守卫一致；
  // 这里用 app.isPackaged 是更直接的语义，兼容 ELECTRON_IS_DEV / NODE_ENV 各种 dev 启动方式）。
  if (!app.isPackaged) {
    log.debug('[ErrorReporter] dev/preview 模式跳过版本一致性自检（isPackaged=false）')
    return
  }
  const runtime = app.getVersion()
  if (!BUILD_TIME_APP_VERSION) {
    log.warn(
      '[ErrorReporter] BUILD_TIME_APP_VERSION 未注入（packaged 但 build 脚本异常），运行时 app.getVersion()=%s',
      runtime,
    )
    return
  }
  if (BUILD_TIME_APP_VERSION !== runtime) {
    log.error(
      '[ErrorReporter] ✗ Version mismatch: build-time VITE_APP_VERSION=%s, runtime app.getVersion()=%s — 反混淆链路可能失效',
      BUILD_TIME_APP_VERSION,
      runtime,
    )
    captureError(
      new Error(
        `VITE_APP_VERSION mismatch: build_time="${BUILD_TIME_APP_VERSION}" runtime="${runtime}"`,
      ),
      {
        build_time_version: BUILD_TIME_APP_VERSION,
        runtime_version: runtime,
        diagnostic: 'sourcemap_resolution_will_likely_fail',
      },
      'fatal',
    )
  } else {
    log.debug('[ErrorReporter] Version consistency OK: %s', runtime)
  }
}

// ── Deduplication ──

function computeFingerprint(errorType: string, message: string, stackTrace: string = ''): string {
  const raw = errorType + (stackTrace
    ? stackTrace.split('\n').filter(l => l.trim()).slice(0, 3).join('')
    : ':' + message
  )
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

// ── Error Capture ──

function captureError(
  error: Error,
  extra: Record<string, unknown> = {},
  level: string = 'error',
) {
  const errorType = error.constructor?.name || 'Error'
  const message = error.message || String(error)
  const stackTrace = error.stack || ''

  const fingerprint = computeFingerprint(errorType, message, stackTrace)
  if (isDuplicate(fingerprint)) return

  // 从堆栈中提取文件/行号
  let file = ''
  let line: number | null = null
  let column: number | null = null
  if (stackTrace) {
    const match = stackTrace.match(/at\s+.*?\(?((?:\/|[A-Za-z]:\\)[^:)]+):(\d+):(\d+)\)?/)
      || stackTrace.match(/([\w./\\-]+\.\w+):(\d+):(\d+)/)
    if (match) {
      file = match[1]
      line = parseInt(match[2], 10)
      column = parseInt(match[3], 10)
    }
  }

  const device = getDeviceInfo()

  const event: ErrorEvent = {
    error_type: errorType.slice(0, 128),
    message: message.slice(0, 4096),
    stack_trace: stackTrace.slice(0, 16384),
    level,
    source: 'main',
    file: file.slice(0, 512),
    line,
    column,
    breadcrumbs: [...mainBreadcrumbs],
    ...device,
    extra: { session_id: sessionId, device_id: getDeviceFingerprint(), ...extra },
    occurred_at: new Date().toISOString(),
    // 给 fatal 事件生成 dedup_key——main 进程虽然没双路径冗余，但 flushErrors
    // 失败时 `eventQueue.unshift(...toSend)` retry 链路会让同一条 fatal 被
    // 后端创建多份 event。后端 partial unique 见到同 dedup_key 已存在时仅前推
    // group last_seen，让 admindash event_count 不被 retry 重复计数。
    dedup_key: level === 'fatal' ? randomUUID() : undefined,
  }

  eventQueue.push(event)
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue = eventQueue.slice(-MAX_QUEUE_SIZE)
  }

  // fatal 级别立即上报
  if (level === 'fatal') {
    flushErrors()
  }
}

// ── Flush / Upload ──

function sendViaNodeHttp(url: string, body: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const httpModule = urlObj.protocol === 'https:' ? https : http
    const bodyBuffer = Buffer.from(body, 'utf-8')

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(bodyBuffer.length),
      },
    }

    const req = httpModule.request(requestOptions, (res) => {
      // 消费响应体以释放 socket
      res.resume()
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve()
      } else {
        reject(new Error(`HTTP ${res.statusCode}`))
      }
    })

    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Request timeout'))
    })
    req.write(bodyBuffer)
    req.end()
  })
}

async function flushErrors(): Promise<void> {
  const toSend = eventQueue.splice(0)
  if (toSend.length === 0) return

  // 判断是否有 auth token
  let token: string | null = null
  try {
    token = await TokenManager.getAccessToken()
  } catch {
    // 无法获取 token，使用匿名上报
  }

  const useAnonymous = !token
  const endpoint = useAnonymous ? '/client-errors/report-anonymous' : '/client-errors/report'
  const url = joinApiPath(API_BASE_URL, endpoint)
  const body = JSON.stringify({ events: toSend })

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    await sendViaNodeHttp(url, body, headers)
    consecutiveFailures = 0
  } catch (err) {
    consecutiveFailures++
    log.debug('Error report flush failed (attempt %d):', consecutiveFailures, err)
    // 连续失败超过 5 次则丢弃，避免无限重试
    if (consecutiveFailures <= 5) {
      eventQueue.unshift(...toSend)
      if (eventQueue.length > MAX_QUEUE_SIZE) {
        eventQueue = eventQueue.slice(-MAX_QUEUE_SIZE)
      }
    } else {
      log.debug('Too many consecutive failures, dropping %d events', toSend.length)
    }
  }
}

// ── Public API ──

/**
 * 初始化主进程错误上报服务（应在 process.on 错误处理之后调用一次）
 */
export function initMainErrorReporter(): void {
  if (installed) return
  installed = true

  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36)

  // 启动时做一次版本号一致性自检（build-time vs runtime），不一致仅 log，不阻断
  assertVersionConsistency()

  // 定时批量上报
  flushTimer = setInterval(flushErrors, FLUSH_INTERVAL_MS)

  // SC-002: 不使用 e.preventDefault() — 阻止退出会导致后续 will-quit handler
  // （如 IPC 注销）被跳过或在第二次 will-quit 中不可靠执行。
  // 改为 best-effort flush：尽力上报但不阻塞退出流程。
  app.on('will-quit', () => {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (eventQueue.length === 0) return
    flushErrors().catch((err) => {
      log.error('flush failed on will-quit:', err)
    })
  })

  // 追踪应用生命周期事件作为面包屑
  app.on('browser-window-created', (_, win) => {
    addMainBreadcrumb('lifecycle', 'window', `Window created: ${win.id}`)
    win.on('closed', () => {
      addMainBreadcrumb('lifecycle', 'window', `Window closed: ${win.id}`)
    })
  })

  app.on('web-contents-created', (_, contents) => {
    contents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
      addMainBreadcrumb('error', 'webContents', `Load failed: ${validatedURL} (${errorCode}: ${errorDescription})`)
    })
  })

  app.on('render-process-gone', (_, _contents, details) => {
    addMainBreadcrumb('error', 'process', `Render process gone: ${details.reason}`, { exitCode: details.exitCode })
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      captureClientError(new Error(`Renderer process gone: ${details.reason}`), {
        handled_by: 'electron_render_process_gone',
        error_category: 'RENDERER_CRASH',
        error_code: `RENDERER_${details.reason.toUpperCase().replaceAll('-', '_')}`,
        severity: 'crash',
        recoverability: 'degraded',
      })
    }
  })

  app.on('child-process-gone', (_, details) => {
    addMainBreadcrumb('error', 'process', `Child process gone: ${details.type} (${details.reason})`)
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      const processType = details.type.toUpperCase().replaceAll('-', '_')
      const reason = details.reason.toUpperCase().replaceAll('-', '_')
      captureClientError(new Error(`${details.type} process gone: ${details.reason}`), {
        handled_by: 'electron_child_process_gone',
        error_category: details.type === 'GPU' ? 'GPU_CRASH' : 'CLIENT_CRASH',
        error_code: `${processType}_${reason}`,
        severity: 'crash',
        recoverability: 'degraded',
      })
    }
  })

  log.debug('Main process error reporter initialized')
}

/**
 * 添加主进程面包屑（供其他主进程模块手动调用）
 */
export { addMainBreadcrumb }

/**
 * 手动上报一个主进程错误
 */
export function reportMainError(
  error: Error,
  extra: Record<string, unknown> = {},
  level: 'error' | 'warning' | 'fatal' = 'error',
): void {
  captureError(error, extra, level)
}
