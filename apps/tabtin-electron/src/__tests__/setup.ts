/**
 * Vitest 全局 setup
 * 模拟 Electron 环境中的 window.tabtin 对象
 */
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// 模拟 import.meta.env
vi.stubGlobal('import', { meta: { env: { DEV: true, PROD: false } } })

const createMemoryStorage = (): Storage => {
  const backing = new Map<string, string>()
  const storage = {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(String(key), String(value))
    },
    removeItem: (key: string) => {
      backing.delete(String(key))
    },
    clear: () => {
      backing.clear()
    },
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    get length() {
      return backing.size
    },
  }
  return storage as Storage
}

const ensureWebStorage = (name: 'localStorage' | 'sessionStorage') => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  const current = descriptor && 'value' in descriptor ? descriptor.value : undefined
  const hasApis =
    current &&
    typeof current.getItem === 'function' &&
    typeof current.setItem === 'function' &&
    typeof current.removeItem === 'function' &&
    typeof current.clear === 'function'
  if (hasApis) return

  const memoryStorage = createMemoryStorage()
  Object.defineProperty(globalThis, name, {
    value: memoryStorage,
    writable: true,
    configurable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, {
      value: memoryStorage,
      writable: true,
      configurable: true,
    })
  }
}

ensureWebStorage('localStorage')
ensureWebStorage('sessionStorage')

const clearWebStorage = (name: 'localStorage' | 'sessionStorage') => {
  ensureWebStorage(name)
  const target = globalThis[name]
  if (target && typeof target.clear === 'function') {
    target.clear()
  }
}

// 基础 auth mock 工厂
export function createMockAuth(overrides: Record<string, any> = {}) {
  return {
    save: vi.fn().mockResolvedValue({ success: true }),
    get: vi.fn().mockResolvedValue({ success: true, data: null }),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue({ success: true }),
    clearTokens: vi.fn().mockResolvedValue({ success: true }),
    clearUserInfo: vi.fn().mockResolvedValue({ success: true }),
    check: vi.fn().mockResolvedValue({ success: true, isValid: false }),
    saveAccessToken: vi.fn().mockResolvedValue({ success: true }),
    getAccessToken: vi.fn().mockResolvedValue({ success: true, token: null }),
    saveRefreshToken: vi.fn().mockResolvedValue({ success: true }),
    getRefreshToken: vi.fn().mockResolvedValue({ success: true, token: null }),
    saveUserInfo: vi.fn().mockResolvedValue({ success: true }),
    getUserInfo: vi.fn().mockResolvedValue({ success: true, userInfo: null }),
    isTokenExpiringSoon: vi.fn().mockResolvedValue({ success: true, isExpiring: false }),
    ...overrides,
  }
}

const createMockElectron = () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
})

const createMockTabtin = (overrides: Record<string, any> = {}) => ({
  auth: createMockAuth(),
  apiRequest: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  setAppearance: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

const resetRuntimeGlobals = () => {
  Object.defineProperty(window, 'electron', {
    value: createMockElectron(),
    writable: true,
    configurable: true,
  })

  Object.defineProperty(window, 'tabtin', {
    value: createMockTabtin(),
    writable: true,
    configurable: true,
  })
}

resetRuntimeGlobals()

// 模拟 i18n
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
    getFixedT: () => (key: string) => key,
  },
  getCurrentLanguage: () => 'zh-CN',
}))

const mockI18next = {
  language: 'zh-CN',
  t: (key: string, options?: { defaultValue?: string }) =>
    typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  changeLanguage: vi.fn(async (language: string) => {
    mockI18next.language = language
    return mockI18next
  }),
  getFixedT: () => (key: string, options?: { defaultValue?: string }) =>
    typeof options?.defaultValue === 'string' ? options.defaultValue : key,
}

