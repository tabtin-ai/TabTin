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

/**
 * 与 mcp-remote `getConfigDir()` 对齐：
 * `MCP_REMOTE_CONFIG_DIR` 或 `os.homedir()/.mcp-auth`。
 * Windows 上 mcp-remote 走 `%USERPROFILE%\.mcp-auth`；若进程里 HOME / USERPROFILE
 * 不一致（Git Bash 起客户端），额外扫一遍，避免卸不掉令牌。
 */
export function resolveMcpAuthRoots(input?: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): string[] {
  const env = input?.env ?? process.env
  const platform = input?.platform ?? process.platform
  const homeDir = input?.homeDir ?? homedir()
  const configured = env.MCP_REMOTE_CONFIG_DIR?.trim()
  if (configured) return [configured]

  const roots = new Set<string>([join(homeDir, '.mcp-auth')])
  if (platform === 'win32') {
    if (env.USERPROFILE) roots.add(join(env.USERPROFILE, '.mcp-auth'))
    if (env.HOME) roots.add(join(env.HOME, '.mcp-auth'))
  }
  return [...roots]
}

function listMcpRemoteConfigDirs(): string[] {
  const dirs: string[] = []
  for (const root of resolveMcpAuthRoots()) {
    if (!existsSync(root)) continue
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('mcp-remote-')) {
          dirs.push(join(root, entry.name))
        }
      }
    } catch {
      // 某个根目录读失败不挡其它根
    }
  }
  return dirs
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
    removeMcpRemoteAuthFiles(dir, hash)
  }
}

function removeMcpRemoteAuthFiles(dir: string, hash: string): number {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(`${hash}_`)) continue
    const path = join(dir, name)
    if (unlinkAuthFile(path)) removed += 1
  }
  return removed
}

function unlinkAuthFile(path: string): boolean {
  // Windows 上 utility process 刚退出时文件句柄可能还没放，EBUSY/EPERM 重试几次。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      unlinkSync(path)
      return true
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      if ((code === 'EBUSY' || code === 'EPERM') && attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
        continue
      }
      log.warn('failed to remove mcp-remote auth file', { path, error })
      return false
    }
  }
  return false
}

/**
 * 卸载连接器时清掉 mcp-remote 缓存在 ~/.mcp-auth 的动态客户端与令牌。
 * 不删这些文件的话，同一 URL 再接入会直接复用旧授权，不再打开浏览器。
 */
export function clearMcpRemoteAuth(serverUrl: string): number {
  const hash = mcpRemoteServerUrlHash(serverUrl)
  let removed = 0
  for (const dir of listMcpRemoteConfigDirs()) {
    removed += removeMcpRemoteAuthFiles(dir, hash)
  }
  if (removed > 0) {
    log.info('cleared mcp-remote auth cache', { hash, removed })
  }
  return removed
}

/** 从 mcp-remote stdio args 抽出远端 URL。 */
export function extractMcpRemoteServerUrl(args: readonly string[] | undefined): string | null {
  if (!args?.length) return null
  const url = args.find(arg => /^https?:\/\//i.test(arg))
  return url ?? null
}
