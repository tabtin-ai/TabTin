import { beforeEach, describe, expect, it } from 'vitest'
import { createEditorWorkspace, ROOT_EDITOR_GROUP_ID } from '../utils/editorGroupLayout'
import {
  getTabCodeWorkspaceSessionKey,
  getUnscopedTabCodeWorkspaceSessionKey,
  useTabCodeStore,
} from './useTabCodeStore'

const rootPath = '/repo'
const resourceId = 'local-dir:/repo'

describe('TabCode workspace sessions', () => {
  beforeEach(() => {
    useTabCodeStore.setState({
      workspaceSessionsByKey: {},
      pendingRevealByRootPath: {},
    })
  })

  it('keeps the same resource isolated across workbench scopes', () => {
    const leftScopeKey = getTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)
    const rightScopeKey = getTabCodeWorkspaceSessionKey('scope-right', resourceId, rootPath)

    expect(leftScopeKey).not.toBe(rightScopeKey)

    useTabCodeStore.getState().openFileInWorkspaceSession(
      leftScopeKey,
      '/repo/left.ts',
      ROOT_EDITOR_GROUP_ID,
    )

    expect(
      useTabCodeStore.getState().workspaceSessionsByKey[leftScopeKey]
        .groupsById[ROOT_EDITOR_GROUP_ID].openFiles,
    ).toEqual(['/repo/left.ts'])
    expect(useTabCodeStore.getState().workspaceSessionsByKey[rightScopeKey]).toBeUndefined()
  })

  it('moves the unscoped v1 session into the first scoped session that restores it', () => {
    const scopedKey = getTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)
    const unscopedKey = getUnscopedTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)
    const workspace = createEditorWorkspace()
    workspace.groupsById[ROOT_EDITOR_GROUP_ID] = {
      ...workspace.groupsById[ROOT_EDITOR_GROUP_ID],
      openFiles: ['/repo/restored.ts'],
      activeFile: '/repo/restored.ts',
    }
    useTabCodeStore.setState({
      workspaceSessionsByKey: {
        [unscopedKey]: {
          ...workspace,
          expandedDirs: ['/repo/src'],
          recentlyClosedFiles: ['/repo/closed.ts'],
        },
      },
    })

    useTabCodeStore.getState().adoptUnscopedWorkspaceSession(scopedKey, unscopedKey)

    expect(useTabCodeStore.getState().workspaceSessionsByKey[unscopedKey]).toBeUndefined()
    expect(useTabCodeStore.getState().workspaceSessionsByKey[scopedKey]).toMatchObject({
      expandedDirs: ['/repo/src'],
      recentlyClosedFiles: ['/repo/closed.ts'],
      groupsById: {
        [ROOT_EDITOR_GROUP_ID]: { openFiles: ['/repo/restored.ts'] },
      },
    })
  })

  it('does not let an older reveal request consume a newer one', () => {
    useTabCodeStore.getState().setPendingReveal(rootPath, {
      filePath: '/repo/first.ts',
      requestId: 123,
    })
    const firstRequestId = useTabCodeStore.getState()
      .pendingRevealByRootPath[rootPath].requestId
    useTabCodeStore.getState().setPendingReveal(rootPath, {
      filePath: '/repo/second.ts',
      requestId: 123,
    })
    const secondRequestId = useTabCodeStore.getState()
      .pendingRevealByRootPath[rootPath].requestId

    expect(secondRequestId).toBeGreaterThan(firstRequestId)
    expect(useTabCodeStore.getState().consumePendingReveal(rootPath, firstRequestId)).toBeNull()
    expect(useTabCodeStore.getState().consumePendingReveal(rootPath, secondRequestId)).toMatchObject({
      filePath: '/repo/second.ts',
      requestId: secondRequestId,
    })
  })

  it('records dismissed preview files into recently closed without duplicating open tabs', () => {
    const sessionKey = getTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)
    useTabCodeStore.getState().openFileInWorkspaceSession(
      sessionKey,
      '/repo/pinned.ts',
      ROOT_EDITOR_GROUP_ID,
    )

    useTabCodeStore.getState().pushRecentlyClosedFile(sessionKey, '/repo/preview-a.ts')
    useTabCodeStore.getState().pushRecentlyClosedFile(sessionKey, '/repo/preview-b.ts')
    useTabCodeStore.getState().pushRecentlyClosedFile(sessionKey, '/repo/preview-a.ts')
    // 仍作为固定标签打开时不进最近关闭
    useTabCodeStore.getState().pushRecentlyClosedFile(sessionKey, '/repo/pinned.ts')

    expect(
      useTabCodeStore.getState().workspaceSessionsByKey[sessionKey].recentlyClosedFiles,
    ).toEqual(['/repo/preview-a.ts', '/repo/preview-b.ts'])
  })

  it('keeps the active preview in the session workspace', () => {
    const sessionKey = getTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)

    useTabCodeStore.getState().setWorkspacePreview(
      sessionKey,
      ROOT_EDITOR_GROUP_ID,
      '/repo/preview.ts',
      true,
    )

    expect(useTabCodeStore.getState().workspaceSessionsByKey[sessionKey]).toMatchObject({
      previewFilesByGroup: { [ROOT_EDITOR_GROUP_ID]: '/repo/preview.ts' },
      previewActiveByGroup: { [ROOT_EDITOR_GROUP_ID]: true },
    })
  })

  it('removes a deleted preview from the session workspace', () => {
    const sessionKey = getTabCodeWorkspaceSessionKey('scope-left', resourceId, rootPath)
    useTabCodeStore.getState().setWorkspacePreview(
      sessionKey,
      ROOT_EDITOR_GROUP_ID,
      '/repo/deleted-preview.ts',
      true,
    )

    useTabCodeStore.getState().pruneWorkspaceSessionPaths(sessionKey, ['/repo/deleted-preview.ts'])

    expect(useTabCodeStore.getState().workspaceSessionsByKey[sessionKey]).toMatchObject({
      previewFilesByGroup: {},
      previewActiveByGroup: {},
    })
  })
})
