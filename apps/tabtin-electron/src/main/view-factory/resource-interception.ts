/**
 * 资源拦截模块
 *
 * 职责：
 * - 阻止广告/跟踪脚本（提升性能）
 * - 设置通用反防盗链请求头（解决图片加载失败）
 * - 自动注入 Client Hints 请求头
 */

import { webContents as electronWebContents, type Session, type WebContents } from 'electron'
import { getGreaseBrand } from '@tabtin/anti-detect/client-hints'
import { isPrivateHost } from '@tabtin/browser-core/url-policy'
import { createLogger } from '../logger'

const log = createLogger('ViewFactory')

export interface ResourceInterceptionContext {
  clientHintsService: {
    generateHeaders: (ua: string, options: any) => Record<string, string>
  }
  systemInfo: {
    darwinVersion?: string
    arch: string
  }
  log: (...args: any[]) => void
  _clientHintsLogged?: boolean
}

/**
 * 广告/跟踪域名黑名单。
 * 匹配规则：精确域名 或 以 `.domain` 结尾（子域名安全匹配）。
 * 不再使用 url.includes() 子串匹配，避免误伤合法域名。
 */
const BLOCKED_DOMAINS = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'cnzz.com',
  'umeng.com',
]

const BLOCKED_HOSTNAME_PREFIXES = [
  'ads.',
  'adservice.',
  'analytics.',
  'tracking.',
  'tracker.',
  'stat.',
]

const BLOCKED_PATH_PATTERNS = [
  'facebook.com/tr',
  'baidu.com/hm.js',
]

type ResourceInterceptionState = {
  targetUrl: string
  mainHostname: string
  userAgent?: string
  blockedCount: number
}

const sessionInterceptionRegistered = new WeakSet<Session>()
const sessionWebContentsStates = new WeakMap<Session, Map<number, ResourceInterceptionState>>()
const webContentsInterceptionState = new Map<number, ResourceInterceptionState>()
const cleanupBoundWebContentsIds = new Set<number>()

export function cleanupResourceInterceptionState(session: Session, webContentsId: number): void {
  cleanupBoundWebContentsIds.delete(webContentsId)
  webContentsInterceptionState.delete(webContentsId)
  const currentStates = sessionWebContentsStates.get(session)
  currentStates?.delete(webContentsId)
  if (currentStates && currentStates.size === 0) {
    sessionWebContentsStates.delete(session)
  }
}

function resolveInterceptionState(
  session: Session,
  details: { webContentsId?: number | null }
): ResourceInterceptionState | undefined {
  const scopedStates = sessionWebContentsStates.get(session)
  const webContentsId = typeof details.webContentsId === 'number' ? details.webContentsId : null
  if (webContentsId !== null) {
    const scoped = scopedStates?.get(webContentsId) ?? webContentsInterceptionState.get(webContentsId)
    if (scoped) return scoped
  }
  if (scopedStates?.size === 1) {
    return Array.from(scopedStates.values())[0]
  }
  return undefined
}

function resolveCurrentTargetUrl(
  state: ResourceInterceptionState,
  details: { webContentsId?: number | null }
): string {
  const webContentsId = typeof details.webContentsId === 'number' ? details.webContentsId : null
  if (webContentsId !== null) {
    try {
      const currentUrl = electronWebContents.fromId(webContentsId)?.getURL()
      if (currentUrl && (currentUrl.startsWith('http://') || currentUrl.startsWith('https://'))) {
        return currentUrl
      }
    } catch {
      // 忽略运行时查询失败，回退到最近一次记录的目标地址
    }
  }
  return state.targetUrl
}

function isBlockedRequest(requestUrl: string): boolean {
  let hostname: string
  let fullUrl: string
  try {
    const parsed = new URL(requestUrl)
    hostname = parsed.hostname
    fullUrl = parsed.host + parsed.pathname
  } catch {
    return false
  }

  for (const domain of BLOCKED_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true
  }
  for (const prefix of BLOCKED_HOSTNAME_PREFIXES) {
    if (hostname.startsWith(prefix)) return true
  }
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (fullUrl.includes(pattern)) return true
  }
  return false
}

