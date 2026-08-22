/**
 * TabSite dev server manager — spawns local dev servers for site preview.
 * Manages lifecycle per siteId: start, detect port, stop on cleanup.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'

interface DevServerEntry {
  process: ChildProcess
  port: number
  url: string
  siteId: string
  projectPath: string
}

const activeServers = new Map<string, DevServerEntry>()

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Failed to get port')))
      }
    })
    server.on('error', reject)
  })
}

function detectPackageManager(projectPath: string): 'pnpm' | 'npm' | 'yarn' {
  if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export interface StartDevServerResult {
  success: boolean
  url?: string
  port?: number
  error?: string
  already_running?: boolean
}

export async function startDevServer(
  siteId: string,
  projectPath: string,
): Promise<StartDevServerResult> {
  const existing = activeServers.get(siteId)
  if (existing) {
    return {
      success: true,
      url: existing.url,
      port: existing.port,
      already_running: true,
    }
  }

  if (!fs.existsSync(projectPath)) {
    return { success: false, error: `项目目录不存在: ${projectPath}` }
  }

  if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
    return { success: false, error: '目录中未找到 package.json' }
  }

  const port = await findFreePort()
  const pm = detectPackageManager(projectPath)
  const args = pm === 'pnpm'
    ? ['dev', '--port', String(port), '--host']
    : pm === 'yarn'
      ? ['dev', '--port', String(port), '--host']
      : ['run', 'dev', '--', '--port', String(port), '--host']

  const child = spawn(pm, args, {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), BROWSER: 'none' },
    shell: process.platform === 'win32',
  })

  const url = `http://localhost:${port}`
  const entry: DevServerEntry = { process: child, port, url, siteId, projectPath }
  activeServers.set(siteId, entry)

  // Wait for dev server to become ready (detect output or port open)
  const ready = await waitForReady(port, child, 30_000)
  if (!ready) {
    stopDevServer(siteId)
    return { success: false, error: 'Dev server 启动超时（30s），请检查项目配置' }
  }

  child.on('exit', () => {
    activeServers.delete(siteId)
  })

  return { success: true, url, port }
}

async function waitForReady(port: number, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    let resolved = false
    const done = (val: boolean) => {
      if (resolved) return
      resolved = true
      resolve(val)
    }

    // Listen for Vite's ready message in stdout
    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes('localhost') || text.includes('Local:') || text.includes('ready in')) {
        done(true)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('exit', () => done(false))

    // Also poll the port
    const interval = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval)
        done(false)
        return
      }
      try {
        await new Promise<void>((res, rej) => {
          const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
            sock.destroy()
            res()
          })
          sock.on('error', rej)
          sock.setTimeout(1000, () => { sock.destroy(); rej(new Error('timeout')) })
        })
        clearInterval(interval)
        done(true)
      } catch {
        // not ready yet
      }
    }, 1000)
  })
}

export function stopDevServer(siteId: string): boolean {
  const entry = activeServers.get(siteId)
  if (!entry) return false
  try {
    entry.process.kill('SIGTERM')
    setTimeout(() => {
      try { entry.process.kill('SIGKILL') } catch { /* already dead */ }
    }, 3000)
  } catch { /* already dead */ }
  activeServers.delete(siteId)
  return true
}

export function getDevServerStatus(siteId: string): { running: boolean; url?: string; port?: number } {
  const entry = activeServers.get(siteId)
  if (!entry) return { running: false }
  return { running: true, url: entry.url, port: entry.port }
}

export function stopAllDevServers(): void {
  for (const [siteId] of activeServers) {
    stopDevServer(siteId)
  }
}
