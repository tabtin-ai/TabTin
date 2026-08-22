import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'
import enSettings from '@/i18n/locales/en-US/settings.json'

const setRoute = vi.fn()
const personalPluginClient = vi.hoisted(() => ({
  checkPersonalPluginUpdate: vi.fn(),
  confirmPersonalPluginUpdate: vi.fn(),
  listInstalledPersonalPlugins: vi.fn(),
  installOfficialPersonalPlugin: vi.fn(),
  uninstallPersonalPlugin: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

/** 英文断言走 en-US locale，避免测试 mock 中英混写 */
const enAppMarket = enSettings.appMarket
const enPluginMarketplace = enSettings.pluginMarketplace

const translations: Record<string, string> = {
  // 统一应用市场文案（结构键用中文标签；产品句读 en-US）
  'appMarket.title': '应用市场',
  'appMarket.subtitle': enAppMarket.subtitle,
  'appMarket.collaborativeSection': '组织共享',
  'appMarket.collaborativeSectionDesc': enAppMarket.collaborativeSectionDesc,
  'appMarket.localSection': '本机应用',
  'appMarket.localSectionDesc': enAppMarket.localSectionDesc,
  'appMarket.surface.builtin': '内置',
  'appMarket.surface.local': '本机',
  'appMarket.surface.collaborative': '协作',
  // 本机插件市场文案
  'pluginMarketplace.title': enPluginMarketplace.title,
  'pluginMarketplace.subtitle': enPluginMarketplace.subtitle,
  'pluginMarketplace.localSubtitle': enPluginMarketplace.localSubtitle,
  'pluginMarketplace.installedSubtitle': 'View personal plugins installed for Team One.',
  'pluginMarketplace.marketplaceTab': '插件市场',
  'pluginMarketplace.installedTab': '已安装',
  'pluginMarketplace.searchPlaceholder': enPluginMarketplace.searchPlaceholder,
  'pluginMarketplace.installedPersonalPlugins': enPluginMarketplace.installedPersonalPlugins,
  'pluginMarketplace.installedPersonalPluginsDesc': enPluginMarketplace.installedPersonalPluginsDesc,
  'pluginMarketplace.installedEmptyTitle': enPluginMarketplace.installedEmptyTitle,
  'pluginMarketplace.installedEmptyDesc': 'Installed plugins will appear here.',
  'pluginMarketplace.officialBadge': enPluginMarketplace.officialBadge,
  'pluginMarketplace.installedBadge': enPluginMarketplace.installedBadge,
  'pluginMarketplace.personalPlugin': enPluginMarketplace.personalPlugin,
  'pluginMarketplace.installedReady': enPluginMarketplace.installedReady,
  'pluginMarketplace.install': enPluginMarketplace.install,
  'pluginMarketplace.installing': enPluginMarketplace.installing,
  'pluginMarketplace.installedAction': enPluginMarketplace.installedAction,
  'pluginMarketplace.sourceLabel': enPluginMarketplace.sourceLabel,
  'pluginMarketplace.versionLabel': enPluginMarketplace.versionLabel,
  'pluginMarketplace.repoLabel': enPluginMarketplace.repoLabel,
  'pluginMarketplace.refLabel': enPluginMarketplace.refLabel,
  'pluginMarketplace.commitLabel': enPluginMarketplace.commitLabel,
  'pluginMarketplace.versionPinLabel': enPluginMarketplace.versionPinLabel,
  'pluginMarketplace.officialReleaseLabel': enPluginMarketplace.officialReleaseLabel,
  'pluginMarketplace.officialVersionLabel': enPluginMarketplace.officialVersionLabel,
  'pluginMarketplace.channelLabel': enPluginMarketplace.channelLabel,
  'pluginMarketplace.upstreamRepoLabel': enPluginMarketplace.upstreamRepoLabel,
  'pluginMarketplace.upstreamVersionLabel': enPluginMarketplace.upstreamVersionLabel,
  'pluginMarketplace.upstreamRevisionLabel': enPluginMarketplace.upstreamRevisionLabel,
  'pluginMarketplace.adapterLabel': enPluginMarketplace.adapterLabel,
  'pluginMarketplace.versionUnknown': enPluginMarketplace.versionUnknown,
  'pluginMarketplace.checkUpdateAction': enPluginMarketplace.checkUpdateAction,
  'pluginMarketplace.checkingUpdate': enPluginMarketplace.checkingUpdate,
  'pluginMarketplace.updateAction': enPluginMarketplace.updateAction,
  'pluginMarketplace.updating': enPluginMarketplace.updating,
  'pluginMarketplace.updateAvailableNotice': '{{name}} has official release {{release}} available.',
  'pluginMarketplace.updateUpToDateNotice': enPluginMarketplace.updateUpToDateNotice,
  'pluginMarketplace.updateNotOfficialNotice': '{{name}} is not an official release.',
  'pluginMarketplace.updateCheckFailedNotice': enPluginMarketplace.updateCheckFailedNotice,
  'pluginMarketplace.confirmUpdatePrompt': enPluginMarketplace.confirmUpdatePrompt,
  'pluginMarketplace.updateSuccessNotice': enPluginMarketplace.updateSuccessNotice,
  'pluginMarketplace.updateFailedNotice': enPluginMarketplace.updateFailedNotice,
  'pluginMarketplace.uninstallAction': enPluginMarketplace.uninstallAction,
  'pluginMarketplace.uninstalling': enPluginMarketplace.uninstalling,
  'pluginMarketplace.confirmUninstallPrompt': 'Uninstall {{name}}?',
  'pluginMarketplace.uninstallSuccessNotice': enPluginMarketplace.uninstallSuccessNotice,
  'pluginMarketplace.uninstallFailedNotice': enPluginMarketplace.uninstallFailedNotice,
  'pluginMarketplace.installSuccessNotice': enPluginMarketplace.installSuccessNotice,
  'pluginMarketplace.alreadyInstalledNotice': enPluginMarketplace.alreadyInstalledNotice,
  'pluginMarketplace.installFailedNotice': enPluginMarketplace.installFailedNotice,
  'pluginMarketplace.loadFailed': enPluginMarketplace.loadFailed,
  'pluginMarketplace.noSearchResults': enPluginMarketplace.noSearchResults,
  'pluginMarketplace.categoryPersonal': 'Personal plugin',
  'sections.organizationApps': '应用市场',
  'sections.organizationExtensions': '插件市场',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      let value = translations[key] ?? key
      for (const [name, replacement] of Object.entries(vars ?? {})) {
        value = value.replaceAll(`{{${name}}}`, replacement)
      }
      return value
    },
  }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: { setRoute: typeof setRoute }) => unknown) =>
    selector({ setRoute }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>{children}</button>
  ),
  EmptyState: ({
    title,
    description,
  }: {
    title: React.ReactNode
    description?: React.ReactNode
  }) => (
    <div>
      <p>{title}</p>
      {description ? <p>{description}</p> : null}
    </div>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Skeleton: ({ className }: { className?: string }) => <div className={className}>loading</div>,
  TabsRoot: ({
    children,
  }: {
    value: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children }: { value: string; children: React.ReactNode }) => (
    <button type="button" role="tab">{children}</button>
  ),
  TabsContent: ({ children }: { value: string; children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: toastMock,
}))

