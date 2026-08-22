/**
 * CR-001 / SD-034 / SD-049 / CR-006 回归测试
 *
 * CR-001 + SD-034: isTrustedSender 拒绝 Tin 沙箱 file:// URL
 * SD-049: isTrustedSender 不再宽泛匹配 http://localhost:
 * CR-006: auth:clear 广播覆盖所有 WebContents（含 webview）
 * isTinSandboxSender: 仅匹配 userData/tin-sandboxes 路径
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_APP_PATH = '/opt/TabTin/resources/app.asar'
const MOCK_USER_DATA = '/home/testuser/.config/TabTin'

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
  },
}))

const mockSend = vi.fn()
const mockWebContentsList: Array<{ id: number; isDestroyed: () => boolean; send: typeof mockSend }> = []

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => MOCK_APP_PATH),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return MOCK_USER_DATA
      return '/tmp'
    }),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  webContents: {
    getAllWebContents: vi.fn(() => mockWebContentsList),
  },
}))

vi.mock('../config/api.js', () => ({
  API_BASE_URL: 'http://localhost:6060',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: vi.fn((base: string, path: string) => base + path),
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}))

function makeEvent(url: string, senderId = 1): any {
  return {
    senderFrame: { url },
    sender: { id: senderId },
  }
}

describe('CR-001 / SD-034: isTrustedSender — file:// 路径精确校验', () => {
  let isTrustedSender: typeof import('../auth').isTrustedSender

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../auth')
    isTrustedSender = mod.isTrustedSender
  })

  it('信任 app 安装目录内的 file:// URL', () => {
    const event = makeEvent(`file://${MOCK_APP_PATH}/out/renderer/index.html`)
    expect(isTrustedSender(event)).toBe(true)
  })

  it('信任 app 安装目录根路径', () => {
    const event = makeEvent(`file://${MOCK_APP_PATH}`)
    expect(isTrustedSender(event)).toBe(true)
  })

  it('拒绝 Tin 沙箱 file:// URL（userData/tin-sandboxes）', () => {
    const event = makeEvent(
      `file://${MOCK_USER_DATA}/tin-sandboxes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/panel.html`
    )
    expect(isTrustedSender(event)).toBe(false)
  })

  it('拒绝 userData 目录下的其他 file:// URL', () => {
    const event = makeEvent(`file://${MOCK_USER_DATA}/some-other-file.html`)
    expect(isTrustedSender(event)).toBe(false)
  })

  it('拒绝 /tmp 目录下的 file:// URL', () => {
    const event = makeEvent('file:///tmp/evil.html')
    expect(isTrustedSender(event)).toBe(false)
  })

  it('拒绝部分前缀匹配的路径（路径穿越防护）', () => {
    const event = makeEvent(`file://${MOCK_APP_PATH}-evil/attack.html`)
    expect(isTrustedSender(event)).toBe(false)
  })
})

describe('SD-049: isTrustedSender — 移除宽泛的 http://localhost 匹配', () => {
  let isTrustedSender: typeof import('../auth').isTrustedSender
  const ORIGINAL_ENV = process.env['ELECTRON_RENDERER_URL']

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../auth')
    isTrustedSender = mod.isTrustedSender
  })

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env['ELECTRON_RENDERER_URL'] = ORIGINAL_ENV
    } else {
      delete process.env['ELECTRON_RENDERER_URL']
    }
  })

  it('信任 ELECTRON_RENDERER_URL 指定的开发服务器', () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    const event = makeEvent('http://localhost:5173/index.html')
    expect(isTrustedSender(event)).toBe(true)
  })

  it('拒绝其他 localhost 端口（无 ELECTRON_RENDERER_URL）', () => {
    delete process.env['ELECTRON_RENDERER_URL']
    const event = makeEvent('http://localhost:9999/evil')
    expect(isTrustedSender(event)).toBe(false)
  })

  it('拒绝与 ELECTRON_RENDERER_URL 不同端口的 localhost', () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    const event = makeEvent('http://localhost:8080/evil')
    expect(isTrustedSender(event)).toBe(false)
  })
})

describe('isTrustedSender — 通用防护', () => {
  let isTrustedSender: typeof import('../auth').isTrustedSender

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../auth')
    isTrustedSender = mod.isTrustedSender
  })

  it('拒绝外部 HTTPS URL', () => {
    expect(isTrustedSender(makeEvent('https://evil.example.com/'))).toBe(false)
  })

  it('拒绝空 URL', () => {
    expect(isTrustedSender(makeEvent(''))).toBe(false)
  })

  it('senderFrame 不存在时返回 false', () => {
    expect(isTrustedSender({ senderFrame: null } as any)).toBe(false)
  })

  it('event 为 null 时不抛异常', () => {
    expect(isTrustedSender({} as any)).toBe(false)
  })
})

describe('isTinSandboxSender — Tin 沙箱来源验证', () => {
  let isTinSandboxSender: typeof import('../auth').isTinSandboxSender

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../auth')
    isTinSandboxSender = mod.isTinSandboxSender
  })

  it('识别 Tin 沙箱的 file:// URL', () => {
    const event = makeEvent(
      `file://${MOCK_USER_DATA}/tin-sandboxes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/panel.html`
    )
    expect(isTinSandboxSender(event)).toBe(true)
  })

  it('识别 Tin 沙箱的 preload.js', () => {
    const event = makeEvent(
      `file://${MOCK_USER_DATA}/tin-sandboxes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/preload.js`
    )
    expect(isTinSandboxSender(event)).toBe(true)
  })

  it('拒绝 app 安装目录的 file:// URL', () => {
    const event = makeEvent(`file://${MOCK_APP_PATH}/out/renderer/index.html`)
    expect(isTinSandboxSender(event)).toBe(false)
  })

  it('拒绝非 file:// 协议', () => {
    expect(isTinSandboxSender(makeEvent('https://evil.com/'))).toBe(false)
    expect(isTinSandboxSender(makeEvent('http://localhost:5173/'))).toBe(false)
  })

  it('拒绝 userData 内非 tin-sandboxes 目录', () => {
    const event = makeEvent(`file://${MOCK_USER_DATA}/other-dir/file.html`)
    expect(isTinSandboxSender(event)).toBe(false)
  })

  it('拒绝 tin-sandboxes 目录本身（需要子目录）', () => {
    const event = makeEvent(`file://${MOCK_USER_DATA}/tin-sandboxes`)
    expect(isTinSandboxSender(event)).toBe(false)
  })

  it('拒绝部分前缀匹配（路径穿越防护）', () => {
    const event = makeEvent(`file://${MOCK_USER_DATA}/tin-sandboxes-evil/attack.html`)
    expect(isTinSandboxSender(event)).toBe(false)
  })
})

describe('CR-006: auth:clear 广播覆盖所有 WebContents', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockWebContentsList.length = 0
    mockSend.mockClear()
  })

  it('auth:clear 向非 sender 的所有 WebContents 发送 force-logout', async () => {
    const { ipcMain } = await import('electron')
    const handleCalls = vi.mocked(ipcMain.handle).mock.calls

    await import('../auth').then((m) => m.registerAuthHandlers())

    const authClearCall = handleCalls.find(([ch]) => ch === 'auth:clear')
    expect(authClearCall).toBeDefined()

    const handler = authClearCall![1]

    const mainWindowWc = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const chatWindowWc = { id: 2, isDestroyed: () => false, send: vi.fn() }
    const tinWebviewWc = { id: 3, isDestroyed: () => false, send: vi.fn() }
    const senderWc = { id: 10, isDestroyed: () => false, send: vi.fn() }

    mockWebContentsList.push(mainWindowWc, chatWindowWc, tinWebviewWc, senderWc)

    const event = {
      senderFrame: { url: `file://${MOCK_APP_PATH}/out/renderer/index.html` },
      sender: { id: 10 },
    }

    await handler(event as any)

    expect(mainWindowWc.send).toHaveBeenCalledWith('auth:force-logout')
    expect(chatWindowWc.send).toHaveBeenCalledWith('auth:force-logout')
    expect(tinWebviewWc.send).toHaveBeenCalledWith('auth:force-logout')
    expect(senderWc.send).not.toHaveBeenCalled()
  })

  it('跳过已销毁的 WebContents', async () => {
    const { ipcMain } = await import('electron')
    const handleCalls = vi.mocked(ipcMain.handle).mock.calls

    await import('../auth').then((m) => m.registerAuthHandlers())

    const authClearCall = handleCalls.find(([ch]) => ch === 'auth:clear')
    const handler = authClearCall![1]

    const aliveWc = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const destroyedWc = { id: 2, isDestroyed: () => true, send: vi.fn() }

    mockWebContentsList.push(aliveWc, destroyedWc)

    const event = {
      senderFrame: { url: `file://${MOCK_APP_PATH}/out/renderer/index.html` },
      sender: { id: 99 },
    }

    await handler(event as any)

    expect(aliveWc.send).toHaveBeenCalledWith('auth:force-logout')
    expect(destroyedWc.send).not.toHaveBeenCalled()
  })
})
