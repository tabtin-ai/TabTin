/**
 * CR-009 / SD-023 / SD-024 回归测试
 *
 * CR-009: tins:get-activation-states 和 tins:toggle-panel 添加 sender 校验
 * SD-023: tins:toggle-panel 添加 senderFrame 防护
 * SD-024: tins:get-page-context / tins:get-resolved-variables 添加 senderFrame 防护
 *
 * 验证这 4 个 handler 在收到非信任来源时返回 Unauthorized 错误。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type IpcHandler = (event: any, ...args: any[]) => any
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  webContents: { fromId: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

let mockIsTrusted = true

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => mockIsTrusted),
}))

vi.mock('../tin-sandbox', () => ({
  prepareSandbox: vi.fn(() => null),
  cleanupSandbox: vi.fn(),
}))

vi.mock('../activation-matcher', () => ({
  matchActivationRules: vi.fn(() => false),
}))

function makeTrustedEvent() {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' }, sender: { id: 999 } }
}

const GUARDED_CHANNELS = [
  'tins:get-activation-states',
  'tins:toggle-panel',
  'tins:get-page-context',
  'tins:get-resolved-variables',
] as const

describe('CR-009 / SD-023 / SD-024: tins IPC handler sender 校验', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    vi.resetModules()

    const { TinManager } = await import('../tin-manager')
    new TinManager()
  })

  for (const channel of GUARDED_CHANNELS) {
    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(
        makeUntrustedEvent(),
        ...(channel === 'tins:toggle-panel'
          ? ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', true]
          : channel === 'tins:get-resolved-variables'
            ? ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']
            : [])
      )

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Unauthorized'),
      })
    })

    it(`${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(
        makeTrustedEvent(),
        ...(channel === 'tins:toggle-panel'
          ? ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', true]
          : channel === 'tins:get-resolved-variables'
            ? ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']
            : [])
      )

      if (result !== null && result !== undefined) {
        expect(result).not.toMatchObject({
          error: expect.stringContaining('Unauthorized'),
        })
      }
    })
  }
})

describe('CR-009: Tin 沙箱 file:// 不能调用 tins:* 管理 IPC', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = false
    vi.resetModules()

    const { TinManager } = await import('../tin-manager')
    new TinManager()
  })

  it('Tin 沙箱无法读取所有 Tin 激活状态（信息泄漏防护）', async () => {
    const handler = handlers.get('tins:get-activation-states')!
    const sandboxEvent = {
      senderFrame: { url: 'file:///home/user/.config/TabTin/tin-sandboxes/abc-123/panel.html' },
      sender: { id: 42 },
    }

    const result = await handler(sandboxEvent)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Unauthorized'),
    })
  })

  it('Tin 沙箱无法切换其他 Tin 面板可见性（UI 操纵防护）', async () => {
    const handler = handlers.get('tins:toggle-panel')!
    const sandboxEvent = {
      senderFrame: { url: 'file:///home/user/.config/TabTin/tin-sandboxes/abc-123/panel.html' },
      sender: { id: 42 },
    }

    const result = await handler(sandboxEvent, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', true)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Unauthorized'),
    })
  })
})
