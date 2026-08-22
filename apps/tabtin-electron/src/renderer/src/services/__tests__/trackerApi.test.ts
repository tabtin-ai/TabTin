/**
 * trackerApi 类型卫生单测（TS-12）
 *
 * 守护两件事：
 *   1. `mapListRowToTask` 把后端列表行的 `agent_id` 透传到 `TrackerTask`，
 *      不再因前端类型缺字段而在列表态丢失 Agent 绑定。
 *   2. `TrackerTaskUpdate` 类型接受 `agent_id` / `intent_snapshot`，与后端
 *      `TrackerUpdate` 及编辑入口真实 payload 对齐（编译期断言）。
 *
 * 仅测纯函数 / 类型，mock 掉 trackerApi 顶层的运行时副作用导入
 * （api-adapter-instance 会初始化 table host runtime，i18n 会初始化 i18next）。
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: vi.fn(),
  getAuthToken: vi.fn(async () => 'test-token'),
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

import {
  mapListRowToTask,
  type TrackerTaskListRow,
  type TrackerTaskUpdate,
} from '../trackerApi'

const baseRow: TrackerTaskListRow = {
  id: 'tracker-1',
  name: 'Daily digest',
  description: 'desc',
  status: 'active',
  space_id: 'space-1',
  trigger_type: 'cron',
  skill_key: 'app:tabmemo-operator',
  total_runs: 3,
  success_runs: 2,
  fail_runs: 1,
  last_run_at: null,
  next_run_at: null,
  created_at: '2026-06-02T00:00:00Z',
  updated_at: '2026-06-02T00:00:00Z',
}

describe('mapListRowToTask', () => {
  it('保留列表行的 agent_id', () => {
    const task = mapListRowToTask({ ...baseRow, agent_id: 'agent-42' })
    expect(task.agent_id).toBe('agent-42')
  })

  it('列表行无 agent_id 时归一为 null（兼容历史无绑定 Tracker）', () => {
    expect(mapListRowToTask(baseRow).agent_id).toBeNull()
    expect(mapListRowToTask({ ...baseRow, agent_id: null }).agent_id).toBeNull()
  })

  it('把列表安全调度字段映射为卡片可消费的 trigger_config', () => {
    const task = mapListRowToTask({
      ...baseRow,
      schedule_config: {
        cron_expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
      },
    })

    expect(task.trigger_config).toEqual({
      cron_expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    })
  })

  it('其余扁平字段按既有契约映射，并兼容旧后端缺少 schedule_config', () => {
    const task = mapListRowToTask(baseRow)
    expect(task.id).toBe('tracker-1')
    expect(task.skill_key).toBe('app:tabmemo-operator')
    // 旧后端不携带 schedule_config；映射后仍有安全占位值。
    expect(task.trigger_config).toEqual({})
    expect(task.skill_params).toBeNull()
  })
})

describe('TrackerTaskUpdate 类型', () => {
  it('接受 agent_id 与 intent_snapshot（编译期断言，对齐后端 TrackerUpdate）', () => {
    const payload: TrackerTaskUpdate = {
      name: 'edited',
      agent_id: 'agent-7',
      intent_snapshot: { created_via: 'ui' },
    }
    expect(payload.agent_id).toBe('agent-7')
    expect(payload.intent_snapshot).toEqual({ created_via: 'ui' })
  })
})
