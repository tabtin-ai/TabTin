import http from 'node:http'
import https from 'node:https'
import { API_BASE_URL } from '../config/api'
import { createLogger } from '../logger'

const log = createLogger('NetworkRecovery')

const DEFAULT_TIMEOUT_MS = 2_500
const DEFAULT_MAX_WAIT_MS = 18_000
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000]

export interface WaitForApiReachableOptions {
  baseUrl?: string
  timeoutMs?: number
  maxWaitMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  probe?: (url: URL, timeoutMs: number) => Promise<void>
}

export interface WaitForApiReachableResult {
  ok: boolean
  attempts: number
  elapsedMs: number
  lastError?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildHealthUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url
}

function requestHealth(url: URL, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https
    const req = transport.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        res.resume()
        const statusCode = res.statusCode ?? 0
        if (statusCode >= 200 && statusCode < 500) {
          resolve()
          return
        }
        reject(new Error(`health returned HTTP ${statusCode}`))
      },
    )

    req.on('timeout', () => {
      req.destroy(new Error(`health probe timeout after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    req.end()
  })
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function waitForApiReachable(
  options: WaitForApiReachableOptions = {},
): Promise<WaitForApiReachableResult> {
  const baseUrl = options.baseUrl ?? API_BASE_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const probe = options.probe ?? requestHealth
  const healthUrl = buildHealthUrl(baseUrl)
  const startedAt = now()
  let attempts = 0
  let lastError: string | undefined

  while (now() - startedAt <= maxWaitMs) {
    attempts += 1
    try {
      await probe(healthUrl, timeoutMs)
      const elapsedMs = now() - startedAt
      if (attempts > 1) {
        log.info('API health probe recovered', { attempts, elapsedMs })
      }
      return { ok: true, attempts, elapsedMs }
    } catch (err) {
      lastError = errorMessage(err)
      const elapsedMs = now() - startedAt
      if (elapsedMs >= maxWaitMs) break
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]
      log.warn('API health probe failed, retrying', { attempts, elapsedMs, delay, error: lastError })
      await wait(Math.min(delay, Math.max(0, maxWaitMs - elapsedMs)))
    }
  }

  return {
    ok: false,
    attempts,
    elapsedMs: now() - startedAt,
    lastError,
  }
}
