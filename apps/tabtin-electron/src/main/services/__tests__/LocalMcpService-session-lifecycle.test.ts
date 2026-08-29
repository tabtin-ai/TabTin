import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type ClientOptionsSnapshot = {
    listChanged?: {
      tools?: {
        onChanged?: (error: Error | null, items: unknown[] | null) => void
      }
    }
  }
  const files = new Map<string, string>()
  const clientClose = vi.fn<() => Promise<void>>(async () => undefined)
  const clientConnect = vi.fn<() => Promise<void>>(async () => undefined)
  const clientListTools = vi.fn(async () => ({ tools: [] }))
  const clientListResources = vi.fn(async () => ({ resources: [] }))
  const clientListPrompts = vi.fn(async () => ({ prompts: [] }))
  const clientCallTool = vi.fn<() => Promise<{ content: unknown[] }>>(async () => ({ content: [] }))
  const clientOptions: ClientOptionsSnapshot[] = []
  const Client = vi.fn(function ClientMock(_implementation: unknown, options: ClientOptionsSnapshot) {
    clientOptions.push(options)
    return {
      connect: clientConnect,
      close: clientClose,
      listTools: clientListTools,
      listResources: clientListResources,
      listPrompts: clientListPrompts,
      callTool: clientCallTool,
    }
  })
  return {
    files,
    Client,
    clientClose,
    clientConnect,
    clientListTools,
    clientListResources,
    clientListPrompts,
    clientCallTool,
    clientOptions,
    atomicWriteFileSync: vi.fn((path: string, content: string) => {
      files.set(path, content)
    }),
    existsSync: vi.fn((path: string) => files.has(path)),
    readFileSync: vi.fn((path: string) => {
      const value = files.get(path)
      if (value == null) throw new Error(`ENOENT: ${path}`)
      return value
    }),
    mkdirSync: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/userData'),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: mocks.Client }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

vi.mock('../bundled-mcp-remote-transport', () => ({
  BundledMcpRemoteTransport: vi.fn(),
  extractBundledMcpRemoteArgs: vi.fn(() => null),
}))

vi.mock('../mcp-oauth-window', () => ({
  closeConnectorOAuthWindow: vi.fn(),
  createOAuthAuthorizeUrlParser: vi.fn(() => vi.fn()),
  openConnectorOAuthWindow: vi.fn(),
  restoreConnectorOAuthClient: vi.fn(),
  waitForPlatformOAuthTicket: vi.fn(),
  withMcpOpenShimPath: vi.fn((env: Record<string, string>) => env),
}))

vi.mock('../mcp-remote-client', () => ({
  ensureMcpRemoteClientName: vi.fn(),
  extractMcpRemoteServerUrl: vi.fn((args?: string[]) =>
    args?.find(arg => /^https?:\/\//i.test(arg)) ?? null,
  ),
  clearMcpRemoteAuth: vi.fn(() => 0),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))

const authMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => 'test-token' as string | null),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
  TokenManager: {
    getAccessToken: authMocks.getAccessToken,
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://127.0.0.1:6060',
}))

vi.mock('@tabtin/terminal-core', () => ({
  atomicWriteFileSync: mocks.atomicWriteFileSync,
}))

vi.mock('@tabtin/storage-manager', () => ({ registerStorageBucket: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const overrides = {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
  }
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  }
})

vi.mock('../../security/agent-access-guard', () => ({
  assertCurrentUserCanAccessAgent: vi.fn(),
  AgentAccessDeniedError: class AgentAccessDeniedError extends Error {},
}))

import { LocalMcpService } from '../LocalMcpService'
import { restoreConnectorOAuthClient } from '../mcp-oauth-window'
import { clearMcpRemoteAuth } from '../mcp-remote-client'

