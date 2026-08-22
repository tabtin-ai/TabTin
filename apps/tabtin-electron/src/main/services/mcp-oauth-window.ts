import { app, shell } from 'electron'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createLogger } from '../logger'
import { getMainWindow } from '../window-manager'

export { createOAuthAuthorizeUrlParser } from './mcp-oauth-url'

const log = createLogger('McpOAuthWindow')

type PlatformOAuthWaiter = {
  finish: (result: PlatformOAuthTicketResult | Error) => void
  donePathIncludes: string
}

let platformOAuthWaiter: PlatformOAuthWaiter | null = null

/**
 * mcp-remote 会调用系统 `open` 跳出默认浏览器。
 * 探测用 stdio 子进程把本 shim 插到 PATH 最前，吞掉 http(s) URL；
 * TabTin 解析 stderr 中的授权 URL 后统一交给系统默认浏览器打开，避免重复唤起。
 */
export function ensureMcpOpenShimDir(): string {
  const dir = join(app.getPath('userData'), 'mcp-open-shim')
  mkdirSync(dir, { recursive: true })
  const shimPath = join(dir, 'open')
  const script = `#!/bin/sh
# TabTin: intercept mcp-remote URL opens; defer to real open otherwise.
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      exit 0
      ;;
  esac
done
if [ -x /usr/bin/open ]; then
  exec /usr/bin/open "$@"
fi
exit 0
`
  let existing = ''
  try {
    existing = readFileSync(shimPath, 'utf8')
  } catch {
    existing = ''
  }
  if (existing !== script) {
    writeFileSync(shimPath, script, { encoding: 'utf8', mode: 0o755 })
    try {
      chmodSync(shimPath, 0o755)
    } catch {
      // ignore
    }
  }
  return dir
}

/** 给 stdio 子进程用：优先走 open shim，避免跳出系统浏览器。 */
export function withMcpOpenShimPath(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const shimDir = ensureMcpOpenShimDir()
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') next[key] = value
  }
  next.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`
  return next
}

/** 连接器 OAuth 始终交给系统默认浏览器，复用用户已有登录态与代理设置。 */
export function openConnectorOAuthWindow(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    log.warn('ignore invalid oauth url')
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    log.warn('ignore non-http oauth url', parsed.protocol)
    return
  }

  const startedAt = Date.now()
  log.info('opening connector oauth in system browser', { host: parsed.hostname })
  void shell.openExternal(parsed.toString()).then(() => {
    log.info('system browser accepted connector oauth url', {
      host: parsed.hostname,
      durationMs: Date.now() - startedAt,
    })
  }).catch(error => {
    log.error('system browser open failed', { host: parsed.hostname, error })
  })
}

export function closeConnectorOAuthWindow(): void {
  // 系统浏览器窗口不归 TabTin 管理；授权任务的生命周期由调用方关闭。
}

/** 主动连接器 OAuth 成功后，把已运行的 TabTin 主窗口带回前台。 */
export function restoreConnectorOAuthClient(): void {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  app.focus({ steal: true })
  mainWindow.focus()
  log.info('connector oauth completed; restored client window')
}

export type PlatformOAuthTicketResult = {
  ticket: string
  login?: string
}

function extractPlatformOAuthTicket(
  rawUrl: string,
  donePathIncludes: string,
): PlatformOAuthTicketResult | null {
  const normalized = rawUrl.startsWith('tabtin://')
    ? rawUrl.replace(/^tabtin:\/\//, 'https://tabtin.local/')
    : rawUrl
  try {
    const parsed = new URL(normalized)
    const ticket = parsed.searchParams.get('ticket')
    if (!ticket || ticket.length < 16) return null
    const isDonePage =
      parsed.pathname.includes(donePathIncludes)
      || rawUrl.includes(donePathIncludes)
      || rawUrl.startsWith('tabtin://integrations/github/')
    if (!isDonePage) return null
    return {
      ticket,
      login: parsed.searchParams.get('login') || undefined,
    }
  } catch {
    return null
  }
}

/** 由统一 deep-link 入口调用；命中正在等待的平台代理 OAuth 时消费该链接。 */
export function consumePlatformOAuthDeepLink(rawUrl: string): boolean {
  const waiter = platformOAuthWaiter
  if (!waiter) return false
  const result = extractPlatformOAuthTicket(rawUrl, waiter.donePathIncludes)
  if (!result) return false
  log.info('received platform oauth callback', { hasLogin: Boolean(result.login) })
  waiter.finish(result)
  return true
}

/**
 * 使用系统浏览器打开平台代理 OAuth 页，等待 tabtin:// 深链接带回一次性 ticket。
 */
export function waitForPlatformOAuthTicket(input: {
  authorizeUrl: string
  donePathIncludes?: string
  timeoutMs?: number
}): Promise<PlatformOAuthTicketResult> {
  const doneNeedle = input.donePathIncludes ?? '/integrations/github/oauth/done'
  const timeoutMs = input.timeoutMs ?? 180_000

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: PlatformOAuthTicketResult | Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (platformOAuthWaiter?.finish === finish) platformOAuthWaiter = null
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    platformOAuthWaiter?.finish(new Error('已开始新的授权，请在新打开的页面中继续'))
    platformOAuthWaiter = { finish, donePathIncludes: doneNeedle }

    let parsed: URL
    try {
      parsed = new URL(input.authorizeUrl)
    } catch {
      finish(new Error('授权地址无效'))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      finish(new Error('授权地址协议不受支持'))
      return
    }

    const startedAt = Date.now()
    log.info('opening platform oauth in system browser', { host: parsed.hostname })
    void shell.openExternal(parsed.toString()).then(() => {
      log.info('system browser accepted platform oauth url', {
        host: parsed.hostname,
        durationMs: Date.now() - startedAt,
      })
    }).catch(error => {
      log.error('system browser open failed for platform oauth', {
        host: parsed.hostname,
        error,
      })
      finish(new Error('无法打开系统浏览器'))
    })

    timer = setTimeout(() => {
      finish(new Error('授权超时，请重试'))
    }, timeoutMs)
  })
}
