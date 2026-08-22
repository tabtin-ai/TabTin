import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TextBlockView } from '../TextBlockView'
import { MSG_COLLAPSE_CHAR_THRESHOLD } from '../../message'
import type { BlockRendererProps, ContentBlockEntry } from '../types'

vi.mock('../../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // CollapsibleMessage 用 defaultValue；partialReasonText 等断言依赖 key 本身。
    t: (key: string, opts?: { defaultValue?: string; lines?: number }) => {
      if (key.startsWith('message.') && opts?.defaultValue) {
        return opts.defaultValue.replace('{{lines}}', String(opts.lines ?? ''))
      }
      return key
    },
  }),
}))

function makeEntry(overrides: Partial<ContentBlockEntry> = {}): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'text-1',
    block: { type: 'text', text: 'Hello world' },
    finalized: true,
    partial: false,
    ...overrides,
  }
}

function renderView(entry: ContentBlockEntry, extra: Partial<BlockRendererProps> = {}) {
  return render(
    <TextBlockView
      entry={entry}
      sessionId="s1"
      messageId="m1"
      {...extra}
    />,
  )
}

describe('TextBlockView', () => {
  it('happy: finalized text renders markdown content', () => {
    renderView(makeEntry({ block: { type: 'text', text: '# Hello\n\nWorld' } }))
    expect(screen.getByTestId('block-text')).toBeTruthy()
    expect(screen.getByTestId('mock-markdown').textContent).toContain('# Hello')
  })

  it('partial: truncated text shows "…内容被截断" indicator', () => {
    renderView(makeEntry({ partial: true }))
    const el = screen.getByTestId('block-text')
    expect(el.textContent).toContain('blockTimeline.text.truncated')
  })

  it('partial: suppressPartialReason hides partial indicator', () => {
    renderView(makeEntry({ partial: true, partialReason: 'aborted' }), { suppressPartialReason: true })
    const el = screen.getByTestId('block-text')
    expect(el.textContent).not.toContain('blockTimeline.partial.aborted')
  })

  it('fallback: empty text renders without crashing', () => {
    renderView(makeEntry({ block: { type: 'text', text: '' } }))
    expect(screen.getByTestId('block-text')).toBeTruthy()
  })

  it('streaming: passes isStreaming=true to markdown when not finalized', () => {
    renderView(
      makeEntry({ finalized: false, block: { type: 'text', text: 'streaming...' } }),
      { isStreaming: true },
    )
    expect(screen.getByTestId('mock-markdown').textContent).toBe('streaming...')
    expect(screen.getByTestId('block-text').getAttribute('data-streaming-text')).toBe('true')
  })

  // 平滑流式揭示（typewriter reveal）：答案正文与 thinking 同款打字机效果
  describe('typewriter 平滑揭示', () => {
    it('streaming: 挂载瞬间对齐当前全量文本（不重播老文本）', () => {
      renderView(
        makeEntry({ finalized: false, block: { type: 'text', text: 'already streamed answer' } }),
        { isStreaming: true },
      )
      expect(screen.getByTestId('mock-markdown').textContent).toBe('already streamed answer')
    })

    it('streaming: 追加的 chunk 不整块闪出，经 rAF 逐帧揭示后收敛到全量', async () => {
      const { rerender } = render(
        <TextBlockView
          entry={makeEntry({ finalized: false, block: { type: 'text', text: 'prefix ' } })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      rerender(
        <TextBlockView
          entry={makeEntry({
            finalized: false,
            block: { type: 'text', text: 'prefix and a newly arrived chunk of answer text' },
          })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      // rerender 同步后追加尾部尚未揭示（rAF 还没跑）——「不闪出」
      expect(screen.getByTestId('mock-markdown').textContent).not.toContain('chunk of answer text')
      expect(screen.getByTestId('mock-markdown').textContent).toContain('prefix')
      await waitFor(
        () => expect(screen.getByTestId('mock-markdown').textContent)
          .toBe('prefix and a newly arrived chunk of answer text'),
        { timeout: 3000 },
      )
    })

    it('streaming: 揭示前缀切开代码围栏时补 ``` 收敛（不闪半个代码块）', () => {
      const { rerender } = render(
        <TextBlockView
          entry={makeEntry({ finalized: false, block: { type: 'text', text: 'intro\n```js\n' } })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      rerender(
        <TextBlockView
          entry={makeEntry({
            finalized: false,
            block: { type: 'text', text: 'intro\n```js\nconst a = 1\nmore lines here\n```\ndone' },
          })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      // 揭示前缀停在围栏内部（rAF 未跑），ensureClosedFences 补上闭合 ```
      const content = screen.getByTestId('mock-markdown').textContent ?? ''
      expect(content).not.toContain('done')
      expect(content.trimEnd().endsWith('```')).toBe(true)
    })

    it('finalize 时平滑排空未揭示尾部，避免结束瞬间整段增高', async () => {
      const { rerender } = render(
        <TextBlockView
          entry={makeEntry({ finalized: false, block: { type: 'text', text: 'start ' } })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      rerender(
        <TextBlockView
          entry={makeEntry({
            finalized: true,
            block: { type: 'text', text: 'start and the final full answer' },
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('mock-markdown').textContent)
        .not.toBe('start and the final full answer')
      await waitFor(
        () => expect(screen.getByTestId('mock-markdown').textContent)
          .toBe('start and the final full answer'),
        { timeout: 3000 },
      )
    })

    it('finalize 后排空代码块尾部时仍补齐临时围栏', () => {
      const { rerender } = render(
        <TextBlockView
          entry={makeEntry({
            finalized: false,
            block: { type: 'text', text: 'intro\n```js\n' },
          })}
          sessionId="s1"
          messageId="m1"
          isStreaming
        />,
      )
      rerender(
        <TextBlockView
          entry={makeEntry({
            finalized: true,
            block: { type: 'text', text: 'intro\n```js\nconst a = 1\n```\ndone' },
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )

      const content = screen.getByTestId('mock-markdown').textContent ?? ''
      expect(content).not.toContain('done')
      expect(content.trimEnd().endsWith('```')).toBe(true)
    })
  })

  describe('长文本折叠', () => {
    //  折叠已临时禁用：finalized 长文本不再折叠，直接全文渲染、无展开按钮
    it('finalized 长文本不折叠，直接全文渲染（ 禁用折叠）', () => {
      const long = 'L'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 100)
      renderView(makeEntry({
        block_id: 'text-long-1',
        finalized: true,
        block: { type: 'text', text: long },
      }))
      expect(screen.getByTestId('mock-markdown').textContent).toBe(long)
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('流式中的长文本不折叠', () => {
      const long = 'S'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 100)
      renderView(
        makeEntry({
          block_id: 'text-stream-long',
          finalized: false,
          block: { type: 'text', text: long },
        }),
        { isStreaming: true },
      )
      expect(screen.getByTestId('mock-markdown').textContent).toBe(long)
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})
