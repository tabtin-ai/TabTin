import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { ChangesFileTree } from '../ChangesFileTree'

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: () => <span data-testid="file-icon" />,
}))

vi.mock('@components/tabcode/components/TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: () => null,
}))

function file(path: string): ChangeFile {
  return {
    path,
    status: 'M',
    staged: false,
    unstaged: true,
    partiallyStaged: false,
    added: 1,
    deleted: 0,
    untracked: false,
    conflict: false,
  }
}

describe('ChangesFileTree readOnly', () => {
  afterEach(() => {
    cleanup()
  })

  it('readOnly 时不渲染 stage/discard 操作区', () => {
    render(
      <ChangesFileTree
        rootPath="/repo"
        files={[file('a.ts')]}
        selectedPath="/repo/a.ts"
        actionKey={null}
        readOnly
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByTestId('changes-file-tree')).toBeTruthy()
    expect(screen.queryByTestId('changes-file-actions')).toBeNull()
  })

  it('非 readOnly 时悬停可出现操作区', () => {
    render(
      <ChangesFileTree
        rootPath="/repo"
        files={[file('a.ts')]}
        selectedPath="/repo/a.ts"
        actionKey={null}
        onSelect={vi.fn()}
        runGitAction={vi.fn(async () => true)}
      />,
    )
    const row = screen.getByTestId('changes-file-row')
    fireEvent.mouseEnter(row)
    expect(screen.getByTestId('changes-file-actions')).toBeTruthy()
  })
})
