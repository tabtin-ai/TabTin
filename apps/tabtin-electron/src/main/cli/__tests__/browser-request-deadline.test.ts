import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'
import { BROWSER_CLI_APPROVAL_TIMEOUT_MS } from '../browser-policy-middleware'
import {
  BROWSER_CLI_REQUEST_TIMEOUT_GRACE_MS,
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  runBrowserRequestWithDeadline,
} from '../cli-server'
import { ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS } from '../routes/browser/interaction'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
    isPackaged: false,
  },
  Notification: {
    isSupported: vi.fn(() => false),
  },
}))

function createMockResponse() {
  const chunks: Buffer[] = []
  const res = {} as any
  res.statusCode = 200
  res.writableEnded = false
  res.destroyed = false
  res.headers = {} as Record<string, string | number | string[]>
  res.writeHead = (status: number, headers?: Record<string, string | number | string[]>) => {
    res.statusCode = status
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        res.headers[key.toLowerCase()] = value
      }
    }
    return res
  }
  res.setHeader = (key: string, value: string | number | string[]) => {
    res.headers[key.toLowerCase()] = value
  }
  res.getHeader = (key: string) => res.headers[key.toLowerCase()]
  res.end = (chunk?: any) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    res.writableEnded = true
    return res
  }
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  return res
}

describe('browser request deadline', () => {
  it('covers the mobile approval window plus browser act execution budget', () => {
    expect(BROWSER_CLI_REQUEST_TIMEOUT_MS).toBe(
      BROWSER_CLI_APPROVAL_TIMEOUT_MS +
      ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS +
      BROWSER_CLI_REQUEST_TIMEOUT_GRACE_MS,
    )
    expect(BROWSER_CLI_REQUEST_TIMEOUT_MS).toBe(PERMISSION_TIMEOUTS.FINAL_MS + 25_000 + 5_000)
  })

  it('returns structured timeout before CLI transport timeout when route hangs', async () => {
    vi.useFakeTimers()
    try {
      const res = createMockResponse()
      const pending = runBrowserRequestWithDeadline('/browser/act', res, async () => new Promise(() => {}))

      await vi.advanceTimersByTimeAsync(BROWSER_CLI_REQUEST_TIMEOUT_MS)
      await pending

      expect(res.statusCode).toBe(504)
      expect(JSON.parse(res.bodyText())).toMatchObject({
        ok: false,
        error: {
          code: 'CONNECTION_TIMEOUT',
          retryable: true,
          detail: {
            url: '/browser/act',
            timeoutMs: BROWSER_CLI_REQUEST_TIMEOUT_MS,
          },
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
