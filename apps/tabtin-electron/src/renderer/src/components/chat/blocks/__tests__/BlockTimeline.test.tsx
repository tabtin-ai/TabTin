import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { BlockTimeline } from '../BlockTimeline'
import type { ContentBlockEntry } from '../types'
import {
  TurnEndLayoutProvider,
  type TurnEndLayoutValue,
} from '../../viewport/TurnEndLayoutContext'
import { TOOL_CARD_GROUP } from '../../registry/chatDesignTokens'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; count?: number }) => {
      let value = opts?.defaultValue ?? _key
      if (opts?.count !== undefined) value = value.replace(/\{\{count\}\}/g, String(opts.count))
      return value
    },
  }),
}))

vi.mock('../../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

vi.mock('../../tool/ToolStepCard', () => ({
  ToolStepCard: ({ toolName, phase, output }: { toolName: string; phase?: string; output?: unknown }) => (
    <div
      data-testid="mock-tool-step-card"
      data-phase={phase ?? ''}
      data-output={output === undefined ? '' : JSON.stringify(output)}
    >
      {toolName}
    </div>
  ),
}))

vi.mock('../../subagent/SubagentProgressCard', () => ({
  SubagentProgressCard: () => <div data-testid="mock-subagent" />,
}))

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
  RichFallback: () => <div data-testid="mock-rich-fallback" />,
}))

vi.mock('../../skill/SkillInjectionInlineCard', () => ({
  SkillInjectionInlineCard: () => <div data-testid="mock-skill-card" />,
}))

