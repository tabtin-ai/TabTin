import { execSync } from 'node:child_process'

export const DEFAULT_DEV_CDP_PORT = 9222

/** dev 下 CDP 端口被占用时的候选 fallback（与 main-process-config 单测 9333 对齐）。 */
export const DEV_CDP_FALLBACK_PORTS = [9333, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230] as const

export function parseEnvCdpPort(): number | undefined {
  const raw = process.env.TABTIN_CDP_PORT ?? process.env.CDP_PORT
  if (!raw?.trim()) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/** 探测 TCP 端口是否已有进程在 LISTEN（dev 环境 macOS/Linux 用 lsof）。 */
export function isTcpPortListening(port: number): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return out.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(out)
    } catch {
      return false
    }
  }

  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface ResolveDevCdpPortResult {
  port: number
  requestedPort: number
  fallbackUsed: boolean
}

export function resolveDevCdpPortWithMeta(explicitPort?: number): ResolveDevCdpPortResult {
  const envPort = parseEnvCdpPort()
  const requestedPort = explicitPort ?? envPort ?? DEFAULT_DEV_CDP_PORT
  const candidates =
    requestedPort === DEFAULT_DEV_CDP_PORT
      ? [DEFAULT_DEV_CDP_PORT, ...DEV_CDP_FALLBACK_PORTS]
      : [requestedPort, ...DEV_CDP_FALLBACK_PORTS.filter((p) => p !== requestedPort)]

  for (const port of candidates) {
    if (!isTcpPortListening(port)) {
      return { port, requestedPort, fallbackUsed: port !== requestedPort }
    }
  }

  const last = candidates[candidates.length - 1]!
  return { port: last, requestedPort, fallbackUsed: last !== requestedPort }
}

export function resolveDevCdpPort(explicitPort?: number): number {
  return resolveDevCdpPortWithMeta(explicitPort).port
}
