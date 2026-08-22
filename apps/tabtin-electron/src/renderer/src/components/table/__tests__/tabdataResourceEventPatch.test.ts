import { describe, expect, it } from 'vitest'

import type { Table } from '@tabtin/table-core'
import type { ResourceWsEvent } from '@/stores/useUnifiedResources'
import {
  applyTableMetaPatchToState,
  buildTabDataTablePatchFromResourceEvent,
} from '../tabdataResourceEventPatch'

function makeEvent(overrides: Partial<ResourceWsEvent>): ResourceWsEvent {
  return {
    type: 'resource_updated',
    resource_type: 'tabdata',
    resource_id: 'table-1',
    title: '💪 健身训练计划表',
    space_id: 'space-1',
    ...overrides,
  }
}

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    id: 'table-1',
    name: '222',
    created_by_id: 'user-1',
    is_archived: false,
    created_at: '2026-06-08T06:00:00Z',
    updated_at: '2026-06-08T06:00:00Z',
    ...overrides,
  }
}

describe('tabdata resource event patch', () => {
  it('把 resource_updated 的标题转成当前表格 name patch', () => {
    expect(buildTabDataTablePatchFromResourceEvent(makeEvent({ title: '💪 健身训练计划表' }))).toEqual({
      name: '💪 健身训练计划表',
    })
  })

  it('同步 icon / archived / updated_at', () => {
    expect(buildTabDataTablePatchFromResourceEvent(makeEvent({
      title: '新表名',
      status: 'archived',
      updated_at: '2026-06-08T07:00:00Z',
      metadata: { icon: '🏋️' },
    }))).toEqual({
      name: '新表名',
      is_archived: true,
      updated_at: '2026-06-08T07:00:00Z',
      icon: '🏋️',
    })
  })

  it('忽略旧事件整包，避免迟到资源回声回滚标题', () => {
    expect(buildTabDataTablePatchFromResourceEvent(
      makeEvent({
        title: '旧标题',
        updated_at: '2026-06-08T07:00:00Z',
        metadata: { icon: 'old' },
      }),
      { updated_at: '2026-06-08T07:01:00Z' },
    )).toBeNull()
  })

  it('忽略非更新事件，且不把 preview 误当成 description', () => {
    expect(buildTabDataTablePatchFromResourceEvent(makeEvent({
      type: 'resource_created',
    }))).toBeNull()

    expect(buildTabDataTablePatchFromResourceEvent(makeEvent({
      title: undefined,
      preview: '字段A | 字段B',
      metadata: { icon: 1 },
    }))).toBeNull()
  })

  it('把 patch 写回 tables 与 selectedTable，供表头 displayTable 立刻刷新', () => {
    const state = {
      tables: [makeTable(), makeTable({ id: 'table-2', name: '其他表' })],
      selectedTable: makeTable(),
      unrelated: true,
    }

    expect(applyTableMetaPatchToState(state, 'table-1', {
      name: '💪 健身训练计划表',
      updated_at: '2026-06-08T07:00:00Z',
    })).toEqual({
      tables: [
        makeTable({
          name: '💪 健身训练计划表',
          updated_at: '2026-06-08T07:00:00Z',
        }),
        makeTable({ id: 'table-2', name: '其他表' }),
      ],
      selectedTable: makeTable({
        name: '💪 健身训练计划表',
        updated_at: '2026-06-08T07:00:00Z',
      }),
    })
  })
})
