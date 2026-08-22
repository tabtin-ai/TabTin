import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let permissionCheckHandler: ((...args: any[]) => boolean) | null = null
  let permissionRequestHandler: ((...args: any[]) => void) | null = null
  let displayMediaHandler: ((...args: any[]) => void) | null = null

  return {
    targetSession: {
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheckHandler = handler
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequestHandler = handler
      }),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        displayMediaHandler = handler
      }),
    },
    desktopCapturerGetSources: vi.fn(async () => [
      {
        id: 'screen:1:0',
        name: 'Entire Screen',
        display_id: '1',
      },
    ]),
    getPermissionCheckHandler: () => permissionCheckHandler,
    getPermissionRequestHandler: () => permissionRequestHandler,
    getDisplayMediaHandler: () => displayMediaHandler,
    resetHandlers: () => {
      permissionCheckHandler = null
      permissionRequestHandler = null
      displayMediaHandler = null
    },
  }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
  },
  session: {
    defaultSession: mocks.targetSession,
  },
  desktopCapturer: {
    getSources: mocks.desktopCapturerGetSources,
  },
}))

import {
  installDisplayMediaHandlers,
  isTrustedDisplayMediaOrigin,
  normalizeOrigin,
  resolveDisplayMediaStreams,
  shouldGrantPermissionCheck,
  shouldGrantPermissionRequest,
} from '../display-media'

describe('display-media service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetHandlers()
  })

  it('识别受信任来源', () => {
    expect(normalizeOrigin('file:///Applications/TabTin/index.html')).toBe('file://')
    expect(normalizeOrigin('tabtin-file:///tmp/demo.pdf')).toBe('tabtin-file://')
    expect(
      isTrustedDisplayMediaOrigin('http://localhost:5173', {
        isDev: true,
      }),
    ).toBe(true)
    expect(
      isTrustedDisplayMediaOrigin('https://app.tabtin.local', {
        trustedOrigins: ['https://app.tabtin.local'],
      }),
    ).toBe(true)
    expect(
      isTrustedDisplayMediaOrigin('https://example.com', {
        trustedOrigins: ['https://app.tabtin.local'],
      }),
    ).toBe(false)
  })

  it('权限策略对敏感权限只放行可信来源', () => {
    expect(
      shouldGrantPermissionRequest({
        permission: 'display-capture',
        details: {
          securityOrigin: 'file:///renderer/index.html',
        } as any,
      }),
    ).toBe(true)

    expect(
      shouldGrantPermissionRequest({
        permission: 'display-capture',
        details: {
          securityOrigin: 'https://example.com',
        } as any,
      }),
    ).toBe(false)

    expect(
      shouldGrantPermissionRequest({
        permission: 'fullscreen',
        details: {
          securityOrigin: 'https://example.com',
        } as any,
      }),
    ).toBe(true)

    expect(
      shouldGrantPermissionCheck({
        permission: 'media',
        requestingOrigin: 'https://example.com',
        details: {
          isMainFrame: true,
          requestingUrl: 'https://example.com',
        } as any,
      }),
    ).toBe(false)
  })

  it('openExternal 仅放行 mailto/tel，拒绝 bitbrowser 等自定义协议', () => {
    expect(
      shouldGrantPermissionRequest({
        permission: 'openExternal',
        details: {
          securityOrigin: 'file:///renderer/index.html',
          externalURL: 'bitbrowser://open',
        } as any,
      }),
    ).toBe(false)

    expect(
      shouldGrantPermissionRequest({
        permission: 'openExternal',
        details: {
          securityOrigin: 'https://www.douyin.com',
          externalURL: 'mailto:a@b.com',
        } as any,
      }),
    ).toBe(true)

    expect(
      shouldGrantPermissionCheck({
        permission: 'openExternal',
        requestingOrigin: 'https://www.douyin.com',
        details: {
          isMainFrame: true,
          requestingUrl: 'https://www.douyin.com',
          externalURL: 'douyin-pc://launch',
        } as any,
      }),
    ).toBe(false)
  })

  it('优先使用当前 frame 作为 capture 源', async () => {
    const frame = { id: 11 }
    const streams = await resolveDisplayMediaStreams({
      frame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: true,
      userGesture: true,
    } as any)

    expect(streams.video).toBe(frame)
    expect(streams.audio).toBe(frame)
    expect(streams.enableLocalEcho).toBe(true)
  })

  it('当前 frame 不可用时回退到主屏 source', async () => {
    const streams = await resolveDisplayMediaStreams({
      frame: null,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: true,
      userGesture: true,
    } as any, {
      captureMode: 'main-display',
      platform: 'win32',
      desktopCapturerApi: {
        getSources: mocks.desktopCapturerGetSources,
      },
    })

    expect(streams.video).toEqual({
      id: 'screen:1:0',
      name: 'Entire Screen',
    })
    expect(streams.audio).toBe('loopback')
  })

  it('安装后会注册权限处理器与媒体流处理器', async () => {
    installDisplayMediaHandlers({
      rendererUrl: 'http://localhost:5173',
      isDev: true,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    })

    expect(mocks.targetSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(mocks.targetSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(mocks.targetSession.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1)

    const permissionHandler = mocks.getPermissionRequestHandler()
    expect(permissionHandler).toBeTypeOf('function')

    const permissionCallback = vi.fn()
    permissionHandler?.(
      {
        getURL: () => 'http://localhost:5173/renderer/index.html',
        isDestroyed: () => false,
      },
      'display-capture',
      permissionCallback,
      {
        securityOrigin: 'http://localhost:5173',
      },
    )
    expect(permissionCallback).toHaveBeenCalledWith(true)

    const deniedCallback = vi.fn()
    permissionHandler?.(
      {
        getURL: () => 'https://example.com',
        isDestroyed: () => false,
      },
      'display-capture',
      deniedCallback,
      {
        securityOrigin: 'https://example.com',
      },
    )
    expect(deniedCallback).toHaveBeenCalledWith(false)

    const displayHandler = mocks.getDisplayMediaHandler()
    expect(displayHandler).toBeTypeOf('function')

    const grantedStreams = await new Promise<any>((resolve) => {
      displayHandler?.(
        {
          frame: { id: 9 },
          securityOrigin: 'http://localhost:5173',
          videoRequested: true,
          audioRequested: false,
          userGesture: true,
        },
        resolve,
      )
    })

    expect(grantedStreams.video).toEqual({ id: 9 })

    const deniedStreams = await new Promise<any>((resolve) => {
      displayHandler?.(
        {
          frame: { id: 9 },
          securityOrigin: 'https://example.com',
          videoRequested: true,
          audioRequested: false,
          userGesture: true,
        },
        resolve,
      )
    })

    expect(deniedStreams).toEqual({})
  })
})
