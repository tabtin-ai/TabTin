import { describe, expect, it } from 'vitest'
import { deriveToolUseExecutionState } from '../deriveToolUseExecutionState'
import { routeToolUseView } from '../toolUseBlockViewLogic'
import type { ContentBlockEntry } from '../types'

const entry = {
  block_id: 'toolu_image',
  block: {
    type: 'tool_use',
    id: 'toolu_image',
    name: 'run_terminal_command',
    input: {},
  },
  finalized: true,
  partial: false,
} as unknown as ContentBlockEntry

function route(params: {
  effectiveInput: unknown
  presentation?: {
    kind: string
    data?: Record<string, unknown>
  }
}) {
  return routeToolUseView({
    entry,
    toolName: 'run_terminal_command',
    effectiveInput: params.effectiveInput,
    phase: 'start',
    inputFinalized: true,
    todoSnapshot: undefined,
    sessionId: 's1',
    presentation: params.presentation,
  })
}

describe('routeToolUseView · structured presentation', () => {
  it('按执行侧 presentation.kind 路由生图卡，并透传展示数据', () => {
    expect(route({
      effectiveInput: { command: 'opaque command text' },
      presentation: {
        kind: 'media_image_generation',
        data: { command: 'tabtin media image generate --prompt apple', prompt: 'apple' },
      },
    })).toEqual({
      kind: 'media_image',
      command: 'tabtin media image generate --prompt apple',
      promptPreview: 'apple',
    })
  })

  it('只有命令文本、没有结构化语义时保持普通终端卡', () => {
    expect(route({
      effectiveInput: {
        command: 'tabtin media image generate --prompt apple',
      },
    })).toEqual({ kind: 'tool_step_card' })
  })

  it('未知 presentation.kind 不触发动画', () => {
    expect(route({
      effectiveInput: { command: 'tabtin media image generate --prompt apple' },
      presentation: { kind: 'unknown_future_presentation' },
    })).toEqual({ kind: 'tool_step_card' })
  })

  it('结果由富内容卡承载时隐藏工具空壳', () => {
    expect(routeToolUseView({
      entry,
      toolName: 'read_file',
      effectiveInput: { path: '/tmp/document.pdf' },
      phase: 'end',
      inputFinalized: true,
      todoSnapshot: undefined,
      sessionId: 's1',
      presentation: { kind: 'rich_content_only' },
    })).toEqual({ kind: 'presentation_hidden' })
  })

  it('历史回放从 canonical tool_result.presentation 恢复同一张生图卡', () => {
    const state = deriveToolUseExecutionState({
      entry,
      toolName: 'run_terminal_command',
      effectiveInput: { command: 'opaque after reload' },
      inputFinalized: true,
      sessionId: 's1',
      toolCallId: 'toolu_image',
      storedToolResult: {
        content: '{"ok":true}',
        presentation: {
          kind: 'media_image_generation',
          data: { command: 'tabtin media image generate --prompt apple', prompt: 'apple' },
        },
      },
      todoSnapshot: undefined,
    })

    expect(state.viewRoute).toEqual({
      kind: 'media_image',
      command: 'tabtin media image generate --prompt apple',
      promptPreview: 'apple',
    })
  })
})
