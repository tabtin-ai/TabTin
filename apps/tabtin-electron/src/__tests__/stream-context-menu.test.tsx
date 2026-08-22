// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { toastMock, storeActionsMock } = vi.hoisted(() => {
  const toastFn = vi.fn()
  return {
    toastMock: toastFn,
    storeActionsMock: {
      openPath: vi.fn(),
      showPathInFolder: vi.fn(),
      cancelStream: vi.fn(),
      removeStreamItem: vi.fn(),
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue || _key,
  }),
}))

vi.mock('../renderer/src/components/crawl/DownloadRowShared', () => ({
  storeActions: storeActionsMock,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuDivider: () => <hr />,
  ContextMenuItem: ({
    label,
    onClick,
  }: {
    label: string
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
  toast: toastMock,
}))

import { StreamContextMenu } from '../renderer/src/components/crawl/StreamContextMenu'

function renderMenu(status: 'resolving' | 'downloading' | 'merging' | 'completed' | 'failed') {
  return render(
    <StreamContextMenu
      x={0}
      y={0}
      onClose={() => {}}
      item={{
        id: 'stream-1',
        name: 'stream',
        url: 'https://example.com/video.m3u8',
        savePath: '/tmp/stream.ts',
        status,
        size: { received: 1, total: 2 },
        segments: { done: 1, total: 2 },
        speed: 0,
        percent: 50,
        startTime: Date.now(),
      }}
    />
  )
}

describe('StreamContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: any }).window = {
      electron: {
        ipcRenderer: {
          invoke: vi.fn(),
        },
      },
    }
  })

  it('进行中任务不显示“从列表移除”', () => {
    renderMenu('downloading')
    expect(screen.queryByText('从列表移除')).toBeNull()
  })

  it('删除文件失败时不应移除列表项', async () => {
    window.electron.ipcRenderer.invoke.mockResolvedValue({ success: false, error: 'unlink failed' })
    renderMenu('completed')
    fireEvent.click(screen.getByText('删除文件'))
    await Promise.resolve()
    await Promise.resolve()
    expect(storeActionsMock.removeStreamItem).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalled()
  })
})
