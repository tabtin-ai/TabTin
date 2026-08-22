import { describe, expect, it } from 'vitest'
import { computeSubRecordTreeOrder } from '../useDataGridDataset'
import type { TableRecord } from '../../types'

const PARENT_FIELD = 'f_parent'

const rec = (
  id: string,
  parentId?: string | null,
): TableRecord =>
  ({
    id,
    table_id: 't1',
    created_by_id: 'u1',
    created_at: '',
    updated_at: '',
    data: {},
    fields: parentId ? { [PARENT_FIELD]: { id: parentId } } : {},
  }) as unknown as TableRecord

type TreeMeta = Record<
  string,
  { depth?: number; has_children?: boolean; parent_id?: string | null }
>

describe('computeSubRecordTreeOrder', () => {
  it('扁平记录无父子关系时保持原序，深度全 0', () => {
    const records = [rec('a'), rec('b'), rec('c')]
    const meta: TreeMeta = {
      a: { depth: 0, parent_id: null },
      b: { depth: 0, parent_id: null },
      c: { depth: 0, parent_id: null },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['a', 'b', 'c'])
    expect(metaById.get('a')?.depth).toBe(0)
  })

  it('并列 __order 下子记录仍紧贴父记录（真实跳因）', () => {
    // 父 p0 与 r1..r5 全部 order 并列；子 child 的 flat 序排在并列组之后（index 6），
    // 但 tree_data 指明它父为 p0 → DFS 必须把它拉到 p0 正下方。
    const records = [
      rec('p0'),
      rec('r1'),
      rec('r2'),
      rec('r3'),
      rec('r4'),
      rec('r5'),
      rec('child', 'p0'),
    ]
    const meta: TreeMeta = {
      p0: { depth: 0, parent_id: null, has_children: true },
      r1: { depth: 0, parent_id: null },
      r2: { depth: 0, parent_id: null },
      r3: { depth: 0, parent_id: null },
      r4: { depth: 0, parent_id: null },
      r5: { depth: 0, parent_id: null },
      child: { depth: 1, parent_id: 'p0' },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['p0', 'child', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(metaById.get('child')?.depth).toBe(1)
    expect(metaById.get('child')?.parentId).toBe('p0')
    expect(metaById.get('p0')?.hasChildren).toBe(true)
  })

  it('新建子记录尚未进 tree_data 时，回退到父 link 字段值聚类', () => {
    // child 不在 tree_data（增量/协作刚到、tree_data 滞后），但记录自身带父 link 值。
    const records = [rec('p0'), rec('r1'), rec('child', 'p0')]
    const meta: TreeMeta = {
      p0: { depth: 0, parent_id: null },
      r1: { depth: 0, parent_id: null },
      // 注意：child 缺失
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['p0', 'child', 'r1'])
    expect(metaById.get('child')?.depth).toBe(1)
    expect(metaById.get('child')?.parentId).toBe('p0')
    expect(metaById.get('p0')?.hasChildren).toBe(true)
  })

  it('删除父记录后子记录归为根，不复活已删父子关系', () => {
    // 删除父记录 p0 后，p0 从已加载集合移除；child 即便父 cell 还残留旧 id，
    // 也会因父不在集合内被归为根（叠加  的 cell 清空，双重保险）。
    const records = [rec('r1'), rec('child', 'p0')]
    const meta: TreeMeta = {
      r1: { depth: 0, parent_id: null },
      child: { depth: 0, parent_id: null },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['r1', 'child'])
    expect(metaById.get('child')?.parentId).toBe(null)
  })

  it('协作移动：显式父 cell 优先于陈旧 tree_data（不回弹）', () => {
    // 协作在线把 child 拖到 p1 下，只改了 Y.Doc 父 cell；tree_data 仍是上次 REST
    // 的旧关系（child 在 p0 下）。显式 cell 应权威，让 child 立刻聚类到 p1。
    const records = [rec('p0'), rec('p1'), rec('child', 'p1')]
    const meta: TreeMeta = {
      p0: { depth: 0, parent_id: null, has_children: true },
      p1: { depth: 0, parent_id: null },
      child: { depth: 1, parent_id: 'p0' },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['p0', 'p1', 'child'])
    expect(metaById.get('child')?.parentId).toBe('p1')
    expect(metaById.get('p1')?.hasChildren).toBe(true)
  })

  it('协作移出到根：父 cell 显式为 null 时归为根，覆盖旧 tree_data', () => {
    const records = [rec('p0'), rec('child', null)]
    // child 父 cell 显式为 null（fields 带 key 值为 null）
    ;(records[1] as unknown as { fields: Record<string, unknown> }).fields = {
      [PARENT_FIELD]: null,
    }
    const meta: TreeMeta = {
      p0: { depth: 0, parent_id: null, has_children: true },
      child: { depth: 1, parent_id: 'p0' },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['p0', 'child'])
    expect(metaById.get('child')?.parentId).toBe(null)
  })

  it('父记录不在当前已加载集合里时，子记录按根处理', () => {
    const records = [rec('a'), rec('orphan', 'missing-parent')]
    const meta: TreeMeta = { a: { depth: 0, parent_id: null } }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['a', 'orphan'])
    expect(metaById.get('orphan')?.depth).toBe(0)
    expect(metaById.get('orphan')?.parentId).toBe(null)
  })

  it('多级嵌套：DFS 深度递增，兄弟保持输入相对序', () => {
    const records = [
      rec('p'),
      rec('c1', 'p'),
      rec('c1a', 'c1'),
      rec('c2', 'p'),
      rec('q'),
    ]
    const meta: TreeMeta = {
      p: { parent_id: null },
      c1: { parent_id: 'p' },
      c1a: { parent_id: 'c1' },
      c2: { parent_id: 'p' },
      q: { parent_id: null },
    }
    const { orderIds, metaById } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(orderIds).toEqual(['p', 'c1', 'c1a', 'c2', 'q'])
    expect(metaById.get('c1a')?.depth).toBe(2)
    expect(metaById.get('c2')?.depth).toBe(1)
  })

  it('循环引用兜底：不死循环且不丢行', () => {
    // a -> b -> a 形成环（通过 link 值），都不在 tree_data。
    const records = [rec('a', 'b'), rec('b', 'a')]
    const meta: TreeMeta = {}
    const { orderIds } = computeSubRecordTreeOrder(records, meta, PARENT_FIELD)
    expect(new Set(orderIds)).toEqual(new Set(['a', 'b']))
    expect(orderIds).toHaveLength(2)
  })
})
