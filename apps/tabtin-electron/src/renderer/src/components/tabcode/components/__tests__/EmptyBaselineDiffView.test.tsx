import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  STATIC_DIFF_CONTENT_WIDTH_CLASS,
  STATIC_DIFF_ROW_WIDTH_CLASS,
} from '../../../context-space/code-workspace/StaticUnifiedFileDiff'
import { EmptyBaselineDiffView } from '../EmptyBaselineDiffView'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('@components/chat/utils/highlightCode', () => ({
  HighlightedCode: ({ code }: { code: string }) => <span>{code}</span>,
  langFromFileName: () => 'plaintext',
}))

describe('EmptyBaselineDiffView', () => {
  it('新文件首行是 add，无前导 remove，统计无假删', async () => {
    const onStats = vi.fn()
    render(
      <EmptyBaselineDiffView
        originalContent=""
        modifiedContent={'first\nsecond\n'}
        filePath="/repo/new.ts"
        onStats={onStats}
      />,
    )

    const rows = await screen.findAllByTestId('empty-baseline-diff-row')
    expect(rows[0]?.getAttribute('data-diff-kind')).toBe('add')
    expect(rows[0]?.textContent).toContain('first')
    expect(rows.every((row) => row.getAttribute('data-diff-kind') !== 'remove')).toBe(true)

    await waitFor(() => {
      expect(onStats).toHaveBeenCalledWith({
        insertions: 2,
        deletions: 0,
        hasChanges: true,
      })
    })
  })

  it('变更行用内容壳 + w-full，底色铺满整行', async () => {
    render(
      <EmptyBaselineDiffView
        originalContent=""
        modifiedContent={'short\n'}
        filePath="/repo/new.ts"
      />,
    )
    const content = await screen.findByTestId('empty-baseline-diff-content')
    for (const token of STATIC_DIFF_CONTENT_WIDTH_CLASS.split(/\s+/)) {
      expect(content.className).toContain(token)
    }
    const row = screen.getByTestId('empty-baseline-diff-row')
    expect(row.className).toContain(STATIC_DIFF_ROW_WIDTH_CLASS)
    expect(row.className).toContain('bg-green-500/15')
    const code = row.querySelector('.whitespace-pre')
    expect(code?.className).not.toContain('min-w-0')
    expect(code?.className).toContain('shrink-0')
  })

  it('删除文件全部为 remove，无假增', async () => {
    const onStats = vi.fn()
    render(
      <EmptyBaselineDiffView
        originalContent={'old\nline\n'}
        modifiedContent=""
        filePath="/repo/gone.ts"
        onStats={onStats}
      />,
    )
    const rows = await screen.findAllByTestId('empty-baseline-diff-row')
    expect(rows.every((row) => row.getAttribute('data-diff-kind') === 'remove')).toBe(true)
    await waitFor(() => {
      expect(onStats).toHaveBeenCalledWith({
        insertions: 0,
        deletions: 2,
        hasChanges: true,
      })
    })
  })
})
