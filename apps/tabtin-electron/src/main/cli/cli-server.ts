/**
 * TabTin CLI Server
 *
 * HTTP server over Unix Socket (macOS/Linux) or Named Pipe (Windows).
 * Receives requests from the `tabtin` CLI and routes them to
 * the appropriate handler (Django API proxy or local action-tools).
 */

import http from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  SlidingWindowRateLimiter,
  parseBody,
  sendJSON,
  sendDjangoResult,
  MAX_BODY_SIZE,
  validateCSRFHeaders,
  validateTokenAuth,
  type CLIServerInfo,
  createCLIHttpServer,
  writeDiscoveryFileDetailed,
  cleanupSocketFile,
  cleanupDiscoveryFile,
  scanMarketplaceManifests,
} from '@tabtin/cli-server-core'
import {
  configureCLIRoutes,
  handleTableRoute,
  handleSpaceRoute,
  handleFetchRoute,
  handleExtensionsRoute,
  handleCodeRoute,
  handleDriveRoute,
  handleOSSRoute,
  handleCapabilitiesRoute,
  handleSearchRoute,
} from '@tabtin/cli-routes'
import { handleBrowserRoute } from './routes/browser'
import { handleSlideRoute } from './routes/slide'
import { wirePythonRuntimeHost } from '@tabtin/python-runtime-host'
import { logger as appLogger } from '../utils/logger'
import { createLogger } from '../logger'
import { resolveDevInstanceId } from '../app-identity'
import { resolveCLIInstancePolicy } from './cli-instance-policy'
import { handleMediaRoute } from './routes/media'
import { handleVideoRoute, shutdownVideoTasks } from './routes/video'
import { handleTabsiteRoute } from './routes/tabsite'
import { handleDesktopRoute } from './routes/desktop'
import { handleTerminalRoute } from './routes/terminal'
import { handleDeviceRoute } from './routes/device'
import { handleReachRoute } from './routes/reach'
import { handleAgentRoute } from './routes/agent'
import { handleMcpRoute } from './routes/mcp'
import { handlePluginRoute } from './routes/plugin'
import { handleSkillsRoute } from './routes/skills'
import { handleSpeechRoute } from './routes/speech'
import {
  enrichCodeBodyWithAgentContext,
  extractAgentThreadId,
  readHeaderString,
  runWithAgentRequestContext,
} from './agent-request-context'
import { errorResponse, djangoRequest } from './routes/shared/error-handler'
import { ensureCliProfileBootstrap } from './cli-profile-bootstrap'
import { okResponse, errResponse } from '@tabtin/agent-wire'
import { runWithHumanInteractionContext } from '@tabtin/agent-runtime'
import {
  getSurfaceByHttpPath,
  createSurfaceHttpHandler,
  configureSurfaceRuntime,
  createSurfacesEndpoint,
} from '@tabtin/cli-server-core'
import {
  getCLIActionExecutor,
  getCLISpaceId,
  getCLIOrganizationId,
  getCLIOrganizationRoot,
  getCLICodeWorktreeController,
  setCLISpaceContextState,
} from './cli-context'
import {
  BROWSER_CLI_APPROVAL_TIMEOUT_MS,
  evaluateElectronBrowserCLIPolicy,
  runWithBrowserPolicyPreapproval,
} from './browser-policy-middleware'
import { ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS } from './routes/browser/interaction'

const cliLog = createLogger('CLIServer')

const codeGrepRateLimiter = new SlidingWindowRateLimiter(20, 60_000)
export const BROWSER_CLI_REQUEST_TIMEOUT_GRACE_MS = 5_000
export const BROWSER_CLI_REQUEST_TIMEOUT_MS =
  BROWSER_CLI_APPROVAL_TIMEOUT_MS +
  ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS +
  BROWSER_CLI_REQUEST_TIMEOUT_GRACE_MS