vi.mock('@services/personalPluginMarketplaceClient', () => personalPluginClient)

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// 协作分区（后端 catalog）在统一市场里以子面板嵌入，这里 mock 掉，聚焦本机市场逻辑。
vi.mock('./OrganizationAppCatalogPanel', async () => {
  const React = await import('react')
  const { SettingsPanelHeader, useCompositeTabActive } = await import('../SettingsPanelHeader')
  return {
    OrganizationAppCatalogPanel: ({
      organization,
      showHeader = true,
    }: {
      organization: Organization
      showHeader?: boolean
    }) => {
      const showFooter = useCompositeTabActive()
      return React.createElement(
        'div',
        { 'data-organization-id': organization.id },
        showHeader && showFooter
          ? React.createElement(SettingsPanelHeader, {
              icon: React.createElement('span'),
              title: 'App Marketplace',
            })
          : null,
        React.createElement('div', { 'data-testid': 'organization-app-catalog' }, 'App Marketplace'),
      )
    },
  }
})

const organization = {
  id: 'team-1',
  name: 'Team One',
} as Organization

const superpowersRecord = {
  pluginId: 'superpowers',
  source: {
    kind: 'codex-compatible-directory',
    uri: 'official://tabtin/superpowers',
    versionPin: '2026.06.23',
  },
  versionPin: '2026.06.23',
  upstream: {
    packageName: 'superpowers',
    version: '5.1.3',
    repository: 'https://github.com/obra/superpowers',
    commit: 'superpowers-5.1.3',
  },
  officialRelease: {
    id: 'tabtin-official:superpowers:2026.06.23',
    version: '2026.06.23',
    channel: 'stable',
  },
  adapter: {
    id: 'tabtin-superpowers-adapter',
    version: '0.1.0',
  },
  installPath: '/tmp/platform/organizations/team-1/spaces/__marketplace__/plugins/installed/superpowers',
  installedAt: '2026-06-22T15:00:00.000Z',
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

const cowartGithubRecord = {
  pluginId: 'cowart',
  source: {
    kind: 'github',
    uri: 'https://github.com/acme/cowart.git',
    repoUrl: 'https://github.com/acme/cowart.git',
    ref: 'main',
    versionPin: 'main',
    commit: '1111111',
  },
  versionPin: 'main',
  commit: '1111111',
  installPath: '/tmp/platform/organizations/team-1/spaces/__marketplace__/plugins/installed/cowart',
  installedAt: '2026-06-22T15:00:00.000Z',
  capabilityManifest: {
    plugin: {
      id: 'cowart',
      name: 'Cowart',
      description: 'Cowart canvas runtime.',
      version: '0.4.1',
    },
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/cowart.git',
      repoUrl: 'https://github.com/acme/cowart.git',
      ref: 'main',
      versionPin: 'main',
      commit: '1111111',
    },
    skills: [{ id: 'cowart-open-canvas', path: 'skills/cowart-open-canvas', skillMdPath: 'skills/cowart-open-canvas/SKILL.md' }],
    mcp: { path: '.mcp.json', serverCount: 1, raw: {} },
    declaredHooks: [{ id: 'stop-summary', sourcePath: 'hooks.json', event: 'Stop', command: 'node scripts/hook.js', raw: {} }],
    scripts: [],
    assets: [],
    apps: [],
    localServices: [{ id: 'preview-server', command: 'pnpm preview' }],
    files: { codexPluginJson: '.codex-plugin/plugin.json', mcpJson: '.mcp.json', hooksJson: 'hooks.json' },
    warnings: [],
  },
}