vi.mock('../../../common/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

function makeBlocks(): ContentBlockEntry[] {
  return [
    {
      index: 0,
      block_id: 'think-1',
      block: { type: 'thinking', thinking: 'Let me analyze...', signature: '' },
      finalized: true,
      partial: false,
    },
    {
      index: 1,
      block_id: 'text-1',
      block: { type: 'text', text: 'I will read the file.' },
      finalized: true,
      partial: false,
    },
    {
      index: 2,
      block_id: 'tool-1',
      // W4.5：用 edit_file（非 compact 工具）确保走完整 ToolStepCard 路径，
      // 让本测试断言"5 个 block 按顺序渲染"的 testid 序列稳定。compact 工具
      // （read_file / grep_search 等）走 CompactToolUseRow 单行视图，testid
      // 是 'block-tool-use-compact' 而非 'block-tool-use'，详见
      // ToolUseBlockView.test.tsx。
      block: { type: 'tool_use', id: 'toolu_001', name: 'edit_file', input: { path: '/foo.py' } },
      finalized: true,
      partial: false,
    },
    {
      index: 3,
      block_id: 'result-1',
      // ：失败 tool_result 也只作为 tool_use 卡片的数据输入，不再独立渲染。
      block: { type: 'tool_result', tool_use_id: 'toolu_001', content: 'Error: file not found', is_error: true },
      finalized: true,
      partial: false,
    },
    {
      index: 4,
      block_id: 'text-2',
      block: { type: 'text', text: 'File content looks good.' },
      finalized: true,
      partial: false,
    },
  ]
}

describe('BlockTimeline', () => {
  it('renders 5 mixed blocks in index order', () => {
    render(
      <BlockTimeline
        blocks={makeBlocks()}
        sessionId="s1"
        messageId="m1"
      />,
    )
    const timeline = screen.getByTestId('block-timeline')
    expect(timeline).toBeTruthy()
    expect(timeline.children.length).toBeGreaterThanOrEqual(4)
  })

  it('blocks render in correct order: thinking → text → tool → text', () => {
    render(<BlockTimeline blocks={makeBlocks()} sessionId="s1" messageId="m1" />)
    const allTestIds = screen.getByTestId('block-timeline')
      .querySelectorAll('[data-testid]')
    const order = Array.from(allTestIds)
      .map(el => el.getAttribute('data-testid'))
      .filter(id => id && id.startsWith('block-') && id !== 'block-timeline')
    expect(order[0]).toBe('block-thinking')
    expect(order[1]).toBe('block-text')
    expect(order[2]).toBe('block-tool-use')
    expect(order[3]).toBe('block-text')
    expect(order).not.toContain('block-tool-result-error')
  })

  it('passes same-message tool_result content to the matching tool_use card', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'tool-1',
        block: { type: 'tool_use', id: 'toolu_local', name: 'run_terminal_command', input: { command: 'df -h' } },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'result-1',
        block: {
          type: 'tool_result',
          tool_use_id: 'toolu_local',
          content: '{"success":true,"exitCode":0,"stdout":"Filesystem  Size\\n"}',
        },
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="subagent-replay:run-1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.output).toContain('Filesystem')
    expect(card.dataset.output).toContain('Size')
  })

  it('passes same-message tool_result error state to the matching tool_use card', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'tool-1',
        block: { type: 'tool_use', id: 'toolu_local', name: 'run_terminal_command', input: { command: 'exit 1' } },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'result-1',
        block: {
          type: 'tool_result',
          tool_use_id: 'toolu_local',
          content: '{"success":false,"exitCode":1,"stderr":"failed\\n"}',
          is_error: true,
        },
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="subagent-replay:run-1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('error')
    expect(card.dataset.output).toContain('failed')
    expect(screen.queryByTestId('block-tool-result-error')).toBeNull()
  })

  it('pairs web_search_tool_result with server_tool_use without a standalone result row', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'server-tool-1',
        block: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'TabTin' },
        } as ContentBlockEntry['block'],
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'server-result-1',
        block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com/tabtin',
              title: 'TabTin',
            },
          ],
        } as ContentBlockEntry['block'],
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="s1" messageId="m1" />)

    expect(screen.getAllByTestId('block-server-tool-use')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('TabTin')).toBeTruthy()
    expect(screen.getByTestId('block-timeline').children).toHaveLength(1)
  })

  it('empty blocks array renders null', () => {
    const { container } = render(
      <BlockTimeline blocks={[]} sessionId="s1" messageId="m1" />,
    )
    expect(container.children.length).toBe(0)
  })

  it('turn-end hold 期间也立即显示工具组合并头，但关闭 size layout', () => {
    const threshold = TOOL_CARD_GROUP.collapseThreshold
    const toolCount = threshold + 1
    const blocks: ContentBlockEntry[] = Array.from({ length: toolCount }, (_, i) => ({
      index: i,
      block_id: `tool-${i}`,
      block: {
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'edit_file',
        input: { path: `/f${i}.py` },
      },
      finalized: true,
      partial: false,
    }))

    const holdValue: TurnEndLayoutValue = {
      phase: 'settling',
      closingUiReady: true,
      shouldHoldThinkingPreviewBudget: true,
      shouldHoldClosingSpacer: false,
      markClosingUiReady: () => {},
      release: () => {},
    }
    render(
      <TurnEndLayoutProvider value={holdValue}>
        <BlockTimeline
          blocks={blocks}
          sessionId="s1"
          messageId="m1"
          isLastAssistantMsg
          isStreaming={false}
        />
      </TurnEndLayoutProvider>,
    )

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.queryAllByTestId('mock-tool-step-card')).toHaveLength(0)
    expect(screen.getByTestId('tool-card-group-panel-body').getAttribute('data-layout-size')).toBe('false')
  })

  it('流式执行中跨过阈值时立即合并，并保留未完成尾步可见', () => {
    const threshold = TOOL_CARD_GROUP.collapseThreshold
    const blocks: ContentBlockEntry[] = Array.from({ length: threshold + 1 }, (_, i) => ({
      index: i,
      block_id: `tool-${i}`,
      block: {
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'edit_file',
        input: { path: `/f${i}.py` },
      },
      finalized: i < threshold,
      partial: i >= threshold,
    }))

    render(
      <BlockTimeline
        blocks={blocks}
        sessionId="s1"
        messageId="m1"
        isLastAssistantMsg
        isStreaming
      />,
    )

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe(String(threshold + 1))
    const visibleTools = screen.getAllByTestId('mock-tool-step-card')
    expect(visibleTools).toHaveLength(1)
    expect(visibleTools[0].textContent).toContain('edit_file')
  })

  it('相邻思考 + 工具调用一起计入折叠阈值，tool_result 不重复计数', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'think-1',
        block: { type: 'thinking', thinking: '先看文件', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'tool-1',
        block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: '/a.py' } },
        finalized: true,
        partial: false,
      },
      {
        index: 2,
        block_id: 'result-1',
        block: { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
        finalized: true,
        partial: false,
      },
      {
        index: 3,
        block_id: 'think-2',
        block: { type: 'thinking', thinking: '再确认一下', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 4,
        block_id: 'tool-2',
        block: { type: 'tool_use', id: 'toolu_2', name: 'edit_file', input: { path: '/b.py' } },
        finalized: true,
        partial: false,
      },
      {
        index: 5,
        block_id: 'result-2',
        block: { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"ok":true}' },
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="s1" messageId="m1" />)

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe('4')
    expect(screen.queryAllByTestId('mock-tool-step-card')).toHaveLength(0)
  })

  it('相邻一段思考 + 一个工具调用也会折叠', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'think-1',
        block: { type: 'thinking', thinking: '先确认一下上下文', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'tool-1',
        block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: '/a.py' } },
        finalized: true,
        partial: false,
      },
      {
        index: 2,
        block_id: 'result-1',
        block: { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="s1" messageId="m1" />)

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe('2')
    expect(screen.queryAllByTestId('mock-tool-step-card')).toHaveLength(0)
  })

  it('多个相邻 thinking+tool pair 中间只有空 text 时合成一个折叠组', () => {
    const blocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'think-1',
        block: { type: 'thinking', thinking: '第一步', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'tool-1',
        block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: { path: '/a.py' } },
        finalized: true,
        partial: false,
      },
      {
        index: 2,
        block_id: 'blank-1',
        block: { type: 'text', text: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 3,
        block_id: 'think-2',
        block: { type: 'thinking', thinking: '第二步', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 4,
        block_id: 'tool-2',
        block: { type: 'tool_use', id: 'toolu_2', name: 'edit_file', input: { path: '/b.py' } },
        finalized: true,
        partial: false,
      },
      {
        index: 5,
        block_id: 'blank-2',
        block: { type: 'text', text: '   ' },
        finalized: true,
        partial: false,
      },
      {
        index: 6,
        block_id: 'think-3',
        block: { type: 'thinking', thinking: '第三步', signature: '' },
        finalized: true,
        partial: false,
      },
      {
        index: 7,
        block_id: 'tool-3',
        block: { type: 'tool_use', id: 'toolu_3', name: 'edit_file', input: { path: '/c.py' } },
        finalized: true,
        partial: false,
      },
    ]

    render(<BlockTimeline blocks={blocks} sessionId="s1" messageId="m1" />)

    expect(screen.getAllByTestId('tool-card-group-header')).toHaveLength(1)
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe('6')
    expect(screen.queryAllByTestId('mock-tool-step-card')).toHaveLength(0)
  })

  it('fallback: unknown future block.type does not crash, shows fallback', () => {
    const futureBlocks: ContentBlockEntry[] = [
      {
        index: 0,
        block_id: 'future-1',
        block: { type: 'code_artifact_v3', code: 'print("hello")' } as unknown as ContentBlockEntry['block'],
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'text-after',
        block: { type: 'text', text: 'After future block' },
        finalized: true,
        partial: false,
      },
    ]
    expect(() => {
      render(<BlockTimeline blocks={futureBlocks} sessionId="s1" messageId="m1" />)
    }).not.toThrow()
    expect(screen.getByTestId('block-fallback')).toBeTruthy()
    expect(screen.getByText('After future block')).toBeTruthy()
  })
})
