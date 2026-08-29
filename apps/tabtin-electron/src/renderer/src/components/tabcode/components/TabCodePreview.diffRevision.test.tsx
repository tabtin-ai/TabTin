import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../sendCodeContextToChat', () => ({ sendCodeContextToChat: vi.fn() }))
vi.mock('@hooks/useFileContentWatch', () => ({
  FILE_DELETED_VERSION: -1,
  useFileContentWatch: () => 0,
}))
vi.mock('@components/shared/file-preview/FileKindPreview', () => ({
  FileKindPreview: () => <div />,
}))
vi.mock('@components/shared/file-preview/MarkdownViewer', () => ({
  MarkdownViewer: () => <div />,
}))
vi.mock('@components/shared/file-preview/localFilePreviewRegistry', () => ({
  stripPlanMetadata: (value: string) => value,
}))
vi.mock('@components/shared/file-preview/TextFileEditor', () => ({
  TextFileEditor: ({
    onSelectionChange,
  }: {
    onSelectionChange?: (selection: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="text-editor"
      onClick={() => onSelectionChange?.({
        text: 'selected text',
        startLine: 1,
        endLine: 1,
        anchor: { top: 100, bottom: 120, centerX: 200 },
      })}
    />
  ),
}))
vi.mock('@components/shared/file-preview/CodeSelectionToolbar', () => ({
  CodeSelectionToolbar: ({ selection }: { selection: { text?: string } | null }) => (
    selection?.text ? <div data-testid="selection-toolbar" /> : null
  ),
}))
vi.mock('@components/shared/file-utils', () => ({
  getBaseName: (path: string) => path.split('/').pop() || path,
  getMonacoLanguage: () => 'plaintext',
  isMarkdownFile: () => false,
}))
vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))
vi.mock('./TabCodeDiffView', () => ({
  default: ({ contentRevision }: { contentRevision: string | number }) => (
    <div data-testid="diff-view" data-content-revision={contentRevision} />
  ),
}))

import { TabCodePreview } from './TabCodePreview'

describe('TabCodePreview diff content revision', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        fileSystem: {
          readFilePreview: vi.fn(async () => ({
            data: { kind: 'text', content: 'organization_name' },
          })),
        },
        git: {},
      },
    })
  })

  it('同时携带 Git 路径版本和本地 watcher 版本', async () => {
    render(
      <TabCodePreview
        rootPath="/repo"
        editorSessionKey="session"
        editorGroupId="group"
        filePath="/repo/tabtest"
        isGitRepo
        gitDiffMode="head"
        gitContentRevision={7}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-view').getAttribute('data-content-revision')).toBe('7:0')
    })
  })

  it('提交历史 Diff 保持原有不可变缓存版本', async () => {
    render(
      <TabCodePreview
        rootPath="/repo"
        editorSessionKey="session"
        editorGroupId="group"
        filePath="/repo/tabtest"
        isGitRepo
        gitDiffMode="commit"
        gitContentRevision={7}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-view').getAttribute('data-content-revision')).toBe('0')
    })
  })

  it('非活动保活 pane 不显示选区操作条，重新激活时不恢复旧选区', async () => {
    const { rerender } = render(
      <TabCodePreview
        rootPath="/repo"
        editorSessionKey="session"
        editorGroupId="group"
        filePath="/repo/tabtest"
        isGitRepo={false}
        isPaneActive
      />,
    )

    await waitFor(() => expect(screen.getByTestId('text-editor')).toBeTruthy())
    fireEvent.click(screen.getByTestId('text-editor'))
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy()

    rerender(
      <TabCodePreview
        rootPath="/repo"
        editorSessionKey="session"
        editorGroupId="group"
        filePath="/repo/tabtest"
        isGitRepo={false}
        isPaneActive={false}
      />,
    )
    expect(screen.queryByTestId('selection-toolbar')).toBeNull()

    rerender(
      <TabCodePreview
        rootPath="/repo"
        editorSessionKey="session"
        editorGroupId="group"
        filePath="/repo/tabtest"
        isGitRepo={false}
        isPaneActive
      />,
    )
    expect(screen.queryByTestId('selection-toolbar')).toBeNull()
  })
})
