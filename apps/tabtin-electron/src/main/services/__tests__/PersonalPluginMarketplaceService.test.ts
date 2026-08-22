import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

// （硬切）：组织级 Personal Plugin 存储必须要有真实 userId，测试统一伪造
// 已登录用户，避免每条用例都要单独兜底鉴权。
vi.mock('../../auth.js', () => ({
  TokenManager: {
    getUserInfo: vi.fn(async () => ({ id: 'user-1' })),
    getAccessToken: vi.fn(async () => 'fake-token'),
  },
}))

vi.mock('@tabtin/terminal-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/terminal-core')>()
  return {
    ...actual,
    resolveDataRoot: () => '/tmp/tabtin-test-data-root',
  }
})

vi.mock('@tabtin/agent-runtime/plugins', () => ({
  approvePersonalPluginGithubUpdate: vi.fn(),
  checkPersonalPluginGithubUpdate: vi.fn(),
  createDefaultPersonalPluginProcessAdapter: () => ({ start: vi.fn(), stop: vi.fn() }),
  installPersonalPluginFromCodexDirectory: vi.fn(),
  listPersonalPluginEnablement: vi.fn(),
  listInstalledPersonalPlugins: vi.fn(),
  setPersonalPluginEnabled: vi.fn(),
  uninstallPersonalPlugin: vi.fn(),
  PersonalPluginRuntimeManager: class {
    launch = vi.fn()
    getStatus = vi.fn()
    stop = vi.fn()
  },
}))

