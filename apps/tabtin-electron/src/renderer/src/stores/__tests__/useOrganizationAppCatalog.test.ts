import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockElectronFetch,
  mockLocalUninstallApp,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockElectronFetch: vi.fn(),
  mockLocalUninstallApp: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}))

vi.mock('@/services/electronFetch', () => ({
  electronFetch: mockElectronFetch,
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'token' }),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key,
  },
}))

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useOrganizationAppCatalog } from '../useOrganizationAppCatalog'

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  }
}

describe('useOrganizationAppCatalog.uninstallApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('window', {
      tabtin: {
        marketplace: {
          uninstallApp: mockLocalUninstallApp,
        },
      },
    })
    useOrganizationAppCatalog.getState().reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes device-scope apps from backend catalog before local cleanup', async () => {
    mockElectronFetch.mockResolvedValueOnce(
      okJson({
        app_id: 'tabtin-demo-app',
        installed: false,
        affected_spaces: 2,
      }),
    )
    mockLocalUninstallApp.mockResolvedValueOnce({ success: true })
    useOrganizationAppCatalog.setState({
      apps: [
        {
          id: 'tabtin-demo-app',
          name: 'Simple Todo (Demo)',
          icon: 'target',
          description: 'Demo app',
          detail_description: 'Demo app',
          screenshots: [],
          category: 'development',
          source: 'marketplace',
          install_scope: 'device',
          installed: true,
          is_default_enabled: false,
          order: 10,
          version: '1.0.0',
          installable: true,
        },
      ],
    })

    const result = await useOrganizationAppCatalog
      .getState()
      .uninstallApp('wt-1', 'tabtin-demo-app')

    expect(result).toEqual({ affected_spaces: 2 })
    expect(mockElectronFetch).toHaveBeenCalledWith(
      expect.stringContaining('/context/organizations/wt-1/app-catalog/tabtin-demo-app/uninstall'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mockLocalUninstallApp).toHaveBeenCalledWith('tabtin-demo-app')
    expect(mockElectronFetch.mock.invocationCallOrder[0]).toBeLessThan(
      mockLocalUninstallApp.mock.invocationCallOrder[0],
    )
    expect(useOrganizationAppCatalog.getState().apps[0]?.installed).toBe(false)
    expect(mockToastSuccess).toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})

describe('useOrganizationAppCatalog.loadCatalog surface classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOrganizationAppCatalog.getState().reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps only collaborative-surface apps in the app catalog (builtin/local/skill filtered out)', async () => {
    mockElectronFetch.mockResolvedValueOnce(
      okJson({
        apps: [
          {
            id: 'tabdata',
            name: 'Tables',
            icon: 'table',
            description: 'Team data',
            detail_description: 'Team data',
            screenshots: [],
            category: 'data',
            source: 'core',
            surface: 'collaborative',
            installed: true,
            is_default_enabled: true,
            order: 1,
            version: null,
          },
          {
            id: 'tabweb',
            name: 'Browser',
            icon: 'globe',
            description: 'Built-in browser runtime',
            detail_description: 'Built-in browser runtime',
            screenshots: [],
            category: 'development',
            source: 'core',
            surface: 'builtin',
            installed: true,
            is_default_enabled: true,
            order: 2,
            version: null,
          },
          {
            id: 'cowart',
            name: 'Cowart',
            icon: 'palette',
            description: 'Local personal plugin',
            detail_description: 'Local personal plugin',
            screenshots: [],
            category: 'creation',
            source: 'marketplace',
            surface: 'local',
            installed: false,
            is_default_enabled: false,
            order: 5,
            version: null,
          },
          {
            id: 'tabtin-office-skills-pack',
            name: 'Office Skills Pack',
            icon: 'function',
            description: 'Skill pack',
            detail_description: 'Skill pack',
            screenshots: [],
            category: 'productivity',
            source: 'marketplace',
            surface: null,
            installed: false,
            is_default_enabled: false,
            order: 3,
            version: null,
          },
          {
            id: 'future-team-video',
            name: 'Team Video',
            icon: 'video',
            description: 'Team-governed video app',
            detail_description: 'Team-governed video app',
            screenshots: [],
            category: 'creation',
            source: 'marketplace',
            surface: 'collaborative',
            installed: false,
            is_default_enabled: false,
            order: 4,
            version: null,
          },
        ],
        categories: [
          { id: 'all', name: 'All', count: 3 },
          { id: 'data', name: 'Data', count: 1 },
          { id: 'creation', name: 'Creation', count: 1 },
          { id: 'development', name: 'Development', count: 1 },
          { id: 'productivity', name: 'Productivity', count: 1 },
        ],
        can_manage: true,
      }),
    )

    await useOrganizationAppCatalog.getState().loadCatalog('wt-1')

    expect(useOrganizationAppCatalog.getState().apps.map((app) => app.id)).toEqual(['tabdata', 'future-team-video'])
    expect(useOrganizationAppCatalog.getState().categories).toEqual([
      { id: 'all', name: 'All', count: 2 },
      { id: 'data', name: 'Data', count: 1 },
      { id: 'creation', name: 'Creation', count: 1 },
    ])
  })
})