describe('LocalMcpService 会话撤销原子性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.files.clear()
    mocks.clientClose.mockResolvedValue(undefined)
    mocks.clientConnect.mockResolvedValue(undefined)
    mocks.clientListTools.mockResolvedValue({ tools: [] })
    mocks.clientCallTool.mockResolvedValue({ content: [] })
    mocks.clientOptions.length = 0
  })

  it('配置变更与 MCP tools/list_changed 会主动通知工具缓存失效', async () => {
    const service = new LocalMcpService()
    const invalidations: Array<{
      agentIds?: readonly string[]
      mode: 'drop' | 'stale'
      reason: string
    }> = []
    service.onToolCacheInvalidated(event => invalidations.push(event))

    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })
    expect(invalidations).toContainEqual({
      agentIds: ['agent-1'],
      mode: 'drop',
      reason: 'configuration-changed',
    })

    invalidations.length = 0
    await service.listAttachedTools('agent-1')
    const onToolsChanged = mocks.clientOptions[0]?.listChanged?.tools?.onChanged
    expect(onToolsChanged).toBeTypeOf('function')
    if (!onToolsChanged) throw new Error('tools/list_changed handler not registered')
    onToolsChanged(null, null)
    expect(invalidations).toEqual([{
      agentIds: ['agent-1'],
      mode: 'stale',
      reason: 'server-list-changed',
    }])

    invalidations.length = 0
    await service.setConnectionEnabled(connection.id, false)
    expect(invalidations).toContainEqual({
      agentIds: ['agent-1'],
      mode: 'drop',
      reason: 'configuration-changed',
    })
    await service.dispose()
  })

  it('编辑连接时直接停用也必须等待已有会话关闭', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })
    await service.listAttachedTools('agent-1')

    let resolveClose!: () => void
    mocks.clientClose.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveClose = resolve
    }))
    let saveSettled = false
    const savePromise = service.saveManualConnection({
      connectionId: connection.id,
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      enabled: false,
    }).then(() => {
      saveSettled = true
    })

    await vi.waitFor(() => expect(mocks.clientClose).toHaveBeenCalled())
    expect(saveSettled).toBe(false)
    resolveClose()
    await savePromise
    await service.dispose()
  })

  it('解绑返回成功前必须等待已有 MCP 会话关闭完成', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })
    await service.listAttachedTools('agent-1')

    let resolveClose!: () => void
    mocks.clientClose.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveClose = resolve
    }))

    let detachSettled = false
    const detachPromise = service
      .attachConnection(connection.id, 'agent-1', false)
      .then(() => {
        detachSettled = true
      })

    await vi.waitFor(() => {
      expect(mocks.clientClose).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    expect(detachSettled).toBe(false)

    resolveClose()
    await detachPromise
    await service.dispose()
  })

  it('停用连接会撤销进行中的调用，且不会用旧授权自动重试', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })
    mocks.clientCallTool.mockImplementationOnce(() => new Promise(() => undefined))

    const callPromise = service.callTool(
      'agent-1',
      { connectionId: connection.id },
      'long_running_tool',
    )
    const callRejection = expect(callPromise).rejects.toThrow('MCP_ERR:SESSION_REVOKED')
    await vi.waitFor(() => {
      expect(mocks.clientCallTool).toHaveBeenCalledTimes(1)
    })

    await service.setConnectionEnabled(connection.id, false)
    await callRejection

    expect(mocks.Client).toHaveBeenCalledTimes(1)
    expect(mocks.clientCallTool).toHaveBeenCalledTimes(1)
    await service.dispose()
  })

  it('连接仍在创建时解绑，不允许连接完成后把旧会话写回池中', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })

    let resolveConnect!: () => void
    mocks.clientConnect.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveConnect = resolve
    }))
    const listPromise = service.listAttachedTools('agent-1')
    const listRejection = expect(listPromise).rejects.toThrow('MCP_ERR:SESSION_REVOKED')
    await vi.waitFor(() => {
      expect(mocks.clientConnect).toHaveBeenCalledTimes(1)
    })

    await service.attachConnection(connection.id, 'agent-1', false)
    resolveConnect()
    await listRejection

    const internals = service as unknown as {
      sessionPool: Map<string, unknown>
      sessionCreationPool: Map<string, unknown>
    }
    expect(internals.sessionPool.size).toBe(0)
    expect(internals.sessionCreationPool.size).toBe(0)
    await service.dispose()
  })

  it('没有发生授权撤销时仍保留一次连接级自动重试', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'demo',
      transport: { kind: 'stdio', command: 'node' },
      attachToAgentId: 'agent-1',
    })
    mocks.clientCallTool
      .mockRejectedValueOnce(new Error('transport disconnected'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })

    await expect(service.callTool(
      'agent-1',
      { connectionId: connection.id },
      'retryable_tool',
    )).resolves.toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    })

    expect(mocks.Client).toHaveBeenCalledTimes(2)
    expect(mocks.clientCallTool).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('手动连接可落盘 description；组织镜像不写明文凭据且幂等', async () => {
    const service = new LocalMcpService()
    const manual = await service.saveManualConnection({
      name: 'http-demo',
      description: '团队远程文档',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/v1',
        headers: { Authorization: 'Bearer local-secret' },
      },
    })
    expect(manual.description).toBe('团队远程文档')
    expect(manual.headerKeys).toContain('Authorization')

    const mirrored = service.upsertOrganizationMirror({
      orgConnectionId: 'org-conn-1',
      name: 'Org Remote',
      description: '组织统一远程',
      url: 'https://mcp.example.com/org',
      headerKeys: ['Authorization'],
    })
    expect(mirrored.source).toMatchObject({
      kind: 'organization',
      orgConnectionId: 'org-conn-1',
    })
    expect(mirrored.description).toBe('组织统一远程')
    expect(mirrored.headerKeys).toEqual(['Authorization'])
    const detail = await service.getConnectionDetail(mirrored.id)
    expect(detail.transport).toEqual({
      kind: 'http',
      url: 'https://mcp.example.com/org',
      headers: { Authorization: '***' },
    })
    const withSecrets = await service.getConnectionDetail(mirrored.id, { includeSecrets: true })
    expect(withSecrets.transport.headers?.Authorization).toBe('')

    const again = service.upsertOrganizationMirror({
      orgConnectionId: 'org-conn-1',
      name: 'Org Remote Updated',
      description: '更新描述',
      url: 'https://mcp.example.com/org2',
      headerKeys: ['Authorization', 'X-Tenant'],
    })
    expect(again.id).toBe(mirrored.id)
    expect(again.name).toBe('Org Remote Updated')
    expect(again.url).toBe('https://mcp.example.com/org2')
    expect(again.headerKeys).toEqual(['Authorization', 'X-Tenant'])
    await service.dispose()
  })

  it('组织镜像 probe 前走 runtime-config；未登录 / 拉取失败可诊断', async () => {
    const service = new LocalMcpService()
    const mirrored = service.upsertOrganizationMirror({
      orgConnectionId: 'org-conn-runtime',
      name: 'Org Runtime',
      url: 'https://mcp.example.com/stale',
      headerKeys: ['Authorization'],
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          endpoint: 'https://mcp.example.com/live',
          headers: { Authorization: 'Bearer runtime-secret' },
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.probeConnection(mirrored.id)).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/context/mcp-connections/org-conn-runtime/runtime-config'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    )

    authMocks.getAccessToken.mockResolvedValueOnce(null)
    await expect(service.probeConnection(mirrored.id)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('ORG_RUNTIME_AUTH_REQUIRED'),
    })

    authMocks.getAccessToken.mockResolvedValueOnce('test-token')
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'forbidden' }),
    })
    await expect(service.probeConnection(mirrored.id)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('forbidden'),
    })

    vi.unstubAllGlobals()
    await service.dispose()
  })

  it('同一连接重新探测时会撤销仍在等待 OAuth 的旧探测', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'oauth-demo',
      transport: { kind: 'stdio', command: 'node' },
    })

    mocks.clientConnect
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(undefined)

    const staleProbe = service.probeConnection(connection.id, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledTimes(1))

    const currentProbe = service.probeConnection(connection.id, { timeoutMs: 60_000 })

    await expect(staleProbe).resolves.toMatchObject({ ok: false })
    await expect(currentProbe).resolves.toMatchObject({ ok: true })
    expect(mocks.clientClose).toHaveBeenCalled()
    expect(service.listConnections()[0]?.lastProbe).toMatchObject({ ok: true })
    await service.dispose()
  })

  it('连续快速重试时由最后发起的探测生效', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'oauth-demo',
      transport: { kind: 'stdio', command: 'node' },
    })

    mocks.clientConnect
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(undefined)

    const firstProbe = service.probeConnection(connection.id, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledTimes(1))
    const secondProbe = service.probeConnection(connection.id, { timeoutMs: 60_000 })
    const finalProbe = service.probeConnection(connection.id, { timeoutMs: 60_000 })

    await expect(firstProbe).resolves.toMatchObject({ ok: false })
    await expect(secondProbe).resolves.toMatchObject({ ok: false })
    await expect(finalProbe).resolves.toMatchObject({ ok: true })
    expect(service.listConnections()[0]?.lastProbe).toMatchObject({ ok: true })
    await service.dispose()
  })

  it('取消探测会立即结束 OAuth 等待并关闭子进程，且不覆盖上次成功状态', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'oauth-demo',
      transport: { kind: 'stdio', command: 'node' },
    })

    await expect(service.probeConnection(connection.id)).resolves.toMatchObject({ ok: true })
    mocks.clientConnect.mockImplementationOnce(() => new Promise(() => undefined))

    const probe = service.probeConnection(connection.id, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledTimes(1))

    await expect(service.cancelProbe(connection.id)).resolves.toBe(true)
    await expect(probe).resolves.toMatchObject({ ok: false })
    expect(mocks.clientClose).toHaveBeenCalled()
    expect(service.listConnections()[0]?.lastProbe).toMatchObject({ ok: true })
    await service.dispose()
  })

  it('OAuth 握手完成后立即恢复客户端，不等待后续能力枚举', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'stripe',
      transport: { kind: 'stdio', command: 'node' },
    })

    let finishListTools!: () => void
    mocks.clientListTools.mockImplementationOnce(() => new Promise(resolve => {
      finishListTools = () => resolve({ tools: [] })
    }))

    const probe = service.probeConnection(connection.id, {
      openOAuthWindow: true,
    })

    await vi.waitFor(() => expect(mocks.clientConnect).toHaveBeenCalledTimes(1))
    expect(restoreConnectorOAuthClient).toHaveBeenCalledTimes(1)

    finishListTools()
    await expect(probe).resolves.toMatchObject({ ok: true })
    await service.dispose()
  })

  it('组织镜像允许保存本机补充配置，并在运行时覆盖组织基线', async () => {
    const service = new LocalMcpService()
    const mirrored = service.upsertOrganizationMirror({
      orgConnectionId: 'org-conn-local-overrides',
      name: 'Org Runtime',
      description: '组织说明',
      url: 'https://mcp.example.com/base',
      headerKeys: ['Authorization'],
    })

    await expect(service.saveManualConnection({
      connectionId: mirrored.id,
      name: 'Org Runtime - 我的配置',
      description: '需要租户信息',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/member',
        headers: {
          Authorization: '',
          'X-Tenant': 'tenant-a',
        },
      },
      enabled: true,
    })).resolves.toMatchObject({
      name: 'Org Runtime - 我的配置',
      description: '需要租户信息',
      url: 'https://mcp.example.com/member',
      headerKeys: ['Authorization', 'X-Tenant'],
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          endpoint: 'https://mcp.example.com/live',
          headers: { Authorization: 'Bearer organization-secret' },
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      (service as unknown as {
        resolveRuntimeTransport: (connection: unknown) => Promise<unknown>
        loadStore: () => { connections: unknown[] }
      }).resolveRuntimeTransport(
        (service as unknown as { loadStore: () => { connections: unknown[] } })
          .loadStore().connections[0],
      ),
    ).resolves.toEqual({
      kind: 'http',
      url: 'https://mcp.example.com/member',
      headers: {
        Authorization: 'Bearer organization-secret',
        'X-Tenant': 'tenant-a',
      },
    })

    vi.unstubAllGlobals()
    await service.dispose()
  })

  it('shareConnectionToOrganization 在 main 内 POST，不依赖 renderer 读密', async () => {
    const service = new LocalMcpService()
    const manual = await service.saveManualConnection({
      name: 'share-me',
      description: '共享测',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/share',
        headers: { Authorization: 'Bearer share-secret' },
      },
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: { id: 'org-new-1', name: 'share-me' },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      service.shareConnectionToOrganization(manual.id, 'org-11111111-1111-1111-1111-111111111111'),
    ).resolves.toEqual({ id: 'org-new-1', name: 'share-me' })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/context/organizations/org-11111111-1111-1111-1111-111111111111/mcp-connections'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Bearer share-secret'),
      }),
    )
    // 默认详情对 renderer 仍 redact
    const publicDetail = await service.getConnectionDetail(manual.id)
    expect(publicDetail.transport.kind === 'http' && publicDetail.transport.headers?.Authorization).toBe('***')

    vi.unstubAllGlobals()
    await service.dispose()
  })

  it('卸载会清掉该 URL 的 mcp-remote 授权缓存', async () => {
    const service = new LocalMcpService()
    const connection = await service.saveManualConnection({
      name: 'stripe',
      transport: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.stripe.com'],
      },
    })

    await service.deleteConnection(connection.id)

    expect(clearMcpRemoteAuth).toHaveBeenCalledWith('https://mcp.stripe.com')
    await service.dispose()
  })

  it('同 URL 还有另一条连接时卸载不删授权缓存', async () => {
    const service = new LocalMcpService()
    const first = await service.saveManualConnection({
      name: 'stripe-a',
      transport: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.stripe.com'],
      },
    })
    await service.saveManualConnection({
      name: 'stripe-b',
      transport: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.stripe.com'],
      },
    })

    await service.deleteConnection(first.id)

    expect(clearMcpRemoteAuth).not.toHaveBeenCalled()
    await service.dispose()
  })
})
