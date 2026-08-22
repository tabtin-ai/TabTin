import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LoginRelaySessionManager } from './relay-session'

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

function electronCookie(overrides: Partial<Electron.Cookie> = {}): Electron.Cookie {
  return {
    name: 'sid',
    value: 'secret',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: 'lax',
    ...overrides,
  }
}

function createHarness(cookies: Electron.Cookie[] = [electronCookie()]) {
  const sender = new FakeSender(7)
  const sessions = new Map<string, {
    cookies: { get: ReturnType<typeof vi.fn> }
    clearStorageData: ReturnType<typeof vi.fn>
  }>()
  const getSession = vi.fn((partition: string) => {
    let value = sessions.get(partition)
    if (!value) {
      value = {
        cookies: { get: vi.fn().mockResolvedValue(cookies) },
        clearStorageData: vi.fn().mockResolvedValue(undefined),
      }
      sessions.set(partition, value)
    }
    return value
  })
  const resolveWorkspaceOrganization = vi.fn().mockImplementation(async (spaceId: string) => ({
    ok: true,
    organizationId: spaceId === 'saved-space' ? 'saved-org' : 'org-1',
  }))
  const uploadPackage = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      package_id: 'package-1',
      import_result: { success: true, imported_count: 1 },
    },
  })
  const manager = new LoginRelaySessionManager({
    getSession,
    resolveWorkspaceOrganization,
    uploadPackage,
    generateRelayId: () => 'relay-1',
  })
  return {
    sender,
    sessions,
    getSession,
    resolveWorkspaceOrganization,
    uploadPackage,
    manager,
  }
}

