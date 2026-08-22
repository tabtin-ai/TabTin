import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { ChangesFileTree } from '../ChangesFileTree'

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: () => <span data-testid="file-icon" />,
}))

vi.mock('@components/tabcode/components/TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: () => null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number }) => {
      if (key === 'gitFlow.filesChanged') {
        return `${opts?.count ?? 0} 个文件变更`
      }
      return opts?.defaultValue ?? key
    },
  }),
}))

function file(path: string, added = 1): ChangeFile {
  return {
    path,
    status: added > 0 ? 'A' : '?',
    staged: false,
    unstaged: true,
    partiallyStaged: false,
    added,
    deleted: 0,
    untracked: true,
    conflict: false,
  }
}

describe('ChangesFileTree expand ancestors + dir counts', () => {
  afterEach(() => {
    cleanup()
  })

  it('目录行显示子文件数，并与标题文件数一致', () => {
    render(
      <ChangesFileTree
        rootPath="/repo"
        files={[
          file('.agent-drafts/2.json', 0),
          file('.agent-drafts/fields.json'),
          file('.agent-drafts/records.json'),
          file('.agent-drafts/对的'),
          file('.workbuddy/memory/2026-08-12.md', 3),
        ]}
        selectedPath={null}
        actionKey={null}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByText('5 个文件变更')).toBeTruthy()
    const counts = screen.getAllByTestId('changes-dir-file-count').map((node) => node.textContent)
    expect(counts).toContain('4')
    expect(counts).toContain('1')
  })

  it('选中折叠目录内的文件时自动展开祖先', async () => {
    const { rerender } = render(
      <ChangesFileTree
        rootPath="/repo"
        files={[
          file('.agent-drafts/fields.json'),
          file('.agent-drafts/records.json'),
          file('notes.md'),
        ]}
        selectedPath={null}
        actionKey={null}
        onSelect={vi.fn()}
      />,
    )

    const dirRow = screen.getByTestId('changes-dir-row')
    fireEvent.click(dirRow)
    expect(screen.queryByText('fields.json')).toBeNull()

    rerender(
      <ChangesFileTree
        rootPath="/repo"
        files={[
          file('.agent-drafts/fields.json'),
          file('.agent-drafts/records.json'),
          file('notes.md'),
        ]}
        selectedPath="/repo/.agent-drafts/fields.json"
        actionKey={null}
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('fields.json')).toBeTruthy()
    })
    const selected = screen.getByText('fields.json').closest('[data-testid="changes-file-row"]')
    expect(selected?.getAttribute('aria-current')).toBe('true')
  })
})
