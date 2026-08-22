/**
 *  回归：云盘组织级建表超限须展示 billing toast，不得静默。
 *
 * 根因：TableStore.createTable 曾吞错返回 null；上层 onError 收不到异常。
 * 本测覆盖 useCreateHandlers.tabdata 在 createTable reject 配额错误时的提示路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const {
  toast,
  extractBillingErrorCode,
  showBillingErrorToast,
} = vi.hoisted(() => ({
  toast: vi.fn(),
  extractBillingErrorCode: vi.fn(() => null as string | null),
  showBillingErrorToast: vi.fn(),
}))

vi.mock('@components/ui', () => ({ toast }))
vi.mock('@tabtin/smartsheet-ui', () => ({
  toast,
  resolveChoiceTagColors: () => ({ backgroundColor: '#eee', color: '#111' }),
  FALLBACK_TAG_BG: '#eee',
  FALLBACK_TAG_TEXT: '#111',
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => {
  const useOrganizationStore = Object.assign(
    vi.fn((sel: (s: { selectedOrganization: { id: string } | null }) => unknown) =>
      sel({ selectedOrganization: { id: 'ws-1' } }),
    ),
    { subscribe: vi.fn(() => () => {}) },
  )
  return { useOrganizationStore }
})

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: vi.fn(() => ({ currentSpaceId: 'sp-1', load: vi.fn() })),
  },
  recordResourceAccessByResourceId: vi.fn(),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => {
  const state = {
    getPrefs: () => ({ resourceScope: 'space' }),
  }
  const useSpaceViewPrefsStore = Object.assign(
    (sel: (s: typeof state) => unknown) => sel(state),
    { getState: () => state },
  )
  return { useSpaceViewPrefsStore }
})

vi.mock('@stores/useBrowserPrefsStore', () => {
  const state = { homepageUrl: '', searchEngine: 'google' as const }
  const useBrowserPrefsStore = Object.assign(
    (sel: (s: typeof state) => unknown) => sel(state),
    { getState: () => state },
  )
  return {
    useBrowserPrefsStore,
    buildSearchUrl: (engine: string, q: string) => `https://example.com/search?q=${q}&e=${engine}`,
  }
})

vi.mock('@/config/api', () => ({ API_CONFIG: { baseURL: 'http://localhost' } }))
vi.mock('@/services/api', () => ({ apiService: { request: vi.fn() } }))
vi.mock('@/components/table/utils/prefillNewTableRows', () => ({
  MIN_NEW_TABLE_VISIBLE_ROW_COUNT: 0,
  prefillNewTableRows: vi.fn(),
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  }
  return { createLogger: () => stub, logger: stub }
})

vi.mock('@/lib/billingErrorHandler', () => ({
  extractBillingErrorCode: (...args: unknown[]) => extractBillingErrorCode(...args),
  showBillingErrorToast: (...args: unknown[]) => showBillingErrorToast(...args),
}))

vi.mock('@/stores/useCreateSiteDialog', () => ({
  useCreateSiteDialog: { getState: vi.fn(() => ({ open: vi.fn() })) },
}))
vi.mock('@tabtin/tabdoc-ui/api-client', () => ({ createDocument: vi.fn() }))
vi.mock('@/skills/agentSkills', () => ({ startAgentSkillsWatcher: vi.fn() }))
vi.mock('../../../tins/openTinsPanel', () => ({ openTinsPanel: vi.fn() }))
vi.mock('@tabtin/app-host-sdk/host', () => ({ createDirectAppClient: vi.fn() }))
vi.mock('@tabtin/table-core', () => ({
  requireTableApiPort: vi.fn(() => ({ getAccessToken: vi.fn(), request: vi.fn() })),
  TableApiService: {
    createTable: vi.fn(),
    updateTable: vi.fn(),
    getTable: vi.fn(),
  },
  normalizeTable: (t: unknown) => t,
}))
vi.mock('@tabtin/table-ui', () => ({}))
vi.mock('../../ResourceContextMenu', () => ({ ResourceContextMenu: () => null }))
vi.mock('../../registry/instance', () => ({
  contextRegistry: {
    getAllHandlers: vi.fn(() => []),
    getAllHandlersRaw: vi.fn(() => []),
  },
  homeSectionRegistry: {
    register: vi.fn(),
  },
}))
vi.mock('@/utils/featureFlags', () => ({ TINS_UI_ENABLED: false }))
vi.mock('../../restore/resourceMembershipPending', () => ({
  markResourceMembershipPending: (meta?: Record<string, unknown>) => meta ?? {},
}))
vi.mock('../../resourceScope', () => ({
  getEffectiveScopeForResourceType: vi.fn(() => 'space'),
  reloadResourceBucketsForScope: vi.fn(),
}))

import { useCreateHandlers } from '../useCreateHandlers'

function makeParams() {
  return {
    spaceId: 'sp-1',
    spaceOrganizationId: 'ws-1',
    isAppEnabled: () => true,
    tableSource: {
      selectedOrganizationId: 'ws-1',
      createTable: vi.fn(),
    },
    terminalSource: {
      createSession: vi.fn(() => ({ tabKey: 'term-1' })),
    },
    navigation: {
      openTable: vi.fn(),
      openDocument: vi.fn(),
      openSlide: vi.fn(),
      openMemo: vi.fn(),
      openSite: vi.fn(),
      createWebTab: vi.fn(),
      openEmbeddedWebApp: vi.fn(),
    },
  }
}

describe('#8321 建表配额错误提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    extractBillingErrorCode.mockReturnValue(null)
  })

  it('createTable 抛出 ENTITLEMENT_TABLE_LIMIT_EXCEEDED 时展示 billing toast，且不走普通失败 toast', async () => {
    extractBillingErrorCode.mockReturnValue('ENTITLEMENT_TABLE_LIMIT_EXCEEDED')
    const quotaError = new Error('ENTITLEMENT_TABLE_LIMIT_EXCEEDED: 当前套餐表格额度已用完')
    const params = makeParams()
    params.tableSource.createTable = vi.fn().mockRejectedValue(quotaError)

    const { result } = renderHook(() => useCreateHandlers(params))

    await act(async () => {
      await result.current.createHandlers.tabdata?.()
    })

    expect(params.tableSource.createTable).toHaveBeenCalled()
    expect(showBillingErrorToast).toHaveBeenCalledWith('ENTITLEMENT_TABLE_LIMIT_EXCEEDED', {
      resourceType: 'tabdata',
    })
    expect(toast).not.toHaveBeenCalled()
  })

  it('createTable 返回 null 时不得误报成功（静默中断）', async () => {
    const params = makeParams()
    params.tableSource.createTable = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(() => useCreateHandlers(params))

    await act(async () => {
      await result.current.createHandlers.tabdata?.()
    })

    expect(params.navigation.openTable).not.toHaveBeenCalled()
    expect(showBillingErrorToast).not.toHaveBeenCalled()
  })
})
