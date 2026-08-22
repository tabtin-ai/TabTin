/**
 * DiffCard 折叠展开 + 协议契约 regression。
 *
 * 核心保护：编辑卡片默认只露出四行，展开时不主动改外层 scrollTop，让卡片
 * 顶部保持稳定、内容自然向下展开。
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

import { DiffCard, DIFF_COLLAPSED_LINES, DIFF_LINE_HEIGHT_PX, diffCollapsedBodyMinHeightPx } from '../DiffCard'

const fileOpenMocks = vi.hoisted(() => ({ openInTabCode: vi.fn() }))

vi.mock('../hooks/useFileOpenAction', () => ({
  useFileOpenAction: () => ({
    openInTabCode: fileOpenMocks.openInTabCode,
    revealInOsFileManager: vi.fn(),
    openWithDefaultApp: vi.fn(),
    copyPath: vi.fn(),
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      String(opts?.defaultValue ?? key),
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({
    children,
    className,
    style,
    ...rest
  }: {
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
    'data-testid'?: string
  }) => (
    <div
      className={className}
      style={style}
      data-testid={rest['data-testid'] ?? 'scroll-area'}
    >
      {children}
    </div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  resolveChoiceTagColors: () => ({ backgroundColor: '#eee', color: '#111' }),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: ({ fileName, className }: { fileName: string; className?: string }) => (
    <span data-testid="tabcode-file-icon" data-file-name={fileName} className={className} />
  ),
}))

vi.mock('../../utils/clipboard', () => ({
  safeCopyToClipboard: vi.fn((_text: string, cb: () => void) => cb()),
}))

/** 生成 N 行 diff（每行一个简单字符串）。 */
function makeLines(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

describe('DiffCard — 滚动锚定（隐患修复）', () => {
  let scrollContainer: HTMLDivElement

  beforeEach(() => {
    // 模拟外层 scroll container：jsdom 默认所有 element overflowY=visible，
    // 这里通过 inline style 显式设置 overflow-y: auto 让 findScrollContainer 能命中。
    scrollContainer = document.createElement('div')
    scrollContainer.style.overflowY = 'auto'
    scrollContainer.style.height = '500px'
    scrollContainer.scrollTop = 200
    document.body.appendChild(scrollContainer)
  })

  afterEach(() => {
    document.body.removeChild(scrollContainer)
    vi.restoreAllMocks()
  })

  it('折叠态点击"展开全部"时不改外层 scrollTop，内容向下展开', () => {
    const oldLines = makeLines('old', 200)
    const newLines = makeLines('new', 250)
    // 总 450 行 > 默认 14 行预览 → shouldCollapse=true。

    const { container } = render(
      <DiffCard
        file="/abs/test.ts"
        startLine={1}
        endLine={450}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    const expandBtn = screen.getByRole('button', {
      name: /展开全部 \(450 行\)/,
    })
    const initialScrollTop = scrollContainer.scrollTop
    expect(container.querySelectorAll('[data-diff-row]').length).toBe(14)

    act(() => {
      fireEvent.click(expandBtn)
    })

    expect(scrollContainer.scrollTop).toBe(initialScrollTop)
    expect(container.querySelectorAll('[data-diff-row]').length).toBe(450)
  })

  it('展开态点击"收起"时也不改外层 scrollTop', () => {
    const oldLines = makeLines('old', 200)
    const newLines = makeLines('new', 250)

    render(
      <DiffCard
        file="/abs/test.ts"
        startLine={1}
        endLine={450}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    // 先展开
    const expandBtn = screen.getByRole('button', { name: /展开全部 \(450 行\)/ })
    act(() => fireEvent.click(expandBtn))
    const scrollAfterExpand = scrollContainer.scrollTop

    const collapseBtn = screen.getByRole('button', { name: /收起/ })
    act(() => fireEvent.click(collapseBtn))

    expect(scrollContainer.scrollTop).toBe(scrollAfterExpand)
  })

  it('超过预览阈值（14 行）的 diff 折叠到预览行数，展开后再显示完整内容', () => {
    const oldLines = makeLines('old', 10)
    const newLines = makeLines('new', 10)
    // 总 20 行 > 14 → 折叠到 14 行预览（old/new 各 7 行）

    const { container } = render(
      <DiffCard
        file="/abs/medium.ts"
        startLine={1}
        endLine={20}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    expect(container.querySelectorAll('[data-diff-row]').length).toBe(14)
    expect(screen.queryByText('old9')).toBeNull()
    expect(screen.queryByText('new9')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /展开全部 \(20 行\)/ }))
    })

    expect(container.querySelectorAll('[data-diff-row]').length).toBe(20)
    expect(screen.getByText('old9')).toBeTruthy()
    expect(screen.getByText('new9')).toBeTruthy()
  })

  it('预览阈值以内的小 diff 不渲染展开按钮，也不触发 scroll 补偿', () => {
    const oldLines = makeLines('old', 2)
    const newLines = makeLines('new', 2)

    render(
      <DiffCard
        file="/abs/small.ts"
        startLine={1}
        endLine={4}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /收起/ })).toBeNull()
  })

  it('展开控件是常驻底部按钮，而不是 hover 渐隐浮层', () => {
    const oldLines = makeLines('old', 10)
    const newLines = makeLines('new', 10)

    const { container } = render(
      <DiffCard
        file="/abs/test.ts"
        startLine={1}
        endLine={20}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    // 不再有渐隐浮层
    expect(container.querySelector('.bg-gradient-to-b')).toBeNull()
    // 展开按钮常驻可见
    expect(screen.getByRole('button', { name: /展开全部 \(20 行\)/ })).toBeTruthy()
  })

  it('展开按钮不再用 opacity-0 hover 门禁，默认即可见', () => {
    const oldLines = makeLines('old', 10)
    const newLines = makeLines('new', 10)

    render(
      <DiffCard
        file="/abs/test.ts"
        startLine={1}
        endLine={20}
        oldLines={oldLines}
        newLines={newLines}
      />,
      { container: scrollContainer },
    )

    const btn = screen.getByRole('button', { name: /展开全部 \(20 行\)/ })
    expect(btn.className).not.toContain('opacity-0')
    expect(btn.className).not.toContain('group-hover/diff-body:opacity-100')
  })

  it('头部使用 TabCode 文件格式图标，而不是编辑语义图标', () => {
    const { container } = render(
      <DiffCard
        file="/abs/calculator.html"
        startLine={1}
        endLine={2}
        oldLines={['old']}
        newLines={['new']}
      />,
      { container: scrollContainer },
    )

    expect(screen.getByTestId('tabcode-file-icon').dataset.fileName).toBe('calculator.html')
    expect(container.querySelector('.lucide-file-pen-line')).toBeNull()
  })
})

