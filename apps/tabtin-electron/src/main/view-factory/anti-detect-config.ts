/**
 * 反检测配置模块
 *
 * 职责：
 * - 代理设置（anti-detect / 传统方式）
 * - User-Agent 清洗与重写
 * - 指纹伪装脚本注入
 *
 * 所有方法均为纯函数或接收显式依赖，不直接引用 ViewFactory 内部状态。
 */

import type { WebContents } from 'electron'
import type { ViewFactoryConfig } from './types'
import { buildSystemUserAgent } from '../utils/system-ua'

export type FullConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

export interface AntiDetectContext {
  log: (...args: any[]) => void
  sessionsWithUARewrite: WeakSet<Electron.Session>
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------

export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s+tabtin-electron\/[\d.]+/gi, '')
    .replace(/\s+Electron\/[\d.]+/gi, '')
    .trim()
}

/**
 * 标记 session 已完成 UA 配置。
 *
 * 不在此处注册 `onBeforeSendHeaders` —— 请求头级别的 UA 注入统一由
 * `resource-interception.ts` 的 handler 处理，避免 Electron 覆盖语义
 * 导致多次注册时后者覆盖前者。
 */
export function ensureSessionUARewrite(
  session: Electron.Session,
  cleanUA: string,
  ctx: AntiDetectContext
): void {
  if (!session || !cleanUA) return
  if (ctx.sessionsWithUARewrite.has(session)) return

  ctx.sessionsWithUARewrite.add(session)
  const partition = (session as any).partition || 'default'
  ctx.log('[ViewFactory] ✅ Session UA Rewrite 已标记 (partition:', partition, '), 请求头注入由 resource-interception 统一处理')
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

export function buildProxyRule(config: NonNullable<ViewFactoryConfig['proxy']>): string {
  try {
    const url = new URL(config.server)
    if (config.username) url.username = config.username
    if (config.password) url.password = config.password
    return url.toString()
  } catch {
    return config.server
  }
}

export async function applyProxyFromAntiDetect(
  webContents: WebContents,
  proxyConfig: any,
  ctx: Pick<AntiDetectContext, 'log'>
): Promise<void> {
  try {
    const protocol: string = proxyConfig.protocol || 'http'

    if (protocol === 'socks4' || protocol === 'socks5') {
      ctx.log(
        `[ViewFactory] ⚠️ SOCKS 代理 (${protocol}) 在 Electron session.setProxy() 中不受支持，` +
        '代理配置将被跳过。请使用 HTTP(S) 代理。'
      )
      return
    }

    const electronProxy: string[] = []

    if (proxyConfig.server) {
      const serverUrl = String(proxyConfig.server)
      if (serverUrl.startsWith('socks4://') || serverUrl.startsWith('socks5://')) {
        ctx.log(
          `[ViewFactory] ⚠️ SOCKS 代理 (${serverUrl}) 在 Electron session.setProxy() 中不受支持，` +
          '代理配置将被跳过。请使用 HTTP(S) 代理。'
        )
        return
      }
      electronProxy.push(serverUrl)
    } else if (proxyConfig.host && proxyConfig.port) {
      electronProxy.push(`${protocol}://${proxyConfig.host}:${proxyConfig.port}`)
    }

    let proxyRules = electronProxy.join(';')

    if (proxyConfig.username) {
      const url = new URL(electronProxy[0])
      url.username = proxyConfig.username
      if (proxyConfig.password) url.password = proxyConfig.password
      proxyRules = url.toString()
    }

    await webContents.session.setProxy({
      proxyRules,
      proxyBypassRules: proxyConfig.bypass?.join(';')
    })

    ctx.log('[ViewFactory] ✅ 代理设置完成')
  } catch (err) {
    ctx.log('[ViewFactory] ⚠️ 设置代理失败:', err)
  }
}

export async function applyProxyFromTraditional(
  webContents: WebContents,
  proxyConfig: NonNullable<ViewFactoryConfig['proxy']>,
  ctx: Pick<AntiDetectContext, 'log'>
): Promise<void> {
  try {
    const server = proxyConfig.server || ''
    if (server.startsWith('socks4://') || server.startsWith('socks5://')) {
      ctx.log(
        `[ViewFactory] ⚠️ SOCKS 代理 (${server}) 在 Electron session.setProxy() 中不受支持，` +
        '代理配置将被跳过（传统方式）。请使用 HTTP(S) 代理。'
      )
      return
    }

    const proxyRules = buildProxyRule(proxyConfig)
    const proxyBypassRules = proxyConfig.bypass?.join(';')

    await webContents.session.setProxy({
      proxyRules,
      proxyBypassRules
    })

    ctx.log('[ViewFactory] ✅ 代理设置完成（传统方式）')
  } catch (err) {
    ctx.log('[ViewFactory] ⚠️ 设置代理失败:', err)
  }
}

// ---------------------------------------------------------------------------
// 传统配置回退
// ---------------------------------------------------------------------------

export async function applyTraditionalConfig(
  webContents: WebContents,
  config: FullConfig,
  ctx: Pick<AntiDetectContext, 'log'>
): Promise<void> {
  ctx.log('[ViewFactory] 🔄 使用传统配置方式...')

  if (config.userAgent) {
    ctx.log('[ViewFactory] 🎭 设置 User-Agent（直接配置）:', config.userAgent.substring(0, 50) + '...')
    webContents.setUserAgent(config.userAgent)
  } else {
    const systemUA = buildSystemUserAgent()
    ctx.log('[ViewFactory] 🎭 设置 User-Agent（系统默认）:', systemUA.substring(0, 50) + '...')
    webContents.setUserAgent(systemUA)
  }

  if (config.proxy?.server) {
    ctx.log('[ViewFactory] 🌐 设置代理（直接配置）:', config.proxy.server)
    await applyProxyFromTraditional(webContents, config.proxy, ctx)
  }
}

// ---------------------------------------------------------------------------
// UA 覆盖注入
// ---------------------------------------------------------------------------

export async function setupUAOverrideInjection(
  webContents: WebContents,
  cleanUA: string | undefined,
  ctx: Pick<AntiDetectContext, 'log'>
): Promise<void> {
  try {
    if (!cleanUA) {
      ctx.log('[ViewFactory] ⚠️  无 cleanUA，跳过 UA 覆盖注入')
      return
    }

    const uaOverrideScript = `
(function() {
  'use strict';
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => ${JSON.stringify(cleanUA)},
      configurable: false
    });
  } catch (e) {}
})();
`

    const injectScript = async () => {
      try {
        await webContents.executeJavaScript(uaOverrideScript, true)
      } catch (err) {
        ctx.log('[ViewFactory] ⚠️  UA 覆盖脚本注入失败:', err)
      }
    }

    webContents.on('will-navigate', async (_event, url) => {
      ctx.log('[ViewFactory] 🎨 will-navigate 触发，注入 UA 覆盖:', url.substring(0, 50))
      injectScript().catch(err => {
        ctx.log('[ViewFactory] ⚠️  will-navigate 注入失败:', err)
      })
    })

    const currentURL = webContents.getURL()
    if (currentURL && currentURL !== 'about:blank') {
      await injectScript()
    }

    ctx.log('[ViewFactory] ✅ UA 覆盖注入已配置')
  } catch (error) {
    ctx.log('[ViewFactory] ⚠️  指纹伪装设置失败:', error)
  }
}

// ---------------------------------------------------------------------------
// 日志脱敏
// ---------------------------------------------------------------------------

export function tagProxy(proxyConfig: any): string {
  if (!proxyConfig) return 'none'
  const server = proxyConfig.server || proxyConfig.host || 'unknown'
  const hasAuth = !!(proxyConfig.username || proxyConfig.password)
  return `${server}${hasAuth ? ' (auth)' : ''}`
}

export function tagUserAgent(ua: string): string {
  if (!ua) return 'empty'
  const match = ua.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)
  return match ? match[0] : ua.substring(0, 30) + '...'
}