describe('PersonalPluginMarketplaceService runtime IPC seam', () => {
  it('launches Cowart through the runtime manager with marketplace install scope', async () => {
    const launch = vi.fn(async () => ({
      runtimeId: 'personal-plugin:wt-1:space-1:agent-1:cowart',
      state: 'running' as const,
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
      url: 'http://127.0.0.1:43217/',
    }))
    const { launchAgentPersonalPluginRuntime } = await import('../PersonalPluginMarketplaceService')

    const status = await launchAgentPersonalPluginRuntime(
      {
        organizationId: ' wt-1 ',
        spaceId: ' space-1 ',
        agentId: 'agent-1',
        pluginId: ' cowart ',
        title: 'Cowart',
      },
      {
        runtimeManager: { launch, getStatus: vi.fn(), stop: vi.fn() },
        resolveProjectDir: () => '/tmp/trusted-space-root',
      },
    )

    expect(status).toMatchObject({ state: 'running', url: 'http://127.0.0.1:43217/' })
    expect(launch).toHaveBeenCalledWith({
      organizationId: 'wt-1',
      userId: 'user-1',
      dataRoot: '/tmp/tabtin-test-data-root',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
      projectDir: '/tmp/trusted-space-root',
      serviceId: undefined,
      title: 'Cowart',
      openBrowser: undefined,
      requireMcp: undefined,
    })
  })

  it('passes requireMcp through launch for diagnostic all-or-nothing MCP startup', async () => {
    const launch = vi.fn(async () => ({ state: 'running' as const }))
    const { launchAgentPersonalPluginRuntime } = await import('../PersonalPluginMarketplaceService')

    await launchAgentPersonalPluginRuntime(
      {
        organizationId: 'wt-1',
        spaceId: 'space-1',
        pluginId: 'cowart',
        requireMcp: true,
      },
      {
        runtimeManager: { launch, getStatus: vi.fn(), stop: vi.fn() },
        resolveProjectDir: () => '/tmp/trusted-space-root',
      },
    )

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ requireMcp: true }))
  })

  it('rejects unsafe organization and space ids before resolving plugin paths', async () => {
    const { launchAgentPersonalPluginRuntime } = await import('../PersonalPluginMarketplaceService')

    await expect(launchAgentPersonalPluginRuntime(
      {
        organizationId: '../wt-1',
        spaceId: 'space-1',
        pluginId: 'cowart',
      },
      { runtimeManager: { launch: vi.fn(), getStatus: vi.fn(), stop: vi.fn() } },
    )).rejects.toThrow(/Invalid organizationId/)
  })

  it('keeps plugin MCP cwd inside the plugin install path', async () => {
    const { resolvePersonalPluginMcpCwd } = await import('../PersonalPluginMarketplaceService')

    expect(resolvePersonalPluginMcpCwd('/tmp/plugin/cowart', undefined)).toBe('/tmp/plugin/cowart')
    expect(resolvePersonalPluginMcpCwd('/tmp/plugin/cowart', 'mcp')).toBe('/tmp/plugin/cowart/mcp')
    expect(() => resolvePersonalPluginMcpCwd('/tmp/plugin/cowart', '../other')).toThrow(/escapes install path/)
    expect(() => resolvePersonalPluginMcpCwd('/tmp/plugin/cowart', '/tmp/other')).toThrow(/escapes install path/)
  })

  it('exposes status and explicit stop through the runtime manager', async () => {
    const getStatus = vi.fn(() => ({
      runtimeId: 'personal-plugin:wt-1:space-1:space-1:cowart',
      state: 'running' as const,
      organizationId: 'wt-1',
      spaceId: 'space-1',
      pluginId: 'cowart',
      url: 'http://127.0.0.1:43217/',
    }))
    const stop = vi.fn(async () => ({
      runtimeId: 'personal-plugin:wt-1:space-1:space-1:cowart',
      state: 'stopped' as const,
      organizationId: 'wt-1',
      spaceId: 'space-1',
      pluginId: 'cowart',
    }))
    const {
      getAgentPersonalPluginRuntimeStatus,
      stopAgentPersonalPluginRuntime,
    } = await import('../PersonalPluginMarketplaceService')
    const deps = { runtimeManager: { launch: vi.fn(), getStatus, stop } }
    const input = { organizationId: 'wt-1', spaceId: 'space-1', pluginId: 'cowart' }

    expect(getAgentPersonalPluginRuntimeStatus(input, deps)).toMatchObject({ state: 'running' })
    await expect(stopAgentPersonalPluginRuntime(input, deps)).resolves.toMatchObject({ state: 'stopped' })

    const scope = {
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: undefined,
      pluginId: 'cowart',
    }
    expect(getStatus).toHaveBeenCalledWith(scope)
    expect(stop).toHaveBeenCalledWith(scope)
  })

  it('exposes MCP tool listing and calls through the scoped runtime manager contract', async () => {
    const listMcpTools = vi.fn(() => [{
      name: 'mcp_cowart_read_selection',
      inputSchema: {},
      isReadOnly: true,
    }])
    const callMcpTool = vi.fn(async () => ({ ok: true }))
    const {
      listAgentPersonalPluginMcpTools,
      callAgentPersonalPluginMcpTool,
    } = await import('../PersonalPluginMarketplaceService')
    const deps = {
      runtimeManager: {
        launch: vi.fn(),
        getStatus: vi.fn(),
        stop: vi.fn(),
        listMcpTools,
        callMcpTool,
      },
    }

    expect(listAgentPersonalPluginMcpTools({
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
    }, deps)).toEqual([expect.objectContaining({ name: 'mcp_cowart_read_selection' })])
    await expect(callAgentPersonalPluginMcpTool({
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
      toolName: 'mcp_cowart_read_selection',
      input: { selection: true },
    }, deps)).resolves.toEqual({ ok: true })

    expect(callMcpTool).toHaveBeenCalledWith({
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
      toolName: 'mcp_cowart_read_selection',
      input: { selection: true },
    })
  })

  it('checks official release updates without auto-applying and confirms updates explicitly', async () => {
    const plugins = await import('@tabtin/agent-runtime/plugins')
    const installedPlugin = {
      pluginId: 'cowart',
      source: {
        kind: 'codex-compatible-directory',
        uri: 'official://tabtin/cowart',
        versionPin: '0.1.1',
      },
      versionPin: '0.1.1',
      upstream: {
        packageName: 'cowart',
        version: '0.1.1',
        repository: 'https://github.com/zhongerxin/cowart',
        commit: 'v0.1.1',
      },
      officialRelease: {
        id: 'tabtin-official:cowart:0.1.1',
        version: '0.1.1',
        channel: 'stable' as const,
      },
      adapter: {
        id: 'tabtin-cowart-adapter',
        version: '0.1.0',
      },
      installPath: '/tmp/cowart',
      installedAt: '2026-06-22T15:00:00.000Z',
      capabilityManifest: {
        plugin: { id: 'cowart', name: 'Cowart' },
        source: {
          kind: 'codex-compatible-directory',
          uri: 'official://tabtin/cowart',
          versionPin: '0.1.1',
        },
        skills: [],
        declaredHooks: [],
        scripts: [],
        assets: [],
        apps: [],
        localServices: [],
        files: {},
        warnings: [],
      },
    }
    vi.mocked(plugins.listInstalledPersonalPlugins).mockResolvedValue([installedPlugin])
    vi.mocked(plugins.installPersonalPluginFromCodexDirectory).mockResolvedValue({
      ...installedPlugin,
      versionPin: '0.1.2',
      officialRelease: {
        id: 'tabtin-official:cowart:0.1.2',
        version: '0.1.2',
        channel: 'stable' as const,
      },
    })
    const {
      checkMarketplacePersonalPluginUpdate,
      confirmMarketplacePersonalPluginUpdate,
    } = await import('../PersonalPluginMarketplaceService')

    await expect(checkMarketplacePersonalPluginUpdate({
      organizationId: 'wt-1',
      pluginId: 'cowart',
    })).resolves.toMatchObject({
      status: 'update-available',
      candidate: { releaseId: 'tabtin-official:cowart:0.1.2' },
    })
    expect(plugins.installPersonalPluginFromCodexDirectory).not.toHaveBeenCalled()

    await confirmMarketplacePersonalPluginUpdate({ organizationId: 'wt-1', pluginId: 'cowart' })
    expect(plugins.installPersonalPluginFromCodexDirectory).toHaveBeenCalledWith(expect.objectContaining({
      sourceUri: 'official://tabtin/cowart',
      versionPin: '0.1.2',
      organizationId: 'wt-1',
      userId: 'user-1',
      dataRoot: '/tmp/tabtin-test-data-root',
      officialRelease: expect.objectContaining({ id: 'tabtin-official:cowart:0.1.2' }),
    }))
  })

  it('does not offer governed updates for arbitrary GitHub imports', async () => {
    const plugins = await import('@tabtin/agent-runtime/plugins')
    vi.mocked(plugins.installPersonalPluginFromCodexDirectory).mockClear()
    vi.mocked(plugins.listInstalledPersonalPlugins).mockResolvedValue([{
      pluginId: 'cowart',
      source: {
        kind: 'github',
        uri: 'https://github.com/acme/cowart.git',
        repoUrl: 'https://github.com/acme/cowart.git',
        ref: 'main',
        commit: '1111111',
      },
      commit: '1111111',
      installPath: '/tmp/cowart',
      installedAt: '2026-06-22T15:00:00.000Z',
      capabilityManifest: {
        plugin: { id: 'cowart', name: 'Cowart' },
        source: { kind: 'github', uri: 'https://github.com/acme/cowart.git' },
        skills: [],
        declaredHooks: [],
        scripts: [],
        assets: [],
        apps: [],
        localServices: [],
        files: {},
        warnings: [],
      },
    }])
    const { checkMarketplacePersonalPluginUpdate } = await import('../PersonalPluginMarketplaceService')

    await expect(checkMarketplacePersonalPluginUpdate({
      organizationId: 'wt-1',
      pluginId: 'cowart',
    })).resolves.toMatchObject({ status: 'not-official' })
    expect(plugins.installPersonalPluginFromCodexDirectory).not.toHaveBeenCalled()
  })

  it('uninstalls marketplace Personal Plugin from the marketplace install scope', async () => {
    const plugins = await import('@tabtin/agent-runtime/plugins')
    vi.mocked(plugins.uninstallPersonalPlugin).mockResolvedValue({ removed: true })
    const stopAllForPlugin = vi.fn(async () => [])
    const { uninstallMarketplacePersonalPlugin } = await import('../PersonalPluginMarketplaceService')

    await expect(uninstallMarketplacePersonalPlugin({
      organizationId: 'wt-1',
      pluginId: 'superpowers',
    }, {
      runtimeManager: {
        launch: vi.fn(),
        getStatus: vi.fn(),
        stop: vi.fn(),
        stopAllForPlugin,
      },
    })).resolves.toEqual({ removed: true })

    expect(stopAllForPlugin).toHaveBeenCalledWith({
      organizationId: 'wt-1',
      pluginId: 'superpowers',
    })
    expect(plugins.uninstallPersonalPlugin).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'wt-1',
      userId: 'user-1',
      pluginId: 'superpowers',
    }))
  })
})
