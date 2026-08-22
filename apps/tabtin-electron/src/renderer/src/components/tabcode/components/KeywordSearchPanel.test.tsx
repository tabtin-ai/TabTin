import React from 'react'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  clear: vi.fn(),
  cancel: vi.fn(),
  loadMoreForFile: vi.fn(),
  truncated: false,
  contentTruncated: false,
  pathMatchesTruncated: false,
  results: [{
    file: '/workspace/source.ts',
    relativePath: 'source.ts',
    matches: [{
      line: 1,
      column: 0,
      text: 'foo Foobar foo',
      matchText: 'foo',
      matchKind: 'content' as const,
      ranges: [{ start: 0, end: 3 }, { start: 11, end: 14 }],
    }],
    mayHaveMore: false,
  }],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const button = ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  )
  const dialog = ({
    children,
    open,
  }: {
    children: React.ReactNode
    open?: boolean
  }) => (open ? <>{children}</> : null)
  return {
    Button: button,
    Dialog: dialog,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    Tooltip: passthrough,
    TooltipContent: passthrough,
    TooltipProvider: passthrough,
    TooltipTrigger: passthrough,
    ToastAction: button,
    toast: vi.fn(),
  }
})

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: () => null,
}))

vi.mock('@utils/cn', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../hooks/useKeywordSearch', () => ({
  useKeywordSearch: () => ({
    results: mocks.results,
    isSearching: false,
    loadingMoreFiles: new Set<string>(),
    error: null,
    errorCode: null,
    totalMatches: 2,
    truncated: mocks.truncated,
    contentTruncated: mocks.contentTruncated,
    pathMatchesTruncated: mocks.pathMatchesTruncated,
    search: mocks.search,
    loadMoreForFile: mocks.loadMoreForFile,
    cancel: mocks.cancel,
    clear: mocks.clear,
  }),
}))

vi.mock('../../utils/searchResultContext', () => ({
  SEARCH_RESULT_CONTEXT_TOOLTIP_DELAY_MS: 0,
  loadSearchResultContext: vi.fn().mockResolvedValue(null),
}))

import {
  findUniqueRefreshedTarget,
  KeywordSearchPanel,
  resolveReplaceAvailability,
} from './KeywordSearchPanel'

