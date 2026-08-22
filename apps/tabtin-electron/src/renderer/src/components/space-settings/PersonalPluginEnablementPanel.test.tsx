import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  getPersonalPluginRuntimeStatus: vi.fn(),
  listPersonalPluginEnablement: vi.fn(),
  setPersonalPluginEnabled: vi.fn(),
  stopPersonalPluginRuntime: vi.fn(),
}))
const toastMock = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, vars?: Record<string, unknown>) => String(vars?.defaultValue ?? _key),
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>{children}</button>
  ),
  EmptyState: ({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) => (
    <div>
      <p>{title}</p>
      {description ? <p>{description}</p> : null}
    </div>
  ),
  StatusNotice: ({ description }: { description: React.ReactNode }) => <p>{description}</p>,
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean
    disabled?: boolean
    onCheckedChange: (checked: boolean) => void
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
  toast: toastMock,
}))

vi.mock('@/services/personalPluginMarketplaceClient', () => client)

const superpowersRecord = {
  pluginId: 'superpowers',
  source: {
    kind: 'codex-compatible-directory',
    uri: 'official://tabtin/superpowers',
    versionPin: '2026.06.23',
  },
  versionPin: '2026.06.23',
  installPath: '/tmp/superpowers',
  installedAt: '2026-06-22T15:00:00.000Z',
  enabled: false,
  capabilityManifest: {
    plugin: {
      id: 'superpowers',
      name: 'Superpowers',
      description: 'Planning, TDD, debugging, and delivery workflows for coding agents.',
      version: '5.1.3',
    },
    source: {
      kind: 'codex-compatible-directory',
      uri: 'official://tabtin/superpowers',
      versionPin: '2026.06.23',
    },
    skills: [
      { id: 'brainstorming', path: 'skills/brainstorming', skillMdPath: 'skills/brainstorming/SKILL.md' },
      { id: 'dispatching-parallel-agents', path: 'skills/dispatching-parallel-agents', skillMdPath: 'skills/dispatching-parallel-agents/SKILL.md' },
      { id: 'executing-plans', path: 'skills/executing-plans', skillMdPath: 'skills/executing-plans/SKILL.md' },
      { id: 'systematic-debugging', path: 'skills/systematic-debugging', skillMdPath: 'skills/systematic-debugging/SKILL.md' },
      { id: 'test-driven-development', path: 'skills/test-driven-development', skillMdPath: 'skills/test-driven-development/SKILL.md' },
    ],
    declaredHooks: [],
    scripts: [],
    assets: [],
    apps: [],
    localServices: [],
    files: { codexPluginJson: '.codex-plugin/plugin.json' },
    warnings: [],
  },
}

beforeEach(() => {
  toastMock.mockClear()
  client.listPersonalPluginEnablement.mockReset()
  client.setPersonalPluginEnabled.mockReset()
  client.getPersonalPluginRuntimeStatus.mockReset()
  client.stopPersonalPluginRuntime.mockReset()
  client.listPersonalPluginEnablement.mockResolvedValue([superpowersRecord])
  client.setPersonalPluginEnabled.mockImplementation(async (
    _organizationId: string,
    _spaceId: string,
    _pluginId: string,
    enabled: boolean,
  ) => ({ ...superpowersRecord, enabled }))
  client.getPersonalPluginRuntimeStatus.mockResolvedValue({
    runtimeId: 'personal-plugin:wt-1:sp-1:sp-1:superpowers',
    state: 'stopped',
    organizationId: 'wt-1',
    spaceId: 'sp-1',
    pluginId: 'superpowers',
  })
  client.stopPersonalPluginRuntime.mockResolvedValue({
    runtimeId: 'personal-plugin:wt-1:sp-1:sp-1:superpowers',
    state: 'stopped',
    organizationId: 'wt-1',
    spaceId: 'sp-1',
    pluginId: 'superpowers',
    mcp: { state: 'detached', serverCount: 0, tools: [] },
  })
})

