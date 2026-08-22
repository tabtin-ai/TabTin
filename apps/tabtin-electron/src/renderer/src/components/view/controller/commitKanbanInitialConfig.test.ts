import { describe, expect, it, vi } from 'vitest'

import { commitKanbanInitialConfig } from './commitKanbanInitialConfig'

describe('commitKanbanInitialConfig', () => {
  const fields = [
    { id: 'assignee', field_type: 'user' },
    { id: 'title', field_type: 'text', is_primary: true },
  ]

  it('保存分组字段并保留已有配置', async () => {
    const updateView = vi.fn().mockResolvedValue({ id: 'view-1' })

    await commitKanbanInitialConfig({
      viewId: 'view-1',
      groupFieldId: 'assignee',
      currentConfig: { freeze_columns: 1 },
      fields,
      updateView,
    })

    expect(updateView).toHaveBeenCalledWith('view-1', {
      config: {
        freeze_columns: 1,
        group_by_field: 'assignee',
        card_title_field: 'title',
      },
    })
  })

  it('运行时拒绝更新时显式失败，允许界面保留配置并提示重试', async () => {
    const updateView = vi.fn().mockResolvedValue(null)

    await expect(commitKanbanInitialConfig({
      viewId: 'view-1',
      groupFieldId: 'assignee',
      currentConfig: {},
      fields,
      updateView,
    })).rejects.toThrow('Kanban view configuration update returned no result')
  })
})