export async function runBrowserRequestWithDeadline(
  url: string,
  res: http.ServerResponse,
  run: (guardedSendJSON: typeof sendJSON) => Promise<void>,
): Promise<void> {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const guardedSendJSON: typeof sendJSON = (targetRes, status, data) => {
    if (settled || targetRes.writableEnded || targetRes.destroyed) return
    settled = true
    clearTimer()
    sendJSON(targetRes, status, data)
  }

  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled || res.writableEnded || res.destroyed) return
      settled = true
      sendJSON(res, 504, errorResponse('CONNECTION_TIMEOUT', `Browser CLI request timed out after ${BROWSER_CLI_REQUEST_TIMEOUT_MS / 1000}s before transport timeout`, {
        retryable: true,
        detail: { url, timeoutMs: BROWSER_CLI_REQUEST_TIMEOUT_MS },
      }))
      resolve()
    }, BROWSER_CLI_REQUEST_TIMEOUT_MS)

    run(guardedSendJSON).then(
      () => {
        if (!settled) {
          guardedSendJSON(res, 500, errorResponse('INTERNAL_ERROR', 'Browser route completed without sending a response', {
            detail: { url },
          }))
        }
        resolve()
      },
      (err) => {
        if (settled) {
          cliLog.warn('Browser request 在响应已 settle 后失败:', err)
          resolve()
          return
        }
        clearTimer()
        reject(err)
      },
    )
  }).finally(clearTimer)
}

// ── W7：marketplace App 命令缓存（懒加载）──────────────────────────
// 扫描 packages/apps/ 下 distribution=marketplace 的 App manifest，
// 缓存结果供 /extensions/cli-commands 响应合并。
let _marketplaceCommandsCache: unknown[] | null = null
function getMarketplaceCommands(): unknown[] {
  if (_marketplaceCommandsCache) return _marketplaceCommandsCache
  const candidates = [
    join(app.getAppPath(), '..', '..', 'packages', 'apps'),
    join(app.getAppPath(), 'packages', 'apps'),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) {
      _marketplaceCommandsCache = scanMarketplaceManifests(dir)
      return _marketplaceCommandsCache
    }
  }
  _marketplaceCommandsCache = []
  return _marketplaceCommandsCache
}

export interface CLIServerConfig {
  socketPath?: string
}

export type { CLIServerInfo }

let serverInstance: http.Server | null = null
let serverInfo: CLIServerInfo | null = null
let serverReadyPromise: Promise<CLIServerInfo> | null = null
let rejectServerReady: ((reason: Error) => void) | null = null
let serverConfig: CLIServerConfig | undefined
let serverGeneration = 0
let activeServerPublishesGlobalDiscovery = false

// CLI request context (Space / Organization / executors / bridges) lives in
// `./cli-context` to keep `cli-server.ts ↔ routes/*.ts` acyclic. We re-export
// the same names below so external callers (ipc-registry / bridge-core /
// deferred-init-action-bridge / unit tests) keep their import paths.
export {
  setCLIActionExecutor,
  getCLIActionExecutor,
  setCLIViewGetter,
  getCLIViewGetter,
  setCLIDesktopExecutor,
  getCLIDesktopExecutor,
  setCLIDesktopGuard,
  getCLIDesktopGuard,
  setCLIContextSpaceBridge,
  getCLIContextSpaceBridge,
  getCLISpaceId,
  getCLICrawlspaceId,
  getCLIOrganizationId,
  getCLIOrganizationRoot,
  setCLIWorkspaceScopeKey,
  CLIWorkspaceScopeTurnLeaseManager,
  getCLIWorkspaceScopeKey,
  syncCLISpaceContextFromQueryRequest,
  setCLIOrganizationRootIfMissing,
  setCLISkillsMaterializer,
  setCLISkillsInteropAdder,
  setCLICodeWorktreeController,
  type ActionExecutor,
  type CLISkillsMaterializer,
  type CLISkillsInteropAdder,
  type CLICodeWorktreeController,
} from './cli-context'

function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || !app.isPackaged
}

/**
 * TD-1/H-2：从 CLI 进来的请求里挑出 Agent run/session 上下文头，转发给 Django，
 * 让版本历史 / ChangeLog 归因为 agent。只透传白名单内的头，不放行任意头。
 */
