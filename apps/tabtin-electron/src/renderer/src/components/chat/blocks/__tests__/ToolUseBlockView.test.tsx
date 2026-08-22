import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { ToolUseBlockView } from '../ToolUseBlockView'
import type { ContentBlockEntry } from '../types'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useChatStore } from '@stores/chat/useChatStore'
import type { ChatMessage } from '@tabtin/chat-client'
import { commitBlocks, __resetMessageBlocks } from '@stores/chat/messages/messageBlocks'

/** 单一 store = message.blocks：commit 前须有消息壳（镜像生产 message_start 建壳）。 */
function seedShell(sessionId: string, messageId: string): void {
  const cur = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  useChatStore.getState().setSessionMessages(sessionId, [
    ...cur,
    { id: messageId, role: 'assistant', content: '', created_at: '2025-01-01T00:00:00Z' } as ChatMessage,
  ])
}

vi.mock('../../tool/ToolStepCard', () => ({
  ToolStepCard: ({
    toolName,
    phase,
    input,
    output,
    durationMs,
    intent,
  }: {
    toolName: string
    phase: string
    input?: unknown
    output?: unknown
    durationMs?: number
    intent?: string
  }) => (
    <div
      data-testid="mock-tool-step-card"
      data-tool={toolName}
      data-phase={phase}
      data-input={input === undefined ? '' : JSON.stringify(input)}
      data-output={output === undefined ? '' : JSON.stringify(output)}
      data-duration={durationMs == null ? '' : String(durationMs)}
      data-intent={intent ?? ''}
    />
  ),
}))

// 单个子 Agent 已统一到「对话内 step 形态」（SubagentAggregateView，runs 长度 1）。
// 保留 SubagentProgressCard 的副作用 import stub（ToolUseBlockView 仍 bare-import
// 它以保住 registry 注册），避免真模块拉进重依赖。
vi.mock('../../subagent/SubagentProgressCard', () => ({
  SubagentProgressCard: () => null,
}))
vi.mock('../../subagent/SubagentAggregateView', () => ({
  AGGREGATE_THRESHOLD: 2,
  SubagentAggregateView: ({ runs }: { runs: unknown[] }) => (
    <div data-testid="mock-subagent-aggregate" data-runs-count={runs.length} />
  ),
}))

function makeTool(name: string, input: Record<string, unknown> = {}, overrides: Partial<ContentBlockEntry> = {}): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'tool-1',
    block: { type: 'tool_use', id: 'toolu_001', name, input },
    finalized: true,
    partial: false,
    ...overrides,
  }
}

