import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STATIC_DIFF_COLORS,
  STATIC_DIFF_CONTENT_WIDTH_CLASS,
  STATIC_DIFF_ROW_WIDTH_CLASS,
  StaticUnifiedFileDiff,
} from '../StaticUnifiedFileDiff'

const loadDiffContents = vi.fn()

vi.mock('@components/tabcode/components/diffContentCache', () => ({
  loadDiffContents: (...args: unknown[]) => loadDiffContents(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; count?: number; file?: string }) => {
      const text = opts?.defaultValue ?? _key
      return text
        .replace(/\{\{count\}\}/g, String(opts?.count ?? ''))
        .replace(/\{\{file\}\}/g, String(opts?.file ?? ''))
    },
  }),
}))

vi.mock('@components/chat/utils/highlightCode', () => ({
  langFromFileName: () => 'typescript',
  HighlightedCode: ({ code }: { code: string }) => <span>{code}</span>,
}))

describe('StaticUnifiedFileDiff visuals', () => {
  beforeEach(() => {
    loadDiffContents.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders full-width gap band and green/red row colors', async () => {
    const original = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n')
    const modified = original
      .replace('line-2', 'changed-2')
      .replace('line-35', 'changed-35')
    loadDiffContents.mockResolvedValue({ left: original, right: modified })

    render(
      <StaticUnifiedFileDiff
        rootPath="/repo"
        filePath="/repo/demo.ts"
        relativePath="demo.ts"
        contentRevision={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('static-unified-file-diff')).toBeTruthy()
    })

    const content = screen.getByTestId('static-unified-file-diff-content')
    for (const token of STATIC_DIFF_CONTENT_WIDTH_CLASS.split(/\s+/)) {
      expect(content.className).toContain(token)
    }

    const gap = screen.getByTestId('static-diff-gap')
    expect(gap.className).toContain('w-full')
    expect(gap.className).toContain('border-y')
    expect(gap.className).toContain('bg-muted/40')

    const addRow = screen.getAllByTestId('static-diff-row').find(
      (node) => node.getAttribute('data-diff-kind') === 'add',
    )
    const removeRow = screen.getAllByTestId('static-diff-row').find(
      (node) => node.getAttribute('data-diff-kind') === 'remove',
    )
    expect(addRow?.className).toContain(STATIC_DIFF_COLORS.addBg)
    expect(removeRow?.className).toContain(STATIC_DIFF_COLORS.removeBg)
    expect(addRow?.className).toContain(STATIC_DIFF_ROW_WIDTH_CLASS)
    expect(removeRow?.className).toContain(STATIC_DIFF_ROW_WIDTH_CLASS)
  })

  it('changed rows paint full-width backgrounds via content shell + w-full rows', async () => {
    const longLine = `x${'y'.repeat(500)}`
    loadDiffContents.mockResolvedValue({
      left: 'short\nold-long\n',
      right: `short\n${longLine}\n`,
    })

    render(
      <StaticUnifiedFileDiff
        rootPath="/repo"
        filePath="/repo/long.ts"
        relativePath="long.ts"
        contentRevision={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('static-unified-file-diff-content')).toBeTruthy()
    })

    const content = screen.getByTestId('static-unified-file-diff-content')
    for (const token of STATIC_DIFF_CONTENT_WIDTH_CLASS.split(/\s+/)) {
      expect(content.className).toContain(token)
    }

    const addRow = screen.getAllByTestId('static-diff-row').find(
      (node) => node.getAttribute('data-diff-kind') === 'add',
    )
    const removeRow = screen.getAllByTestId('static-diff-row').find(
      (node) => node.getAttribute('data-diff-kind') === 'remove',
    )
    expect(addRow).toBeTruthy()
    expect(removeRow).toBeTruthy()
    expect(addRow?.className).toContain(STATIC_DIFF_ROW_WIDTH_CLASS)
    expect(removeRow?.className).toContain(STATIC_DIFF_ROW_WIDTH_CLASS)
    expect(addRow?.className).toContain(STATIC_DIFF_COLORS.addBg)
    expect(removeRow?.className).toContain(STATIC_DIFF_COLORS.removeBg)

    const addCode = addRow?.querySelector('.whitespace-pre')
    const removeCode = removeRow?.querySelector('.whitespace-pre')
    expect(addCode?.className).not.toContain('min-w-0')
    expect(removeCode?.className).not.toContain('min-w-0')
    expect(addCode?.className).toContain('shrink-0')
    expect(removeCode?.className).toContain('shrink-0')
    expect(addCode?.textContent).toContain(longLine)
  })

  it('empty line-level diff uses inline empty copy', async () => {
    loadDiffContents.mockResolvedValue({ left: 'same\n', right: 'same\n' })
    render(
      <StaticUnifiedFileDiff
        rootPath="/repo"
        filePath="/repo/empty.ts"
        relativePath="empty.ts"
        contentRevision={1}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('static-diff-empty')).toBeTruthy()
    })
    expect(screen.getByTestId('static-diff-empty').textContent).toContain(
      '此文件没有可展示的行级 Diff',
    )
  })

  it('forwards commit mode to loadDiffContents', async () => {
    loadDiffContents.mockResolvedValue({ left: 'a\n', right: 'b\n' })
    render(
      <StaticUnifiedFileDiff
        rootPath="/repo"
        filePath="/repo/a.ts"
        relativePath="a.ts"
        contentRevision={1}
        diffMode="commit"
        commitHash="deadbeef"
      />,
    )
    await waitFor(() => {
      expect(loadDiffContents).toHaveBeenCalled()
    })
    expect(loadDiffContents.mock.calls[0][0]).toMatchObject({
      diffMode: 'commit',
      commitHash: 'deadbeef',
    })
  })

  it('renders in-memory left/right text without calling Git', async () => {
    render(
      <StaticUnifiedFileDiff
        relativePath="frozen.ts"
        leftText="old line"
        rightText="new line"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('static-unified-file-diff')).toBeTruthy()
    })
    expect(loadDiffContents).not.toHaveBeenCalled()
    const rows = screen.getAllByTestId('static-diff-row')
    expect(rows.some((row) => row.getAttribute('data-diff-kind') === 'remove')).toBe(true)
    expect(rows.some((row) => row.getAttribute('data-diff-kind') === 'add')).toBe(true)
  })
})