function pickAgentContextHeaders(
  req: http.IncomingMessage,
): Record<string, string> {
  const out: Record<string, string> = {}
  const runId = req.headers['x-tabtin-agent-run-id']
  const sessionId = req.headers['x-tabtin-session-id']
  if (typeof runId === 'string' && runId) out['X-Tabtin-Agent-Run-Id'] = runId
  if (typeof sessionId === 'string' && sessionId) out['X-Tabtin-Session-Id'] = sessionId
  return out
}

function enrichBrowserBodyWithAgentThread(
  body: unknown,
  req: http.IncomingMessage,
): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body

  const record = body as Record<string, unknown>
  const {
    _thread_id: _ignoredPrivateThreadId,
    thread_id: _ignoredThreadId,
    threadId: _ignoredCamelThreadId,
    runId: _ignoredRunId,
    run_id: _ignoredSnakeRunId,
    context,
    ...rest
  } = record
  const cleanContext = context && typeof context === 'object' && !Array.isArray(context)
    ? (() => {
        const {
          thread_id: _ignoredContextThreadId,
          threadId: _ignoredContextCamelThreadId,
          ...contextRest
        } = context as Record<string, unknown>
        return contextRest
      })()
    : context

  const threadId =
    readHeaderString(req, 'x-tabtin-session-id') ||
    readHeaderString(req, 'x-tabtin-thread-id')
  // Agent runtime 已为每条 CLI 请求注入此可信 header。浏览器页创建必须携带
  // 该 runId，才能在 webview 容器模式进入后台可交互的 keepalive 档位；不能
  // 让 body 覆盖它，避免请求体伪造归属到另一个 Agent run。
  const runId = readHeaderString(req, 'x-tabtin-agent-run-id')

  return {
    ...rest,
    ...(cleanContext !== undefined ? { context: cleanContext } : {}),
    ...(threadId ? { _thread_id: threadId } : {}),
    ...(runId ? { runId } : {}),
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url || '/'
  const method = (req.method || 'GET').toUpperCase()

  if (validateCSRFHeaders(req, res)) return

  // Health check — no auth required (only expose non-sensitive fields)
  if (url === '/health') {
    sendJSON(res, 200, okResponse({ status: 'ok', version: app.getVersion() }))
    return
  }

  // Dev-only token endpoint — no auth required
  if (url === '/dev/token') {
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
      sendJSON(res, 200, okResponse({ token: serverInfo?.token, sock: serverInfo?.socketPath }))
    } else {
      sendJSON(res, 404, errResponse('UNKNOWN_ROUTE', `Unknown route: ${url}`))
    }
    return
  }

  if (validateTokenAuth(req, res, serverInfo?.token ?? null, [
    '确保在 TabTin 内置终端中运行命令',
    '运行 tabtin doctor 进行环境诊断',
  ])) return

  try {
    // /surfaces endpoint（Wave 4）：暴露 registry 清单供 Go CLI / Agent 发现新能力
    if (url === '/surfaces') {
      const surfacesHandler = createSurfacesEndpoint()
      await surfacesHandler(req, res)
      return
    }

    // PlatformSurface 路由分发（Wave 3）：在手写路由之前查找 registry，
    // 命中则走 surface HTTP adapter（内部自行 parseBody），不再落入下方手写路由。
    const matchedSurface = getSurfaceByHttpPath(url)
    if (matchedSurface) {
      const surfaceHandler = createSurfaceHttpHandler(matchedSurface)
      await surfaceHandler(req, res)
      return
    }

    // Always parse body for routes that may pass params via body even on GET requests
    const body = (method !== 'GET' || url.startsWith('/space/') || url.startsWith('/table/') || url.startsWith('/slide/') || url.startsWith('/image/') || url.startsWith('/media/') || url.startsWith('/video/') || url.startsWith('/audio/') || url.startsWith('/speech/') || url.startsWith('/capabilities/') || url.startsWith('/agent/') || url.startsWith('/code/') || url.startsWith('/drive/') || url.startsWith('/desktop/') || url.startsWith('/terminal/') || url.startsWith('/device/') || url.startsWith('/extensions/') || url === '/fetch' || url.startsWith('/browser/') || url.startsWith('/reach/') || url.startsWith('/site/') || url.startsWith('/skills/') || url.startsWith('/mcp/') || url.startsWith('/plugin/') || url.startsWith('/oss/')) ? await parseBody(req) : undefined

    if (url.startsWith('/space/')) {
      await handleSpaceRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/table/')) {
      await runWithAgentRequestContext(
        pickAgentContextHeaders(req),
        () => handleTableRoute(url, method, body, res, sendJSON),
      )
      return
    }

    if (url === '/fetch') {
      await handleFetchRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/browser/')) {
      const browserBody = enrichBrowserBodyWithAgentThread(body, req)
      const dispatchBrowserRoute = async (browserSendJSON: typeof sendJSON) => {
        const policy = await evaluateElectronBrowserCLIPolicy(url, browserBody)
        if (policy.action === 'deny') {
          browserSendJSON(res, policy.status, errorResponse(policy.code as any, policy.message, {
            detail: policy.detail,
          }))
          return
        }
        await runWithBrowserPolicyPreapproval(policy.preapprovedActionIds, () =>
          handleBrowserRoute(url, method, browserBody, res, browserSendJSON)
        )
      }
      if (url === '/browser/act') {
        await runBrowserRequestWithDeadline(url, res, dispatchBrowserRoute)
      } else if (url === '/browser/collect/table' || url.startsWith('/browser/collect/table?')) {
        await runWithAgentRequestContext(
          pickAgentContextHeaders(req),
          () => dispatchBrowserRoute(sendJSON),
        )
      } else {
        await dispatchBrowserRoute(sendJSON)
      }
      return
    }

    if (url.startsWith('/reach/')) {
      const reachBody = enrichBrowserBodyWithAgentThread(body, req)
      await handleReachRoute(url, method, reachBody, res, sendJSON)
      return
    }

    if (url.startsWith('/slide/')) {
      await handleSlideRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/image/')) {
      await handleMediaRoute(url.replace(/^\/image/, '/media'), method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/media/')) {
      await handleMediaRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/video/')) {
      await handleVideoRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/audio/')) {
      await handleSpeechRoute(url.replace(/^\/audio/, '/speech'), method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/speech/')) {
      await handleSpeechRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/oss/')) {
      await handleOSSRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/drive/')) {
      await handleDriveRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/code/')) {
      // RP-018: rate limit grep-heavy operations
      if (url === '/code/grep' && !codeGrepRateLimiter.tryAcquire()) {
        sendJSON(res, 429, errorResponse('RATE_LIMIT_EXCEEDED', 'Too many grep requests. Max 20 per minute.'))
        return
      }
      await handleCodeRoute(url, method, enrichCodeBodyWithAgentContext(body, req), res, sendJSON)
      return
    }

    if (url.startsWith('/desktop/')) {
      const desktopBody = enrichBrowserBodyWithAgentThread(body, req)
      const threadId = extractAgentThreadId(req)
      if (threadId) {
        await runWithHumanInteractionContext(
          { threadId, interactionMode: 'interactive' },
          () => handleDesktopRoute(url, method, desktopBody, res, sendJSON),
        )
      } else {
        await handleDesktopRoute(url, method, desktopBody, res, sendJSON)
      }
      return
    }

    if (url.startsWith('/terminal/')) {
      const terminalBody = enrichBrowserBodyWithAgentThread(body, req)
      const terminalRouteBody = terminalBody && typeof terminalBody === 'object' && !Array.isArray(terminalBody)
        ? terminalBody as Record<string, unknown>
        : undefined
      const threadId = extractAgentThreadId(req)
      if (threadId) {
        await runWithHumanInteractionContext(
          { threadId, interactionMode: 'interactive' },
          () => handleTerminalRoute(url, method, terminalRouteBody, res, sendJSON),
        )
      } else {
        await handleTerminalRoute(url, method, terminalRouteBody, res, sendJSON)
      }
      return
    }

    if (url.startsWith('/device/')) {
      await handleDeviceRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/capabilities/')) {
      await handleCapabilitiesRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/extensions/')) {
      await handleExtensionsRoute(url, method, body, res, sendJSON, {
        marketplaceCommands: getMarketplaceCommands(),
      })
      return
    }

    if (url.startsWith('/site/')) {
      await handleTabsiteRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/skills/')) {
      await handleSkillsRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/mcp/')) {
      await handleMcpRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/plugin/')) {
      await handlePluginRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/agent/')) {
      await handleAgentRoute(url, method, body, res, sendJSON)
      return
    }

    if (url === '/search' || url.startsWith('/search?')) {
      await handleSearchRoute(url, method, body, res, sendJSON)
      return
    }

    if (url.startsWith('/api/')) {
      const result = await djangoRequest(method, url, body, {
        logTag: '[CLI Proxy]',
        extraHeaders: pickAgentContextHeaders(req),
      })
      sendDjangoResult(res, sendJSON, result)
      return
    }

    sendJSON(res, 404, errResponse('UNKNOWN_ROUTE', `Unknown route: ${url}`))
  } catch (err: any) {
    cliLog.error(`Request error (${method} ${url}):`, err)
    if (err instanceof Error) {
      if (err.message === 'Invalid JSON body') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '请求体必须是合法 JSON'))
        return
      }
      if (err.message === 'Body too large') {
        sendJSON(res, 413, errorResponse('VALIDATION_ERROR', `请求体超过 ${MAX_BODY_SIZE / 1024 / 1024} MB 限制`))
        return
      }
      if (err.message === 'Body read timeout') {
        sendJSON(res, 408, errorResponse('VALIDATION_ERROR', '请求体读取超时'))
        return
      }
    }
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal server error'))
  }
}

