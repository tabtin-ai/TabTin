/**
 * RichSearchResults / RichMemoryCard / RichDocumentExcerpt — W7 渲染基线测试。
 *
 * 钉死的契约：
 *   - 各 kind 在常态、空数据、折叠展开等关键路径下不抛、能渲染关键文本
 *   - 解析状态机（document_excerpt：parsing / pending / partial）走对应分支
 *
 * react-i18next 已被全局 setup mock 为 `t = (key) => key`，断言走原始 key 字符串。
 */

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { RichContentBlock } from '@tabtin/chat-client'

import { RichSearchResults } from '../RichSearchResults'
import { RichMemoryCard } from '../RichMemoryCard'
import { RichDocumentExcerpt } from '../RichDocumentExcerpt'

function block(overrides: Partial<RichContentBlock>): RichContentBlock {
  return {
    type: 'rich_content',
    kind: 'search_results',
    summary: 'test',
    ...overrides,
  } as RichContentBlock
}

/** 整卡默认折叠，点 header（aria-expanded 按钮）展开出结果体。 */
function expandCard(container: HTMLElement): void {
  const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement
  expect(header).not.toBeNull()
  fireEvent.click(header)
}

describe('RichSearchResults', () => {
  it('is collapsed by default: results hidden until header is clicked', () => {
    const { container } = render(
      <RichSearchResults block={block({
        kind: 'search_results',
        query: 'tabtin docs',
        total_count: 1,
        search_results: [
          { title: 'TabTin manual', url: 'https://example.com/manual', snippet: 'snippet A' },
        ],
      })} />,
    )
    // 折叠态：header 上的 query 可见，但结果体（标题 / 摘要）不渲染
    expect(container.textContent).toContain('tabtin docs')
    expect(screen.queryByText('TabTin manual')).toBeNull()
    expect(screen.queryByText('snippet A')).toBeNull()

    expandCard(container)
    expect(screen.getByText('TabTin manual')).toBeTruthy()
    expect(screen.getByText('snippet A')).toBeTruthy()
  })

  it('renders title + snippet for each result once expanded', () => {
    const { container } = render(
      <RichSearchResults block={block({
        kind: 'search_results',
        query: 'tabtin docs',
        total_count: 2,
        search_results: [
          { title: 'TabTin manual', url: 'https://example.com/manual', snippet: 'snippet A' },
          { title: 'Quickstart', url: 'https://example.com/quickstart', snippet: 'snippet B' },
        ],
      })} />,
    )
    expandCard(container)
    expect(screen.getByText('TabTin manual')).toBeTruthy()
    expect(screen.getByText('snippet A')).toBeTruthy()
    expect(screen.getByText('Quickstart')).toBeTruthy()
  })

  it('shows empty-state when search_results is empty array (after expand)', () => {
    const { container } = render(
      <RichSearchResults block={block({
        kind: 'search_results',
        query: 'empty',
        total_count: 0,
        search_results: [],
      })} />,
    )
    expandCard(container)
    expect(container.textContent).toContain('richContent.searchResults.noResults')
  })

  it('truncates list to first 5 once expanded and exposes show-all button', () => {
    const { container } = render(
      <RichSearchResults block={block({
        kind: 'search_results',
        query: 'big',
        total_count: 12,
        search_results: Array.from({ length: 12 }, (_, i) => ({
          title: `r${i}`,
          url: `https://r${i}.example`,
          snippet: `s${i}`,
        })),
      })} />,
    )
    expandCard(container)
    // r0..r4 visible, r5..r11 hidden
    expect(container.textContent).toContain('r0')
    expect(container.textContent).toContain('r4')
    expect(container.textContent).not.toContain('r5')
    expect(container.textContent).toContain('richContent.searchResults.showAll')
  })

  it('renders content_type chip and score percentage when provided (rag_search hits)', () => {
    const { container } = render(
      <RichSearchResults block={block({
        kind: 'search_results',
        query: 'q',
        total_count: 1,
        search_results: [
          { title: 'My table', snippet: 'preview', content_type: 'table', score: 0.92, source: 'tbl-123' },
        ],
      })} />,
    )
    expandCard(container)
    expect(screen.getByText('table')).toBeTruthy()
    expect(screen.getByText('92%')).toBeTruthy()
  })
})

const openAgentMemoryMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/agentMemoryNavigation', () => ({
  openAgentMemory: openAgentMemoryMock,
}))
vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: { selectedOrganization: { id: string } | null }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

