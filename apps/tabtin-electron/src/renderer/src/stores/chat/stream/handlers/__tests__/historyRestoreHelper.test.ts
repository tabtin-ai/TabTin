import { describe, expect, it } from 'vitest'

import { restoreRuntimeStateFromHistory } from '../historyRestoreHelper'

describe('historyRestoreHelper', () => {
  it('在历史恢复时保留 tool error 的真实输出文案', () => {
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        created_at: '2026-03-09T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'tool_call',
            tool_name: 'shell',
            tool_call_id: 'tool-1',
            output: 'permission denied',
            error: true,
          },
        ],
      } as any,
    ])

    expect(result.toolEvents[0]?.error).toBe('permission denied')
    expect(result.agentSteps[0]?.detail).toBe('permission denied')
  })

  it('在历史恢复时补出 metadata 里的最终失败步骤', () => {
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-2',
        role: 'assistant',
        content: '',
        created_at: '2026-03-09T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'metadata',
            error: true,
            error_message: 'daemon crashed',
          },
        ],
      } as any,
    ])

    expect(result.agentSteps[0]?.status).toBe('error')
    expect(result.agentSteps[0]?.detail).toBe('daemon crashed')
  })

  // 2026-05-10 dogfood 回归：content_blocks_json 持久化的 tool_call.output 可能是
  // FR-09 fence-wrapped string（runtime 在 phase=end 时写盘 raw fence 字符串，
  // 实时路径在 toolHandler 解 fence，hydrate 路径必须做对称解包）。
  // 真实 dogfood 现场：read_file 返回 7K 字符 fence-wrapped envelope，切走
  // session 再切回时 FileReadCard 显示「文件内容为空」——根因就是这条路径
  // 漏了 unwrapToolOutputFence。
  it('hydrate 时对 read_file fence-wrapped string 解包成对象（成功路径）', () => {
    const fenceBody = JSON.stringify({
      success: true,
      content: '1\t<!DOCTYPE html>\n2\t<html lang="zh-CN">',
      path: '/tmp/foo.html',
      total_lines: 2,
    })
    const fenceWrapped = `<tool_output tool_name="read_file" tool_call_id="read_file:0">\n${fenceBody}\n</tool_output>`
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-3',
        role: 'assistant',
        content: '',
        created_at: '2026-05-10T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'tool_call',
            tool_name: 'read_file',
            tool_call_id: 'read_file:0',
            output: fenceWrapped,
          },
        ],
      } as any,
    ])

    const restoredOutput = result.toolEvents[0]?.output
    expect(typeof restoredOutput).toBe('object')
    expect((restoredOutput as Record<string, unknown>)?.success).toBe(true)
    expect((restoredOutput as Record<string, unknown>)?.path).toBe('/tmp/foo.html')
    expect((restoredOutput as Record<string, unknown>)?.content).toContain('<!DOCTYPE html>')
  })

  it('hydrate 时 plain string 输出（非 fence）原样保留', () => {
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-4',
        role: 'assistant',
        content: '',
        created_at: '2026-05-10T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'tool_call',
            tool_name: 'todo',
            tool_call_id: 'todo:0',
            output: 'todos updated',
          },
        ],
      } as any,
    ])

    expect(result.toolEvents[0]?.output).toBe('todos updated')
  })

  it('hydrate 时 error 路径不剥 fence（错误文案保持 plain，走 restoredError）', () => {
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-5',
        role: 'assistant',
        content: '',
        created_at: '2026-05-10T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'tool_call',
            tool_name: 'shell',
            tool_call_id: 'shell:0',
            output: 'permission denied',
            error: true,
          },
        ],
      } as any,
    ])

    expect(result.toolEvents[0]?.error).toBe('permission denied')
    expect(result.toolEvents[0]?.output).toBe('permission denied')
  })

  it('hydrate 新协议 tool_use + 独立 user tool_result 时恢复 toolEvent.output', () => {
    const result = restoreRuntimeStateFromHistory([
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: '',
        created_at: '2026-05-17T00:00:00.000Z',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'run_terminal_command:0',
            name: 'run_terminal_command',
            input: { command: 'ls -la', description: '列目录' },
          },
        ],
      } as any,
      {
        id: 'msg-tool-result',
        role: 'user',
        content: '',
        created_at: '2026-05-17T00:00:01.000Z',
        content_blocks_json: [
          {
            type: 'tool_result',
            tool_use_id: 'run_terminal_command:0',
            content: '{"success":true,"exitCode":0,"durationMs":61,"stdout":"total 8\\n","stderr":"","agent_session_id":"agent-s1"}',
            is_error: false,
          },
        ],
      } as any,
    ])

    expect(result.toolEvents[0]).toMatchObject({
      id: 'run_terminal_command:0',
      toolName: 'run_terminal_command',
      phase: 'end',
      durationMs: 61,
    })
    expect(result.toolEvents[0]?.output).toMatchObject({
      success: true,
      stdout: 'total 8\n',
      agent_session_id: 'agent-s1',
    })
    expect(result.agentSteps[0]?.status).toBe('done')
  })
})

// ：待办恢复逻辑已迁出 restoreRuntimeStateFromHistory——清单不再进 runtime
// 状态，改由 deriveTodoTimeline 从 message.blocks 纯派生。相关用例见
// todoTimeline.test.ts。