export function startCLIServer(config?: CLIServerConfig): CLIServerInfo {
  if (serverInstance) {
    cliLog.warn('Server 已在运行，复用现有实例')
    return serverInfo!
  }

  // Wave 4b：把宿主特有能力注入 @tabtin/cli-routes 共享路由模块。
  // djangoRequest 走 Electron TokenManager（JWT 自动刷新），actionExecutor
  // 走 FrontendActionBridge（IPC 到渲染进程），getSpaceId / workspaceRoot 走
  // ./cli-context（state owner，避免和 routes 形成循环）。
  configureCLIRoutes({
    djangoRequest,
    getSpaceId: () => getCLISpaceId(),
    getActionExecutor: () => getCLIActionExecutor(),
    workspaceRootForCode: (context) => {
      if (!context) return getCLIOrganizationRoot()
      return getCLICodeWorktreeController()?.resolveRoot?.(context) ?? null
    },
    getCodeWorktreeController: () => getCLICodeWorktreeController(),
  })

  // PlatformSurface 运行时注入（Wave 3）：与 configureCLIRoutes 同款模式，
  // 把 Django 代理和 Space 上下文注入给所有 surface handler 使用。
  configureSurfaceRuntime({
    djangoRequest,
    spaceId: getCLISpaceId(),
  })

  const instancePolicy = resolveCLIInstancePolicy({
    isDev: isDev(),
    instanceId: resolveDevInstanceId(),
  })
  const generation = ++serverGeneration
  const publishesGlobalDiscovery = instancePolicy.publishGlobalDiscovery
  let resolveReady!: (info: CLIServerInfo) => void
  serverReadyPromise = new Promise<CLIServerInfo>((resolve, reject) => {
    resolveReady = resolve
    rejectServerReady = reject
  })
  void serverReadyPromise.catch(() => {})
  cliLog.info('Starting CLI Server', {
    socketName: instancePolicy.socketName,
    publishesGlobalDiscovery,
    customSocketPath: config?.socketPath ?? null,
    pid: process.pid,
    platform: process.platform,
  })
  const { server, info } = createCLIHttpServer(handleRequest, {
    socketPath: config?.socketPath,
    socketName: instancePolicy.socketName,
    onError: (err) => {
      cliLog.error('Server error:', err)
      if (generation !== serverGeneration || serverInstance?.listening) return
      serverInstance = null
      serverInfo = null
      serverReadyPromise = null
      activeServerPublishesGlobalDiscovery = false
      rejectServerReady?.(err)
      rejectServerReady = null
    },
    onListening: (socketPath) => {
      cliLog.info(`Listening on ${socketPath}`)
      if (generation !== serverGeneration) {
        cliLog.warn('忽略已过期 CLI Server 的 listening 回调', {
          generation,
          activeGeneration: serverGeneration,
          socketPath,
        })
        return
      }
      if (!publishesGlobalDiscovery) {
        cliLog.info('隔离开发实例不发布全局 CLI discovery', {
          instanceId: resolveDevInstanceId(),
          socketPath,
        })
        serverReadyPromise = null
        rejectServerReady = null
        resolveReady(info)
        return
      }
      const discovery = writeDiscoveryFileDetailed('server.json', info, { source: 'electron' })
      if (discovery.ok) {
        cliLog.info('Server discovery written', {
          file: 'server.json',
          path: discovery.filePath,
          socketPath,
          pid: process.pid,
          source: 'electron',
        })
      } else {
        cliLog.warn('写 discovery 文件失败 — CLI 工具可能无法自动发现本 server', {
          file: 'server.json',
          path: discovery.filePath,
          socketPath,
          pid: process.pid,
          error: discovery.error,
        })
      }
      if (isDev()) {
        // dev 专用：开发者手动 curl / doctor 用；生产分支不进入，且 dev 下
        // 只记录 token 元信息，不把本地 transport token 写进日志。
        cliLog.info('DEV token available', { tokenPresent: Boolean(info.token), tokenLength: info.token.length })
        const devDiscovery = writeDiscoveryFileDetailed('dev-server.json', info, { source: 'electron-dev' })
        if (devDiscovery.ok) {
          cliLog.info('Server discovery written', {
            file: 'dev-server.json',
            path: devDiscovery.filePath,
            socketPath,
            pid: process.pid,
            source: 'electron-dev',
          })
        } else {
          cliLog.warn('写 dev discovery 文件失败 — CLI 工具可能无法自动发现本 dev server', {
            file: 'dev-server.json',
            path: devDiscovery.filePath,
            socketPath,
            pid: process.pid,
            error: devDiscovery.error,
          })
        }
      }
      serverReadyPromise = null
      rejectServerReady = null
      resolveReady(info)
    },
  })

  serverInstance = server
  serverInfo = info
  serverConfig = config
  activeServerPublishesGlobalDiscovery = publishesGlobalDiscovery

  // Ensure tabtin CLI binary is on PATH.
  // Go CLI (tabtin-cli-go) takes priority over Node CLI (node_modules/.bin)
  // for faster startup (~10ms vs ~200ms) and better structured output.
  const sep = process.platform === 'win32' ? ';' : ':'
  const goCliDirs = [
    // dev：app.getAppPath() 在仓库内，往上两级回到 repo 根
    join(app.getAppPath(), '..', '..', 'packages', 'tabtin-cli-go', 'dist'),
    join(app.getAppPath(), 'packages', 'tabtin-cli-go', 'dist'),
    // 打包产物：electron-builder 把二进制作为 extraResources 落到 Contents/Resources/
    // （= process.resourcesPath），to: "tabtin-cli-go/dist"。dev 形态下该目录不存在，
    // 由下面的 existsSync 过滤掉。
    ...(process.resourcesPath ? [join(process.resourcesPath, 'tabtin-cli-go', 'dist')] : []),
  ].filter((d) => existsSync(join(d, process.platform === 'win32' ? 'tabtin.exe' : 'tabtin')))

  // tabtin-filegen：随包分发的文件生成二进制（PyInstaller 自包含，客户端免装 Python）。
  // `tabtin file create` 代理与 Agent 通过 PATH 命中它。打包/路径形态与 Go CLI 一致。
  const fileGenName = process.platform === 'win32' ? 'tabtin-filegen.exe' : 'tabtin-filegen'
  const fileGenCliDirs = [
    join(app.getAppPath(), '..', '..', 'packages', 'tabtin-filegen-python', 'dist'),
    join(app.getAppPath(), 'packages', 'tabtin-filegen-python', 'dist'),
    ...(process.resourcesPath ? [join(process.resourcesPath, 'tabtin-filegen-python', 'dist')] : []),
  ].filter((d) => existsSync(join(d, fileGenName)))

  const nodeCliDirs = [
    join(app.getAppPath(), 'node_modules', '.bin'),
    join(app.getAppPath(), '..', '..', 'node_modules', '.bin'),
  ].filter((d) => existsSync(d))

  const allBinDirs = [...goCliDirs, ...fileGenCliDirs, ...nodeCliDirs]
  if (allBinDirs.length > 0) {
    process.env.PATH = allBinDirs.join(sep) + sep + (process.env.PATH || '')
  }

  if (goCliDirs.length > 0) {
    cliLog.info(`🚀 Go CLI found at: ${goCliDirs[0]}`)
  }

  // 自管 Python 运行时：解析/provision 后把解释器 bin 接入 PATH（真实实现由
  // @tabtin/python-runtime-host 经 agent-runtime re-export 提供）。
  // fire-and-forget（同 ensureCliProfileBootstrap 模式）：agent PTY 在用户操作时才 spawn，
  // 届时读 process.env 已就绪；dev 无种子无 OSS 时静默跳过，回落系统 python3。
  // 传 app logger → [python-runtime] 日志落 electron-log 文件（生产可查，不再依赖 stdout）。
  void wirePythonRuntimeHost({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    logger: {
      info: (m, ...a) => appLogger.info('python-runtime', m, ...a),
      warn: (m, ...a) => appLogger.warn('python-runtime', m, ...a),
    },
  })

  // 异步初始化 ~/.tabtin/config.json placeholder profile——
  // 解决 Go CLI fail-fast 闸门在首次启动 / 删 config.json 后误拦请求的问题。
  // 详见 cli-profile-bootstrap.ts 顶部注释 + ADR
  // support/about/2026-05-27-electron-cli-profile-bootstrap.md
  //
  // 异步 fire-and-forget：失败已被函数内部 catch 并 log，不阻塞 CLI Server 启动，
  // 最坏情况降级到修复前的现状（不影响其它路由）。
  ensureCliProfileBootstrap().catch((err) => {
    cliLog.warn('ensureCliProfileBootstrap 未预期抛错：', err)
  })

  return serverInfo
}