const cowartOfficialRecord = {
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
    channel: 'stable',
  },
  adapter: {
    id: 'tabtin-cowart-adapter',
    version: '0.1.0',
  },
  installPath: '/tmp/platform/organizations/team-1/spaces/__marketplace__/plugins/installed/cowart',
  installedAt: '2026-06-22T15:00:00.000Z',
  capabilityManifest: {
    plugin: {
      id: 'cowart',
      name: 'Cowart',
      description: 'Cowart canvas runtime.',
      version: '0.1.1',
    },
    source: {
      kind: 'codex-compatible-directory',
      uri: 'official://tabtin/cowart',
      versionPin: '0.1.1',
    },
    skills: [{ id: 'cowart-open-canvas', path: 'skills/cowart-open-canvas', skillMdPath: 'skills/cowart-open-canvas/SKILL.md' }],
    mcp: { path: '.mcp.json', serverCount: 1, raw: {} },
    declaredHooks: [],
    scripts: [],
    assets: [],
    apps: [],
    localServices: [{ id: 'canvas', command: 'bash ./scripts/start-canvas.sh' }],
    files: { codexPluginJson: '.codex-plugin/plugin.json', mcpJson: '.mcp.json' },
    warnings: [],
  },
}

beforeEach(() => {
  setRoute.mockClear()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
  personalPluginClient.listInstalledPersonalPlugins.mockReset()
  personalPluginClient.installOfficialPersonalPlugin.mockReset()
  personalPluginClient.uninstallPersonalPlugin.mockReset()
  personalPluginClient.checkPersonalPluginUpdate.mockReset()
  personalPluginClient.confirmPersonalPluginUpdate.mockReset()
  personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([])
  personalPluginClient.installOfficialPersonalPlugin.mockResolvedValue({
    status: 'installed',
    plugin: superpowersRecord,
  })
  personalPluginClient.uninstallPersonalPlugin.mockResolvedValue({ removed: true })
  personalPluginClient.checkPersonalPluginUpdate.mockResolvedValue({
    status: 'up-to-date',
    pluginId: 'superpowers',
    current: {},
  })
})

