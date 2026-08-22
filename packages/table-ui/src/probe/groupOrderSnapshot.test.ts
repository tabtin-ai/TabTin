import { describe, expect, it } from 'vitest'
import type { TableGridRow } from '@tabtin/table-engine'
import { buildGroupOrderSnapshot } from './groupOrderSnapshot'

const header = (
  path: string,
  value: unknown,
  level = 0,
): TableGridRow => ({
  id: `group:${path}`,
  __rowType: 'group_header',
  __groupLevel: level,
  __groupLabel: value == null ? 'Ungrouped' : String(value),
  __groupValue: value,
  __groupPath: path,
  __groupCount: 1,
}) as unknown as TableGridRow

describe('buildGroupOrderSnapshot', () => {
  it('captures the rendered group order and accepts empty siblings at the end', () => {
    const snapshot = buildGroupOrderSnapshot([
      header('a', 'A'),
      header('b', 'B'),
      header('__empty__', null),
    ])

    expect(snapshot.groups.map(group => group.path)).toEqual([
      'a',
      'b',
      '__empty__',
    ])
    expect(snapshot.emptyGroupsLast).toBe(true)
    expect(snapshot.siblingOrders.__root__).toEqual(['a', 'b', '__empty__'])
  })

  it('rejects an empty group followed by a non-empty sibling', () => {
    const snapshot = buildGroupOrderSnapshot([
      header('a', 'A'),
      header('__empty__', null),
      header('b', 'B'),
    ])

    expect(snapshot.emptyGroupsLast).toBe(false)
  })

  it('evaluates empty placement independently at each nesting level', () => {
    const snapshot = buildGroupOrderSnapshot([
      header('parent-a', 'Parent A'),
      header('parent-a||child-a', 'Child A', 1),
      header('parent-a||__empty__', '', 1),
      header('parent-b', 'Parent B'),
      header('parent-b||child-b', 'Child B', 1),
      header('parent-b||__empty__', [], 1),
    ])

    expect(snapshot.emptyGroupsLast).toBe(true)
    expect(snapshot.siblingOrders['parent-a']).toEqual([
      'parent-a||child-a',
      'parent-a||__empty__',
    ])
    expect(snapshot.siblingOrders['parent-b']).toEqual([
      'parent-b||child-b',
      'parent-b||__empty__',
    ])
    expect(snapshot.groups.filter(group => group.level === 1).map(group => group.empty)).toEqual([
      false,
      true,
      false,
      true,
    ])
  })

  it('changes its signature when presentation order changes', () => {
    const first = buildGroupOrderSnapshot([header('a', 'A'), header('b', 'B')])
    const second = buildGroupOrderSnapshot([header('b', 'B'), header('a', 'A')])

    expect(first.signature).not.toBe(second.signature)
  })
})