// CC-009: 改为 Promise<void>，等待 server.close() 完成并强制断开已有连接，
// 防止已有连接继续使用已置 null 的 serverInfo 导致 401 错误（参考 Daemon 实现）
export function stopCLIServer(): Promise<void> {
  if (!serverInstance) return Promise.resolve()

  shutdownVideoTasks()

  const instance = serverInstance
  const savedSocketPath = serverInfo?.socketPath ?? null
  const stoppedGeneration = serverGeneration
  const stoppedServerPublishedGlobalDiscovery = activeServerPublishesGlobalDiscovery
  const pendingReadyRejection = rejectServerReady

  // 先清理状态：新请求将立即收到 401（serverInfo=null 触发 auth check 失败）
  serverInstance = null
  serverInfo = null
  serverReadyPromise = null
  rejectServerReady = null
  activeServerPublishesGlobalDiscovery = false
  pendingReadyRejection?.(new Error('CLI Server 在完成监听前已停止'))

  return new Promise<void>((resolve) => {
    const cleanupFiles = () => {
      if (stoppedGeneration !== serverGeneration) {
        const activeSocketPath = serverInfo?.socketPath ?? null
        if (savedSocketPath && savedSocketPath !== activeSocketPath) {
          cleanupSocketFile(savedSocketPath)
        }
        cliLog.info('跳过已过期 CLI Server 的文件清理', {
          stoppedGeneration,
          activeGeneration: serverGeneration,
        })
        return
      }
      cleanupSocketFile(savedSocketPath ?? '')
      if (stoppedServerPublishedGlobalDiscovery) {
        cleanupDiscoveryFile('server.json')
        cleanupDiscoveryFile('dev-server.json')
      }
    }

    const timer = setTimeout(() => {
      cliLog.warn('⚠️ Server close 5s 超时，强制关闭')
      instance.close()
      cleanupFiles()
      resolve()
    }, 5000)

    if (typeof (instance as any).closeAllConnections === 'function') {
      ;(instance as any).closeAllConnections()
    }

    instance.close((err) => {
      clearTimeout(timer)
      if (err) cliLog.warn(`Server close error: ${err.message}`)
      else cliLog.info('⏹️ Server stopped')
      cleanupFiles()
      resolve()
    })
  })
}

