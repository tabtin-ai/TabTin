import { beforeEach, describe, expect, it, vi } from 'vitest'

const notifyWorkspacePathsForSpace = vi.hoisted(() => vi.fn())

vi.mock('@components/context-space/registry/instance', () => ({
  contextRegistry: {
    buildTabKey: (type: string, id: string) => `${type}:${id}`,
  },
}))

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace,
}))

import { useFolderContextStore } from '../useFolderStore'

describe('useFolderContextStore desktop user folders', () => {
  beforeEach(() => {
    notifyWorkspacePathsForSpace.mockClear()
    useFolderContextStore.setState({ folders: {}, userFolders: {}, seenBoundDirs: {} })
  })

  it('stores user folders by workspace scope without notifying Space allowed paths', () => {
    const result = useFolderContextStore.getState().addUserFolder('desktop:wt-1:user-u1', {
      rootPath: '/Users/me/reference',
      kind: 'user',
      title: 'reference',
    })

    expect(result.folderId).toContain('user::')
    expect(useFolderContextStore.getState().getUserFolderIds('desktop:wt-1:user-u1')).toEqual([result.folderId])
    expect(useFolderContextStore.getState().userFolders[result.folderId]?.rootPath).toBe('/Users/me/reference')
    expect(notifyWorkspacePathsForSpace).not.toHaveBeenCalled()
  })

  it('relocateUserFolder swaps path-encoded id and drops the old entry', () => {
    const scope = 'desktop:wt-1:user-u1'
    const { folderId } = useFolderContextStore.getState().addUserFolder(scope, {
      rootPath: '/Users/me/old-name',
      kind: 'user',
      title: 'old-name',
    })

    const relocated = useFolderContextStore.getState().relocateUserFolder(
      folderId,
      '/Users/me/new-name',
    )

    expect(relocated).toMatchObject({
      oldFolderId: folderId,
      rootPath: '/Users/me/new-name',
      title: 'new-name',
    })
    expect(relocated?.newFolderId).not.toBe(folderId)
    expect(useFolderContextStore.getState().userFolders[folderId]).toBeUndefined()
    expect(useFolderContextStore.getState().userFolders[relocated!.newFolderId]?.rootPath).toBe(
      '/Users/me/new-name',
    )
  })

  it('legacy space folders still notify workspace paths', () => {
    useFolderContextStore.getState().addSpaceFolder('space-1', {
      rootPath: '/Users/me/agent',
      kind: 'sandbox',
      title: 'Agent 文件夹',
    })

    expect(notifyWorkspacePathsForSpace).toHaveBeenCalledWith('space-1')
  })

  describe('reconcileBoundDirs (降级承接)', () => {
    const scope = 'tabfolder:organization:wt-1:user:u1'

    it('records the current bound snapshot without adding user folders on first sight', () => {
      useFolderContextStore.getState().reconcileBoundDirs(scope, ['/Users/me/a', '/Users/me/b'])

      expect(useFolderContextStore.getState().seenBoundDirs[scope]).toEqual(['/Users/me/a', '/Users/me/b'])
      expect(Object.keys(useFolderContextStore.getState().userFolders)).toHaveLength(0)
    })

    it('downgrades a disappeared bound dir into a deletable user folder', () => {
      const store = useFolderContextStore.getState()
      // 首次快照：a、b 都在
      store.reconcileBoundDirs(scope, ['/Users/me/a', '/Users/me/b'])
      // b 的绑定消失（Space 删除 / 换绑）
      store.reconcileBoundDirs(scope, ['/Users/me/a'])

      const userFolders = useFolderContextStore.getState().userFolders
      const downgraded = Object.values(userFolders).find(f => f?.rootPath === '/Users/me/b')
      expect(downgraded).toBeTruthy()
      expect(downgraded?.kind).toBe('user')
      expect(downgraded?.readOnly).toBe(false)
      // 快照收敛为当前值
      expect(useFolderContextStore.getState().seenBoundDirs[scope]).toEqual(['/Users/me/a'])
    })

    it('does not duplicate a downgraded folder that already exists as a user folder', () => {
      const store = useFolderContextStore.getState()
      store.addUserFolder(scope, { rootPath: '/Users/me/b', kind: 'user', title: 'b' })
      const before = Object.keys(useFolderContextStore.getState().userFolders).length

      store.reconcileBoundDirs(scope, ['/Users/me/b'])
      store.reconcileBoundDirs(scope, [])

      const after = Object.keys(useFolderContextStore.getState().userFolders).length
      expect(after).toBe(before)
    })
  })
})
