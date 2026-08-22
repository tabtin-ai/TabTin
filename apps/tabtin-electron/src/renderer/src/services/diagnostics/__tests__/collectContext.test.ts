import { describe, it, expect, beforeEach, vi } from 'vitest'
import { collectDiagnosticsMeta } from '../collectContext'

const spaceStoreState = {
  selectedSpace: null as { id: string; name: string; organization_id: string; type: string } | null,
  selectedAgent: null as { id: string; name: string } | null,
  spaces: [] as Array<{ id: string; name: string; organization_id: string; type: string }>,
}

const listStoreState = {
  selectedSpaceId: null as string | null,
  selectedSpaceKind: null as string | null,
  selectionByOrganization: {} as Record<string, { selectedSpaceId: string | null; selectedSpaceKind: string | null }>,
}

const organizationStoreState = {
  selectedOrganization: { id: 'wt-1', name: 'Team A' } as { id: string; name: string } | null,
}

vi.mock('@/utils/featureFlags', () => ({ BUILD_PROFILE: 'preprod' }))
vi.mock('@/services/errorReporter', () => ({
  getClientContextSnapshot: () => ({
    session_id: 'sess',
    device_id: 'dev',
    app_version: '0.0.17',
    os_name: 'macOS',
    os_version: '14',
    arch: 'arm64',
    locale: 'zh-CN',
  }),
}))
vi.stubEnv('VITE_GIT_COMMIT', 'e3646f2c8bd7')
vi.stubEnv('VITE_GIT_BRANCH', 'release-20260609-0.0.1')
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'u1', nickname: 'tester', username: 'tester', phone: '13800138000' } }),
  },
}))
vi.mock('@/services/sentry', () => ({
  isSentryEnabled: () => true,
  getRecentSentryEventIds: () => ['evt-1', 'evt-2'],
}))
vi.mock('@tabtin/app-shell', () => ({
  useOrganizationStore: { getState: () => organizationStoreState },
  useSpaceStore: { getState: () => spaceStoreState },
  useSpaceListStore: { getState: () => listStoreState },
  parseSpaceSelectionId: (id: string) => {
    const [, rawId] = id.split(':')
    return { rawId, kind: 'workspace' }
  },
}))

describe('collectDiagnosticsMeta', () => {
  beforeEach(() => {
    spaceStoreState.selectedSpace = null
    spaceStoreState.selectedAgent = null
    spaceStoreState.spaces = []
    listStoreState.selectedSpaceId = null
    listStoreState.selectedSpaceKind = null
    listStoreState.selectionByOrganization = {}
  })

  it('设置页清空 selectedSpace 时回退到 Space 列表选择', () => {
    spaceStoreState.spaces = [{
      id: 'sp-1',
      name: 'IDE',
      organization_id: 'wt-1',
      type: 'workspace',
    }]
    listStoreState.selectedSpaceId = 'workspace:sp-1'
    listStoreState.selectedSpaceKind = 'workspace'

    const meta = collectDiagnosticsMeta('settings')

    expect(meta.context.spaceId).toBe('sp-1')
    expect(meta.context.spaceName).toBe('IDE')
    expect(meta.context.organizationId).toBe('wt-1')
  })

  it('meta 携带 Sentry 互认信息', () => {
    const meta = collectDiagnosticsMeta('settings')

    expect(meta.sentry.enabled).toBe(true)
    expect(meta.sentry.recentEventIds).toEqual(['evt-1', 'evt-2'])
  })

  it('meta 携带构建期 git commit/branch', () => {
    const meta = collectDiagnosticsMeta('menu')

    expect(meta.gitCommit).toBe('e3646f2c8bd7')
    expect(meta.gitBranch).toBe('release-20260609-0.0.1')
  })

  it('#6302：诊断 Agent 只读 selectedAgent，不回落工作空间.agent_id', () => {
    spaceStoreState.spaces = [{
      id: 'sp-1',
      name: 'IDE',
      organization_id: 'wt-1',
      type: 'workspace',
    }]
    spaceStoreState.selectedSpace = spaceStoreState.spaces[0]
    spaceStoreState.selectedAgent = { id: 'agent-sel', name: '小明' }

    const meta = collectDiagnosticsMeta('settings')

    expect(meta.context.agentId).toBe('agent-sel')
    expect(meta.context.agentName).toBe('小明')
  })

  it('meta 可携带主进程 host 环境（Intel / ARM / Rosetta 排查）', () => {
    const meta = collectDiagnosticsMeta('menu', {
      processArch: 'x64',
      platform: 'darwin',
      cpuBrand: 'Intel Core i7',
      macTranslated: 0,
      macSupportsArm64: 0,
      osBuild: '19H2',
      execBasename: 'TabTin',
      runtimeLabel: 'intel-native',
    })

    expect(meta.host?.runtimeLabel).toBe('intel-native')
    expect(meta.host?.cpuBrand).toBe('Intel Core i7')
  })
})
