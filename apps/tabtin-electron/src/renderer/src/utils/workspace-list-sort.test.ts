import { describe, expect, it } from 'vitest'
import {
  compareWorkspaceListOrder,
  type WorkspaceListSortInput,
} from './workspace-list-sort'

const item = (
  partial: Partial<WorkspaceListSortInput> & Pick<WorkspaceListSortInput, 'id' | 'name'>,
): WorkspaceListSortInput => partial

describe('compareWorkspaceListOrder', () => {
  it('name 模式按名称固定，忽略活跃时间', () => {
    const items = [
      item({ id: 'b', name: 'Beta', lastActivityAt: '2026-07-11T18:00:00.000Z' }),
      item({ id: 'a', name: 'Alpha', lastActivityAt: '2026-07-10T10:00:00.000Z' }),
    ]
    const sorted = [...items].sort((a, b) => compareWorkspaceListOrder(a, b, 'name'))
    expect(sorted.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('activity 模式无会话活跃时按 last_activity_at 降序，同活跃再按名称', () => {
    const items = [
      item({ id: 'a', name: 'Alpha', lastActivityAt: '2026-07-10T10:00:00.000Z' }),
      item({ id: 'b', name: 'Beta', lastActivityAt: '2026-07-11T18:00:00.000Z' }),
      item({ id: 'c', name: 'Charlie', lastActivityAt: '2026-07-11T18:00:00.000Z' }),
    ]
    const sorted = [...items].sort((a, b) => compareWorkspaceListOrder(a, b, 'activity'))
    expect(sorted.map(i => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('activity 模式有会话活跃时优先按会话活跃排序，避免资源 touch 改变任务侧栏顺序', () => {
    const items = [
      item({
        id: 'resource-touched',
        name: 'Resource Touched',
        lastActivityAt: '2026-07-11T18:00:00.000Z',
        sessionActivityTs: 100,
      }),
      item({
        id: 'latest-task',
        name: 'Latest Task',
        lastActivityAt: '2026-07-10T10:00:00.000Z',
        sessionActivityTs: 200,
      }),
    ]
    const sorted = [...items].sort((a, b) => compareWorkspaceListOrder(a, b, 'activity'))
    expect(sorted.map(i => i.id)).toEqual(['latest-task', 'resource-touched'])
  })

  it('activity 模式无 last_activity_at 时按会话活跃时间排序', () => {
    const items = [
      item({ id: 'old', name: 'Old', sessionActivityTs: 100 }),
      item({ id: 'new', name: 'New', sessionActivityTs: 200 }),
    ]
    const sorted = [...items].sort((a, b) => compareWorkspaceListOrder(a, b, 'activity'))
    expect(sorted.map(i => i.id)).toEqual(['new', 'old'])
  })
})
