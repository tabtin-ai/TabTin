import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockRenameSync,
  mockConfigGet,
  mockConfigSet,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockConfigGet: vi.fn(),
  mockConfigSet: vi.fn(),
}))

vi.mock('fs', () => {
  const mocks = {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
    realpathSync: vi.fn((p: any) => String(p)),
  }
  return { ...mocks, default: mocks }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/downloads') },
}))

vi.mock('../main/services/ConfigService', () => ({
  configService: {
    get: mockConfigGet,
    set: mockConfigSet,
  },
}))

import { DownloadPersistence } from '../main/download-persistence'
import type { DownloadItemData } from '../shared/types/download'

function makeItem(overrides: Partial<DownloadItemData> = {}): DownloadItemData {
  return {
    id: 'test-1',
    name: 'file.zip',
    url: 'https://example.com/file.zip',
    savePath: '/mock/downloads/file.zip',
    status: 'completed',
    mimeType: 'application/zip',
    startTime: Date.now(),
    size: { received: 1024, total: 1024 },
    speed: 0,
    canResume: false,
    ...overrides,
  }
}

describe('DownloadPersistence', () => {
  let persistence: DownloadPersistence

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigGet.mockReturnValue(undefined)
    persistence = new DownloadPersistence()
  })

  afterEach(() => {
    persistence.dispose()
  })

  describe('loadFromDisk', () => {
    it('returns empty map when ConfigService 中没有历史记录', () => {
      const result = persistence.loadFromDisk()
      expect(result.size).toBe(0)
    })

    it('loads valid items from ConfigService', () => {
      const item = makeItem()
      mockConfigGet.mockReturnValue({ 'test-1': item })

      const result = persistence.loadFromDisk()
      expect(result.size).toBe(1)
      expect(result.get('test-1')).toBeDefined()
      expect(result.get('test-1')?.name).toBe('file.zip')
    })

    it('converts progressing status to interrupted on load', () => {
      const item = makeItem({ status: 'progressing', speed: 5000 })
      mockConfigGet.mockReturnValue({ 'test-1': item })

      const result = persistence.loadFromDisk()
      const loaded = result.get('test-1')!
      expect(loaded.status).toBe('interrupted')
      expect(loaded.speed).toBe(0)
    })

    it('converts paused status to interrupted on load', () => {
      const item = makeItem({ status: 'paused', speed: 100 })
      mockConfigGet.mockReturnValue({ 'test-1': item })

      const result = persistence.loadFromDisk()
      expect(result.get('test-1')?.status).toBe('interrupted')
    })

    it('handles ConfigService 读取异常 gracefully', () => {
      mockConfigGet.mockImplementation(() => {
        throw new Error('boom')
      })

      const result = persistence.loadFromDisk()
      expect(result.size).toBe(0)
    })

    it('returns empty map when history object is empty', () => {
      mockConfigGet.mockReturnValue({})

      const result = persistence.loadFromDisk()
      expect(result.size).toBe(0)
    })

    it('仅按 id 建立映射，不再做旧文件格式字段校验', () => {
      const invalid = { id: 'bad', name: 'test' }
      const valid = makeItem({ id: 'good' })
      mockConfigGet.mockReturnValue({ bad: invalid, good: valid })

      const result = persistence.loadFromDisk()
      expect(result.size).toBe(2)
      expect(result.has('good')).toBe(true)
      expect(result.has('bad')).toBe(true)
    })
  })

  describe('flushSync', () => {
    it('writes sorted history into ConfigService', () => {
      const downloads = new Map<string, DownloadItemData>()
      downloads.set('a', makeItem({ id: 'a', startTime: 100 }))
      downloads.set('b', makeItem({ id: 'b', startTime: 200 }))

      persistence.flushSync(downloads)

      expect(mockConfigSet).toHaveBeenCalledOnce()
      expect(mockConfigSet).toHaveBeenCalledWith('download.history', {
        b: expect.objectContaining({ id: 'b' }),
        a: expect.objectContaining({ id: 'a' }),
      })
    })

    it('空集合也会写回空 history', () => {
      persistence.flushSync(new Map())

      expect(mockConfigSet).toHaveBeenCalledWith('download.history', {})
    })

    it('limits items to MAX_HISTORY_ITEMS (500)', () => {
      const downloads = new Map<string, DownloadItemData>()
      for (let i = 0; i < 600; i++) {
        downloads.set(`item-${i}`, makeItem({ id: `item-${i}`, startTime: i }))
      }

      persistence.flushSync(downloads)

      const history = mockConfigSet.mock.calls[0][1] as Record<string, DownloadItemData>
      expect(Object.keys(history)).toHaveLength(500)
    })
  })

  describe('schedulePersist', () => {
    it('debounces multiple calls', () => {
      vi.useFakeTimers()
      mockExistsSync.mockReturnValue(true)

      const downloads = new Map<string, DownloadItemData>()
      downloads.set('a', makeItem({ id: 'a' }))

      persistence.schedulePersist(downloads)
      persistence.schedulePersist(downloads)
      persistence.schedulePersist(downloads)

      expect(mockConfigSet).not.toHaveBeenCalled()

      vi.advanceTimersByTime(900)

      expect(mockConfigSet).toHaveBeenCalledOnce()

      vi.useRealTimers()
    })
  })

  describe('dispose', () => {
    it('clears pending timer', () => {
      vi.useFakeTimers()
      mockExistsSync.mockReturnValue(true)

      const downloads = new Map<string, DownloadItemData>()
      downloads.set('a', makeItem({ id: 'a' }))

      persistence.schedulePersist(downloads)
      persistence.dispose()

      vi.advanceTimersByTime(2000)

      expect(mockConfigSet).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })
})
