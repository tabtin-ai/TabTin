import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { SubagentRun } from '../../../../stores/chat/shared/types'
import { appendNestedSubagentCompletionNotifications, buildSubagentVisibleMessages, collectBackgroundSubagentToolCallIds, subagentMessageText } from '../subagentTaskTimeline'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'created_at'>): ChatMessage {
  return {
    content: '',
    ...partial,
  }
}

function run(partial: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return {
    status: 'completed',
    ...partial,
  }
}

describe('buildSubagentVisibleMessages', () => {
  it('resume 运行中没有 summary 时，按 startedAt 把 resume prompt 放到本次输出前', () => {
    const firstStarted = Date.parse('2026-08-13T01:00:00.000Z')
    const resumeStarted = Date.parse('2026-08-13T01:10:00.000Z')
    const messages = [
      msg({
        id: 'first-output',
        role: 'assistant',
        content: 'first done',
        content_blocks_json: [{ type: 'text', text: 'FIRST-OK' }],
        created_at: '2026-08-13T01:01:00.000Z',
      }),
      msg({
        id: 'resume-output',
        role: 'assistant',
        content: 'resume partial',
        content_blocks_json: [{ type: 'text', text: 'RESUME-PARTIAL' }],
        created_at: '2026-08-13T01:10:01.000Z',
      }),
    ]
    const taskRuns = [
      run({
        subagentRunId: 'child-a',
        parentToolCallId: 'agent:first',
        task: 'FIRST-PROMPT',
        startedAt: firstStarted,
        summary: 'FIRST-OK',
      }),
      run({
        subagentRunId: 'child-a',
        parentToolCallId: 'agent:resume',
        task: 'RESUME-PROMPT',
        startedAt: resumeStarted,
        status: 'running',
      }),
    ]

    const visible = buildSubagentVisibleMessages({
      messages,
      taskRuns,
      subagentRunId: 'child-a',
    })

    expect(visible.map(subagentMessageText)).toEqual([
      'FIRST-PROMPT',
      'FIRST-OK',
      'RESUME-PROMPT',
      'RESUME-PARTIAL',
    ])
  })

  it('resume prompt 与首次 prompt 文本相同时仍按 tool call 各展示一次', () => {
    const firstStarted = Date.parse('2026-08-13T01:00:00.000Z')
    const resumeStarted = Date.parse('2026-08-13T01:10:00.000Z')
    const messages = [
      msg({
        id: 'first-output',
        role: 'assistant',
        content_blocks_json: [{ type: 'text', text: 'FIRST-OK' }],
        created_at: '2026-08-13T01:01:00.000Z',
      }),
      msg({
        id: 'resume-output',
        role: 'assistant',
        content_blocks_json: [{ type: 'text', text: 'RESUME-OK' }],
        created_at: '2026-08-13T01:10:01.000Z',
      }),
    ]
    const taskRuns = [
      run({
        subagentRunId: 'child-a',
        parentToolCallId: 'agent:first',
        task: 'SAME-PROMPT',
        startedAt: firstStarted,
        summary: 'FIRST-OK',
      }),
      run({
        subagentRunId: 'child-a',
        parentToolCallId: 'agent:resume',
        task: 'SAME-PROMPT',
        startedAt: resumeStarted,
        summary: 'RESUME-OK',
      }),
    ]

    const visible = buildSubagentVisibleMessages({
      messages,
      taskRuns,
      subagentRunId: 'child-a',
    })

    expect(visible.map(subagentMessageText)).toEqual([
      'SAME-PROMPT',
      'FIRST-OK',
      'SAME-PROMPT',
      'RESUME-OK',
    ])
  })

  it('重复检测读取 runtime blocks，避免实时路径重复合成 prompt', () => {
    const visible = buildSubagentVisibleMessages({
      messages: [
        msg({
          id: 'existing-user',
          role: 'user',
          content: '',
          blocks: [{ block_id: 'b1', block: { type: 'text', text: 'TASK' }, finalized: true }],
          created_at: '2026-08-13T01:00:00.000Z',
        }),
      ],
      taskRuns: [
        run({
          subagentRunId: 'child-a',
          parentToolCallId: 'agent:0',
          task: 'TASK',
          startedAt: Date.parse('2026-08-13T01:00:00.000Z'),
        }),
      ],
      subagentRunId: 'child-a',
    })

    expect(visible).toHaveLength(1)
    expect(subagentMessageText(visible[0])).toBe('TASK')
  })
})

