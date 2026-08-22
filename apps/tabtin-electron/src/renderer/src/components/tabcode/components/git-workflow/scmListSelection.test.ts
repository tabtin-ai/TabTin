import { describe, expect, it } from 'vitest'
import {
  emptyScmSelection,
  makeScmSelectionKey,
  pruneSelection,
  reduceSelection,
  resolveActionPaths,
  selectionModeFromEvent,
} from './scmListSelection'

const unstaged = ['a.ts', 'b.ts', 'c.ts', 'd.ts'] as const

describe('scmListSelection', () => {
  it('replace 清空并单选，设置锚点', () => {
    const prev = reduceSelection({
      prev: emptyScmSelection(),
      mode: 'replace',
      section: 'unstaged',
      path: 'b.ts',
      sectionPaths: unstaged,
    })
    expect([...prev.selectedKeys]).toEqual(['unstaged:b.ts'])
    expect(prev.anchorKey).toBe('unstaged:b.ts')
  })

  it('toggle 增减选中并更新锚点', () => {
    let state = reduceSelection({
      prev: emptyScmSelection(),
      mode: 'replace',
      section: 'unstaged',
      path: 'a.ts',
      sectionPaths: unstaged,
    })
    state = reduceSelection({
      prev: state,
      mode: 'toggle',
      section: 'unstaged',
      path: 'c.ts',
      sectionPaths: unstaged,
    })
    expect(new Set(state.selectedKeys)).toEqual(new Set([
      'unstaged:a.ts',
      'unstaged:c.ts',
    ]))
    expect(state.anchorKey).toBe('unstaged:c.ts')

    state = reduceSelection({
      prev: state,
      mode: 'toggle',
      section: 'unstaged',
      path: 'a.ts',
      sectionPaths: unstaged,
    })
    expect([...state.selectedKeys]).toEqual(['unstaged:c.ts'])
  })

  it('range 同分区从锚点连续选，不跨区', () => {
    let state = reduceSelection({
      prev: emptyScmSelection(),
      mode: 'replace',
      section: 'unstaged',
      path: 'a.ts',
      sectionPaths: unstaged,
    })
    state = reduceSelection({
      prev: state,
      mode: 'range',
      section: 'unstaged',
      path: 'c.ts',
      sectionPaths: unstaged,
    })
    expect([...state.selectedKeys].sort()).toEqual([
      'unstaged:a.ts',
      'unstaged:b.ts',
      'unstaged:c.ts',
    ])
    expect(state.anchorKey).toBe('unstaged:a.ts')

    // 锚点在 staged 时，对 unstaged 做 range → 退化为单选
    state = {
      selectedKeys: new Set([makeScmSelectionKey('staged', 'x.ts')]),
      anchorKey: makeScmSelectionKey('staged', 'x.ts'),
    }
    state = reduceSelection({
      prev: state,
      mode: 'range',
      section: 'unstaged',
      path: 'b.ts',
      sectionPaths: unstaged,
    })
    expect([...state.selectedKeys]).toEqual(['unstaged:b.ts'])
  })

  it('pruneSelection 清掉已消失路径', () => {
    const prev = {
      selectedKeys: new Set([
        makeScmSelectionKey('unstaged', 'a.ts'),
        makeScmSelectionKey('unstaged', 'gone.ts'),
      ]),
      anchorKey: makeScmSelectionKey('unstaged', 'gone.ts'),
    }
    const next = pruneSelection(prev, new Set([makeScmSelectionKey('unstaged', 'a.ts')]))
    expect([...next.selectedKeys]).toEqual(['unstaged:a.ts'])
    expect(next.anchorKey).toBeNull()
  })

  it('resolveActionPaths：多选命中则批量，否则单文件', () => {
    const selected = new Set([
      makeScmSelectionKey('unstaged', 'a.ts'),
      makeScmSelectionKey('unstaged', 'b.ts'),
      makeScmSelectionKey('staged', 's.ts'),
    ])
    expect(resolveActionPaths(selected, 'unstaged', 'a.ts', unstaged)).toEqual(['a.ts', 'b.ts'])
    expect(resolveActionPaths(selected, 'unstaged', 'c.ts', unstaged)).toEqual(['c.ts'])
    expect(resolveActionPaths(selected, 'staged', 's.ts')).toEqual(['s.ts'])
  })

  it('selectionModeFromEvent', () => {
    expect(selectionModeFromEvent({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe('range')
    expect(selectionModeFromEvent({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe('toggle')
    expect(selectionModeFromEvent({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe('toggle')
    expect(selectionModeFromEvent({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe('replace')
  })
})
