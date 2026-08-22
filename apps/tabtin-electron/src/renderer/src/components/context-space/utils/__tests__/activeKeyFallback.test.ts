/**
 * activeKeyFallback 纯函数单元测试 —— W4 单 pane group 边界覆盖
 *
 * 策略优先级：group survivor → visible 右邻居 → visible 左邻居 → tabOrder 最近 visible → 兜底
 *
 * W4 关键边界：
 *   - 单 pane group 关闭时 remaining = [] → survivor undefined → 落到 visible 邻居
 *   - 空 group（0 pane）→ 无 group match → visible 邻居
 */
import { describe, it, expect } from 'vitest'
import { computeFallbackTabKey, computeFallbackTabKeyFromStore } from '../../utils/activeKeyFallback'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'

function makeGroup(id: string, panes: Array<{ id: string; tabKey: string }>, activePaneId?: string): CanvasLayoutGroup {
  return {
    id,
    spaceId: 'sp-1',
    panes: panes.map(p => ({ id: p.id, content: { tabKey: p.tabKey } })),
    activePaneId: activePaneId ?? panes[0]?.id ?? null,
    anchorTabKey: panes[0]?.tabKey ?? null,
    layout: null,
    updatedAt: Date.now(),
  } as unknown as CanvasLayoutGroup
}

describe('computeFallbackTabKey — W4 单 pane group 边界', () => {
  it('单 pane group 关闭唯一 pane → remaining 为空 → fallback 到 visible 右邻居', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabweb:only',
      visibleTabKeys: ['tabweb:only', 'tabdoc:right'],
      tabOrder: ['tabweb:only', 'tabdoc:right'],
      spaceGroups: [
        makeGroup('g1', [{ id: 'p1', tabKey: 'tabweb:only' }]),
      ],
    })
    expect(result).toBe('tabdoc:right')
  })

  it('单 pane group 关闭唯一 pane + 无 visible 邻居 → fallback null', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabweb:only',
      visibleTabKeys: ['tabweb:only'],
      tabOrder: ['tabweb:only'],
      spaceGroups: [
        makeGroup('g1', [{ id: 'p1', tabKey: 'tabweb:only' }]),
      ],
    })
    expect(result).toBeNull()
  })

  it('2 pane group 关闭一个 → fallback 到 group survivor', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabweb:a',
      visibleTabKeys: ['tabdoc:external'],
      tabOrder: ['tabweb:a', 'tabweb:b', 'tabdoc:external'],
      spaceGroups: [
        makeGroup('g1', [
          { id: 'p1', tabKey: 'tabweb:a' },
          { id: 'p2', tabKey: 'tabweb:b' },
        ], 'p1'),
      ],
    })
    expect(result).toBe('tabweb:b')
  })

  it('2 pane group 关闭非 active pane → survivor 优先选 activePaneId', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabweb:b',
      visibleTabKeys: ['tabdoc:external'],
      tabOrder: ['tabweb:a', 'tabweb:b', 'tabdoc:external'],
      spaceGroups: [
        makeGroup('g1', [
          { id: 'p1', tabKey: 'tabweb:a' },
          { id: 'p2', tabKey: 'tabweb:b' },
        ], 'p1'),
      ],
    })
    expect(result).toBe('tabweb:a')
  })

  it('不在 group 内的普通 tab 关闭 → visible 右邻居', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabdoc:middle',
      visibleTabKeys: ['tabdoc:left', 'tabdoc:middle', 'tabdoc:right'],
      tabOrder: ['tabdoc:left', 'tabdoc:middle', 'tabdoc:right'],
      spaceGroups: [],
    })
    expect(result).toBe('tabdoc:right')
  })

  it('不在 group 内的末尾 tab 关闭 → visible 左邻居', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabdoc:right',
      visibleTabKeys: ['tabdoc:left', 'tabdoc:right'],
      tabOrder: ['tabdoc:left', 'tabdoc:right'],
      spaceGroups: [],
    })
    expect(result).toBe('tabdoc:left')
  })

  it('group 内 tab 不在 visibleTabKeys → 通过 tabOrder 找最近 visible', () => {
    const result = computeFallbackTabKey({
      closingTabKey: 'tabweb:only',
      visibleTabKeys: ['tabdoc:a', 'tabdoc:b'],
      tabOrder: ['tabdoc:a', 'tabweb:only', 'tabdoc:b'],
      spaceGroups: [
        makeGroup('g1', [{ id: 'p1', tabKey: 'tabweb:only' }]),
      ],
    })
    expect(result).toBe('tabdoc:b')
  })
})

describe('computeFallbackTabKeyFromStore — 直接单测', () => {
  it('单 group 单 pane：closing 在 group 内 → fallback 到外面 visible 邻居', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabweb:a',
      tabOrder: ['tabweb:a', 'tabdoc:x', 'tabdoc:y'],
      spaceGroups: [makeGroup('g1', [{ id: 'p1', tabKey: 'tabweb:a' }])],
    })
    expect(result).toBe('tabdoc:x')
  })

  it('单 group 多 pane：closing 在 group 内 → fallback 到 group survivor', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabweb:a',
      tabOrder: ['tabweb:a', 'tabweb:b', 'tabdoc:x'],
      spaceGroups: [
        makeGroup('g1', [
          { id: 'p1', tabKey: 'tabweb:a' },
          { id: 'p2', tabKey: 'tabweb:b' },
        ]),
      ],
    })
    expect(result).toBe('tabweb:b')
  })

  it('多 group：closing 在某 group 内 → fallback 优先 group survivor', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabweb:a',
      tabOrder: ['tabweb:a', 'tabweb:b', 'tabweb:c', 'tabweb:d', 'tabdoc:x'],
      spaceGroups: [
        makeGroup('g1', [
          { id: 'p1', tabKey: 'tabweb:a' },
          { id: 'p2', tabKey: 'tabweb:b' },
        ]),
        makeGroup('g2', [
          { id: 'p3', tabKey: 'tabweb:c' },
          { id: 'p4', tabKey: 'tabweb:d' },
        ]),
      ],
    })
    expect(result).toBe('tabweb:b')
  })

  it('无 group：closing 是普通 tab → fallback 到 visible 邻居', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabdoc:mid',
      tabOrder: ['tabdoc:left', 'tabdoc:mid', 'tabdoc:right'],
      spaceGroups: [],
    })
    expect(result).toBe('tabdoc:right')
  })

  it('0 pane group（持久化崩溃产物）混在中间 → 自动剔除 + fallback 仍正确', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabdoc:mid',
      tabOrder: ['tabdoc:left', 'tabdoc:mid', 'tabdoc:right'],
      spaceGroups: [makeGroup('g-empty', [])],
    })
    expect(result).toBe('tabdoc:right')
  })

  it('空 tabOrder → null', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabdoc:x',
      tabOrder: [],
      spaceGroups: [],
    })
    expect(result).toBeNull()
  })

  it('自动剔除 group 内 tab key 算 visibleTabKeys（区别于 computeFallbackTabKey 需显式传入）', () => {
    const result = computeFallbackTabKeyFromStore({
      closingTabKey: 'tabdoc:a',
      tabOrder: ['tabdoc:a', 'tabweb:g1', 'tabweb:g2', 'tabdoc:b'],
      spaceGroups: [
        makeGroup('g1', [
          { id: 'p1', tabKey: 'tabweb:g1' },
          { id: 'p2', tabKey: 'tabweb:g2' },
        ]),
      ],
    })
    expect(result).toBe('tabdoc:b')
  })
})
