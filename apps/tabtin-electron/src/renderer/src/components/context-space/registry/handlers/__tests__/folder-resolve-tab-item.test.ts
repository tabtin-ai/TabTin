import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const mocks = vi.hoisted(() => ({
  openResourceTab: vi.fn(),
}))

vi.mock('@components/context-space/folder/useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({
      folders: {},
      userFolders: {},
      refreshFolder: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: {
    getState: () => ({ push: vi.fn() }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab: mocks.openResourceTab }),
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? 'Agent 文件夹',
  },
}))

import { folderHandler } from '../folder'

describe('folderHandler keepAliveSuspendMode ', () => {
  it('uses visibility keepAlive so switching tabs preserves local directory state', () => {
    expect(folderHandler.keepAlive).toBe(true)
    expect(folderHandler.keepAliveSuspendMode).toBe('visibility')
  })
})

describe('folderHandler.resolveTabItem', () => {
  it('preserves reveal_path from persisted tabfolder metadata', () => {
    const resolved = folderHandler.resolveTabItem?.('folder-agent', {
      spaceId: 'space-1',
      tabKey: 'tabfolder:folder-agent',
      persistedItem: {
        title: 'Agent 文件夹',
        meta: {
          path: '/Users/me/space',
          kind: 'sandbox',
          reveal_path: '/Users/me/space/artifacts/news.md',
        },
      },
    })

    expect(resolved?.meta).toEqual({
      path: '/Users/me/space',
      kind: 'sandbox',
      reveal_path: '/Users/me/space/artifacts/news.md',
    })
  })
})

describe('folderHandler local directory activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('activates the requested tab without an async focus handoff', () => {
    folderHandler.onSelect?.({
      type: 'tabfolder',
      id: 'user-folder',
      tabKey: 'tabfolder:user-folder',
      title: 'TabTin',
      meta: {
        path: 'C:\\workspace\\TabTin-feature\\TabTin',
        kind: 'user',
      },
    }, {
      spaceId: 'space-1',
      tabScopeKey: 'desktop:user-1',
      closeBrowserView: vi.fn(),
    })

    expect(mocks.openResourceTab).toHaveBeenCalledWith('desktop:user-1', {
      type: 'tabfolder',
      id: 'user-folder',
      title: 'TabTin',
      meta: {
        path: 'C:\\workspace\\TabTin-feature\\TabTin',
        kind: 'user',
      },
    })
  })

  it('requires session authorization at the render seam for every user directory entry path', () => {
    const pane = folderHandler.renderPane?.({
      type: 'tabfolder',
      id: 'user-folder',
      tabKey: 'tabfolder:user-folder',
      title: 'TabTin',
      meta: {
        path: 'C:\\workspace\\TabTin-feature\\TabTin',
        kind: 'user',
      },
    }, {
      spaceId: 'space-1',
      tabScopeKey: 'desktop:user-1',
      closeBrowserView: vi.fn(),
    }) as ReactElement<{ children: ReactElement<{ requiresSessionAuthorization?: boolean }> }>

    expect(pane.props.children.props.requiresSessionAuthorization).toBe(true)
  })
})