describe('LocalPluginMarketplacePanel', () => {
  it('renders only local personal plugins with a green Local surface badge and no built-in cards', async () => {
    const { container } = render(<LocalPluginMarketplacePanel organization={organization} />)

    // 内置能力已移出市场：不再出现任何 builtin 卡片。
    expect(container.querySelectorAll('[data-plugin-kind="builtin"]')).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: 'Code' })).toBeNull()

    // 只剩本机 Personal Plugin（Cowart），带绿色「本机」形态角标。
    const cowartCard = screen.getByRole('heading', { name: 'Cowart' }).closest('article') as HTMLElement
    expect(cowartCard.dataset.pluginSurface).toBe('local')
    expect(within(cowartCard).getByText('本机')).not.toBeNull()
    await waitFor(() => {
      expect(personalPluginClient.listInstalledPersonalPlugins).toHaveBeenCalledWith('team-1')
    })
  })

  it('shows the official Cowart personal plugin with an enabled install button', async () => {
    render(<LocalPluginMarketplacePanel organization={organization} />)

    const cowartCard = screen.getByRole('heading', { name: 'Cowart' }).closest('article') as HTMLElement

    expect(cowartCard).not.toBeNull()
    expect(within(cowartCard).getByText('Official')).not.toBeNull()
    expect(within(cowartCard).getByText('本机')).not.toBeNull()
    expect(within(cowartCard).getByRole('button', { name: /Install/ })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('heading', { name: 'Superpowers' })).toBeNull()
    await waitFor(() => {
      expect(personalPluginClient.listInstalledPersonalPlugins).toHaveBeenCalledWith('team-1')
    })
  })

  it('installs Cowart, shows light enablement guidance and does not auto-enable a Workspace', async () => {
    personalPluginClient.installOfficialPersonalPlugin.mockResolvedValue({
      status: 'installed',
      plugin: cowartOfficialRecord,
    })
    render(<LocalPluginMarketplacePanel organization={organization} />)

    const cowartCard = screen.getByRole('heading', { name: 'Cowart' }).closest('article') as HTMLElement
    fireEvent.click(within(cowartCard).getByRole('button', { name: /Install/ }))

    const installNotice = enPluginMarketplace.installSuccessNotice.replaceAll('{{name}}', 'Cowart')
    expect(await screen.findByText(installNotice)).not.toBeNull()
    expect(personalPluginClient.installOfficialPersonalPlugin).toHaveBeenCalledWith('team-1', 'cowart')
    expect(toastMock.success).toHaveBeenCalled()
    expect(setRoute).not.toHaveBeenCalled()
    await waitFor(() => {
      const updatedCard = screen.getByRole('heading', { name: 'Cowart' }).closest('article')
      expect(within(updatedCard as HTMLElement).getByRole('button', { name: /Installed/ })).toHaveProperty('disabled', true)
    })
  })

  it('renders installed official Superpowers with release, upstream and capability summary', async () => {
    personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([superpowersRecord])
    render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    expect(screen.getByText('Installed Personal Plugins')).not.toBeNull()
    expect(await screen.findByRole('heading', { name: 'Superpowers' })).not.toBeNull()
    expect(screen.getByText('official://tabtin/superpowers')).not.toBeNull()
    expect(screen.getByText('tabtin-official:superpowers:2026.06.23')).not.toBeNull()
    expect(screen.getByText('https://github.com/obra/superpowers')).not.toBeNull()
    expect(screen.getByText('superpowers-5.1.3')).not.toBeNull()
    expect(screen.getByText('tabtin-superpowers-adapter@0.1.0')).not.toBeNull()
    expect(screen.getByText('skill:brainstorming')).not.toBeNull()
    expect(screen.getByText('skill:dispatching-parallel-agents')).not.toBeNull()
    expect(screen.getByText('skill:executing-plans')).not.toBeNull()
  })

  it('clears installed personal plugins when switching organizations', async () => {
    personalPluginClient.listInstalledPersonalPlugins
      .mockResolvedValueOnce([superpowersRecord])
      .mockResolvedValueOnce([])

    const { rerender } = render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    expect(await screen.findByRole('heading', { name: 'Superpowers' })).not.toBeNull()

    rerender(
      <LocalPluginMarketplacePanel
        organization={{ id: 'team-2', name: 'Team Two' } as Organization}
        view="installed"
      />,
    )

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Superpowers' })).toBeNull()
    })
  })

  it('uninstalls installed Personal Plugin from the installed tab', async () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([superpowersRecord])
    render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    const card = (await screen.findByRole('heading', { name: 'Superpowers' })).closest('article') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /Uninstall/ }))

    await waitFor(() => {
      expect(personalPluginClient.uninstallPersonalPlugin).toHaveBeenCalledWith('team-1', 'superpowers')
    })
    expect(await screen.findByText('Superpowers uninstalled.')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Superpowers' })).toBeNull()
    confirmSpy.mockRestore()
  })

  it('shows official release pins and requires explicit confirmation before update', async () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([cowartOfficialRecord])
    personalPluginClient.checkPersonalPluginUpdate.mockResolvedValue({
      status: 'update-available',
      pluginId: 'cowart',
      current: {
        releaseId: 'tabtin-official:cowart:0.1.1',
        version: '0.1.1',
        upstreamVersion: '0.1.1',
        upstreamCommit: 'v0.1.1',
      },
      candidate: {
        releaseId: 'tabtin-official:cowart:0.1.2',
        version: '0.1.2',
        channel: 'stable',
        upstream: {
          packageName: 'cowart',
          version: '0.1.2',
          repository: 'https://github.com/zhongerxin/cowart',
          commit: 'v0.1.2',
        },
      },
    })
    personalPluginClient.confirmPersonalPluginUpdate.mockResolvedValue({
      ...cowartOfficialRecord,
      versionPin: '0.1.2',
      officialRelease: { ...cowartOfficialRecord.officialRelease, id: 'tabtin-official:cowart:0.1.2', version: '0.1.2' },
    })
    render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    const card = (await screen.findByRole('heading', { name: 'Cowart' })).closest('article') as HTMLElement
    expect(within(card).getByText('tabtin-official:cowart:0.1.1')).not.toBeNull()
    expect(within(card).getByText('https://github.com/zhongerxin/cowart')).not.toBeNull()
    expect(within(card).getByText('v0.1.1')).not.toBeNull()
    expect(within(card).getByText('mcp:1')).not.toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Check update' }))
    expect(await screen.findByText('Cowart has official release tabtin-official:cowart:0.1.2 available.')).not.toBeNull()
    expect(personalPluginClient.confirmPersonalPluginUpdate).not.toHaveBeenCalled()

    fireEvent.click(within(card).getByRole('button', { name: 'Update' }))
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled()
      expect(personalPluginClient.confirmPersonalPluginUpdate).toHaveBeenCalledWith('team-1', 'cowart')
    })
    confirmSpy.mockRestore()
  })

  it('keeps the installed official release visible when confirmed update fails', async () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([cowartOfficialRecord])
    personalPluginClient.checkPersonalPluginUpdate.mockResolvedValue({
      status: 'update-available',
      pluginId: 'cowart',
      current: { releaseId: 'tabtin-official:cowart:0.1.1', version: '0.1.1' },
      candidate: {
        releaseId: 'tabtin-official:cowart:0.1.2',
        version: '0.1.2',
        channel: 'stable',
        upstream: cowartOfficialRecord.upstream,
      },
    })
    personalPluginClient.confirmPersonalPluginUpdate.mockRejectedValue(new Error('copy failed'))
    render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    const card = (await screen.findByRole('heading', { name: 'Cowart' })).closest('article') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Check update' }))
    await screen.findByText('Cowart has official release tabtin-official:cowart:0.1.2 available.')
    fireEvent.click(within(card).getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Failed to update Cowart: copy failed')).not.toBeNull()
    expect(screen.getByText('tabtin-official:cowart:0.1.1')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Update' })).not.toBeNull()
    confirmSpy.mockRestore()
  })

  it('does not offer official update governance for arbitrary GitHub imports', async () => {
    personalPluginClient.listInstalledPersonalPlugins.mockResolvedValue([cowartGithubRecord])
    personalPluginClient.checkPersonalPluginUpdate.mockResolvedValue({
      status: 'not-official',
      pluginId: 'cowart',
      current: {},
    })
    render(<LocalPluginMarketplacePanel organization={organization} view="installed" />)

    const card = (await screen.findByRole('heading', { name: 'Cowart' })).closest('article') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Check update' }))

    expect(await screen.findByText('Cowart is not an official release.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })
})

describe('AppsIntegrationComposite unified app marketplace', () => {
  it('renders the unified App Marketplace (collaborative + local) on the apps tab', async () => {
    render(
      <AppsIntegrationComposite
        organization={organization}
        canManageOrganization
        activeSubsection="apps"
      />,
    )

    // 协作分区（后端 catalog，已 mock）
    expect(await screen.findByTestId('organization-app-catalog')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '本机应用' }))
    // 本机分区（Personal Plugin，Cowart）
    expect(await screen.findByRole('heading', { name: 'Cowart' })).not.toBeNull()
    // 旧集成中心 tab 不再存在
    expect(screen.queryByText('集成中心')).toBeNull()
  })

  it('keeps legacy appCatalog deep links on the unified App Marketplace tab', async () => {
    render(
      <AppsIntegrationComposite
        organization={organization}
        canManageOrganization
        activeSubsection="appCatalog"
      />,
    )

    expect(await screen.findByTestId('organization-app-catalog')).not.toBeNull()
  })

  it('routes legacy extensions deep links to the unified App Marketplace tab', async () => {
    render(
      <AppsIntegrationComposite
        organization={organization}
        canManageOrganization
        activeSubsection="extensions"
      />,
    )

    expect(await screen.findByRole('tab', { name: '本机应用' })).not.toBeNull()
    expect(screen.queryByTestId('organization-app-catalog')).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Cowart' })).not.toBeNull()
  })

  it('keeps installed personal plugin management reachable', async () => {
    render(
      <AppsIntegrationComposite
        organization={organization}
        canManageOrganization
        activeSubsection="installedExtensions"
      />,
    )

    expect(await screen.findByRole('tab', { name: '已安装' })).not.toBeNull()
    expect(await screen.findByText('Installed Personal Plugins')).not.toBeNull()
  })

  it('pre-mounts sibling tabs while showing the active marketplace tab', async () => {
    render(
      <AppsIntegrationComposite
        organization={organization}
        canManageOrganization
        activeSubsection="apps"
      />,
    )

    expect(await screen.findByTestId('organization-app-catalog')).not.toBeNull()
    expect(screen.getByText('Installed Personal Plugins', { hidden: true })).not.toBeNull()
  })
})

import { AppsIntegrationComposite } from './SettingsGroupComposites'
import { LocalPluginMarketplacePanel } from './LocalPluginMarketplacePanel'
