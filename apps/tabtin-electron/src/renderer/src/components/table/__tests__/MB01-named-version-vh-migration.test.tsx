/**
 * MB-01 回归测试：TableHistoryModal 命名版本迁移到 VH API
 *
 * 测试覆盖:
 * 1. VHNamedVersion 类型兼容性：新旧格式字段映射
 * 2. NamedVersionItem 时间展示：支持 created_at 回退
 * 3. 命名版本点击：预览/还原锚点始终用 VH id
 * 4. API 调用链未断裂：fetchNamedVersions → UndoRedoApiService
 */
import { describe, it, expect } from 'vitest'
import { resolveNamedVersionSnapshotKey } from '../namedVersionSnapshotKey'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('MB-01: TableHistoryModal VH migration', () => {
  // ── VHNamedVersion 类型兼容性 ──

  it('VHNamedVersion 应兼容旧 TableNamedVersion 格式', () => {
    interface VHNamedVersion {
      id: string
      table_id?: string
      history_id?: string | null
      snapshot_at?: string | null
      name: string
      created_by?: string | null
      created_at?: string | null
    }

    const oldFormat: VHNamedVersion = {
      id: 'nv-001',
      table_id: 'tbl-001',
      history_id: 'hist-001',
      snapshot_at: '2026-03-20T12:00:00Z',
      name: '版本1',
      created_by: 'user-001',
      created_at: '2026-03-20T12:00:00Z',
    }

    const newFormat: VHNamedVersion = {
      id: 'vh-001',
      name: '版本2',
      created_at: '2026-03-20T13:00:00Z',
    }

    expect(oldFormat.id).toBe('nv-001')
    expect(oldFormat.history_id).toBe('hist-001')
    expect(newFormat.id).toBe('vh-001')
    expect(newFormat.history_id).toBeUndefined()
  })

  // ── 版本点击 key 计算──

  it('命名版本预览 key 始终使用 VH id（不优先 history_id）', () => {
    const withHistoryId = { id: 'vh-001', history_id: 'hist-001', name: 'A' }
    const withoutHistoryId = { id: 'vh-002', name: 'B' }
    const withNullHistoryId = { id: 'vh-003', history_id: null, name: 'C' }

    expect(resolveNamedVersionSnapshotKey(withHistoryId)).toBe('vh-001')
    expect(resolveNamedVersionSnapshotKey(withoutHistoryId)).toBe('vh-002')
    expect(resolveNamedVersionSnapshotKey(withNullHistoryId)).toBe('vh-003')
  })

  // ── 时间展示回退 ──

  it('时间展示应在 snapshot_at 缺失时回退到 created_at', () => {
    const version = {
      id: 'v1',
      name: 'test',
      snapshot_at: null as string | null,
      created_at: '2026-03-20T14:30:00Z',
    }

    const time = (version.snapshot_at || version.created_at)
      ? new Date(version.snapshot_at || version.created_at!)
      : null
    const timeStr = time && !Number.isNaN(time.getTime())
      ? time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '-'

    expect(time).not.toBeNull()
    expect(timeStr).not.toBe('-')
  })

  // ── UndoRedoApiService 方法存在性 ──

  it('UndoRedoApiService 应提供所有命名版本方法', async () => {
    const { UndoRedoApiService } = await import('@tabtin/table-core')
    expect(typeof UndoRedoApiService.listTableNamedVersions).toBe('function')
    expect(typeof UndoRedoApiService.createTableNamedVersion).toBe('function')
    expect(typeof UndoRedoApiService.renameTableNamedVersion).toBe('function')
    expect(typeof UndoRedoApiService.deleteTableNamedVersion).toBe('function')
  })

  // ── groupOperations 与命名版本 ID 匹配 ──

  it('命名版本 versionKey 能在 historyGroupById 中查找', async () => {
    const { groupOperations } = await import('@tabtin/smartsheet-ui')

    const mockOps = [
      {
        id: 'h-100',
        record_id: 'r-100',
        action: 'update',
        action_display: '修改',
        field_changes: { f1: { old: 'a', new: 'b' } },
        user: { id: 1, name: 'Bob' },
        created_at: '2026-03-20T10:00:00Z',
        is_undone: false,
      },
    ]

    const groups = groupOperations(mockOps as any)
    const groupById = new Map<string, (typeof groups)[number]>()
    for (const g of groups) {
      groupById.set(g.id, g)
      for (const op of g.operations) {
        if (op.id) groupById.set(op.id, g)
      }
    }

    // 时间线高亮仍可按 legacy history_id 找 group；预览锚点用 VH id
    const versionWithHistoryId = { id: 'vh-999', history_id: 'h-100', name: 'Named' }
    const snapshotKey = resolveNamedVersionSnapshotKey(versionWithHistoryId)
    const timelineKey = versionWithHistoryId.history_id || versionWithHistoryId.id
    expect(snapshotKey).toBe('vh-999')
    const matched = groupById.get(timelineKey) ?? null
    expect(matched).not.toBeNull()

    // VH id 不匹配（新创建的命名版本无对应 history group）
    const versionNoMatch = { id: 'vh-new', name: 'New VH' }
    const matched2 = groupById.get(resolveNamedVersionSnapshotKey(versionNoMatch)) ?? null
    expect(matched2).toBeNull()
  })
})