describe('KeywordSearchPanel 搜索选项与 ranges 高亮', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.search.mockReset()
    mocks.clear.mockReset()
    mocks.cancel.mockReset()
    mocks.loadMoreForFile.mockReset()
    mocks.truncated = false
    mocks.contentTruncated = false
    mocks.pathMatchesTruncated = false
    mocks.results[0] = {
      file: '/workspace/source.ts',
      relativePath: 'source.ts',
      matches: [{
        line: 1,
        column: 0,
        text: 'foo Foobar foo',
        matchText: 'foo',
        matchKind: 'content' as const,
        ranges: [{ start: 0, end: 3 }, { start: 11, end: 14 }],
      }],
      mayHaveMore: false,
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('只高亮主进程返回的多个 ranges，不把 Foobar 误判为命中', () => {
    const { container } = render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe(
      'keywordSearch.placeholder',
    )
    expect(container.textContent).not.toContain('keywordSearch.hint')
    expect(container.querySelector('.lucide-search')).toBeNull()
    expect(container.querySelectorAll('mark')).toHaveLength(2)
    expect(container.textContent).toContain('Foobar')
  })

  it('点击正则选项后重新搜索并透传 isRegex', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.regex' }))
    vi.advanceTimersByTime(300)

    expect(mocks.search).toHaveBeenCalledWith(
      'foo',
      expect.objectContaining({ isRegex: true }),
    )
  })

  it('仅在不区分大小写和区分大小写之间切换', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'foo' } })
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.caseMode.insensitive' }))
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.caseMode.sensitive' }))
    vi.advanceTimersByTime(300)

    expect(mocks.search).toHaveBeenLastCalledWith(
      'foo',
      expect.objectContaining({ matchCase: false }),
    )
  })

  it('点击右下角文件过滤按钮后按上下布局展示包含和排除输入框', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const filterButton = screen.getByRole('button', {
      name: 'keywordSearch.filterGlob',
    })
    fireEvent.click(filterButton)

    expect(filterButton.getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('textbox', { name: 'keywordSearch.includeGlob' }).parentElement?.className,
    ).toContain('flex-col')
    expect(
      screen.getByRole('textbox', { name: 'keywordSearch.excludeGlob' }).parentElement?.className,
    ).toContain('flex-col')
  })

  it('过滤条件仍生效但面板收起时，… 按钮保持高亮', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.filterGlob' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'keywordSearch.includeGlob' }), {
      target: { value: '*.ts' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.filterGlob' }))

    const filterButton = screen.getByRole('button', { name: 'keywordSearch.filterGlobActive' })
    expect(filterButton.getAttribute('aria-pressed')).toBe('true')
    expect(filterButton.className).toContain('text-primary')
    expect(screen.queryByRole('textbox', { name: 'keywordSearch.includeGlob' })).toBeNull()
  })

  it('展开替换输入后把 replacement 透传给搜索，缺少预览时禁用替换', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'foo' } })
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'keywordSearch.replaceWith' }), {
      target: { value: '$1' },
    })
    vi.advanceTimersByTime(300)

    expect(mocks.search).toHaveBeenLastCalledWith(
      'foo',
      expect.objectContaining({ replace: '$1' }),
    )
    const disabledReplaceButtons = screen.getAllByRole('button', {
      name: 'keywordSearch.replaceNoPreview',
    })
    expect(disabledReplaceButtons.length).toBeGreaterThanOrEqual(2)
    expect(disabledReplaceButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('空字符串替换仍会启用 replacement 搜索模式', () => {
    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'foo' } })
    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'keywordSearch.replaceWith' }), {
      target: { value: '' },
    })
    vi.advanceTimersByTime(300)

    expect(mocks.search).toHaveBeenLastCalledWith(
      'foo',
      expect.objectContaining({ replace: '' }),
    )
  })

  it('保存后同一行重复命中不会猜测旧 occurrence', () => {
    const groups = [{
      file: '/workspace/source.ts',
      relativePath: 'source.ts',
      matches: [
        { line: 1, column: 0, text: 'foo foo', matchText: 'foo', matchKind: 'content' as const },
        { line: 1, column: 4, text: 'foo foo', matchText: 'foo', matchKind: 'content' as const },
      ],
    }]

    expect(findUniqueRefreshedTarget(groups, {
      file: '/workspace/source.ts',
      line: 1,
      matchText: 'foo',
    })).toBeUndefined()
  })

  it('单文件 mayHaveMore 时展示加载更多并触发 loadMoreForFile', () => {
    mocks.results[0] = {
      ...mocks.results[0],
      mayHaveMore: true,
    }

    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.loadMore' }))
    expect(mocks.loadMoreForFile).toHaveBeenCalledWith('/workspace/source.ts')
  })

  it('过滤未展开时统计行预留 … 按钮高度；截断时全部替换可悬停看到原因', () => {
    mocks.truncated = true
    mocks.contentTruncated = true

    const { container, rerender } = render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))

    const statsBar = container.querySelector('.pt-7')
    expect(statsBar?.textContent).toContain('keywordSearch.matchCount')

    const replaceAll = statsBar?.querySelector('button[aria-label="keywordSearch.replaceTruncated"]')
    expect(replaceAll).toHaveProperty('disabled', true)
    expect(replaceAll?.parentElement?.getAttribute('title')).toBe('keywordSearch.replaceTruncated')

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.filterGlob' }))
    rerender(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(container.querySelector('.pt-7')).toBeNull()
  })

  it('无效替换预览时全部/文件级入口禁用，且文案一致', () => {
    mocks.results[0] = {
      file: '/workspace/source.ts',
      relativePath: 'source.ts',
      matches: [{
        line: 1,
        column: 0,
        text: 'foo',
        matchText: 'foo',
        matchKind: 'content',
        ranges: [{ start: 0, end: 3 }],
        byteRange: { start: 0, end: 3 },
        replacementError: 'missing_preview',
      }],
      mayHaveMore: false,
    }

    render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))
    fireEvent.click(screen.getByRole('button', { name: /source\.ts/i }))

    const disabledButtons = screen.getAllByRole('button', {
      name: 'keywordSearch.replaceInvalidPreview',
    })
    expect(disabledButtons.length).toBeGreaterThanOrEqual(2)
    expect(disabledButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(
      disabledButtons.every((button) => button.parentElement?.getAttribute('title')
        === 'keywordSearch.replaceInvalidPreview'),
    ).toBe(true)
  })

  it('仅路径遍历截断时替换可用，并展示非阻塞提示', () => {
    mocks.truncated = true
    mocks.contentTruncated = false
    mocks.pathMatchesTruncated = true
    mocks.results[0] = {
      file: '/workspace/source.ts',
      relativePath: 'source.ts',
      matches: [{
        line: 1,
        column: 0,
        text: 'foo Foobar foo',
        matchText: 'foo',
        matchKind: 'content' as const,
        ranges: [{ start: 0, end: 3 }],
        byteRange: { start: 0, end: 3 },
        replacement: 'bar',
      }],
      mayHaveMore: false,
    }

    const { container } = render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))

    expect(screen.getByText('keywordSearch.pathMatchesTruncated')).toBeTruthy()
    expect(screen.queryByText(/keywordSearch\.truncated:/)).toBeNull()
    const replaceAll = container.querySelector('button[aria-label="keywordSearch.replaceAll"]')
    expect(replaceAll).toHaveProperty('disabled', false)
  })

  it('内容截断时仍禁用替换并展示原截断提示', () => {
    mocks.truncated = true
    mocks.contentTruncated = true
    mocks.pathMatchesTruncated = false
    mocks.results[0] = {
      file: '/workspace/source.ts',
      relativePath: 'source.ts',
      matches: [{
        line: 1,
        column: 0,
        text: 'foo Foobar foo',
        matchText: 'foo',
        matchKind: 'content' as const,
        ranges: [{ start: 0, end: 3 }],
        byteRange: { start: 0, end: 3 },
        replacement: 'bar',
      }],
      mayHaveMore: false,
    }

    const { container } = render(
      <KeywordSearchPanel
        rootPath="/workspace"
        onFileSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'keywordSearch.expandReplace' }))

    expect(screen.getByText('keywordSearch.truncated:{"count":2}')).toBeTruthy()
    expect(screen.queryByText('keywordSearch.pathMatchesTruncated')).toBeNull()
    const replaceAll = container.querySelector('button[aria-label="keywordSearch.replaceTruncated"]')
    expect(replaceAll).toHaveProperty('disabled', true)
  })

  it('resolveReplaceAvailability 按固定优先级返回禁用原因', () => {
    const labels = {
      truncated: 'truncated',
      tooMany: 'tooMany',
      invalidPreview: 'invalidPreview',
      busy: 'busy',
      noPreview: 'noPreview',
    }

    expect(resolveReplaceAvailability({
      editsCount: 1,
      truncated: true,
      replaceBusy: true,
      hasInvalidReplacementPreview: true,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: true, reason: 'truncated' })

    expect(resolveReplaceAvailability({
      editsCount: 501,
      truncated: false,
      replaceBusy: false,
      hasInvalidReplacementPreview: true,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: true, reason: 'tooMany' })

    expect(resolveReplaceAvailability({
      editsCount: 1,
      truncated: false,
      replaceBusy: true,
      hasInvalidReplacementPreview: true,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: true, reason: 'invalidPreview' })

    expect(resolveReplaceAvailability({
      editsCount: 1,
      truncated: false,
      replaceBusy: true,
      hasInvalidReplacementPreview: false,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: true, reason: 'busy' })

    expect(resolveReplaceAvailability({
      editsCount: 0,
      truncated: false,
      replaceBusy: false,
      hasInvalidReplacementPreview: false,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: true, reason: 'noPreview' })

    expect(resolveReplaceAvailability({
      editsCount: 2,
      truncated: false,
      replaceBusy: false,
      hasInvalidReplacementPreview: false,
      enabledLabel: 'ok',
      labels,
    })).toEqual({ disabled: false, reason: 'ok' })
  })
})