describe('RichMemoryCard', () => {
  beforeEach(() => {
    openAgentMemoryMock.mockReset()
  })

  it('renders memo content + memo_type + tags', () => {
    render(
      <RichMemoryCard block={block({
        kind: 'memory_card',
        query: 'login',
        total_count: 1,
        memories: [{
          id: 'm1',
          content: 'User prefers SSO over password',
          memo_type: 'about_you',
          tags: ['login', 'sso'],
          created_at: new Date(Date.now() - 60_000).toISOString(),
        }],
      })} />,
    )
    expect(screen.getByText('User prefers SSO over password')).toBeTruthy()
    expect(screen.getByText('about_you')).toBeTruthy()
    expect(screen.getByText('#login')).toBeTruthy()
    expect(screen.getByText('#sso')).toBeTruthy()
  })

  it('deep-links to agent memory governance on row click ', () => {
    render(
      <RichMemoryCard block={block({
        kind: 'memory_card',
        agent_id: 'agent-9',
        memories: [{
          id: 'm-deep',
          content: 'Morning standup at 9',
        }],
      })} />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(openAgentMemoryMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      agentId: 'agent-9',
      memoryId: 'm-deep',
    })
  })

  it('shows empty state when no memories', () => {
    const { container } = render(
      <RichMemoryCard block={block({
        kind: 'memory_card',
        query: 'q',
        total_count: 0,
        memories: [],
      })} />,
    )
    expect(container.textContent).toContain('richContent.memory.noMemos')
  })

  it('renders source_url as anchor when http(s)', () => {
    const { container } = render(
      <RichMemoryCard block={block({
        kind: 'memory_card',
        memories: [{
          id: 'm1',
          content: 'note',
          source_url: 'https://example.com/page',
        }],
      })} />,
    )
    const anchor = container.querySelector('a[href="https://example.com/page"]')
    expect(anchor).not.toBeNull()
  })

  it('renders source_url as plain chip for tabtin internal protocols', () => {
    const { container } = render(
      <RichMemoryCard block={block({
        kind: 'memory_card',
        memories: [{
          id: 'm1',
          content: 'note',
          source_url: 'thread://session-abc-123',
        }],
      })} />,
    )
    expect(container.textContent).toContain('thread://session-abc-123')
    expect(container.querySelector('a[href^="thread://"]')).toBeNull()
  })
})

describe('RichDocumentExcerpt', () => {
  it('renders parsing state with loader text', () => {
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'parsing',
        parsed_pages: 5,
        total_pages: 20,
      })} />,
    )
    expect(container.textContent).toContain('richContent.document.parsing')
    expect(container.textContent).toContain('richContent.document.pageOf')
  })

  it('renders pending state', () => {
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'pending',
      })} />,
    )
    expect(container.textContent).toContain('richContent.document.pending')
  })

  it('renders chunks grouped by page on success', () => {
    render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'success',
        total_pages: 2,
        parsed_pages: 2,
        document_chunks: [
          { page: 1, content: 'Heading on page 1', chunk_type: 'heading', heading_level: 1 },
          { page: 1, content: 'Body on page 1', chunk_type: 'paragraph' },
          { page: 2, content: 'Body on page 2', chunk_type: 'paragraph' },
        ],
      })} />,
    )
    expect(screen.getByText('Heading on page 1')).toBeTruthy()
    expect(screen.getByText('Body on page 1')).toBeTruthy()
    expect(screen.getByText('Body on page 2')).toBeTruthy()
  })

  it('renders partial banner when parse_status=partial', () => {
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'partial',
        document_chunks: [{ page: 1, content: 'x' }],
      })} />,
    )
    expect(container.textContent).toContain('richContent.document.partial')
  })

  it('renders empty hint when no chunks on success', () => {
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'success',
        document_chunks: [],
      })} />,
    )
    expect(container.textContent).toContain('richContent.document.empty')
  })

  it('文档摘录标题优先展示 filename，不暴露 file_id', () => {
    const fileId = '4da336e0-a00d-4957-9eb4-8e64eaddbaf6'
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: fileId,
        filename: '测试word.docx',
        parse_status: 'success',
        document_chunks: [{ page: 1, content: 'x' }],
      })} />,
    )

    expect(container.textContent).toContain('测试word.docx')
    expect(container.textContent).not.toContain(fileId)
  })

  it('exposes file_id navigation button when onResourceNavigate is provided', () => {
    const calls: Array<[string, string]> = []
    const { container } = render(
      <RichDocumentExcerpt
        block={block({
          kind: 'document_excerpt',
          file_id: 'file-uuid-1',
          parse_status: 'success',
          document_chunks: [{ page: 1, content: 'x' }],
        })}
        onResourceNavigate={(rt, rid) => calls.push([rt, rid])}
      />,
    )
    const button = container.querySelector('button[title="richContent.document.openFile"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    expect(calls).toEqual([['file', 'file-uuid-1']])
  })

  it('does NOT show navigation button when no callback wired', () => {
    const { container } = render(
      <RichDocumentExcerpt block={block({
        kind: 'document_excerpt',
        file_id: 'f1',
        parse_status: 'success',
        document_chunks: [{ page: 1, content: 'x' }],
      })} />,
    )
    expect(container.querySelector('button[title="richContent.document.openFile"]')).toBeNull()
  })
})