export function setupResourceInterception(
  webContents: WebContents,
  targetUrl: string,
  ctx: ResourceInterceptionContext
): void {
  try {
    if (!targetUrl || !(targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      ctx.log('[ViewFactory] 资源拦截跳过（非 http/https）:', targetUrl)
      return
    }

    const session = webContents.session
    const webContentsId = webContents.id
    const existingState = webContentsInterceptionState.get(webContentsId)
    const nextState: ResourceInterceptionState = {
      targetUrl,
      mainHostname: new URL(targetUrl).hostname,
      userAgent: webContents.getUserAgent() || existingState?.userAgent,
      blockedCount: existingState?.blockedCount ?? 0,
    }

    webContentsInterceptionState.set(webContentsId, nextState)
    const scopedStates = sessionWebContentsStates.get(session) ?? new Map<number, ResourceInterceptionState>()
    scopedStates.set(webContentsId, nextState)
    sessionWebContentsStates.set(session, scopedStates)

    if (!cleanupBoundWebContentsIds.has(webContentsId)) {
      cleanupBoundWebContentsIds.add(webContentsId)
      webContents.once('destroyed', () => {
        // 只在尚未被显式清理时执行，保证两条路径幂等且顺序无关
        if (cleanupBoundWebContentsIds.has(webContentsId)) {
          cleanupResourceInterceptionState(session, webContentsId)
        }
      })
    }

    if (sessionInterceptionRegistered.has(session)) {
      ctx.log('[ViewFactory] ✅ 资源拦截目标已更新:', nextState.mainHostname)
      return
    }

    sessionInterceptionRegistered.add(session)

    session.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        const state = resolveInterceptionState(session, details)
        if (!state) {
          callback({ cancel: false })
          return
        }

        const requestUrl = details.url

        const currentTargetUrl = resolveCurrentTargetUrl(state, details)
        const currentMainHostname = (() => {
          try {
            return new URL(currentTargetUrl).hostname
          } catch {
            return state.mainHostname
          }
        })()

        // SSRF 防护：阻止 Agent 自动化 session 访问非当前目标的私有/内网地址。
        // Personal Plugin 本地服务（如 Cowart 127.0.0.1）是用户批准后主动打开的
        // 当前页面目标；同 host 请求必须放行，否则主文档会被 ERR_BLOCKED_BY_CLIENT 拦掉。
        try {
          const reqUrl = new URL(requestUrl)
          if (isPrivateHost(reqUrl.hostname) && reqUrl.hostname !== currentMainHostname) {
            ctx.log('[ViewFactory] 🛡️ SSRF 拦截: 阻止私有地址请求:', requestUrl.substring(0, 100))
            callback({ cancel: true })
            return
          }
        } catch {
          // 非标准 URL（如 data: / blob:），跳过 SSRF 检查
        }

        let shouldBlock = isBlockedRequest(requestUrl)

        if (shouldBlock) {
          try {
            const reqHostname = new URL(requestUrl).hostname
            if (reqHostname === currentMainHostname || reqHostname.endsWith(`.${currentMainHostname}`)) {
              shouldBlock = false
            }
          } catch {
            // URL 解析失败，保持之前的判断
          }
        }

        if (shouldBlock) {
          state.blockedCount++
          if (state.blockedCount <= 5) {
            ctx.log('[ViewFactory] 🚫 阻止请求:', requestUrl.substring(0, 80))
          }
          callback({ cancel: true })
        } else {
          callback({ cancel: false })
        }
      }
    )

    ctx.log('[ViewFactory] ✅ 资源拦截已启用:', nextState.mainHostname)

    session.webRequest.onBeforeSendHeaders(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        const state = resolveInterceptionState(session, details)
        if (!state) {
          callback({ requestHeaders: details.requestHeaders })
          return
        }

        const requestUrl = details.url
        const currentTargetUrl = resolveCurrentTargetUrl(state, details)
        const requestHeaders = { ...details.requestHeaders }
        const userAgent = state.userAgent

        if (userAgent) {
          requestHeaders['User-Agent'] = userAgent

          try {
            const clientHintsHeaders = ctx.clientHintsService.generateHeaders(userAgent, {
              includeExtended: true,
              includeFullVersion: false,
              enableGrease: true,
              systemOverrides: {
                platformVersion: ctx.systemInfo.darwinVersion,
                arch: ctx.systemInfo.arch,
              },
            })

            Object.assign(requestHeaders, clientHintsHeaders)

            if (process.env.NODE_ENV === 'development' && !ctx._clientHintsLogged) {
              log.debug('🛡️  Client Hints 已自动注入:', {
                'User-Agent': userAgent.substring(0, 80) + '...',
                ...clientHintsHeaders
              })
              ctx._clientHintsLogged = true
            }
          } catch (error) {
            log.warn('⚠️  Client Hints 生成失败，使用降级方案:', error)

            const chromeMatch = userAgent.match(/Chrome\/(\d+)/)
            const majorVersion = chromeMatch
              ? parseInt(chromeMatch[1], 10)
              : parseInt(process.versions.chrome ?? '132', 10)

            const grease = getGreaseBrand(majorVersion)
            requestHeaders['Sec-CH-UA'] =
              `${grease.brand};v="${grease.version}", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`
            requestHeaders['Sec-CH-UA-Mobile'] = /Mobile|Android|iPhone|iPad/i.test(userAgent) ? '?1' : '?0'

            let platform: string
            if (/Macintosh|Mac OS X/i.test(userAgent)) {
              platform = '"macOS"'
            } else if (/Android/i.test(userAgent)) {
              platform = '"Android"'
            } else if (/iPhone|iPad|iPod/i.test(userAgent)) {
              platform = '"iOS"'
            } else if (/CrOS/i.test(userAgent)) {
              platform = '"Chrome OS"'
            } else if (/Linux/i.test(userAgent)) {
              platform = '"Linux"'
            } else {
              platform = '"Windows"'
            }
            requestHeaders['Sec-CH-UA-Platform'] = platform
          }
        }

        const isImageOrMedia =
          details.resourceType === 'image' ||
          details.resourceType === 'media' ||
          /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mp3)(\?|$)/i.test(requestUrl)

        if (isImageOrMedia) {
          if (!requestHeaders['Referer'] && !requestHeaders['referer']) {
            requestHeaders['Referer'] = currentTargetUrl
          }
          if (!requestHeaders['Accept']) {
            requestHeaders['Accept'] = 'image/webp,image/apng,image/*,*/*;q=0.8'
          }
        }

        callback({ requestHeaders })
      }
    )

    ctx.log('[ViewFactory] ✅ 反防盗链请求头已启用')

    setTimeout(() => {
      const states = sessionWebContentsStates.get(session)
      const blockedCount = states
        ? Array.from(states.values()).reduce((sum, state) => sum + state.blockedCount, 0)
        : 0
      if (blockedCount > 0) {
        ctx.log(`[ViewFactory] 📊 资源拦截统计: 阻止 ${blockedCount} 个请求`)
      }
    }, 10000)

  } catch (error) {
    log.error('❌ 设置资源拦截失败:', error)
  }
}