describe('ToolUseBlockView', () => {
  beforeEach(() => {
    useChatRuntimeStore.getState().clearToolEventsForSession('s1')
    useChatRuntimeStore.setState({
      toolEventsBySessionId: {},
      subagentRunsBySessionId: {},
    })
    useChatStore.setState({ messagesBySessionId: {} })
    __resetMessageBlocks()
  })

  it('todo：产物由输入区 TodoPanel 承载，对话流内不渲染工具卡', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('todo', {
          todos: [{ id: 't1', content: 'step 1', status: 'pending' }],
        })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
    expect(screen.queryByTestId('block-tool-use')).toBeNull()
  })

  it('todo：创建和写入期间显示紧凑状态行，清单解析后再由 TodoPanel 接管', () => {
    const { rerender } = render(
      <ToolUseBlockView
        entry={makeTool('todo', {}, { finalized: false, partial: true })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    expect(screen.getByTestId('block-tool-use-compact').dataset.activity).toBe('calling')
    expect(screen.getByTestId('shiny-text')).toBeTruthy()
    expect(screen.getByTestId('block-tool-use-compact').querySelector('.animate-spin')).toBeNull()

    rerender(
      <ToolUseBlockView
        entry={makeTool('todo', {
          todos: [{ id: 't1', content: 'step 1', status: 'pending' }],
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    expect(screen.getByTestId('block-tool-use-compact').dataset.activity).toBe('executing')
    expect(screen.getByTestId('shiny-text')).toBeTruthy()
    expect(screen.getByTestId('block-tool-use-compact').querySelector('.animate-spin')).toBeNull()
  })

  it('happy: finalized tool_use（非 compact 工具）renders ToolStepCard with phase=end', () => {
    // edit_file 是写操作，不在 compact 白名单 → 走 ToolStepCard 完整卡片路径
    render(<ToolUseBlockView entry={makeTool('edit_file', { path: '/foo.py' })} sessionId="s1" messageId="m1" />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('edit_file')
    expect(card.dataset.phase).toBe('end')
  })

  it('live 流式：参数已封口但结果未到时 phase=running（执行态）', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('edit_file', { path: '/foo.py' })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )
    expect(screen.getByTestId('mock-tool-step-card').dataset.phase).toBe('running')
  })

  it('live 流式：参数未封口时 phase=start（调用态）', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('edit_file', { path: '/foo.py' }, { finalized: false, partial: true })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )
    expect(screen.getByTestId('mock-tool-step-card').dataset.phase).toBe('start')
  })

  it('工具结果返回前展示 runtime intent', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'read_file',
      phase: 'start',
      intent: '读取项目配置',
      timestamp: Date.now(),
    })

    render(
      <ToolUseBlockView
        entry={makeTool('read_file', { path: '/foo.py' }, { finalized: false })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    expect(screen.getByTestId('mock-tool-step-card').dataset.intent).toBe('读取项目配置')
  })

  it('统一卡片：read_file（信息读取类）现在走 ToolStepCard，不再 compact 单行', () => {
    // 工具调用统一卡片化后，信息读取/检索类也走 ToolStepCard（折叠行 + 下沉
    // 展开），不再走 CompactToolUseRow。
    render(<ToolUseBlockView entry={makeTool('read_file', { path: '/foo.py' })} sessionId="s1" messageId="m1" />)
    expect(screen.queryByTestId('block-tool-use-compact')).toBeNull()
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('read_file')
    expect(card.dataset.phase).toBe('end')
  })

  it('read_file 失败时同样走完整 ToolStepCard，错误结果不被静默', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('read_file', { path: '/foo.py' })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '{"success":false,"error_kind":"mode_restricted","error":"blocked"}',
          isError: true,
        }}
      />,
    )

    expect(screen.queryByTestId('block-tool-use-compact')).toBeNull()
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('read_file')
    expect(card.dataset.phase).toBe('error')
    expect(card.dataset.output).toContain('mode_restricted')
  })

  it('tool_completed system_notice 可作为 output 兜底，避免完成态终端卡误显示 running', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'end',
      input: { command: 'ls -la' },
      output: '{"success":true,"exitCode":0,"stdout":"total 8\\n","stderr":"","agent_session_id":"agent-s1"}',
      timestamp: Date.now(),
      durationMs: 68,
    })

    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'ls -la' })} sessionId="s1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
    expect(card.dataset.output).toContain('total 8')
    expect(card.dataset.duration).toBe('68')
  })

  it('自动批准回执前缀：终端卡解析出 envelope 对象，不 dump 原始 approval_note 串', () => {
    const raw = [
      '<approval_note>',
      'Tool \'run_terminal_command\' was auto-approved by the user\'s standing "always allow" rule.',
      '</approval_note>',
      '',
      '{"exit_code":1,"stdout":"hdiutil: create failed - 文件已经存在","file_history":{"created_paths":[]}}',
    ].join('\n')

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'hdiutil create final.dmg' })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{ content: raw }}
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    const output = card.getAttribute('data-output') || ''
    // 已剥前缀并解析为对象：不再把 approval_note / file_history 原始串 dump 给用户
    expect(output).not.toContain('approval_note')
    const parsed = JSON.parse(output) as { exit_code?: number; stdout?: string }
    expect(parsed.exit_code).toBe(1)
    expect(parsed.stdout).toContain('hdiutil: create failed')
  })

  it('tool_completed 已到但 tool_use 尚未 finalized 时，终端卡也不继续显示 running', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'end',
      input: { command: 'tabtin browser open --url https://36kr.com/' },
      output: '{"success":true,"exitCode":0,"stdout":"{\\"ok\\":true,\\"data\\":{\\"tabId\\":\\"view-1\\"}}","stderr":""}',
      timestamp: Date.now(),
      durationMs: 30017,
    })

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', {}, {
          finalized: false,
          pendingInputJson: '{"command":"tabtin browser open --url https://36kr.com/"',
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
    expect(card.dataset.input).toContain('https://36kr.com')
    expect(card.dataset.output).toContain('view-1')
    expect(card.dataset.duration).toBe('30017')
  })

  it('tool_failed 已到但 tool_use 尚未 finalized 时，终端卡进入 error 而不是 running', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'error',
      input: { command: 'tabtin browser open --url https://36kr.com/ --wait-until networkidle' },
      output: '{"success":false,"error_kind":"request_timeout","abort_reason":"timeout","error":"network idle timeout"}',
      timestamp: Date.now(),
      durationMs: 30012,
    })

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', {}, {
          finalized: false,
          pendingInputJson: '{"command":"tabtin browser open --url https://36kr.com/ --wait-until networkidle"',
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('error')
    expect(card.dataset.input).toContain('networkidle')
    expect(card.dataset.output).toContain('network idle timeout')
    expect(card.dataset.duration).toBe('30012')
  })

  it('subagent replay: 同 message sibling tool_result 可直接作为 output（虚拟 session 不依赖 runtime store）', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'df -h' })}
        sessionId="subagent-replay:run-1"
        messageId="m1"
        siblingToolResult={{ content: '{"success":true,"exitCode":0,"stdout":"Filesystem  Size  Used\\n","stderr":""}' }}
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
    expect(card.dataset.output).toContain('Filesystem')
    expect(card.dataset.output).toContain('Size')
  })

  it('subagent replay: sibling tool_result is_error=true 时外层卡片进入 error phase', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'exit 1' })}
        sessionId="subagent-replay:run-1"
        messageId="m1"
        siblingToolResult={{
          content: '{"success":false,"exitCode":1,"stdout":"","stderr":"failed\\n"}',
          isError: true,
        }}
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('error')
    expect(card.dataset.output).toContain('failed')
  })

  it('runtime store: 跨 message tool_result is_error=true 时外层卡片进入 error phase', () => {
    seedShell('s1', 'tool-result-message')
    commitBlocks('s1', 'tool-result-message', [{
      index: 0,
      block_id: 'result-1',
      block: {
        type: 'tool_result',
        tool_use_id: 'toolu_001',
        content: '{"success":false,"stderr":"failed from store\\n"}',
        is_error: true,
      } as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }])

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'exit 1' })}
        sessionId="s1"
        messageId="tool-use-message"
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('error')
    expect(card.dataset.output).toContain('failed from store')
  })

  it('layout: compact tool row stays transparent with brighter text', () => {
    // read_file / web_search 已统一为卡片；用 show_widget 验证呈现类 compact 行布局。
    render(<ToolUseBlockView entry={makeTool('show_widget', { summary: 'x' }, { finalized: false })} sessionId="s1" messageId="m1" />)
    const compact = screen.getByTestId('block-tool-use-compact')
    expect(compact.classList.contains('pl-0')).toBe(true)
    expect(compact.classList.contains('bg-muted/20')).toBe(false)
  })

  it('partial: streaming tool_use with pendingInputJson 走 start 调用态，不再叠「正在生成参数…」', () => {
    const entry = makeTool('edit_file', {}, {
      finalized: false,
      pendingInputJson: '{"path": "/foo.py", "content": "hello',
    })
    render(<ToolUseBlockView entry={entry} sessionId="s1" messageId="m1" isStreaming />)
    expect(screen.getByTestId('mock-tool-step-card').dataset.phase).toBe('start')
    expect(screen.queryByText('blockTimeline.toolUse.generatingArgs')).toBeNull()
  })

  it('partial: streaming tool_use with input={} renders start phase', () => {
    render(<ToolUseBlockView entry={makeTool('edit_file', {}, { finalized: false })} sessionId="s1" messageId="m1" />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('start')
  })

  it('web_search 保留标准工具调用卡，不渲染富内容结果框', () => {
    render(<ToolUseBlockView entry={makeTool('web_search', {}, { finalized: true })} sessionId="s1" messageId="m1" />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('web_search')
    expect(card.dataset.phase).toBe('end')
    expect(screen.queryByTestId('block-tool-use-compact')).toBeNull()
    expect(screen.queryByTestId('block-rich-content')).toBeNull()
  })

  it('web_search 失败态仍显示工具卡，方便诊断', () => {
    render(<ToolUseBlockView
      entry={makeTool('web_search')}
      sessionId="s1"
      messageId="m1"
      siblingToolResult={{
        type: 'tool_result',
        tool_use_id: 'toolu_001',
        content: { success: false, error: 'boom' },
        is_error: true,
      }}
    />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('web_search')
    expect(card.dataset.phase).toBe('error')
  })

  it('compact: show_widget 走 compact 单行（产物画布走独立 mini-message）', () => {
    render(<ToolUseBlockView entry={makeTool('show_widget', { summary: 'TabTin 架构图', format: 'svg', code: '<svg></svg>' })} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-tool-use-compact')).toBeTruthy()
    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
  })

  it('parse_document 紧凑步骤优先展示 filename，不展示 file_id', () => {
    const fileId = '4da336e0-a00d-4957-9eb4-8e64eaddbaf6'
    render(<ToolUseBlockView
      entry={makeTool('parse_document', { file_id: fileId, filename: '测试word.docx' })}
      sessionId="s1"
      messageId="m1"
    />)

    const row = screen.getByTestId('block-tool-use-compact')
    expect(row.textContent).toContain('测试word.docx')
    expect(row.textContent).not.toContain(fileId)
  })

  it('present_to_user 走折叠卡片行（与 ToolStepCard 同款 step row）', () => {
    render(<ToolUseBlockView entry={makeTool('present_to_user', { items: [], summary: '简要说明', title: '方案对比' })} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-tool-use-presentation-fold')).toBeTruthy()
    expect(screen.queryByTestId('block-tool-use-compact')).toBeNull()
    expect(screen.getByRole('button', { name: /方案对比/ })).toBeTruthy()
  })

  it('parseError: shows "工具调用参数损坏" warning', () => {
    const entry = makeTool('bash', {}, {
      parseError: { message: 'bad json', partial: '{"cmd": "ls' },
    })
    render(<ToolUseBlockView entry={entry} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-tool-use-parse-error')).toBeTruthy()
    expect(screen.getByText('{"cmd": "ls')).toBeTruthy()
  })

  it('subagent: name="task" routes to SubagentAggregateView（单个子 Agent 也走对话内 step 形态）', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('task', { prompt: 'do stuff' })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )
    const agg = screen.getByTestId('mock-subagent-aggregate')
    expect(agg).toBeTruthy()
    // 实时窗口 + store-miss → 合成 1 条乐观占位 run
    expect(agg.getAttribute('data-runs-count')).toBe('1')
  })

  it('agent wait_agent_ids 路由为等待步骤，不渲染 SubagentAggregateView', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    expect(screen.getByTestId('block-subagent-wait').dataset.count).toBe('2')
    expect(screen.getByTestId('block-subagent-wait').dataset.state).toBe('waiting')
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
  })

  it.each([
    [],
    ['  '],
  ])('agent 有有效 prompt 且 wait_agent_ids=%j 时仍渲染 spawn 子任务', (waitAgentIds) => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', {
          prompt: '调查 issue 10502',
          background: true,
          wait_agent_ids: waitAgentIds,
          check_agent_id: '',
          resume_agent_id: '',
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    expect(screen.getByTestId('mock-subagent-aggregate').dataset.runsCount).toBe('1')
    expect(screen.queryByTestId('block-subagent-wait')).toBeNull()
  })

  it('agent wait_agent_ids 参数流式未闭合时直接显示等待语义，不闪通用“正在调用”', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', {}, {
          finalized: false,
          partial: true,
          pendingInputJson: '{"wait_agent_ids":["child-a"',
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    const waitRow = screen.getByTestId('block-subagent-wait')
    expect(waitRow.dataset.count).toBe('0')
    expect(waitRow.dataset.state).toBe('waiting')
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
  })

  it('agent wait_agent_ids 建屏障失败后停止扫光，保留红色图标但文字使用日志灰色', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['missing-child'] })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '未找到后台子 Agent。',
          isError: true,
          presentation: {
            kind: 'subagent_wait',
            data: {
              childIds: ['missing-child'],
              status: 'error',
            },
          },
        }}
      />,
    )

    const waitRow = screen.getByTestId('block-subagent-wait')
    const icon = waitRow.querySelector('[data-testid="subagent-orchestration-icon"]')
    const label = waitRow.querySelector('span')
    expect(waitRow.dataset.state).toBe('error')
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).toBeNull()
    expect(icon?.getAttribute('class')).toContain('text-destructive/80')
    expect(label?.className).toContain('text-muted-foreground/60')
    expect(label?.className).not.toContain('text-destructive/80')
  })

  it('agent wait_agent_ids 目标已全终态时只依赖 Runtime 快照也能显示完成', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '两个后台子 Agent 均已结束。',
          presentation: {
            kind: 'subagent_wait',
            data: {
              childIds: ['child-a', 'child-b'],
              status: 'completed',
              completedChildIds: ['child-a', 'child-b'],
            },
          },
        }}
      />,
    )

    const waitRow = screen.getByTestId('block-subagent-wait')
    expect(waitRow.dataset.state).toBe('completed')
    expect(waitRow.dataset.settledCount).toBe('2')
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).toBeNull()
  })

  it('agent wait_agent_ids 混合终态时合并 Runtime 快照与 live 状态计数', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        s1: [
          { subagentRunId: 'child-b', status: 'running' },
        ],
      },
    })
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '只等待 child-b。',
          presentation: {
            kind: 'subagent_wait',
            data: {
              childIds: ['child-a', 'child-b'],
              status: 'waiting',
              completedChildIds: ['child-a'],
            },
          },
        }}
      />,
    )

    const waitRow = screen.getByTestId('block-subagent-wait')
    expect(waitRow.dataset.state).toBe('waiting')
    expect(waitRow.dataset.settledCount).toBe('1')
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
  })

  it('agent 工具参数尚为空时不渲染错误的通用“子任务 · 正在调用”', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', {}, { finalized: false, partial: true })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
    expect(screen.queryByTestId('block-subagent-wait')).toBeNull()
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
  })

  it('agent check_agent_id 流式阶段显示紧凑查询行，不渲染子任务卡', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', {}, {
          finalized: false,
          partial: true,
          pendingInputJson: '{"check_agent_id":"child-a"',
        })}
        sessionId="s1"
        messageId="m1"
        isStreaming
        isLastAssistantMsg
      />,
    )

    const checkRow = screen.getByTestId('block-subagent-check')
    expect(checkRow.dataset.state).toBe('checking')
    expect(checkRow.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(checkRow.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
    expect(checkRow.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
  })

  it('agent check_agent_id 结束后显示查询时快照，状态不伪装成实时运行卡', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { check_agent_id: 'child-a' })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '子 Agent 查询时运行中。',
          presentation: {
            kind: 'subagent_status_check',
            data: { childId: 'child-a', status: 'running' },
          },
        }}
      />,
    )

    const checkRow = screen.getByTestId('block-subagent-check')
    expect(checkRow.dataset.childId).toBe('child-a')
    expect(checkRow.dataset.state).toBe('running')
    expect(checkRow.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(checkRow.querySelector('[data-testid="shiny-text"]')).toBeNull()
    expect(checkRow.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
    expect(screen.queryByTestId('mock-subagent-aggregate')).toBeNull()
  })

  it('agent check_agent_id 单个查询消费 Runtime label，明确显示查询对象', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { check_agent_id: 'child-a' })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '子 Agent 查询时运行中。',
          presentation: {
            kind: 'subagent_status_check',
            data: {
              childId: 'child-a',
              label: '后台子代理 A',
              status: 'running',
            },
          },
        }}
      />,
    )

    const checkRow = screen.getByTestId('block-subagent-check')
    expect(checkRow.dataset.label).toBe('后台子代理 A')
    expect(checkRow.textContent).toContain('subagent.check.named.running')
  })

  it('agent check_agent_id 重复查询被 Runtime 节流后不显示状态行', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { check_agent_id: 'child-a' })}
        sessionId="s1"
        messageId="m1"
        siblingToolResult={{
          content: '本轮已查询过。',
          isError: true,
          presentation: {
            kind: 'subagent_status_check',
            data: { childId: 'child-a', status: 'already_checked' },
          },
        }}
      />,
    )

    expect(screen.queryByTestId('block-subagent-check')).toBeNull()
    expect(screen.queryByTestId('mock-tool-step-card')).toBeNull()
  })

  it('agent wait_agent_ids 随真实子任务从等待态更新到完成态', () => {
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
      />,
    )
    const waitRow = screen.getByTestId('block-subagent-wait')
    expect(waitRow.dataset.state).toBe('waiting')
    expect(waitRow.dataset.settledCount).toBe('0')
    expect(waitRow.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
    expect(waitRow.querySelector('.animate-spin')).toBeNull()

    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          s1: [
            { subagentRunId: 'child-a', status: 'completed' },
            { subagentRunId: 'child-b', status: 'running' },
          ],
        },
      })
    })
    expect(waitRow.dataset.state).toBe('waiting')
    expect(waitRow.dataset.settledCount).toBe('1')
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
    expect(waitRow.querySelector('.animate-spin')).toBeNull()

    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          s1: [
            { subagentRunId: 'child-a', status: 'completed' },
            { subagentRunId: 'child-b', status: 'completed' },
          ],
        },
      })
    })
    expect(waitRow.dataset.state).toBe('completed')
    expect(waitRow.dataset.settledCount).toBe('2')
    expect(waitRow.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(waitRow.querySelector('[data-testid="shiny-text"]')).toBeNull()
  })

  it('agent wait_agent_ids 任一子任务失败时显示失败收敛态', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        s1: [
          { subagentRunId: 'child-a', status: 'completed' },
          { subagentRunId: 'child-b', status: 'failed' },
        ],
      },
    })
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    expect(screen.getByTestId('block-subagent-wait').dataset.state).toBe('failed')
  })

  it('agent wait_agent_ids 子任务取消时不误报为失败', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        s1: [
          { subagentRunId: 'child-a', status: 'completed' },
          { subagentRunId: 'child-b', status: 'cancelled' },
        ],
      },
    })
    render(
      <ToolUseBlockView
        entry={makeTool('agent', { wait_agent_ids: ['child-a', 'child-b'] })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    const waitRow = screen.getByTestId('block-subagent-wait')
    expect(waitRow.dataset.state).toBe('cancelled')
    expect(waitRow.dataset.failedCount).toBe('0')
    expect(waitRow.dataset.cancelledCount).toBe('1')
  })

  it('fallback: unknown tool name still renders ToolStepCard', () => {
    render(<ToolUseBlockView entry={makeTool('__future_tool_v9__')} sessionId="s1" messageId="m1" />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.tool).toBe('__future_tool_v9__')
  })

  // ── 2026-05-17 dogfood 事故回归 ───────────────────────────────────
  //
  // 现场：terminal 超时（120s）走 `phase='error'` 路径，原版 lifecycle 兜底
  // 只接受 `phase === 'end'` 的 output，error 路径 output 被静默 filter 掉，
  // TerminalCard 收到 output=null → 退化"结果正在同步…"占位，用户永远看
  // 不到 timeout / hint / partial stdout 等关键错误信息。
  //
  // 修复：lifecycle 兜底接受 'end' 和 'error' 两档 phase；error 路径 output
  // 是 runtime 端 `buildToolErrorResult` 输出的结构化 JSON，TerminalCardRenderer
  // legacy fallback 能识别 `success: false` / `error_kind` 字段正常渲染。
  it('lifecycle 兜底接受 phase=error 的 output（超时/工具抛错也能渲染）', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'error',
      input: { command: 'find ~ -name "calculator.html"' },
      output: '{"success":false,"error_kind":"request_timeout","abort_reason":"timeout","timeout_ms":120000,"stdout":"","error":"Command timed out after 120000ms"}',
      timestamp: Date.now(),
      durationMs: 120013,
    })

    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'find ~ -name "calculator.html"' })} sessionId="s1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.output).toContain('request_timeout')
    expect(card.dataset.output).toContain('timed out')
    expect(card.dataset.duration).toBe('120013')
  })

  // ── 2026-05-17 streaming tool_progress ───────────────────────────
  //
  // 流式期间（entry.finalized=false）lifecycle event 带 progress.stdout 时，
  // 把它包装成 partial output 喂给 ToolStepCard，让 TerminalCard 实时显示
  // partial body 而不是 spinner 黑屏。Anthropic 协议的 atomic tool_result
  // 仍然等到 finalized 才更新，这条 progress 只走 UI 通道。
  it('流式期间（finalized=false）有 progress.stdout → 包装成 partial output 喂 ToolStepCard', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'start',
      timestamp: Date.now(),
      progress: {
        stdout: 'added 12 packages\nadded 47 packages\nadded 89 packages\n',
        outputBytes: 73,
        truncated: false,
        capturedAt: Date.now(),
      },
    })

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'npm install' }, { finalized: false })}
        sessionId="s1"
        messageId="m1"
        isStreaming
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('start')
    // partial stdout 已喂给 ToolStepCard，下游 TerminalCard 能渲染 partial body
    expect(card.dataset.output).toContain('added 89 packages')
    expect(card.dataset.output).toContain('"_tool_progress":true')
    expect(card.dataset.output).toContain('"output_bytes":73')
  })

  it('finalized=true + lifecycle phase=start + progress/session_id → 仍把 progress 当 output 喂 ToolStepCard', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'start',
      timestamp: Date.now(),
      progress: {
        stdout: 'Building...\n',
        outputBytes: 10,
        truncated: false,
        capturedAt: Date.now(),
        sessionId: 'agent-space-1-1779005704948-1d1z',
      },
    })

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'pnpm build' })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
    expect(card.dataset.output).toContain('Building...')
    expect(card.dataset.output).toContain('"session_id":"agent-space-1-1779005704948-1d1z"')
    expect(card.dataset.output).toContain('"_tool_progress":true')
  })

  it('finalized=true 时 progress 不再覆盖 final output（防 race）', () => {
    // Final output（结构化错误 JSON）跟 progress.stdout 都在 lifecycle event 里时，
    // finalized=true 优先取 final output——避免命令完成后还显示中间帧。
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'end',
      output: '{"success":true,"exitCode":0,"stdout":"final output\\n"}',
      timestamp: Date.now(),
      durationMs: 1500,
      progress: {
        stdout: 'partial only',
        outputBytes: 12,
        truncated: false,
        capturedAt: Date.now() - 500,
      },
    })

    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'pwd' })} sessionId="s1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
    // 取 final output（含 final output\n），不取 partial only
    expect(card.dataset.output).toContain('final output')
    expect(card.dataset.output).not.toContain('partial only')
  })

  // ── 2026-05-17 dogfood Review P0-1 回归 ─────────────────────────
  //
  // 终端 timeout / 工具抛错时 lifecycle event phase='error'。原版 ToolUseBlockView
  // 把 phase 永远设为 'start'/'end'，永不传 'error' → ToolStepCard 头部恒走绿勾 ✓
  // → TerminalCard body 红色显示 "Command timed out" 但卡片头是绿勾，用户体感矛盾。
  //
  // 修复：finalized 后从 lifecycle event 真实 phase 决定 'end' / 'error'。
  it('P0-1：finalized + lifecycle phase=error → ToolStepCard 收到 phase=error（外层走红色 XCircle）', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'error',
      output: '{"success":false,"error_kind":"request_timeout","error":"timed out"}',
      timestamp: Date.now(),
      durationMs: 120000,
    })

    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'find /' })} sessionId="s1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    // 关键契约：phase 是 'error' 不是 'end'
    expect(card.dataset.phase).toBe('error')
  })

  it('P0-1：finalized + lifecycle phase=end → 仍走 phase=end（成功路径不回归）', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'end',
      output: '{"success":true,"exitCode":0,"stdout":"ok"}',
      timestamp: Date.now(),
      durationMs: 100,
    })

    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'pwd' })} sessionId="s1" messageId="m1" />)

    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
  })

  it('P0-1：finalized 但 lifecycle event 缺失（race 边界） → fallback end 不变成 error', () => {
    // 极端 race：tool_use block finalized 但 lifecycle notice 还没到。
    // 不传 lifecycle event，确认 fallback 走 'end' 而非误判 'error'。
    render(<ToolUseBlockView entry={makeTool('run_terminal_command', { command: 'pwd' })} sessionId="s1" messageId="m1" />)
    const card = screen.getByTestId('mock-tool-step-card')
    expect(card.dataset.phase).toBe('end')
  })

  // ── 2026-05-17 dogfood Review P0-3 回归 ─────────────────────────
  //
  // 现场：tool_progress notice 写入 progress.stdout 后，紧跟着 tool_completed
  // 到达。原版 handleToolLifecycleNotice 在 phase=end upsert 时不传 progress 字段，
  // upsertToolEventForSession 的 merge 在"未传字段沿用旧值"语义下保留旧 progress。
  // 当 entry.finalized 还没切到 true 时（race），ToolUseBlockView 的
  // lifecycleFinalOutput 被 finalized 门拦住，仍走 lifecycleProgressSnapshot
  // 显示过期的 partial 中间帧。
  //
  // 修复：handleToolLifecycleNotice phase=end/error 时显式 `progress: undefined`
  // 把旧 progress 擦掉。本测试验证写入 phase=end 的 lifecycle event 后，原本的
  // progress 字段被清空。
  it('P0-3：phase=end notice 到达后 progress 字段被清空（不再残留）', async () => {
    const { handleToolLifecycleNotice } = await import('@stores/chat/stream/handlers/toolLifecycleNotice')
    const ctx = {
      sessionId: 's-p3',
      get: () => useChatRuntimeStore.getState() as never,
      notifyPrefix: '',
    } as never

    // 第 1 步：tool_progress 写入 progress
    useChatRuntimeStore.getState().upsertToolEventForSession('s-p3', {
      id: 'toolu_p3',
      toolName: 'run_terminal_command',
      phase: 'start',
      timestamp: Date.now(),
      progress: {
        stdout: 'partial frame',
        outputBytes: 13,
        truncated: false,
        capturedAt: Date.now(),
      },
    })

    // 第 2 步：模拟 tool_completed notice 到达 → handleToolLifecycleNotice
    handleToolLifecycleNotice({
      notice_type: 'tool_completed',
      tool_name: 'run_terminal_command',
      tool_call_id: 'toolu_p3',
      phase: 'end',
      output: 'final result',
      duration_ms: 100,
    }, ctx)

    // 第 3 步：拿当前 toolEvent，progress 应该被清空
    const ev = useChatRuntimeStore.getState().getEffectiveToolEventForSession('s-p3', 'toolu_p3')
    expect(ev?.phase).toBe('end')
    expect(ev?.progress).toBeUndefined()
  })

  it('P0-3：phase=error notice 同样清 progress', async () => {
    const { handleToolLifecycleNotice } = await import('@stores/chat/stream/handlers/toolLifecycleNotice')
    const ctx = {
      sessionId: 's-p3-err',
      get: () => useChatRuntimeStore.getState() as never,
      notifyPrefix: '',
    } as never

    useChatRuntimeStore.getState().upsertToolEventForSession('s-p3-err', {
      id: 'toolu_p3_err',
      toolName: 'run_terminal_command',
      phase: 'start',
      timestamp: Date.now(),
      progress: {
        stdout: 'before timeout',
        outputBytes: 14,
        truncated: false,
        capturedAt: Date.now(),
      },
    })

    handleToolLifecycleNotice({
      notice_type: 'tool_failed',
      tool_name: 'run_terminal_command',
      tool_call_id: 'toolu_p3_err',
      phase: 'error',
      output: '{"success":false,"error_kind":"request_timeout"}',
    }, ctx)

    const ev = useChatRuntimeStore.getState().getEffectiveToolEventForSession('s-p3-err', 'toolu_p3_err')
    expect(ev?.phase).toBe('error')
    expect(ev?.progress).toBeUndefined()
  })

  it('P0-3：phase=start 的 notice 不清 progress（progress 是 start 期间累积的）', async () => {
    const { handleToolLifecycleNotice } = await import('@stores/chat/stream/handlers/toolLifecycleNotice')
    const ctx = {
      sessionId: 's-p3-start',
      get: () => useChatRuntimeStore.getState() as never,
      notifyPrefix: '',
    } as never

    useChatRuntimeStore.getState().upsertToolEventForSession('s-p3-start', {
      id: 'toolu_p3_start',
      toolName: 'run_terminal_command',
      phase: 'start',
      timestamp: Date.now(),
      progress: {
        stdout: 'progress data',
        outputBytes: 13,
        truncated: false,
        capturedAt: Date.now(),
      },
    })

    // 模拟 tool_started 重复到达（譬如 WS replay）—— 不应清 progress
    handleToolLifecycleNotice({
      notice_type: 'tool_started',
      tool_name: 'run_terminal_command',
      tool_call_id: 'toolu_p3_start',
      phase: 'start',
      input: { command: 'pwd' },
    }, ctx)

    const ev = useChatRuntimeStore.getState().getEffectiveToolEventForSession('s-p3-start', 'toolu_p3_start')
    expect(ev?.progress).toEqual({
      stdout: 'progress data',
      outputBytes: 13,
      truncated: false,
      capturedAt: expect.any(Number),
    })
  })

  // ── ：abort 后 terminal tool 卡 running 的回归 ──────────────
  //
  // 现场：用户在 run_terminal_command 执行中点停止，daemon 的 tool_failed /
  // lifecycle.end 因 StreamManager._doAbortSession 先退订 WS 而丢包，ToolEvent
  // 永远停在 phase='start' → ToolUseBlockView 持续显示 "tool in flight" /
  // partial。修复：cleanupSessionOnTerminal 在 cancel/error 终态调
  // finalizeInFlightToolEventsForSession 把 phase='start' 强制收尾成 phase='error'。
  it('#1332 未收尾时 phase=start 的 terminal tool 显示 running（记录 bug 现场）', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'start',
      input: { command: 'npm install' },
      timestamp: Date.now(),
      startedAt: Date.now() - 5_000,
      progress: { stdout: 'added 12 packages\n', outputBytes: 17, truncated: false, capturedAt: Date.now() },
    })

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'npm install' }, { finalized: false })}
        sessionId="s1"
        messageId="m1"
        isStreaming
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    // 现场断言：未收尾时卡片停在 start（running / tool in flight）
    expect(card.dataset.phase).toBe('start')
  })

  it('#1332 abort 收尾后 phase=start 的 terminal tool 切到 error（不再 running）', () => {
    useChatRuntimeStore.getState().upsertToolEventForSession('s1', {
      id: 'toolu_001',
      toolName: 'run_terminal_command',
      phase: 'start',
      input: { command: 'npm install' },
      timestamp: Date.now(),
      startedAt: Date.now() - 5_000,
      progress: { stdout: 'added 12 packages\n', outputBytes: 17, truncated: false, capturedAt: Date.now() },
    })

    // abort 兜底收尾（cleanupSessionOnTerminal 在 cancel/error 终态调用）
    useChatRuntimeStore.getState().finalizeInFlightToolEventsForSession('s1')

    render(
      <ToolUseBlockView
        entry={makeTool('run_terminal_command', { command: 'npm install' }, { finalized: false })}
        sessionId="s1"
        messageId="m1"
        isStreaming
      />,
    )

    const card = screen.getByTestId('mock-tool-step-card')
    // 关键契约：phase 切到 'error'（不再 'start' / running / tool in flight）
    expect(card.dataset.phase).toBe('error')
  })
})
