import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  defaultSession,
  fromPartitionSessions,
  appOn,
} = vi.hoisted(() => {
  const fromPartitionSessions = new Map<string, any>()
  const defaultSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
  return {
    defaultSession,
    fromPartitionSessions,
    appOn: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: {
    on: (...args: unknown[]) => appOn(...args),
  },
  session: {
    defaultSession,
    fromPartition: (partition: string) => {
      if (!fromPartitionSessions.has(partition)) {
        fromPartitionSessions.set(partition, {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
        })
      }
      return fromPartitionSessions.get(partition)
    },
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  installExternalProtocolGuards,
  isBlockedExternalAppProtocol,
  shouldAllowWebOpenExternal,
} from '../external-protocol-guard'

describe('external-protocol-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fromPartitionSessions.clear()
    // reset module-level WeakSet by re-importing is hard; installOnSession
    // uses WeakSet so new session objects still get handlers.
  })

  it.each([
    'bitbrowser://open?profile=1',
    'douyin-pc://launch',
    'sslocal://config',
  ])('blocks external app protocol %s', (url) => {
    expect(isBlockedExternalAppProtocol(url)).toBe(true)
  })

  it.each([
    'https://www.douyin.com/',
    'http://example.com',
    'mailto:a@b.com',
    'about:blank',
  ])('does not block navigable/safe url %s', (url) => {
    expect(isBlockedExternalAppProtocol(url)).toBe(false)
  })

  it('allows only mailto/tel for web openExternal permission', () => {
    expect(shouldAllowWebOpenExternal('mailto:a@b.com')).toBe(true)
    expect(shouldAllowWebOpenExternal('tel:+8613800138000')).toBe(true)
    expect(shouldAllowWebOpenExternal('bitbrowser://open')).toBe(false)
    expect(shouldAllowWebOpenExternal('https://example.com')).toBe(false)
    expect(shouldAllowWebOpenExternal(undefined)).toBe(false)
  })

  it('installExternalProtocolGuards wires session-created and denies bitbrowser openExternal', () => {
    installExternalProtocolGuards()

    expect(appOn).toHaveBeenCalledWith('session-created', expect.any(Function))
    // defaultSession 交给 display-media 综合 handler，不在此重复 setPermission*
    expect(defaultSession.setPermissionRequestHandler).not.toHaveBeenCalled()

    const onSessionCreated = appOn.mock.calls.find(([event]) => event === 'session-created')?.[1]
    expect(onSessionCreated).toBeTypeOf('function')

    const crawlSession = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }
    onSessionCreated(crawlSession)

    expect(crawlSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(crawlSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1)

    const requestHandler = crawlSession.setPermissionRequestHandler.mock.calls[0][0]
    const callback = vi.fn()
    requestHandler(
      {},
      'openExternal',
      callback,
      { externalURL: 'bitbrowser://open?profile=secret' },
    )
    expect(callback).toHaveBeenCalledWith(false)

    callback.mockClear()
    requestHandler({}, 'openExternal', callback, { externalURL: 'mailto:hi@example.com' })
    expect(callback).toHaveBeenCalledWith(true)

    callback.mockClear()
    requestHandler({}, 'notifications', callback, {})
    expect(callback).toHaveBeenCalledWith(true)
  })
})
