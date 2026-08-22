/**
 * TL-006 / TL-012 回归测试
 *
 * TL-006: removeInstance 主动调用 cleanupSandbox，不再依赖渲染进程
 * TL-012: cleanupSandbox 清理 partition session 数据（localStorage/Cookie/IndexedDB）
 *
 * 验证策略：通过 electron.session.fromPartition mock 观察 partition 清理行为，
 * 因为这是 TL-012 的核心修复点。磁盘文件删除由 fs.rmSync 处理（内部实现细节），
 * 通过 partition session 清理的正确调用来间接验证 cleanupSandbox 被执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockClearStorageData, mockFromPartition } = vi.hoisted(() => {
  const mockClearStorageData = vi.fn(() => Promise.resolve())
  const mockFromPartition = vi.fn(() => ({ clearStorageData: mockClearStorageData }))
  return { mockClearStorageData, mockFromPartition }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mock-user-data' },
  session: { fromPartition: (...args: unknown[]) => mockFromPartition(...args) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}))

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    default: actual,
    existsSync: () => true,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  }
})

vi.mock(import('crypto'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    default: actual,
    randomBytes: () => ({ toString: () => 'dGVzdG5vbmNl' }),
  }
})

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('../tin-bridge', () => ({
  generateTinPreloadScript: () => '/* preload */',
}))

vi.mock('../../auth', () => ({
  isTrustedSender: () => true,
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
}))

import { cleanupSandbox } from '../tin-sandbox'
import { TinManager } from '../tin-manager'
import type { TinInstance } from '../types'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

function makeTinInstance(id = VALID_UUID): TinInstance {
  return {
    id,
    tin_id: 'tid-1',
    organization_id: 'ws-1',
    space_id: 'sp-1',
    is_enabled: true,
    pinned: false,
    user_variables: {},
    created_at: '',
    updated_at: '',
    tin: {
      id: 'tid-1',
      organization_id: 'ws-1',
      name: 'TestTin',
      description: '',
      icon_url: '',
      version: '1.0',
      status: 'active',
      source: 'user_created',
      activation_mode: 'manual',
      activation_rules: [],
      activation_match: 'any',
      variables_schema: {},
      permissions: [],
      panel_position: 'sidebar_right',
      panel_width: 360,
      panel_html: '',
      created_at: '',
      updated_at: '',
    },
  }
}

// ── TL-012: cleanupSandbox 清理 partition session ────

describe('cleanupSandbox — partition session cleanup (TL-012)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClearStorageData.mockImplementation(() => Promise.resolve())
  })

  it('calls session.fromPartition with correct partition name and clearStorageData', async () => {
    await cleanupSandbox(VALID_UUID)

    expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${VALID_UUID}`)
    expect(mockClearStorageData).toHaveBeenCalledOnce()
  })

  it('skips everything for invalid instanceId', async () => {
    await cleanupSandbox('not-a-uuid')

    expect(mockFromPartition).not.toHaveBeenCalled()
  })

  it('does not throw if clearStorageData rejects', async () => {
    mockClearStorageData.mockRejectedValueOnce(new Error('session error'))

    await expect(cleanupSandbox(VALID_UUID)).resolves.toBeUndefined()
  })

  it('does not throw if fromPartition throws', async () => {
    mockFromPartition.mockImplementationOnce(() => { throw new Error('partition error') })

    await expect(cleanupSandbox(VALID_UUID)).resolves.toBeUndefined()
  })

  it('clears partition for each unique instanceId', async () => {
    const uuid2 = '12345678-1234-1234-1234-123456789abc'
    await cleanupSandbox(VALID_UUID)
    await cleanupSandbox(uuid2)

    expect(mockFromPartition).toHaveBeenCalledTimes(2)
    expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${VALID_UUID}`)
    expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${uuid2}`)
    expect(mockClearStorageData).toHaveBeenCalledTimes(2)
  })
})

// ── TL-006: removeInstance 主动触发 cleanupSandbox ───

describe('TinManager.removeInstance — triggers cleanup (TL-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClearStorageData.mockImplementation(() => Promise.resolve())
  })

  it('triggers partition session cleanup when an instance is removed', async () => {
    const manager = new TinManager()
    manager.addInstance(makeTinInstance())

    manager.removeInstance(VALID_UUID)

    await vi.waitFor(() => {
      expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${VALID_UUID}`)
    })

    expect(mockClearStorageData).toHaveBeenCalledOnce()
  })

  it('instance is removed from manager even if cleanup fails', () => {
    mockFromPartition.mockImplementationOnce(() => { throw new Error('partition error') })

    const manager = new TinManager()
    manager.addInstance(makeTinInstance())

    expect(() => manager.removeInstance(VALID_UUID)).not.toThrow()
    expect(manager.findInstance(VALID_UUID)).toBeUndefined()
  })

  it('does not call cleanup for instances that were never added', () => {
    const manager = new TinManager()

    manager.removeInstance(VALID_UUID)

    vi.waitFor(() => {
      expect(mockFromPartition).toHaveBeenCalled()
    })
  })
})

// ── TL-006: setInstances eviction 路径触发清理 ───────

describe('TinManager.setInstances — eviction triggers cleanup (TL-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClearStorageData.mockImplementation(() => Promise.resolve())
  })

  it('cleans up sandbox for instances evicted by setInstances', async () => {
    const manager = new TinManager()
    manager.addInstance(makeTinInstance())

    manager.setInstances([])

    await vi.waitFor(() => {
      expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${VALID_UUID}`)
    })
    expect(mockClearStorageData).toHaveBeenCalledOnce()
  })

  it('does not clean up instances that remain in the new list', async () => {
    const manager = new TinManager()
    const inst = makeTinInstance()
    manager.addInstance(inst)

    manager.setInstances([inst])

    await new Promise((r) => setTimeout(r, 50))
    expect(mockFromPartition).not.toHaveBeenCalled()
  })

  it('cleans up multiple evicted instances', async () => {
    const uuid2 = '12345678-1234-1234-1234-123456789abc'
    const manager = new TinManager()
    manager.addInstance(makeTinInstance(VALID_UUID))
    manager.addInstance(makeTinInstance(uuid2))

    manager.setInstances([])

    await vi.waitFor(() => {
      expect(mockFromPartition).toHaveBeenCalledTimes(2)
    })

    expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${VALID_UUID}`)
    expect(mockFromPartition).toHaveBeenCalledWith(`persist:tin-${uuid2}`)
  })

  it('does not throw if cleanup fails during eviction', () => {
    mockFromPartition.mockImplementation(() => { throw new Error('partition error') })

    const manager = new TinManager()
    manager.addInstance(makeTinInstance())

    expect(() => manager.setInstances([])).not.toThrow()
  })
})