describe('appendNestedSubagentCompletionNotifications', () => {
  it('为当前子代理派发的后台孙代理合成完成通知', () => {
    const visible = appendNestedSubagentCompletionNotifications({
      subagentRunId: 'child-run',
      messages: [
        msg({
          id: 'assistant-1',
          role: 'assistant',
          content: 'child text',
          created_at: '2026-08-13T01:00:00.000Z',
        }),
      ],
      descendantRuns: [
        run({
          subagentRunId: 'grandchild-run',
          dispatchedByRunId: 'child-run',
          parentToolCallId: 'agent:grandchild',
          background: true,
          label: '后台孙代理',
          status: 'completed',
          summary: 'DONE',
          startedAt: Date.parse('2026-08-13T01:00:01.000Z'),
          endedAt: Date.parse('2026-08-13T01:00:02.000Z'),
        }),
      ],
    })

    expect(visible).toHaveLength(2)
    const notification = visible[1]
    expect(notification.role).toBe('user')
    expect(notification.subagent_run_id).toBe('child-run')
    expect(notification.metadata).toMatchObject({
      triggered_by: 'push-notification',
      synthetic: 'nested_subagent_completion',
    })
    expect(notification.content).toContain('<task-notification kind="subagent-completed">')
    expect(notification.content).toContain('<subagent-run-id>grandchild-run</subagent-run-id>')
    expect(notification.content).toContain('<parent-tool-call-id>agent:grandchild</parent-tool-call-id>')
    expect(notification.content).toContain('<summary>DONE</summary>')
  })

  it('已有孙代理完成通知时不重复合成', () => {
    const existing = msg({
      id: 'existing-push',
      role: 'system',
      content: [
        'A background sub-agent finished while you were doing other work:',
        '',
        '<task-notification kind = "subagent-completed">',
        '<subagent-run-id>grandchild-run</subagent-run-id>',
        '<label>后台孙代理</label>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('\n'),
      created_at: '2026-08-13T01:00:02.000Z',
    })

    const visible = appendNestedSubagentCompletionNotifications({
      subagentRunId: 'child-run',
      messages: [existing],
      descendantRuns: [
        run({
          subagentRunId: 'grandchild-run',
          dispatchedByRunId: 'child-run',
          background: true,
          status: 'completed',
        }),
      ],
    })

    expect(visible).toEqual([existing])
  })
})

describe('collectBackgroundSubagentToolCallIds', () => {
  it('从 runtime blocks 和 persisted blocks 识别后台 agent tool call', () => {
    const ids = collectBackgroundSubagentToolCallIds([
      msg({
        id: 'runtime',
        role: 'assistant',
        created_at: '2026-08-13T01:00:00.000Z',
        blocks: [
          {
            block_id: 'entry-runtime',
            block: {
              type: 'tool_use',
              name: 'agent',
              id: 'tool-runtime',
              input: { prompt: 'run', background: true },
            },
            finalized: true,
          },
        ],
      }),
      msg({
        id: 'persisted',
        role: 'assistant',
        created_at: '2026-08-13T01:00:01.000Z',
        content_blocks_json: [
          {
            type: 'tool_use',
            name: 'agent',
            id: 'tool-persisted',
            input: { prompt: 'run', run_in_background: true },
          },
        ],
      }),
    ])

    expect([...ids].sort()).toEqual(['tool-persisted', 'tool-runtime'])
  })
})
