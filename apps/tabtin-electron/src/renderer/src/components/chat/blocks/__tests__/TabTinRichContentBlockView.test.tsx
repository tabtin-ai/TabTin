import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TabTinRichContentBlockView } from '../TabTinRichContentBlockView'
import type { ContentBlockEntry } from '../types'

vi.mock('../../richContent', () => ({
  RichImage: () => <div data-testid="mock-rich-image" />,
  RichTablePreview: () => <div data-testid="mock-rich-table" />,
  RichResourceRef: () => <div data-testid="mock-rich-resource" />,
  RichFile: () => <div data-testid="mock-rich-file" />,
  RichWidget: () => <div data-testid="mock-rich-widget" />,
  RichCliOutputTable: () => <div data-testid="mock-rich-cli-table" />,
  RichCliOutputRecord: () => <div data-testid="mock-rich-cli-record" />,
  RichSearchResults: () => <div data-testid="mock-rich-search" />,
  RichMemoryCard: () => <div data-testid="mock-rich-memory" />,
  RichDocumentExcerpt: () => <div data-testid="mock-rich-doc-excerpt" />,
  RichFallback: ({ block }: any) => <div data-testid="mock-rich-fallback">{block?.summary}</div>,
}))

vi.mock('../../skill/SkillInjectionInlineCard', () => ({
  SkillInjectionInlineCard: ({ content }: { content: string }) => (
    <div data-testid="mock-skill-card">{content}</div>
  ),
}))

function makeRich(kind: string, payload: Record<string, unknown> = {}, summary = ''): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'rich-1',
    block: { type: 'tabtin_rich_content', kind, summary, payload } as any,
    finalized: true,
    partial: false,
  }
}

describe('TabTinRichContentBlockView', () => {
  it('happy: widget kind routes to RichWidget', () => {
    render(<TabTinRichContentBlockView entry={makeRich('widget')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('mock-rich-widget')).toBeTruthy()
  })

  it('legacy flow_view widget falls back to the generic widget renderer', () => {
    render(
      <TabTinRichContentBlockView
        entry={makeRich('widget', { widget_variant: 'flow_view' })}
        sessionId="s1"
        messageId="m1"
      />,
    )
    expect(screen.getByTestId('mock-rich-widget')).toBeTruthy()
  })

  it('happy: search_results kind routes to RichSearchResults', () => {
    render(<TabTinRichContentBlockView entry={makeRich('search_results')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('mock-rich-search')).toBeTruthy()
  })

  it('hides legacy web_search search_results blocks from the main timeline', () => {
    const { container } = render(
      <TabTinRichContentBlockView
        entry={makeRich('search_results', { query: '上海今天天气' }, 'web_search: 上海今天天气 (192204)')}
        sessionId="s1"
        messageId="m1"
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('mock-rich-search')).toBeNull()
  })

  it('happy: image kind routes to RichImage', () => {
    render(<TabTinRichContentBlockView entry={makeRich('image')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('mock-rich-image')).toBeTruthy()
  })

  it('legacy: task_episode kind falls back to RichFallback', () => {
    render(
      <TabTinRichContentBlockView
        entry={makeRich('task_episode', {}, '旧任务进展摘要')}
        sessionId="s1"
        messageId="m1"
      />,
    )
    expect(screen.getByTestId('mock-rich-fallback')).toBeTruthy()
    expect(screen.getByText('旧任务进展摘要')).toBeTruthy()
  })

  it('fallback: unknown kind routes to RichFallback with summary', () => {
    render(<TabTinRichContentBlockView entry={makeRich('holographic_v9', {}, 'Future content')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('mock-rich-fallback')).toBeTruthy()
    expect(screen.getByText('Future content')).toBeTruthy()
  })

  it('skill_invocation: renders SkillInjectionInlineCard', () => {
    const entry: ContentBlockEntry = {
      index: 0,
      block_id: 'skill-1',
      block: { type: 'tabtin_skill_invocation', skill_id: 's1', skill_name: 'Test', injected_text: 'Injected content', injected_text_summary: 'summary' } as any,
      finalized: true,
      partial: false,
    }
    render(<TabTinRichContentBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('mock-skill-card')).toBeTruthy()
  })

  it('approval_request: renders approval card with prompt', () => {
    const entry: ContentBlockEntry = {
      index: 0,
      block_id: 'approval-1',
      block: {
        type: 'tabtin_approval_request',
        approval_id: 'a1',
        prompt: 'Allow web_search?',
        options: [{ id: 'yes', label: 'Allow' }],
      } as any,
      finalized: true,
      partial: false,
    }
    render(<TabTinRichContentBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-approval-request')).toBeTruthy()
    expect(screen.getByText('Allow web_search?')).toBeTruthy()
    expect(screen.getByText('Allow')).toBeTruthy()
  })

  it('source_ref: renders reference card with title', () => {
    const entry: ContentBlockEntry = {
      index: 0,
      block_id: 'ref-1',
      block: {
        type: 'tabtin_source_ref',
        source_id: 'src-1',
        ref_kind: 'web',
        snapshot: { kind: 'web', url: 'https://example.com', title: 'Example Page' },
      } as any,
      finalized: true,
      partial: false,
    }
    render(<TabTinRichContentBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-source-ref')).toBeTruthy()
    expect(screen.getByText('Example Page')).toBeTruthy()
  })
})