vi.mock('i18next', () => ({
  default: mockI18next,
  t: mockI18next.t,
  changeLanguage: mockI18next.changeLanguage,
  getFixedT: mockI18next.getFixedT,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('keytar', () => {
  const api = {
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
    findPassword: vi.fn().mockResolvedValue(null),
  }
  return {
    default: api,
    ...api,
  }
})

type MockIndexSpec = {
  keyPath: string | string[]
}

type MockStoreSpec = {
  keyPath: string
  records: Map<unknown, unknown>
  indexes: Map<string, MockIndexSpec>
}

type MockDbState = {
  stores: Map<string, MockStoreSpec>
}

const mockDbRegistry = new Map<string, MockDbState>()

const cloneRecord = <T,>(value: T): T =>
  value == null ? value : JSON.parse(JSON.stringify(value)) as T

const readKeyPath = (record: Record<string, any>, keyPath: string | string[]): unknown => {
  if (Array.isArray(keyPath)) {
    return keyPath.map((key) => record[key])
  }
  return record[keyPath]
}

const sameKey = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const createStoreApi = (store: MockStoreSpec) => {
  const getAllRecords = () => Array.from(store.records.values()).map((value) => cloneRecord(value))

  return {
    put: vi.fn(async (value: Record<string, any>) => {
      const key = readKeyPath(value, store.keyPath)
      store.records.set(key, cloneRecord(value))
      return key
    }),
    get: vi.fn(async (key: unknown) => cloneRecord(store.records.get(key))),
    delete: vi.fn(async (key: unknown) => {
      store.records.delete(key)
    }),
    clear: vi.fn(async () => {
      store.records.clear()
    }),
    getAll: vi.fn(async () => getAllRecords()),
    index: vi.fn((indexName: string) => {
      const spec = store.indexes.get(indexName)
      if (!spec) {
        throw new Error(`Mock IDB index not found: ${indexName}`)
      }
      return {
        getAll: vi.fn(async (query: unknown) =>
          getAllRecords().filter((record) =>
            sameKey(readKeyPath(record as Record<string, any>, spec.keyPath), query)
          )
        ),
        getAllKeys: vi.fn(async (query: unknown) =>
          getAllRecords()
            .filter((record) =>
              sameKey(readKeyPath(record as Record<string, any>, spec.keyPath), query)
            )
            .map((record) => readKeyPath(record as Record<string, any>, store.keyPath))
        ),
      }
    }),
  }
}

const createDbApi = (state: MockDbState) => {
  const ensureStore = (storeName: string) => {
    const store = state.stores.get(storeName)
    if (!store) {
      throw new Error(`Mock IDB store not found: ${storeName}`)
    }
    return store
  }

  return {
    objectStoreNames: {
      contains: (storeName: string) => state.stores.has(storeName),
    },
    createObjectStore: (storeName: string, options?: { keyPath?: string }) => {
      const store: MockStoreSpec = {
        keyPath: options?.keyPath ?? 'id',
        records: new Map(),
        indexes: new Map(),
      }
      state.stores.set(storeName, store)
      return {
        createIndex: (indexName: string, keyPath: string | string[]) => {
          store.indexes.set(indexName, { keyPath })
        },
      }
    },
    put: async (storeName: string, value: Record<string, any>) =>
      createStoreApi(ensureStore(storeName)).put(value),
    get: async (storeName: string, key: unknown) =>
      createStoreApi(ensureStore(storeName)).get(key),
    getAll: async (storeName: string) =>
      createStoreApi(ensureStore(storeName)).getAll(),
    getAllFromIndex: async (storeName: string, indexName: string, query: unknown) =>
      createStoreApi(ensureStore(storeName)).index(indexName).getAll(query),
    delete: async (storeName: string, key: unknown) =>
      createStoreApi(ensureStore(storeName)).delete(key),
    clear: async (storeName: string) =>
      createStoreApi(ensureStore(storeName)).clear(),
    transaction: (storeNames: string | string[]) => {
      const normalized = Array.isArray(storeNames) ? storeNames : [storeNames]
      return {
        objectStore: (storeName: string) => {
          if (!normalized.includes(storeName)) {
            throw new Error(`Mock IDB transaction missing store: ${storeName}`)
          }
          return createStoreApi(ensureStore(storeName))
        },
        done: Promise.resolve(),
      }
    },
  }
}

vi.mock('idb', () => ({
  openDB: vi.fn(async (dbName: string, _version: number, options?: { upgrade?: (db: ReturnType<typeof createDbApi>) => void }) => {
    let state = mockDbRegistry.get(dbName)
    const isFirstOpen = !state
    if (!state) {
      state = { stores: new Map() }
      mockDbRegistry.set(dbName, state)
    }
    const db = createDbApi(state)
    if (isFirstOpen) {
      options?.upgrade?.(db)
    }
    return db
  }),
}))

vi.mock('@tabtin/smartsheet-adapter-electron/renderer', () => ({
  getApiAdapter: () => ({
    request: vi.fn().mockResolvedValue({ status: 200, data: {}, statusText: 'OK' }),
    getAccessToken: vi.fn().mockResolvedValue(null),
    getRefreshToken: vi.fn().mockResolvedValue(null),
    saveAccessToken: vi.fn().mockResolvedValue(undefined),
    saveRefreshToken: vi.fn().mockResolvedValue(undefined),
    clearTokens: vi.fn().mockResolvedValue(undefined),
    getUserInfo: vi.fn().mockResolvedValue(null),
    saveUserInfo: vi.fn().mockResolvedValue(undefined),
    clearUserInfo: vi.fn().mockResolvedValue(undefined),
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  mockI18next.language = 'zh-CN'
  mockDbRegistry.clear()
  clearWebStorage('localStorage')
  clearWebStorage('sessionStorage')
})

beforeEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  mockI18next.language = 'zh-CN'
  mockDbRegistry.clear()
  clearWebStorage('localStorage')
  clearWebStorage('sessionStorage')
})
