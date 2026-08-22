/**
 * RP-018: CLI /code/grep 速率限制回归测试
 *
 * 验证 SlidingWindowRateLimiter 在超过速率限制时正确返回 429。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0-test',
    getPath: (name: string) => {
      if (name === 'temp') return '/tmp'
      return '/tmp'
    },
    getAppPath: () => '/tmp/app',
    isPackaged: false,
  },
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}))

// shared/error-handler 仍在 electron 本地（djangoRequest / errorResponse 走宿主
// TokenManager + tabtin-config）。
vi.mock('../routes/shared/error-handler', () => ({
  errorResponse: (code: string, msg: string) => ({ code, message: msg }),
  djangoRequest: vi.fn(),
}))

// 仍在 electron 本地实现的路由
vi.mock('../routes/browser', () => ({ handleBrowserRoute: vi.fn() }))
vi.mock('../routes/session', () => ({ handleSessionRoute: vi.fn() }))
vi.mock('../routes/slide', () => ({ handleSlideRoute: vi.fn() }))
vi.mock('../routes/media', () => ({ handleMediaRoute: vi.fn() }))
vi.mock('../routes/video', () => ({ handleVideoRoute: vi.fn(), shutdownVideoTasks: vi.fn() }))
vi.mock('../routes/tabsite', () => ({ handleTabsiteRoute: vi.fn() }))
vi.mock('../routes/device', () => ({ handleDeviceRoute: vi.fn() }))
vi.mock('../routes/desktop', () => ({ handleDesktopRoute: vi.fn() }))
vi.mock('../routes/terminal', () => ({ handleTerminalRoute: vi.fn() }))
vi.mock('../routes/agent', () => ({ handleAgentRoute: vi.fn() }))
vi.mock('../routes/skills', () => ({ handleSkillsRoute: vi.fn() }))
vi.mock('../routes/speech', () => ({ handleSpeechRoute: vi.fn() }))

// PlatformSurface 重构（2026-05）后，code / table / space / 等路由已迁移到
// @tabtin/cli-routes。`handleCodeRoute` 用瞬时 200 mock，让本测试聚焦
// cli-server.ts 内嵌的 RP-018 SlidingWindowRateLimiter 行为，而不是真实
// grep_search（真实跑 ~1s/次会触发 vitest test timeout）。
vi.mock('@tabtin/cli-routes', () => ({
  configureCLIRoutes: vi.fn(),
  handleCodeRoute: vi.fn(async (_url: string, _method: string, _body: any, _res: any, sendJSON: any) => {
    sendJSON(_res, 200, { ok: true, data: { output: '' } })
  }),
  handleTableRoute: vi.fn(),
  handleSpaceRoute: vi.fn(),
  handleFetchRoute: vi.fn(),
  handleExtensionsRoute: vi.fn(),
  handleOSSRoute: vi.fn(),
  handleCapabilitiesRoute: vi.fn(),
  handleSearchRoute: vi.fn(),
}))
describe('RP-018: /code/grep 速率限制', () => {
  let startCLIServer: typeof import('../cli-server').startCLIServer
  let stopCLIServer: typeof import('../cli-server').stopCLIServer
  let serverInfo: { socketPath: string; token: string }

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../cli-server')
    startCLIServer = mod.startCLIServer
    stopCLIServer = mod.stopCLIServer
    serverInfo = startCLIServer({ socketPath: `/tmp/test-cli-rp018-${Date.now()}.sock` })
  })

  afterEach(async () => {
    await stopCLIServer()
    vi.restoreAllMocks()
  })

  it('SlidingWindowRateLimiter 应在超过限制后拒绝请求', async () => {
    const http = await import('node:http')
    const makeRequest = () => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const options = {
        socketPath: serverInfo.socketPath,
        path: '/code/grep',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tabtin-token': serverInfo.token,
        },
      }
      const req = http.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode || 0, body: data })
          }
        })
      })
      req.on('error', reject)
      req.write(JSON.stringify({ pattern: 'test' }))
      req.end()
    })

    const results: { status: number }[] = []
    for (let i = 0; i < 25; i++) {
      try {
        const result = await makeRequest()
        results.push(result)
      } catch {
        break
      }
    }

    const rateLimited = results.filter(r => r.status === 429)
    expect(rateLimited.length).toBeGreaterThan(0)

    const firstRateLimited = rateLimited[0] as { status: number; body: any }
    expect(firstRateLimited.body.code).toBe('RATE_LIMIT_EXCEEDED')
  })
})
