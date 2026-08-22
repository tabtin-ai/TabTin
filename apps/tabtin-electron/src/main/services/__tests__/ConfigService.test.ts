import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAtomicWriteFileSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' },
}))

vi.mock('@tabtin/terminal-core', () => ({
  atomicWriteFileSync: mockAtomicWriteFileSync,
}))

vi.mock('fs', () => {
  const mod = {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
  }
  return { ...mod, default: mod }
})

import {
  AppConfigService,
  KEY_CATEGORIES,
  ConfigPersistError,
  type AppConfig,
  type BucketCategory,
} from '../ConfigService'

function freshService(data?: AppConfig): AppConfigService {
  ;(AppConfigService as any).instance = undefined
  if (data) {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(data))
  } else {
    mockExistsSync.mockReturnValue(false)
  }
  return AppConfigService.getInstance()
}

beforeEach(() => {
  mockAtomicWriteFileSync.mockReset()
  mockReadFileSync.mockReset()
  mockExistsSync.mockReset()
})

describe('KEY_CATEGORIES', () => {
  it('覆盖 AppConfig 全部 9 个 key', () => {
    const keys = Object.keys(KEY_CATEGORIES)
    expect(keys).toHaveLength(9)
    expect(keys.sort()).toEqual([
      'approval.scopeCache',
      'browser_env',
      'download.history',
      'mcp.connections',
      'notification.userPrefs',
      'notification.userPrefsMeta',
      'settings',
      'window.main',
      'ws.gatewayId',
    ])
  })

  it.each([
    ['window.main', 'cache'],
    ['ws.gatewayId', 'cache'],
    ['notification.userPrefs', 'semi-cache'],
    ['notification.userPrefsMeta', 'semi-cache'],
    ['download.history', 'semi-cache'],
    ['approval.scopeCache', 'semi-cache'],
    ['mcp.connections', 'data'],
    ['settings', 'data'],
    ['browser_env', 'data'],
  ] as [keyof AppConfig, BucketCategory][])('%s → %s', (key, expected) => {
    expect(KEY_CATEGORIES[key]).toBe(expected)
  })

  it('cache 类只有 2 个 key', () => {
    const cacheKeys = Object.entries(KEY_CATEGORIES)
      .filter(([, v]) => v === 'cache')
      .map(([k]) => k)
    expect(cacheKeys.sort()).toEqual(['window.main', 'ws.gatewayId'])
  })

  it('data 类只有 3 个 key', () => {
    const dataKeys = Object.entries(KEY_CATEGORIES)
      .filter(([, v]) => v === 'data')
      .map(([k]) => k)
    expect(dataKeys.sort()).toEqual(['browser_env', 'mcp.connections', 'settings'])
  })
})

const fullConfig: AppConfig = {
  'window.main': { width: 1200, height: 800, isMaximized: false },
  'ws.gatewayId': 'gw-abc-123',
  'notification.userPrefs': {
    enabled: true,
    desktopEnabled: true,
    dockBadgeEnabled: true,
    soundEnabled: false,
    dndEnabled: false,
    categoryOverrides: {},
  },
  'notification.userPrefsMeta': { updatedAt: 1_700_000_000_000, owner: 'u1' },
  'download.history': { dl1: { name: 'file.zip' } },
  'approval.scopeCache': { execute_in_terminal: { scope: 'always', updatedAt: 1 } },
  'mcp.connections': [{ id: 'conn1' }],
  'settings': { theme: 'dark', language: 'zh-CN' },
  'browser_env': {
    user1: {
      environments: [{ id: 'env1', name: 'work' } as any],
      bindings: [],
    },
  },
}

