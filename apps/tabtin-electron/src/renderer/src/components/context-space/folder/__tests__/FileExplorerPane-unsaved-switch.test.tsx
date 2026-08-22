import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestLeaveMock = vi.hoisted(() => vi.fn(async () => true))
const readFilePreviewMock = vi.hoisted(() => vi.fn())

vi.mock('@hooks/useFileContentWatch', () => ({
  useFileContentWatch: () => 0,
  FILE_DELETED_VERSION: -1,
}))

vi.mock('@components/layout/WorkdirPaneShell', () => ({
  WorkdirPaneShell: ({
    sidebar,
    children,
  }: {
    sidebar: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <div data-testid="sidebar">{sidebar}</div>
      <div data-testid="content">{children}</div>
    </div>
  ),
}))

vi.mock('../FolderHeader', () => ({
  FolderHeader: () => <div data-testid="folder-header" />,
}))

vi.mock('../FolderSearch', () => ({
  FolderSearch: () => <div data-testid="folder-search" />,
}))

vi.mock('../FileTree', () => ({
  FileTree: ({
    onSelectFile,
  }: {
    onSelectFile: (entry: {
      name: string
      path: string
      isDirectory: boolean
      size: number
      modifiedAt: number | null
    }) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onSelectFile({
          name: 'a.txt',
          path: '/tmp/a.txt',
          isDirectory: false,
          size: 1,
          modifiedAt: 1,
        })}
      >
        open-a
      </button>
      <button
        type="button"
        onClick={() => onSelectFile({
          name: 'b.txt',
          path: '/tmp/b.txt',
          isDirectory: false,
          size: 1,
          modifiedAt: 1,
        })}
      >
        open-b
      </button>
    </div>
  ),
}))

vi.mock('../FilePreview', () => ({
  FilePreview: React.forwardRef(function MockFilePreview(
    { entry }: { entry: { name: string } | null },
    ref: React.Ref<{ requestLeave: () => Promise<boolean> }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      requestLeave: requestLeaveMock,
    }))
    return <div data-testid="file-preview">{entry?.name ?? 'empty'}</div>
  }),
}))

vi.mock('@components/shared/file-ops', () => ({
  useFileTreeActions: () => ({
    createFile: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    moveToDirectory: vi.fn(),
    deleteItem: vi.fn(),
  }),
  depthForNewItem: () => 0,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

describe('FileExplorerPane unsaved switch guard', () => {
  beforeEach(() => {
    requestLeaveMock.mockReset()
    requestLeaveMock.mockResolvedValue(true)
    readFilePreviewMock.mockReset()
    readFilePreviewMock.mockResolvedValue({
      data: { kind: 'text', content: 'x', truncated: false },
    })
    ;(window as unknown as {
      tabtin: { fileSystem: { readFilePreview: typeof readFilePreviewMock }; openPath: () => Promise<void> }
    }).tabtin = {
      fileSystem: { readFilePreview: readFilePreviewMock },
      openPath: vi.fn(async () => undefined),
    }
  })

  it('asks FilePreview.requestLeave before switching to another file', async () => {
    const { FileExplorerPane } = await import('../FileExplorerPane')
    render(
      <FileExplorerPane
        rootPath="/tmp"
        kind="user"
        title="tmp"
      />,
    )

    fireEvent.click(screen.getByText('open-a'))
    await waitFor(() => {
      expect(screen.getByTestId('file-preview').textContent).toBe('a.txt')
    })
    expect(requestLeaveMock).not.toHaveBeenCalled()
    expect(readFilePreviewMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('open-b'))
    await waitFor(() => {
      expect(requestLeaveMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId('file-preview').textContent).toBe('b.txt')
    })
    expect(readFilePreviewMock).toHaveBeenCalledTimes(2)
  })

  it('keeps current file when leave is cancelled', async () => {
    const { FileExplorerPane } = await import('../FileExplorerPane')
    render(
      <FileExplorerPane
        rootPath="/tmp"
        kind="user"
        title="tmp"
      />,
    )

    fireEvent.click(screen.getByText('open-a'))
    await waitFor(() => {
      expect(screen.getByTestId('file-preview').textContent).toBe('a.txt')
    })
    requestLeaveMock.mockClear()
    readFilePreviewMock.mockClear()

    requestLeaveMock.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByText('open-b'))

    await waitFor(() => {
      expect(requestLeaveMock).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('file-preview').textContent).toBe('a.txt')
    expect(readFilePreviewMock).not.toHaveBeenCalled()
  })
})
