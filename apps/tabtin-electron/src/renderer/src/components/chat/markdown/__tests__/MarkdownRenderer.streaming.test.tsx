import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: {
    open: vi.fn(),
  },
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ selectedSpace: { id: 'space-test' } }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      draftExecutionSpaceIdByWorkspaceKey: {},
      getSessionById: () => undefined,
      messagesBySessionId: {},
    }),
  },
}))

vi.mock('../../preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({ open: vi.fn() }),
  },
}))

vi.mock('../../context/ResourceLinkContextMenu', () => ({
  showResourceLinkContextMenu: vi.fn(),
  ResourceLinkContextMenuHost: () => null,
}))

vi.mock('../MermaidBlock', () => ({
  MermaidBlock: () => null,
}))

import { MarkdownRenderer } from '../MarkdownRenderer'

describe('MarkdownRenderer streaming table rendering', () => {
  it('renders a GFM table while it is still in the streaming tail', () => {
    const markdown = [
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| Agent 对话 | 修复中',
    ].join('\n')

    const { container } = render(
      <MarkdownRenderer
        content={markdown}
        renderLevel={1}
        isStreaming
      />
    )

    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    expect(table?.querySelectorAll('th')).toHaveLength(2)
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(table?.textContent).toContain('Agent 对话')
    expect(container.querySelector('p')?.textContent ?? '').not.toContain('| --- |')
  })

  it('keeps updating table rows as more streamed chunks arrive', () => {
    const firstChunk = [
      '| 名称 | 值 |',
      '| --- | --- |',
      '| A | 1 |',
    ].join('\n')
    const secondChunk = [
      firstChunk,
      '| B | 2 |',
    ].join('\n')

    const { container, rerender } = render(
      <MarkdownRenderer
        content={firstChunk}
        renderLevel={1}
        isStreaming
      />
    )

    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)

    rerender(
      <MarkdownRenderer
        content={secondChunk}
        renderLevel={1}
        isStreaming
      />
    )

    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(container.querySelector('table')?.textContent).toContain('B')
  })

  it('does not render a table before the separator row is complete', () => {
    const markdown = [
      '| 模块 | 状态 |',
      '| --- |',
    ].join('\n')

    const { container } = render(
      <MarkdownRenderer
        content={markdown}
        renderLevel={1}
        isStreaming
      />
    )

    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('| --- |')
  })

  it('does not treat pipe-looking code block content as a streaming table', () => {
    const markdown = [
      '```markdown',
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| Agent | ok |',
    ].join('\n')

    const { container } = render(
      <MarkdownRenderer
        content={markdown}
        renderLevel={1}
        isStreaming
      />
    )

    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('| --- | --- |')
  })
})

describe('MarkdownRenderer scroll ownership ', () => {
  let rafPending: Map<number, FrameRequestCallback>
  let rafId: number
  let originalRaf: typeof requestAnimationFrame
  let originalCancel: typeof cancelAnimationFrame
  let originalGetComputedStyle: typeof window.getComputedStyle

  beforeEach(() => {
    rafPending = new Map()
    rafId = 0
    originalRaf = window.requestAnimationFrame
    originalCancel = window.cancelAnimationFrame
    originalGetComputedStyle = window.getComputedStyle
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++rafId
      rafPending.set(id, cb)
      return id
    }) as typeof requestAnimationFrame
    window.cancelAnimationFrame = ((id: number) => {
      rafPending.delete(id)
    }) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCancel
    window.getComputedStyle = originalGetComputedStyle
  })

  function flushRaf(): void {
    const pending = [...rafPending.values()]
    rafPending.clear()
    for (const cb of pending) cb(performance.now())
  }

  it('renderLevel 3→1 不写 container.scrollTop', () => {
    const scrollTopSets: number[] = []
    const scrollParent = document.createElement('div')
    let scrollTop = 180
    Object.defineProperty(scrollParent, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
        scrollTopSets.push(value)
      },
    })
    window.getComputedStyle = ((el: Element) => {
      if (el === scrollParent) {
        return { overflowY: 'auto' } as CSSStyleDeclaration
      }
      return originalGetComputedStyle(el)
    }) as typeof window.getComputedStyle

    document.body.appendChild(scrollParent)
    try {
      const content = 'x'.repeat(500)
      const { rerender } = render(
        <MarkdownRenderer content={content} renderLevel={3} />,
        { container: scrollParent },
      )

      act(() => {
        rerender(<MarkdownRenderer content={content} renderLevel={1} />)
      })
      act(() => {
        flushRaf()
      })

      expect(scrollTopSets).toHaveLength(0)
    } finally {
      scrollParent.remove()
    }
  })

  it('uses 15px message body typography at zoom 0.9 baseline ', () => {
    const { container } = render(
      <MarkdownRenderer content="hello **world**" renderLevel={1} />,
    )
    const root = container.querySelector('.markdown-body')
    expect(root?.className).toContain('text-[15px]')
  })

  it('makes h1/h2 larger than body and drops blockquote italics ', () => {
    const markdown = [
      '# 一级标题',
      '',
      '## 二级标题',
      '',
      '### 三级标题',
      '',
      '> 引用不应斜体',
      '',
      '正文 `inline`',
    ].join('\n')

    const { container } = render(
      <MarkdownRenderer content={markdown} renderLevel={1} />,
    )

    expect(container.querySelector('h1')?.className).toContain('text-title')
    expect(container.querySelector('h2')?.className).toContain('text-[18px]')
    expect(container.querySelector('h3')?.className).toContain('text-[15px]')
    expect(container.querySelector('blockquote')?.className).not.toContain('italic')
    expect(container.querySelector('code')?.className).toContain('text-[13px]')
  })

  it('stable block DOM 不因 tail 追加而重挂', () => {
    const head = 'H'.repeat(120)
    const first = `${head}\n\nstreaming start ${'a'.repeat(50)}`
    const second = `${first} further`

    const { container, rerender } = render(
      <MarkdownRenderer content={first} renderLevel={1} isStreaming />,
    )

    const root = container.querySelector('.markdown-body')
    expect(root).toBeTruthy()
    const stableNode = root!.firstElementChild
    expect(stableNode).toBeTruthy()
    expect(stableNode!.textContent ?? '').toContain('H'.repeat(8))

    rerender(
      <MarkdownRenderer content={second} renderLevel={1} isStreaming />,
    )

    expect(root!.firstElementChild).toBe(stableNode)
  })
})