describe('DiffCard — IDE Diff 跳转', () => {
  it('点击显式入口后按文件与变更行打开 HEAD Diff', () => {
    render(
      <DiffCard
        file="src/example.ts"
        startLine={12}
        endLine={18}
        oldLines={['old']}
        newLines={['new']}
        oldStartLine={12}
        newStartLine={15}
        tabScopeKey="conversation:session-1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '在 IDE 中查看 Diff' }))

    expect(fileOpenMocks.openInTabCode).toHaveBeenCalledWith('src/example.ts', {
      line: 15,
      endLine: 18,
      gitDiffMode: 'head',
      tabScopeKey: 'conversation:session-1',
    })
  })

  it('复制 unified diff 时保留旧/新侧不同起始行', async () => {
    render(
      <DiffCard
        file="src/example.ts"
        startLine={12}
        endLine={15}
        oldLines={['old']}
        newLines={['new']}
        oldStartLine={12}
        newStartLine={15}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'card.copy_diff' }))

    const { safeCopyToClipboard } = await import('../../utils/clipboard')
    const copied = (safeCopyToClipboard as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    expect(copied).toContain('@@ -12,1 +15,1 @@')
  })
})

describe('DiffCard — Phase2 Task6 折叠 body 行高预算', () => {
  it('diffCollapsedBodyMinHeightPx：空/流式/超阈值边界', () => {
    expect(diffCollapsedBodyMinHeightPx(0)).toBe(0)
    expect(diffCollapsedBodyMinHeightPx(1)).toBe(DIFF_LINE_HEIGHT_PX)
    expect(diffCollapsedBodyMinHeightPx(5)).toBe(5 * DIFF_LINE_HEIGHT_PX)
    expect(diffCollapsedBodyMinHeightPx(DIFF_COLLAPSED_LINES)).toBe(
      DIFF_COLLAPSED_LINES * DIFF_LINE_HEIGHT_PX,
    )
    expect(diffCollapsedBodyMinHeightPx(DIFF_COLLAPSED_LINES + 20)).toBe(
      DIFF_COLLAPSED_LINES * DIFF_LINE_HEIGHT_PX,
    )
    expect(DIFF_COLLAPSED_LINES).toBe(14)
    expect(DIFF_LINE_HEIGHT_PX).toBe(18)
  })

  it('折叠 diff 在行数据到达前/中保持行高预算，避免 0→N 无预算跳变', () => {
    const { rerender } = render(
      <DiffCard
        file="/abs/stream.ts"
        startLine={1}
        endLine={1}
        oldLines={[]}
        newLines={[]}
      />,
    )
    const body0 = screen.getByTestId('diff-body')
    expect(body0.style.minHeight === '' || body0.style.minHeight === '0px').toBe(true)

    rerender(
      <DiffCard
        file="/abs/stream.ts"
        startLine={1}
        endLine={3}
        oldLines={makeLines('old', 1)}
        newLines={makeLines('new', 2)}
      />,
    )
    const body3 = screen.getByTestId('diff-body')
    expect(body3.style.minHeight).toBe(`${diffCollapsedBodyMinHeightPx(3)}px`)

    rerender(
      <DiffCard
        file="/abs/stream.ts"
        startLine={1}
        endLine={40}
        oldLines={makeLines('old', 20)}
        newLines={makeLines('new', 20)}
      />,
    )
    const bodyBig = screen.getByTestId('diff-body')
    expect(bodyBig.style.minHeight).toBe(
      `${diffCollapsedBodyMinHeightPx(40)}px`,
    )
    expect(bodyBig.style.minHeight).toBe(`${DIFF_COLLAPSED_LINES * DIFF_LINE_HEIGHT_PX}px`)
    expect(screen.getByTestId('diff-body').querySelectorAll('[data-diff-row]').length).toBe(
      DIFF_COLLAPSED_LINES,
    )
  })

  it('展开后不再强制折叠预算 minHeight；且不写外层 scrollTop', () => {
    const scrollContainer = document.createElement('div')
    scrollContainer.style.overflowY = 'auto'
    scrollContainer.style.height = '500px'
    scrollContainer.scrollTop = 180
    document.body.appendChild(scrollContainer)

    try {
      render(
        <DiffCard
          file="/abs/expand.ts"
          startLine={1}
          endLine={40}
          oldLines={makeLines('old', 20)}
          newLines={makeLines('new', 20)}
        />,
        { container: scrollContainer },
      )
      const before = scrollContainer.scrollTop
      fireEvent.click(screen.getByRole('button', { name: /展开全部 \(40 行\)/ }))
      expect(scrollContainer.scrollTop).toBe(before)
      const body = screen.getByTestId('diff-body')
      expect(body.style.minHeight === '' || body.style.minHeight === '0px').toBe(true)
      expect(body.querySelectorAll('[data-diff-row]').length).toBe(40)
    } finally {
      document.body.removeChild(scrollContainer)
    }
  })
})
