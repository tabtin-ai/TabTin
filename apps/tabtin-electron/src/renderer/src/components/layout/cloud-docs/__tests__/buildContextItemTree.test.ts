import { describe, expect, it } from 'vitest'
import { buildContextItemTree } from '../buildContextItemTree'

describe('buildContextItemTree ', () => {
  it('nests children by parent_id and promotes orphans to root', () => {
    const roots = buildContextItemTree([
      { id: 'a', item_type: 'tabdoc', title: 'A', order: 0 },
      { id: 'b', parent_id: 'a', item_type: 'tabdata', title: 'B', order: 1 },
      { id: 'c', parent_id: 'missing', item_type: 'tabdoc', title: 'C', order: 2 },
    ])

    expect(roots.map(n => n.item.id)).toEqual(['a', 'c'])
    expect(roots[0]?.children.map(n => n.item.id)).toEqual(['b'])
  })

  it('filters by allowedTypes', () => {
    const roots = buildContextItemTree(
      [
        { id: 'a', item_type: 'tabdoc', title: 'A' },
        { id: 'f', item_type: 'tabfiles', title: 'File' },
      ],
      { allowedTypes: new Set(['tabdoc', 'tabdata']) },
    )
    expect(roots.map(n => n.item.id)).toEqual(['a'])
  })
})
