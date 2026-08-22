import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchResult = vi.hoisted(() => ({
  filePath: '/agent/notes.txt',
  line: 3,
  isDirectory: false,
  label: 'notes.txt',
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('@hooks/useFileContentWatch', () => ({
  FILE_DELETED_VERSION: -1,
  useFileContentWatch: () => 0,
}))

vi.mock('@components/shared/file-ops', () => ({
  depthForNewItem: () => 0,
  useFileTreeActions: () => ({
    createFile: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    moveToDirectory: vi.fn(),
    deleteItem: vi.fn(),
  }),
}))

vi.mock('@components/layout/WorkdirPaneShell', () => ({
  WorkdirPaneShell: ({ header, sidebar, children }: { header: React.ReactNode; sidebar: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <div data-testid="header">{header}</div>
      <div data-testid="sidebar">{sidebar}</div>
      <div data-testid="preview">{children}</div>
    </div>
  ),
}))

vi.mock('./FolderHeader', () => ({
  FolderHeader: ({ onToggleSearch }: { onToggleSearch: () => void }) => (
    <button type="button" onClick={onToggleSearch}>toggle-search</button>
  ),
}))

vi.mock('./FolderSearch', () => ({
  FolderSearch: ({ onSelectResult }: { onSelectResult: (filePath: string, line?: number, isDirectory?: boolean) => void }) => (
    <div data-testid="search-panel">
      <button type="button" onClick={() => onSelectResult(searchResult.filePath, searchResult.line, searchResult.isDirectory)}>
        {searchResult.label}
      </button>
    </div>
  ),
}))

vi.mock('./FileTree', () => ({
  FileTree: () => <div data-testid="file-tree" />,
}))

vi.mock('./FilePreview', () => ({
  FilePreview: ({ entry }: { entry: { name: string } | null }) => (
    <div>{entry ? `preview:${entry.name}` : 'no-preview'}</div>
  ),
}))

import { FileExplorerPane } from './FileExplorerPane'

describe('FileExplorerPane 搜索结果预览交互', () => {
  beforeEach(() => {
    searchResult.filePath = '/agent/notes.txt'
    searchResult.line = 3
    searchResult.isDirectory = false
    searchResult.label = 'notes.txt'
    const baseTabtin = (window as Window & { tabtin?: { fileSystem?: Record<string, unknown> } }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: {
        ...baseTabtin,
        fileSystem: {
          ...(baseTabtin.fileSystem ?? {}),
          readFilePreview: vi.fn().mockResolvedValue({
            data: { kind: 'text', content: 'hello', size: 5, truncated: false },
          }),
        },
      },
      writable: true,
      configurable: true,
    })
  })

  it('点击搜索结果只切换右侧预览，不退出搜索面板', async () => {
    render(<FileExplorerPane rootPath="/agent" kind="user" title="Agent" />)

    fireEvent.click(screen.getByText('toggle-search'))
    expect(screen.getByTestId('search-panel')).toBeTruthy()

    fireEvent.click(screen.getByText('notes.txt'))

    await waitFor(() => {
      expect(screen.getByText('preview:notes.txt')).toBeTruthy()
    })
    expect(screen.getByTestId('search-panel')).toBeTruthy()
    expect(screen.queryByTestId('file-tree')).toBeNull()
  })

  it('点击目录搜索结果不按文件读取预览', async () => {
    searchResult.filePath = '/agent/666-folder'
    searchResult.line = 0
    searchResult.isDirectory = true
    searchResult.label = '666-folder'

    render(<FileExplorerPane rootPath="/agent" kind="user" title="Agent" />)

    fireEvent.click(screen.getByText('toggle-search'))
    fireEvent.click(screen.getByText('666-folder'))

    await waitFor(() => {
      expect(screen.getByText('preview:666-folder')).toBeTruthy()
    })
    const tabtin = window as unknown as { tabtin: { fileSystem: { readFilePreview: ReturnType<typeof vi.fn> } } }
    expect(tabtin.tabtin.fileSystem.readFilePreview).not.toHaveBeenCalled()
    expect(screen.getByTestId('search-panel')).toBeTruthy()
  })
})
