import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceExecutionRootEntry,
  encodeTabCodeResourceId,
  normalizeWorkingDirType,
  openWorkspaceExecutionRoot,
  resolveExecutionView,
  resolveWorkspaceWorkingDir,
} from './workspaceExecutionRootApp'

const mocks = vi.hoisted(() => ({
  openResourceTab: vi.fn(),
  addSpaceFolder: vi.fn(() => ({ folderId: 'space-1::folder', isNew: false })),
  findFolderByPathForSpace: vi.fn(() => null as string | null),
}))

vi.mock('./registry', () => ({
  contextRegistry: {
    buildTabKey: (type: string, id: string) => `${type}:${id}`,
  },
}))

vi.mock('./folder/useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({
      addSpaceFolder: mocks.addSpaceFolder,
      findFolderByPathForSpace: mocks.findFolderByPathForSpace,
    }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mocks.openResourceTab,
    }),
  },
}))

const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key

describe('workspaceExecutionRootApp', () => {
  beforeEach(() => {
    mocks.openResourceTab.mockClear()
    mocks.addSpaceFolder.mockClear()
    mocks.findFolderByPathForSpace.mockReset()
    mocks.findFolderByPathForSpace.mockReturnValue(null)
  })

  it('normalizeWorkingDirType 只接受 code/doc/mixed', () => {
    expect(normalizeWorkingDirType('code')).toBe('code')
    expect(normalizeWorkingDirType('unknown')).toBe('')
  })

  it('resolveExecutionView：code → IDE，其余 → 目录', () => {
    expect(resolveExecutionView('code')).toBe('code')
    expect(resolveExecutionView('mixed')).toBe('folder')
    expect(resolveExecutionView('doc')).toBe('folder')
  })

  it('resolveWorkspaceWorkingDir 优先 Space.working_dir', () => {
    expect(resolveWorkspaceWorkingDir(
      { type: 'workspace', working_dir: '/a' },
      { working_dir: '/b' } as never,
    )).toBe('/a')
    expect(resolveWorkspaceWorkingDir(
      { type: 'workspace', working_dir: '' },
      { working_dir: '/b' } as never,
    )).toBe('/b')
  })

  it('buildWorkspaceExecutionRootEntry：code 类型生成 TabCode tabKey', () => {
    const path = '/Users/me/project'
    const entry = buildWorkspaceExecutionRootEntry({
      spaceId: 'space-1',
      workingDir: path,
      workingDirType: 'code',
      t,
    })
    expect(entry?.appId).toBe('tabcode')
    expect(entry?.label).toBe('IDE')
    expect(entry?.tabKey).toBe(`tabcode:${encodeTabCodeResourceId(path)}`)
  })

  it('openWorkspaceExecutionRoot：非 code 打开 tabfolder', () => {
    openWorkspaceExecutionRoot({
      tabScopeKey: 'space-1',
      spaceId: 'space-1',
      workingDir: '/tmp/docs',
      view: 'folder',
    })
    expect(mocks.addSpaceFolder).toHaveBeenCalled()
    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'tabfolder',
      meta: expect.objectContaining({ preferredView: 'folder' }),
    }))
  })
})