describe('clearByCategory', () => {
  it("clearByCategory('cache') 只清 cache 字段，不动 data / semi-cache", () => {
    const svc = freshService({ ...fullConfig })

    const result = svc.clearByCategory('cache')

    expect(result.clearedKeys.sort()).toEqual(['window.main', 'ws.gatewayId'])
    expect(svc.get('window.main')).toBeUndefined()
    expect(svc.get('ws.gatewayId')).toBeUndefined()

    expect(svc.get('browser_env')).toEqual(fullConfig['browser_env'])
    expect(svc.get('settings')).toEqual({ theme: 'dark', language: 'zh-CN' })
    expect(svc.get('mcp.connections')).toEqual([{ id: 'conn1' }])
    expect(svc.get('notification.userPrefs')).toEqual(fullConfig['notification.userPrefs'])
    expect(svc.get('notification.userPrefsMeta')).toEqual(fullConfig['notification.userPrefsMeta'])
    expect(svc.get('download.history')).toEqual(fullConfig['download.history'])
    expect(svc.get('approval.scopeCache')).toEqual(fullConfig['approval.scopeCache'])
  })

  it("clearByCategory('data') 只清 data 字段，不动 cache / semi-cache", () => {
    const svc = freshService({ ...fullConfig })

    const result = svc.clearByCategory('data')

    expect(result.clearedKeys.sort()).toEqual(['browser_env', 'mcp.connections', 'settings'])
    expect(svc.get('browser_env')).toBeUndefined()
    expect(svc.get('settings')).toBeUndefined()
    expect(svc.get('mcp.connections')).toBeUndefined()

    expect(svc.get('window.main')).toEqual(fullConfig['window.main'])
    expect(svc.get('ws.gatewayId')).toBe('gw-abc-123')
    expect(svc.get('notification.userPrefs')).toEqual(fullConfig['notification.userPrefs'])
    expect(svc.get('notification.userPrefsMeta')).toEqual(fullConfig['notification.userPrefsMeta'])
    expect(svc.get('download.history')).toEqual(fullConfig['download.history'])
    expect(svc.get('approval.scopeCache')).toEqual(fullConfig['approval.scopeCache'])
  })

  it("clearByCategory('semi-cache') 只清 semi-cache 字段", () => {
    const svc = freshService({ ...fullConfig })

    const result = svc.clearByCategory('semi-cache')

    expect(result.clearedKeys.sort()).toEqual([
      'approval.scopeCache',
      'download.history',
      'notification.userPrefs',
      'notification.userPrefsMeta',
    ])
    expect(svc.get('notification.userPrefs')).toBeUndefined()
    expect(svc.get('notification.userPrefsMeta')).toBeUndefined()
    expect(svc.get('download.history')).toBeUndefined()
    expect(svc.get('approval.scopeCache')).toBeUndefined()

    expect(svc.get('window.main')).toEqual(fullConfig['window.main'])
    expect(svc.get('browser_env')).toEqual(fullConfig['browser_env'])
    expect(svc.get('settings')).toEqual(fullConfig['settings'])
  })

  it('空配置下 clearedKeys 为空数组', () => {
    const svc = freshService({})
    const result = svc.clearByCategory('cache')
    expect(result.clearedKeys).toEqual([])
  })

  it('写盘失败时回滚内存 + 抛 ConfigPersistError', () => {
    const svc = freshService({ ...fullConfig })
    mockAtomicWriteFileSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left')
    })

    expect(() => svc.clearByCategory('cache')).toThrow(ConfigPersistError)

    expect(svc.get('window.main')).toEqual(fullConfig['window.main'])
    expect(svc.get('ws.gatewayId')).toBe('gw-abc-123')
    expect(svc.get('browser_env')).toEqual(fullConfig['browser_env'])
  })
})

describe('clearByKey', () => {
  it('清除单个 key 后其值为 undefined', () => {
    const svc = freshService({
      'ws.gatewayId': 'gw-999',
      'settings': { theme: 'light' },
    })

    svc.clearByKey('ws.gatewayId')
    expect(svc.get('ws.gatewayId')).toBeUndefined()
    expect(svc.get('settings')).toEqual({ theme: 'light' })
  })

  it('写盘失败时回滚 + 抛 ConfigPersistError', () => {
    const svc = freshService({
      'browser_env': { u1: { environments: [], bindings: [] } },
    })
    mockAtomicWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(() => svc.clearByKey('browser_env')).toThrow(ConfigPersistError)
    expect(svc.get('browser_env')).toEqual({ u1: { environments: [], bindings: [] } })
  })

  it('清除已经是 undefined 的 key 不报错', () => {
    const svc = freshService({})
    expect(() => svc.clearByKey('ws.gatewayId')).not.toThrow()
    expect(svc.get('ws.gatewayId')).toBeUndefined()
  })
})

describe('现有 API 兼容性（set / setOrThrow / get 不受影响）', () => {
  it('set 仍然正常工作', () => {
    const svc = freshService({})
    svc.set('ws.gatewayId', 'new-gw')
    expect(svc.get('ws.gatewayId')).toBe('new-gw')
  })

  it('set 首次写入时要求原子写创建 userData 目录', () => {
    const svc = freshService({})

    svc.set('ws.gatewayId', 'new-gw')

    expect(mockAtomicWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-userdata/app-config.json',
      expect.stringContaining('"ws.gatewayId": "new-gw"'),
      { mkdirSync: true },
    )
  })

  it('setOrThrow 仍然正常工作', () => {
    const svc = freshService({})
    svc.setOrThrow('settings', { theme: 'dark' })
    expect(svc.get('settings')).toEqual({ theme: 'dark' })
  })

  it('setOrThrow 写盘失败时回滚 + 抛 ConfigPersistError', () => {
    const svc = freshService({})
    mockAtomicWriteFileSync.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => svc.setOrThrow('settings', { theme: 'dark' })).toThrow(ConfigPersistError)
    expect(svc.get('settings')).toBeUndefined()
  })
})
