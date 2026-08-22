/**
 * CLI Server lifecycle helpers.
 *
 * Shared server creation, socket path resolution, discovery file I/O.
 * Both Electron and Daemon use these to avoid duplicating ~100 lines
 * of boilerplate socket setup and teardown.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'

export interface CLIServerInfo {
  socketPath: string
  token: string
}

export interface DiscoveryWriteResult {
  ok: boolean
  filePath: string
  error?: string
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>

export interface CLIServerOptions {
  socketPath?: string
  socketName?: string
  discoveryFileName?: string
  onError?: (err: Error) => void
  onListening?: (socketPath: string) => void
}

const CONFIG_DIR = getHomeTabtinPath()

export function discoveryFilePath(fileName: string): string {
  return join(CONFIG_DIR, fileName)
}

function ensureConfigDir(): void {
  try { mkdirSync(CONFIG_DIR, { recursive: true }) } catch { /* ignore */ }
}

/**
 * Resolve the socket path for the CLI server.
 *
 * Windows uses named pipes; Unix uses ~/.tabtin/<socketName>.
 */
export function resolveSocketPath(socketName: string = 'cli.sock'): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tabtin-${socketName.replace('.sock', '')}-${process.pid}`
  }
  ensureConfigDir()
  return join(CONFIG_DIR, socketName)
}

/**
 * Write a discovery JSON file for CLI auto-detection.
 *
 * The file contains socket path, token, and PID so the `tabtin` CLI
 * can discover the running server. Permissions are restricted to 0o600.
 */
export function writeDiscoveryFile(
  fileName: string,
  info: CLIServerInfo,
  extra?: Record<string, unknown>,
): boolean {
  return writeDiscoveryFileDetailed(fileName, info, extra).ok
}

export function writeDiscoveryFileDetailed(
  fileName: string,
  info: CLIServerInfo,
  extra?: Record<string, unknown>,
): DiscoveryWriteResult {
  const filePath = discoveryFilePath(fileName)
  try {
    ensureConfigDir()
    const payload = JSON.stringify(
      {
        token: info.token,
        sock: info.socketPath,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )
    writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600 })
    if (process.platform !== 'win32') {
      chmodSync(filePath, 0o600)
    }
    return { ok: true, filePath }
  } catch (error) {
    return {
      ok: false,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Remove a stale socket file (Unix only).
 */
export function cleanupSocketFile(socketPath: string): void {
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    try { unlinkSync(socketPath) } catch (err) {
      console.warn(`[cli-server-core] Failed to cleanup socket file ${socketPath}:`, err)
    }
  }
}

/**
 * Remove a discovery JSON file, but only if it belongs to the current process.
 *
 * Prevents a race condition during Vite HMR / process restart: the old
 * process's cleanup handler must not delete a file already overwritten
 * by the new process (which has a different PID).
 */
export function cleanupDiscoveryFile(fileName: string): void {
  try {
    const filePath = join(CONFIG_DIR, fileName)
    if (!existsSync(filePath)) return
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    if (data.pid && data.pid !== process.pid) {
      return
    }
    unlinkSync(filePath)
  } catch (err) {
    console.warn(`[cli-server-core] Failed to cleanup discovery file ${fileName}:`, err)
  }
}

/**
 * Create and bind an HTTP server on a Unix socket / named pipe.
 *
 * Returns the server instance and generated auth token.
 * The caller is responsible for setting up request routing
 * (via the `handler` parameter) and stopping the server.
 */
export function createCLIHttpServer(
  handler: RouteHandler,
  options?: CLIServerOptions,
): { server: http.Server; info: CLIServerInfo } {
  const socketName = options?.socketName ?? 'cli.sock'
  const socketPath = options?.socketPath ?? resolveSocketPath(socketName)
  const token = randomBytes(32).toString('hex')

  cleanupSocketFile(socketPath)

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      options?.onError?.(err instanceof Error ? err : new Error(String(err)))
      if (!res.headersSent) {
        const body = JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
        res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
      }
    })
  })

  let oldUmask: number | undefined
  if (process.platform !== 'win32') {
    oldUmask = process.umask(0o077)
  }

  server.listen(socketPath, () => {
    if (oldUmask !== undefined) {
      process.umask(oldUmask)
    }
    if (process.platform !== 'win32') {
      try { chmodSync(socketPath, 0o600) } catch { /* ignore */ }
    }
    options?.onListening?.(socketPath)
  })

  server.on('error', (err) => {
    if (oldUmask !== undefined) {
      process.umask(oldUmask)
      oldUmask = undefined
    }
    options?.onError?.(err)
  })

  const info: CLIServerInfo = { socketPath, token }
  return { server, info }
}
