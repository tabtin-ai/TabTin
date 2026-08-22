import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  agentToolDeliverableToArtifact,
  parseDeliverablesFromAgentToolContent,
} from '../turnArtifactFromAgentTool'
import { collectTurnArtifacts } from '../turnArtifacts'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'>): ChatMessage {
  const base = {
    message_kind: partial.role === 'assistant' ? 'llm' : undefined,
    ...partial,
  } as ChatMessage
  if (base.blocks === undefined && Array.isArray(base.content_blocks_json)) {
    base.blocks = base.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${base.id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as never
  }
  return base
}

describe('turnArtifactFromAgentTool', () => {
  it('parses deliverables tag from agent tool_result content', () => {
    const content = [
      '子任务完成',
      '',
      '交付物：',
      '- local_file: reports/a.xlsx',
      '',
      '<tabtin-subagent-deliverables>',
      JSON.stringify([
        {
          artifact_kind: 'local_file',
          relative_path: 'reports/a.xlsx',
          filename: 'a.xlsx',
        },
      ]),
      '</tabtin-subagent-deliverables>',
    ].join('\n')
    expect(parseDeliverablesFromAgentToolContent(content)).toEqual([
      {
        artifact_kind: 'local_file',
        relative_path: 'reports/a.xlsx',
        filename: 'a.xlsx',
      },
    ])
  })

  it('maps deliverable to TurnArtifact', () => {
    const mapped = agentToolDeliverableToArtifact(
      {
        artifact_kind: 'platform_resource',
        resource_type: 'tabdoc',
        resource_id: 'doc_1',
        resource_name: '周报',
        url: 'tabtin://resource/tabdoc/doc_1',
      },
      'agent_1',
      0,
      '文件操作助手',
    )
    expect(mapped).toMatchObject({
      kind: 'doc',
      title: '周报',
      href: 'tabtin://resource/tabdoc/doc_1',
      sourceSubagentName: '文件操作助手',
    })
  })

  it('collectTurnArtifacts merges agent tool_result deliverables into the turn', () => {
    const deliverablesJson = JSON.stringify([
      {
        artifact_kind: 'local_file',
        relative_path: 'out/report.md',
        filename: 'report.md',
      },
    ])
    const content = `done\n\n<tabtin-subagent-deliverables>\n${deliverablesJson}\n</tabtin-subagent-deliverables>`
    const turn: ChatMessage[] = [
      msg({ id: 'u1', role: 'user', content: '写报告', created_at: '2026-08-04T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        message_kind: 'llm',
        created_at: '2026-08-04T00:00:01Z',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'agent_1',
            name: 'agent',
            input: { prompt: '写报告', description: '创建指定文件并汇报', role: '文件操作助手' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'agent_1',
            content,
          },
          {
            type: 'text',
            text: '报告写好了',
          },
        ],
      }),
    ]

    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts.map((a) => a.title)).toContain('report.md')
    expect(artifacts[0]?.href).toContain('out%2Freport.md')
    expect(artifacts[0]?.sourceSubagentName).toBe('文件操作助手')
  })

  it('resolveSubagentDisplayName resolver beats tool_use description for badge', () => {
    const deliverablesJson = JSON.stringify([
      {
        artifact_kind: 'local_file',
        relative_path: 'out/a.md',
        filename: 'a.md',
      },
    ])
    const content = `done\n\n<tabtin-subagent-deliverables>\n${deliverablesJson}\n</tabtin-subagent-deliverables>`
    const turn: ChatMessage[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        message_kind: 'llm',
        created_at: '2026-08-04T00:00:01Z',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'agent_2',
            name: 'agent',
            input: { description: 'fallback-desc' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'agent_2',
            content,
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn, undefined, {
      resolveSubagentDisplayName: (id) => (id === 'agent_2' ? '角色甲' : undefined),
    })
    expect(artifacts[0]?.sourceSubagentName).toBe('角色甲')
  })

  it('collectTurnArtifacts merges subagentDeliverables resolver for background late completion', () => {
    const turn: ChatMessage[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        message_kind: 'llm',
        created_at: '2026-08-04T00:00:01Z',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'agent_bg_1',
            name: 'agent',
            input: { prompt: '后台写', run_in_background: true, description: '后台写文件' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'agent_bg_1',
            content: '已在后台启动\n\n[子 Agent ID: child-bg]',
          },
          {
            type: 'text',
            text: '已派发',
          },
        ],
      }),
    ]

    const artifacts = collectTurnArtifacts(turn, undefined, {
      subagentDeliverables: (parentToolCallId) => (
        parentToolCallId === 'agent_bg_1'
          ? [{
              artifact_kind: 'local_file',
              relative_path: 'bg/done.txt',
              filename: 'done.txt',
            }]
          : []
      ),
    })
    expect(artifacts.map((a) => a.title)).toEqual(['done.txt'])
    expect(artifacts[0]?.sourceSubagentName).toBe('后台写文件')
  })
})
