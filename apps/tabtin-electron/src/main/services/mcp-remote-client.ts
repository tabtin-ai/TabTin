import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('McpRemoteClient')

/** 与 mcp-remote getServerUrlHash(serverUrl) 对齐（无 authorizeResource / headers）。 */
export function mcpRemoteServerUrlHash(serverUrl: string): string {
  return createHash('md5').update(serverUrl).digest('hex')
}

function resolveMcpAuthRoot(): string {
  // 测试可设 HOME；mcp-remote 默认同样落在 ~/.mcp-auth
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  return join(home, '.mcp-auth')
}

function listMcpRemoteConfigDirs(): string[] {
  const root = resolveMcpAuthRoot()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('mcp-remote-'))
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

/**
 * mcp-remote 会复用 ~/.mcp-auth 里旧的动态注册客户端；
 * 若 client_name 不是 TabTin，授权页会显示「MCP CLI Proxy」等，和原型不符。
 * 发现不一致时删掉该 server 的 client_info / tokens，强制按货架 metadata 重新注册。
 */
export function ensureMcpRemoteClientName(serverUrl: string, expectedClientName: string): void {
  const hash = mcpRemoteServerUrlHash(serverUrl)
  for (const dir of listMcpRemoteConfigDirs()) {
    const clientInfoPath = join(dir, `${hash}_client_info.json`)
    if (!existsSync(clientInfoPath)) continue
    let clientName = ''
    try {
      const raw = JSON.parse(readFileSync(clientInfoPath, 'utf8')) as { client_name?: string }
      clientName = typeof raw.client_name === 'string' ? raw.client_name : ''
    } catch {
      clientName = ''
    }
    if (clientName === expectedClientName) continue

    log.info('resetting mcp-remote client registration for name mismatch', {
      dir,
      hash,
      clientName,
      expectedClientName,
    })
    for (const suffix of [
      'client_info.json',
      'tokens.json',
      'code_verifier.txt',
      'lock.json',
    ]) {
      const path = join(dir, `${hash}_${suffix}`)
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (error) {
        log.warn('failed to remove mcp-remote auth file', { path, error })
      }
    }
  }
}

/** 从 mcp-remote stdio args 抽出远端 URL。 */
export function extractMcpRemoteServerUrl(args: readonly string[] | undefined): string | null {
  if (!args?.length) return null
  const url = args.find(arg => /^https?:\/\//i.test(arg))
  return url ?? null
}
