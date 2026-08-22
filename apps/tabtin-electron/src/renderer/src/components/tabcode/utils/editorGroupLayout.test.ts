import { describe, expect, it } from 'vitest'
import {
  ROOT_EDITOR_GROUP_ID,
  activateEditorGroupFile,
  closeEditorGroupFile,
  createEditorWorkspace,
  moveEditorFile,
  normalizeEditorWorkspace,
  reorderEditorGroupFile,
  splitEditorGroupWithFile,
  splitEmptyEditorGroup,
  pinEditorGroup,
  unpinEditorGroup,
} from './editorGroupLayout'

describe('TabCode editor group layout', () => {
  it('migrates the legacy single-tab session into a root editor group', () => {
    const workspace = normalizeEditorWorkspace({
      openFiles: ['/repo/a.ts', '/repo/b.ts'],
      activeFile: '/repo/a.ts',
    })

    expect(workspace.activeGroupId).toBe(ROOT_EDITOR_GROUP_ID)
    expect(workspace.groupsById[ROOT_EDITOR_GROUP_ID]).toMatchObject({
      openFiles: ['/repo/a.ts', '/repo/b.ts'],
      activeFile: '/repo/a.ts',
    })
    expect(workspace.layout).toEqual({ type: 'leaf', paneId: ROOT_EDITOR_GROUP_ID })
  })

  it('moves a tab into a split next to its own group', () => {
    let workspace = createEditorWorkspace()
    workspace = activateEditorGroupFile(
      { ...workspace, groupsById: {
        ...workspace.groupsById,
        [ROOT_EDITOR_GROUP_ID]: {
          ...workspace.groupsById[ROOT_EDITOR_GROUP_ID],
          openFiles: ['/repo/a.ts', '/repo/b.ts'],
          activeFile: '/repo/a.ts',
        },
      } },
      ROOT_EDITOR_GROUP_ID,
      '/repo/a.ts',
    )

    const split = splitEditorGroupWithFile(
      workspace,
      ROOT_EDITOR_GROUP_ID,
      ROOT_EDITOR_GROUP_ID,
      '/repo/b.ts',
      'right',
    )

    expect(split.layout.type).toBe('split')
    expect(Object.values(split.groupsById)).toHaveLength(2)
    expect(split.groupsById[ROOT_EDITOR_GROUP_ID].openFiles).toEqual(['/repo/a.ts'])
    expect(split.groupsById[split.activeGroupId].openFiles).toEqual(['/repo/b.ts'])
  })

  it('reorders tabs within a group without changing the active file', () => {
    const workspace = normalizeEditorWorkspace({
      openFiles: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      activeFile: '/repo/c.ts',
    })

    const reordered = reorderEditorGroupFile(
      workspace,
      ROOT_EDITOR_GROUP_ID,
      '/repo/c.ts',
      '/repo/a.ts',
    )

    expect(reordered.groupsById[ROOT_EDITOR_GROUP_ID]).toMatchObject({
      openFiles: ['/repo/c.ts', '/repo/a.ts', '/repo/b.ts'],
      activeFile: '/repo/c.ts',
    })
  })

  it('inserts a dragged tab after the hovered tab when requested', () => {
    const workspace = normalizeEditorWorkspace({
      openFiles: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      activeFile: '/repo/a.ts',
    })

    const reordered = reorderEditorGroupFile(
      workspace,
      ROOT_EDITOR_GROUP_ID,
      '/repo/a.ts',
      '/repo/b.ts',
      'after',
    )

    expect(reordered.groupsById[ROOT_EDITOR_GROUP_ID].openFiles).toEqual([
      '/repo/b.ts',
      '/repo/a.ts',
      '/repo/c.ts',
    ])
  })

  it('moves a tab to another group and collapses the emptied source group', () => {
    let workspace = normalizeEditorWorkspace({
      groupsById: {
        left: { id: 'left', openFiles: ['/repo/a.ts'], activeFile: '/repo/a.ts' },
        right: { id: 'right', openFiles: ['/repo/b.ts'], activeFile: '/repo/b.ts' },
      },
      layout: {
        type: 'split',
        id: 'root-split',
        direction: 'horizontal',
        children: [{ type: 'leaf', paneId: 'left' }, { type: 'leaf', paneId: 'right' }],
        sizes: [0.5, 0.5],
      },
      activeGroupId: 'left',
    })

    workspace = moveEditorFile(workspace, 'left', 'right', '/repo/a.ts')

    expect(workspace.layout).toEqual({ type: 'leaf', paneId: 'right' })
    expect(workspace.groupsById).toEqual({
      right: { id: 'right', openFiles: ['/repo/b.ts', '/repo/a.ts'], activeFile: '/repo/a.ts' },
    })
  })

  it('moves a tab into a precise cross-group insertion position', () => {
    const workspace = normalizeEditorWorkspace({
      groupsById: {
        left: { id: 'left', openFiles: ['/repo/a.ts', '/repo/c.ts'], activeFile: '/repo/a.ts' },
        right: { id: 'right', openFiles: ['/repo/b.ts', '/repo/d.ts'], activeFile: '/repo/b.ts' },
      },
      layout: {
        type: 'split',
        id: 'root-split',
        direction: 'horizontal',
        children: [{ type: 'leaf', paneId: 'left' }, { type: 'leaf', paneId: 'right' }],
        sizes: [0.5, 0.5],
      },
      activeGroupId: 'left',
    })

    const moved = moveEditorFile(workspace, 'left', 'right', '/repo/c.ts', '/repo/b.ts', 'before')

    expect(moved.groupsById.left.openFiles).toEqual(['/repo/a.ts'])
    expect(moved.groupsById.right.openFiles).toEqual(['/repo/c.ts', '/repo/b.ts', '/repo/d.ts'])
    expect(moved.activeGroupId).toBe('right')
  })

  it('keeps an existing target tab in place when both groups open the same file', () => {
    const workspace = normalizeEditorWorkspace({
      groupsById: {
        left: { id: 'left', openFiles: ['/repo/a.ts'], activeFile: '/repo/a.ts' },
        right: {
          id: 'right',
          openFiles: ['/repo/b.ts', '/repo/a.ts', '/repo/c.ts'],
          activeFile: '/repo/b.ts',
        },
      },
      layout: {
        type: 'split',
        id: 'root-split',
        direction: 'horizontal',
        children: [{ type: 'leaf', paneId: 'left' }, { type: 'leaf', paneId: 'right' }],
        sizes: [0.5, 0.5],
      },
      activeGroupId: 'left',
    })

    const moved = moveEditorFile(workspace, 'left', 'right', '/repo/a.ts', '/repo/a.ts', 'before')

    expect(moved.groupsById.right.openFiles).toEqual(['/repo/b.ts', '/repo/a.ts', '/repo/c.ts'])
    expect(moved.groupsById.right.activeFile).toBe('/repo/a.ts')
  })

  it('preserves existing split proportions when a nested group is added then closed', () => {
    const workspace = normalizeEditorWorkspace({
      groupsById: {
        left: { id: 'left', openFiles: ['/repo/a.ts'], activeFile: '/repo/a.ts' },
        right: {
          id: 'right',
          openFiles: ['/repo/b.ts', '/repo/c.ts'],
          activeFile: '/repo/b.ts',
        },
      },
      layout: {
        type: 'split',
        id: 'root-split',
        direction: 'horizontal',
        children: [{ type: 'leaf', paneId: 'left' }, { type: 'leaf', paneId: 'right' }],
        sizes: [0.7, 0.3],
      },
      activeGroupId: 'right',
    })

    const split = splitEditorGroupWithFile(workspace, 'right', 'right', '/repo/b.ts', 'right')
    expect(split.layout).toMatchObject({
      type: 'split',
      sizes: [0.7, 0.3],
      children: [
        { type: 'leaf', paneId: 'left' },
        { type: 'split', sizes: [0.5, 0.5] },
      ],
    })

    const closed = closeEditorGroupFile(split, split.activeGroupId, '/repo/b.ts')
    expect(closed.layout).toEqual({
      type: 'split',
      id: 'root-split',
      direction: 'horizontal',
      children: [{ type: 'leaf', paneId: 'left' }, { type: 'leaf', paneId: 'right' }],
      sizes: [0.7, 0.3],
    })
  })

  it('collapses the final empty group to a reusable root workspace', () => {
    let workspace = createEditorWorkspace()
    workspace = {
      ...workspace,
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: ['/repo/a.ts'],
          activeFile: '/repo/a.ts',
        },
      },
    }

    expect(closeEditorGroupFile(workspace, ROOT_EDITOR_GROUP_ID, '/repo/a.ts')).toEqual(
      createEditorWorkspace(),
    )
  })

  it('keeps an empty pinned group so History can occupy a split alone', () => {
    let workspace = createEditorWorkspace()
    workspace = {
      ...workspace,
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: ['/repo/a.ts'],
          activeFile: '/repo/a.ts',
        },
      },
    }
    const split = splitEmptyEditorGroup(workspace, ROOT_EDITOR_GROUP_ID, 'right')
    expect(split.layout.type).toBe('split')
    expect(split.groupsById[split.activeGroupId].openFiles).toEqual([])
    expect(split.pinnedGroupIds).toContain(split.activeGroupId)

    const closedSource = closeEditorGroupFile(split, ROOT_EDITOR_GROUP_ID, '/repo/a.ts')
    expect(closedSource.groupsById[split.activeGroupId]).toBeTruthy()
    expect(Object.keys(closedSource.groupsById)).toHaveLength(1)

    const unpinned = unpinEditorGroup(closedSource, split.activeGroupId)
    expect(unpinned).toEqual(createEditorWorkspace())
  })

  it('does not persist a pin on a missing group', () => {
    const workspace = pinEditorGroup(createEditorWorkspace(), 'missing')
    expect(workspace.pinnedGroupIds ?? []).toEqual([])
  })

  it('drops pinned empty groups when pins are cleared before normalize', () => {
    let workspace = createEditorWorkspace()
    workspace = {
      ...workspace,
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: ['/repo/a.ts'],
          activeFile: '/repo/a.ts',
        },
      },
    }
    const split = splitEmptyEditorGroup(workspace, ROOT_EDITOR_GROUP_ID, 'right')
    const persisted = normalizeEditorWorkspace({ ...split, pinnedGroupIds: [] })
    expect(persisted.groupsById[split.activeGroupId]).toBeUndefined()
    expect(persisted.groupsById[ROOT_EDITOR_GROUP_ID].openFiles).toEqual(['/repo/a.ts'])
  })
})
