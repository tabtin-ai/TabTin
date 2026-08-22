import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasPane } from '@stores/useCanvasLayoutStore'
import { CanvasPaneContent } from './CanvasPaneContent'

const mocks = vi.hoisted(() => ({
  renderPane: vi.fn((item: { meta?: Record<string, unknown> }) => (
    <div data-testid="folder-pane">{String(item.meta?.path ?? '')}</div>
  )),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: (selector: (state: {
    crawlspaceContextCache: Record<string, unknown>
  }) => unknown) => selector({ crawlspaceContextCache: {} }),
}))

vi.mock('@/crawlspace/registry', () => ({
  useCrawlspaceRegistry: () => ({ getConfig: vi.fn() }),
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    parseTabKey: () => ({ type: 'tabfolder', id: 'user-folder' }),
    getHandler: () => ({ renderPane: mocks.renderPane }),
  },
}))

vi.mock('@components/context-space/folder', () => ({
  useFolderContextStore: (selector: (state: {
    folders: Record<string, unknown>
    userFolders: Record<string, unknown>
  }) => unknown) => selector({
    folders: {},
    userFolders: {
      'user-folder': {
        title: 'TabTin',
        rootPath: 'C:\\workspace\\TabTin-feature\\TabTin',
        kind: 'user',
        updatedAt: 1,
      },
    },
  }),
}))

vi.mock('@components/context-space/sources/terminal', () => ({
  useTerminalSessionStore: (selector: (state: {
    sessionsBySpace: Record<string, unknown[]>
  }) => unknown) => selector({ sessionsBySpace: {} }),
}))

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => ({
    isRemoteViewer: false,
    controlDeviceName: null,
    workingDir: null,
  }),
}))

vi.mock('@components/context-space/folder/RemoteAgentBanner', () => ({
  RemoteAgentBanner: () => null,
}))

vi.mock('@components/context-space/executionDeviceApps', () => ({
  EXECUTION_DEVICE_APP_IDS: new Set<string>(),
  EXECUTION_DEVICE_APP_LABEL_FALLBACK: {},
}))

describe('CanvasPaneContent user directory metadata', () => {
  it('resolves a canvas tabfolder from userFolders', () => {
    const pane: CanvasPane = {
      id: 'pane-1',
      content: { tabKey: 'tabfolder:user-folder' },
    }

    render(
      <CanvasPaneContent
        pane={pane}
        spaceId="space-1"
        isActive
      />,
    )

    expect(screen.getByTestId('folder-pane').textContent)
      .toBe('C:\\workspace\\TabTin-feature\\TabTin')
    expect(mocks.renderPane).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-folder',
        meta: expect.objectContaining({
          path: 'C:\\workspace\\TabTin-feature\\TabTin',
          kind: 'user',
        }),
      }),
      expect.objectContaining({ spaceId: 'space-1' }),
    )
  })
})
