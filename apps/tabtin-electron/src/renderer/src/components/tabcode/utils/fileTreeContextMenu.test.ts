import { describe, expect, it } from 'vitest'
import { getFileTreeContextMenuModel } from './fileTreeContextMenu'

describe('getFileTreeContextMenuModel', () => {
  it('allows creating children from a folder in the primary tree', () => {
    expect(getFileTreeContextMenuModel({ path: '/project/src', isDirectory: true }, 'tree')).toEqual({
      canCreateChildren: true,
      newItemParentPath: '/project/src',
    })
  })

  it('removes create actions from a file in the primary tree', () => {
    expect(getFileTreeContextMenuModel({ path: '/project/src/index.ts', isDirectory: false }, 'tree')).toEqual({
      canCreateChildren: false,
      newItemParentPath: null,
    })
  })

  it('does not add create actions to auxiliary folder rows', () => {
    const folder = { path: '/project/src', isDirectory: true }

    expect(getFileTreeContextMenuModel(folder, 'search')).toEqual({
      canCreateChildren: false,
      newItemParentPath: null,
    })
    expect(getFileTreeContextMenuModel(folder, 'pinned')).toEqual({
      canCreateChildren: false,
      newItemParentPath: null,
    })
  })
})