describe('LoginRelaySessionManager', () => {
  it('opens the organization browser session without preflighting or clearing cookies', async () => {
    const { sender, getSession, uploadPackage, manager } = createHarness([
      electronCookie(),
      electronCookie({ name: 'sub', domain: 'login.example.com' }),
      electronCookie({ name: 'foreign', domain: 'evil.test' }),
    ])

    await expect(manager.start(sender, {
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'Example.COM',
    })).resolves.toEqual({
      success: true,
      relayId: 'relay-1',
      partition: 'persist:tabtin:organization:org-1:browser',
      loginUrl: 'https://example.com/',
    })

    expect(getSession).toHaveBeenCalledWith('persist:tabtin:organization:org-1:browser')
    expect(getSession.mock.results[0].value.cookies.get).not.toHaveBeenCalled()
    expect(getSession.mock.results[0].value.clearStorageData).not.toHaveBeenCalled()
    expect(uploadPackage).not.toHaveBeenCalled()
  })

  it('opens the same site page even when its existing login state is absent or expired', async () => {
    const { sender, uploadPackage, manager } = createHarness([
      electronCookie({ domain: 'evil.test' }),
    ])

    await expect(manager.start(sender, {
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })).resolves.toEqual({
      success: true,
      relayId: 'relay-1',
      partition: 'persist:tabtin:organization:org-1:browser',
      loginUrl: 'https://example.com/',
    })
    expect(uploadPackage).not.toHaveBeenCalled()
  })

  it('rejects a renderer organization that does not match the server-authoritative workspace organization', async () => {
    const { sender, getSession, resolveWorkspaceOrganization, manager } = createHarness()
    resolveWorkspaceOrganization.mockResolvedValueOnce({
      ok: true,
      organizationId: 'org-workspace',
    })

    await expect(manager.start(sender, {
      spaceId: 'space-1',
      organizationId: 'org-active-ui',
      domain: 'example.com',
    })).resolves.toEqual({
      success: false,
      error: '执行现场与当前组织不匹配',
    })
    expect(getSession).not.toHaveBeenCalled()
  })

  it.each([
    [{ spaceId: '', organizationId: 'org-1', domain: 'example.com' }],
    [{ spaceId: 'space-1', organizationId: '', domain: 'example.com' }],
    [{ spaceId: 'space-1', organizationId: 'org/../other', domain: 'example.com' }],
    [{ spaceId: 'space-1', organizationId: 'org-1', domain: 'localhost' }],
    [{ spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com/path' }],
  ])('rejects unsafe start input without opening a session: %j', async (input) => {
    const { sender, getSession, manager } = createHarness()
    await expect(manager.start(sender, input as never)).resolves.toMatchObject({ success: false })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('binds completion to the starting sender and uploads only the saved target scope', async () => {
    const { sender, uploadPackage, manager } = createHarness([
      electronCookie(),
      electronCookie({ name: 'sub', domain: 'login.example.com' }),
      electronCookie({ name: 'foreign', domain: 'evil.test' }),
    ])
    await manager.start(sender, {
      spaceId: 'saved-space',
      organizationId: 'saved-org',
      domain: 'example.com',
    })

    await expect(manager.complete(new FakeSender(8), {
      relayId: 'relay-1',
      threadId: 'thread_login_relay_1',
    })).resolves.toMatchObject({ success: false, error: '无权操作该登录接力' })

    await expect(manager.complete(sender, {
      relayId: 'relay-1',
      threadId: 'thread_login_relay_1',
      tabId: 'view-login-wall',
      spaceId: 'attacker-space',
      domain: 'evil.test',
    } as never)).resolves.toEqual({
      success: true,
      packageId: 'package-1',
      importResult: { success: true, imported_count: 1 },
    })
    expect(uploadPackage).toHaveBeenCalledWith({
      space_id: 'saved-space',
      thread_id: 'thread_login_relay_1',
      domain: 'example.com',
      tab_id: 'view-login-wall',
      cookies: expect.arrayContaining([
        expect.objectContaining({ name: 'sid' }),
        expect.objectContaining({ name: 'sub' }),
      ]),
    })
    expect(uploadPackage.mock.calls[0][0].cookies).toHaveLength(2)
  })

  it('keeps A browser cookies after successful completion', async () => {
    const { sender, sessions, manager } = createHarness([electronCookie()])
    await manager.start(sender, {
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })
    const organizationSession = sessions.get('persist:tabtin:organization:org-1:browser')!

    await expect(manager.complete(sender, {
      relayId: 'relay-1',
      threadId: 'thread_login_relay_1',
    })).resolves.toMatchObject({ success: true })
    expect(organizationSession.clearStorageData).not.toHaveBeenCalled()
  })

  it('keeps the relay ready when no scoped cookies exist', async () => {
    const { sender, sessions, uploadPackage, manager } = createHarness([])
    await manager.start(sender, {
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })
    const organizationSession = sessions.get('persist:tabtin:organization:org-1:browser')!

    await expect(manager.complete(sender, {
      relayId: 'relay-1',
      threadId: 'thread_login_relay_1',
    })).resolves.toEqual({
      success: false,
      error: '未检测到该站登录态，请先完成登录后重试',
    })
    expect(uploadPackage).not.toHaveBeenCalled()
    expect(organizationSession.clearStorageData).not.toHaveBeenCalled()
  })

  it('prevents duplicate upload while a completion is in flight', async () => {
    const { sender, uploadPackage, manager } = createHarness()
    let resolveUpload!: (value: unknown) => void
    uploadPackage.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve }))
    await manager.start(sender, {
      spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com',
    })

    const first = manager.complete(sender, {
      relayId: 'relay-1', threadId: 'thread_login_relay_1',
    })
    await expect(manager.complete(sender, {
      relayId: 'relay-1', threadId: 'thread_login_relay_1',
    })).resolves.toMatchObject({ success: false, error: '登录态正在提交' })
    expect(uploadPackage).toHaveBeenCalledTimes(1)
    resolveUpload({
      ok: true,
      data: { package_id: 'package-1', import_result: { success: true } },
    })
    await first
  })

  it('does not clear A browser cookies on cancel, sender destruction, or dispose', async () => {
    const first = createHarness()
    await first.manager.start(first.sender, {
      spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com',
    })
    const firstSession = first.sessions.get('persist:tabtin:organization:org-1:browser')!
    await expect(first.manager.cancel(first.sender, { relayId: 'relay-1' })).resolves.toEqual({ success: true })
    expect(firstSession.clearStorageData).not.toHaveBeenCalled()
    await expect(first.manager.cancel(first.sender, { relayId: 'relay-1' })).resolves.toEqual({ success: true })

    const second = createHarness()
    await second.manager.start(second.sender, {
      spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com',
    })
    const secondSession = second.sessions.get('persist:tabtin:organization:org-1:browser')!
    second.sender.emit('destroyed')
    await vi.waitFor(() => expect(secondSession.clearStorageData).not.toHaveBeenCalled())

    const third = createHarness()
    await third.manager.start(third.sender, {
      spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com',
    })
    const thirdSession = third.sessions.get('persist:tabtin:organization:org-1:browser')!
    third.manager.dispose()
    await vi.waitFor(() => expect(thirdSession.clearStorageData).not.toHaveBeenCalled())
  })

  it('rejects cancel from another sender without clearing the session', async () => {
    const { sender, sessions, manager } = createHarness()
    await manager.start(sender, {
      spaceId: 'space-1', organizationId: 'org-1', domain: 'example.com',
    })
    const organizationSession = sessions.get('persist:tabtin:organization:org-1:browser')!

    await expect(manager.cancel(new FakeSender(8), { relayId: 'relay-1' })).resolves.toEqual({
      success: false,
      error: '无权操作该登录接力',
    })
    expect(organizationSession.clearStorageData).not.toHaveBeenCalled()
  })
})