export function getCLIServerInfo(): CLIServerInfo | null {
  if (!serverInstance?.listening || !serverInfo) return null
  if (process.platform !== 'win32' && !existsSync(serverInfo.socketPath)) return null
  return serverInfo
}

export async function ensureCLIServerReady(): Promise<CLIServerInfo> {
  if (serverReadyPromise) return serverReadyPromise

  const readyInfo = getCLIServerInfo()
  if (readyInfo) return readyInfo

  const config = serverConfig
  if (serverInstance) {
    await stopCLIServer()
  }

  startCLIServer(config)
  if (!serverReadyPromise) {
    const startedInfo = getCLIServerInfo()
    if (startedInfo) return startedInfo
    throw new Error('CLI Server 未进入监听状态')
  }
  return serverReadyPromise
}

/**
 * Current Space + associated Crawlspace context.
 * Updated when the user navigates to a different Space.
 *
 * State + low-level setters/getters live in `./cli-context`. This wrapper
 * stays here so the public API (`setCLISpaceContext` with optional
 * crawlspace / organization args) is unchanged for callers like
 * `ipc-registry.ts`, and so the surface runtime re-config + log line stay
 * co-located with the rest of the server bootstrap.
 *
 * Wave 3 收尾：原先的 `cliContextEmitter` + `waitForOrganization` / `waitForSpaceContext`
 * 在 Wave 2 把 ElectronAgentService 对它们的引用移除后已经成为死代码
 * （仓库 grep 无其他消费方），一并删除以降低认知负担。
 */