describe('PersonalPluginEnablementPanel', () => {
  it('lists installed Personal Plugins and toggles whole-plugin enablement for the Agent Space', async () => {
    render(<PersonalPluginEnablementPanel organizationId="wt-1" spaceId="sp-1" />)

    expect(await screen.findByText('Personal Plugins')).not.toBeNull()
    const card = screen.getByText('Superpowers').closest('article') as HTMLElement
    expect(within(card).getByText('skill:brainstorming')).not.toBeNull()
    expect(within(card).getByText('skill:dispatching-parallel-agents')).not.toBeNull()
    expect(within(card).getByText('skill:executing-plans')).not.toBeNull()
    expect(screen.getByText('启用或禁用后只在新对话生效；当前对话不会热加载插件上下文。')).not.toBeNull()

    const toggle = within(card).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(client.setPersonalPluginEnabled).toHaveBeenCalledWith('wt-1', 'sp-1', 'superpowers', true)
    })
    expect(await within(card).findByText('已启用')).not.toBeNull()
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: '变更只会在新对话中生效，当前对话不会热加载。',
    }))
  })

  it('shows runtime URL, projectDir, MCP tools and stops a running plugin explicitly', async () => {
    client.listPersonalPluginEnablement.mockResolvedValue([{
      ...superpowersRecord,
      pluginId: 'cowart',
      enabled: true,
      capabilityManifest: {
        ...superpowersRecord.capabilityManifest,
        plugin: { id: 'cowart', name: 'Cowart', description: 'Canvas runtime.', version: '0.4.1' },
        mcp: { path: '.mcp.json', serverCount: 1, raw: {} },
        localServices: [{ id: 'preview-server', command: 'pnpm preview' }],
      },
    }])
    client.getPersonalPluginRuntimeStatus.mockResolvedValue({
      runtimeId: 'personal-plugin:wt-1:sp-1:sp-1:cowart',
      state: 'running',
      organizationId: 'wt-1',
      spaceId: 'sp-1',
      pluginId: 'cowart',
      url: 'http://127.0.0.1:43217/',
      projectDir: '/Users/seda/project',
      process: { processId: 'fake-1', command: 'pnpm preview', cwd: '/tmp/cowart' },
      mcp: {
        state: 'attached',
        serverCount: 1,
        tools: [{ name: 'mcp_cowart_read_selection', inputSchema: {}, isReadOnly: true }],
      },
    })
    render(<PersonalPluginEnablementPanel organizationId="wt-1" spaceId="sp-1" />)

    const card = (await screen.findByText('Cowart')).closest('article') as HTMLElement
    expect(within(card).getByText('running')).not.toBeNull()
    expect(within(card).getByText('http://127.0.0.1:43217/')).not.toBeNull()
    expect(within(card).getByText('/Users/seda/project')).not.toBeNull()
    expect(within(card).getByText('mcp_cowart_read_selection')).not.toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: '停止' }))
    await waitFor(() => {
      expect(client.stopPersonalPluginRuntime).toHaveBeenCalledWith({
        organizationId: 'wt-1',
        spaceId: 'sp-1',
        pluginId: 'cowart',
      })
    })
    await waitFor(() => {
      expect(within(card).getAllByText('stopped').length).toBeGreaterThan(0)
    })
  })

  it('does not auto-enable anything when no Personal Plugin is installed', async () => {
    client.listPersonalPluginEnablement.mockResolvedValue([])
    render(<PersonalPluginEnablementPanel organizationId="wt-1" spaceId="sp-1" />)

    expect(await screen.findByText('还没有安装 Personal Plugin')).not.toBeNull()
    expect(screen.getByText('先到 Marketplace 安装 Superpowers，再回到这里为这个 Agent 启用。')).not.toBeNull()
    expect(client.setPersonalPluginEnabled).not.toHaveBeenCalled()
  })
})

import { PersonalPluginEnablementPanel } from './PersonalPluginEnablementPanel'
