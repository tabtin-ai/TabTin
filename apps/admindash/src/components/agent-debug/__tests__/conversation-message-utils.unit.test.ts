import { describe, expect, it } from 'vitest'
import type { ThreadOverviewMessage } from '@/types/agent-debug'
import {
  collectDisplayAttachments,
  extractResourceLinkAttachments,
  isToolProcessOnlyMessage,
  resolveAttachmentAdminPath,
} from '../conversation-message-utils'

function msg(overrides: Partial<ThreadOverviewMessage>): ThreadOverviewMessage {
  return {
    id: 'm1',
    role: 'assistant',
    message_kind: 'llm',
    content: '',
    attachments: [],
    trace_id: null,
    agent_run_id: null,
    model_name: null,
    stop_reason: null,
    usage: null,
    error: null,
    subagent_run_id: null,
    created_at: '2026-08-03T00:00:00Z',
    ...overrides,
  }
}

describe('isToolProcessOnlyMessage', () => {
  it('隐藏纯工具调用占位气泡', () => {
    expect(isToolProcessOnlyMessage(msg({ content: '[工具调用]' }))).toBe(true)
    expect(isToolProcessOnlyMessage(msg({ content: '', message_kind: 'tool_artifact' }))).toBe(
      true
    )
    expect(isToolProcessOnlyMessage(msg({ role: 'tool', content: 'ok' }))).toBe(true)
  })

  it('保留用户文字与带附件的 Agent 产物', () => {
    expect(
      isToolProcessOnlyMessage(msg({ role: 'user', content: 'hi', message_kind: 'llm' }))
    ).toBe(false)
    expect(
      isToolProcessOnlyMessage(
        msg({
          content: '[工具调用]',
          message_kind: 'tool_artifact',
          attachments: [
            {
              kind: 'file',
              filename: 'out.pdf',
              source: 'agent',
              url: 'https://cdn.example.com/out.pdf',
            },
          ],
        })
      )
    ).toBe(false)
    expect(
      isToolProcessOnlyMessage(msg({ role: 'assistant', content: '这是最终回复' }))
    ).toBe(false)
  })

  it('仅有思考/工具 content_blocks 的占位气泡仍隐藏（过程进运行诊断）', () => {
    expect(
      isToolProcessOnlyMessage(
        msg({
          content: '[工具调用]',
          content_blocks_json: [
            { type: 'thinking', thinking: '先读技能' },
            { type: 'tool_use', id: 't1', name: 'skills.read', input: {} },
          ],
        })
      )
    ).toBe(true)
  })
})

describe('extractResourceLinkAttachments', () => {
  it('从 markdown 资源链接抽出文档产物', () => {
    const content =
      '文档创建成功！\n\n**[萌猫档案](tabtin://resource/document/056c501e-a833-4d2f-a86d-fd0ef84e9547?hint=tabdoc)**'
    expect(extractResourceLinkAttachments(content)).toEqual([
      {
        kind: 'document',
        filename: '萌猫档案',
        source: 'agent',
        url: 'tabtin://resource/document/056c501e-a833-4d2f-a86d-fd0ef84e9547?hint=tabdoc',
        resource_type: 'document',
        resource_id: '056c501e-a833-4d2f-a86d-fd0ef84e9547',
        file_id: undefined,
      },
    ])
  })

  it('忽略代码块中的示例链接', () => {
    const content = '```\n[样例](tabtin://resource/document/02eda024-5f11-…)\n```'
    expect(extractResourceLinkAttachments(content)).toEqual([])
  })
})

describe('collectDisplayAttachments / resolveAttachmentAdminPath', () => {
  it('合并接口附件与正文链接并映射管理页路径', () => {
    const attachments = collectDisplayAttachments(
      msg({
        content:
          '[周报](tabtin://resource/document/doc-1?hint=tabdoc)\n另见 tabtin://resource/table/tbl-2',
        attachments: [
          {
            kind: 'image',
            filename: 'shot.png',
            source: 'user',
            file_id: 'img-1',
            url: 'https://cdn.example.com/shot.png',
          },
        ],
      })
    )
    expect(attachments.map((item) => item.filename)).toEqual(['shot.png', '周报', 'tbl-2'])
    expect(resolveAttachmentAdminPath(attachments[1]!)).toBe('/docs/doc-1')
    expect(resolveAttachmentAdminPath(attachments[2]!)).toBe('/tables/tbl-2')
  })
})