// Space 桌面相关缓存（Wave 2 / Wave 2.1 · 规范 § 6.4 / § 6.5）。
// 实现抽到 `./cli-space-desktop-cache` 纯模块（无 electron 依赖），
// 方便在非 Electron 的 vitest 宿主里直接单测；本文件仅 re-export 以保持
// 对外接口不变。

type SpaceContextListener = (payload: {
  spaceId: string | null
  organizationId: string | null
}) => void

const spaceContextListeners = new Set<SpaceContextListener>()

/** Host 等模块订阅 Space/组织上下文就绪（如会话代码根 sidecar 补 restore）。 */
export function onCLISpaceContextChanged(listener: SpaceContextListener): () => void {
  spaceContextListeners.add(listener)
  return () => {
    spaceContextListeners.delete(listener)
  }
}

export function setCLISpaceContext(
  spaceId: string | null,
  crawlspaceId?: string | null,
  organizationId?: string | null,
  organizationRoot?: string | null,
): void {
  setCLISpaceContextState(spaceId, crawlspaceId, organizationId, organizationRoot)

  // PlatformSurface 运行时跟随 Space 切换更新（configureSurfaceRuntime 多次调用合法）
  configureSurfaceRuntime({
    djangoRequest,
    spaceId: getCLISpaceId(),
  })

  // Space 上下文切换（IPC space:set-active 落到 CLI 全局态）——进 main.log 便于诊断
  cliLog.info('Space context updated:', { spaceId, crawlspaceId, organizationId })

  for (const listener of spaceContextListeners) {
    try {
      listener({
        spaceId: getCLISpaceId(),
        organizationId: getCLIOrganizationId(),
      })
    } catch (err) {
      cliLog.warn('space context listener failed:', err)
    }
  }
}

export {
  // PD-11（W6 M3）：authorization_preset 缓存已删除（详见 cli-space-desktop-cache.ts）。
  setCurrentSpaceDevicePermissions,
  getCurrentSpaceDevicePermissions,
} from './cli-space-desktop-cache'
