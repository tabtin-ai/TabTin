import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { deriveSubagentRunsFromMessages } from '../subagentRunsFromMessages'

function parentMsg(id: string, blocks: unknown[], owner?: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2026-06-28T00:00:00.000Z',
    content_blocks_json: blocks as never,
    // ：派生器读运行时 SSoT message.blocks（生产由入口反序列化灌入）。测试从
    // content_blocks_json 派生 finalized entries 模拟 ingress。
    blocks: blocks.map((block, index) => ({
      index,
      block_id: `b-${id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as never,
    ...(owner ? { subagent_run_id: owner } : {}),
  } as ChatMessage
}

describe('deriveSubagentRunsFromMessages', () => {
  it('从父 tool_use + 配对 tool_result([子 Agent ID]) 派生 completed run', () => {
    const messages = [
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '报数', description: '子0', role: '报数员' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '1\n\n报数完毕\n\n[子 Agent ID: child-0]',
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'child-0', status: 'completed' },
          },
        },
      ]),
    ]
    const runs = deriveSubagentRunsFromMessages(messages)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'child-0',
      parentToolCallId: 'agent:0',
      status: 'completed',
      label: '子0',
      task: '报数',
      role: '报数员',
    })
    // summary 去掉 [子 Agent ID] 标记
    expect(runs[0].summary).toContain('报数完毕')
    expect(runs[0].summary).not.toContain('子 Agent ID')
  })

  it('：从 tool_use.input.template_id 回填 templateId（冷源恢复模板标记）', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '审代码', template_id: 'tpl-1' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: 'done\n\n[子 Agent ID: child-t]',
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'child-t', status: 'completed' },
          },
        },
      ]),
    ])
    expect(runs[0]).toMatchObject({ subagentRunId: 'child-t', templateId: 'tpl-1' })
  })

  it('：无 template_id 的 ad-hoc 派发 → templateId 为 undefined', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '临时活' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: 'done\n\n[子 Agent ID: child-a]',
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'child-a', status: 'completed' },
          },
        },
      ]),
    ])
    expect(runs[0].templateId).toBeUndefined()
  })

  it('is_error 的 tool_result → failed', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: {} },
        { type: 'tool_result', tool_use_id: 'agent:0', content: 'boom\n\n[子 Agent ID: child-x]', is_error: true },
      ]),
    ])
    expect(runs[0]).toMatchObject({ subagentRunId: 'child-x', status: 'failed', errorKind: 'failed' })
  })

  it('后台派发 presentation 只派生 pending，不猜 completed', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('background-dispatch', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '后台调研', background: true } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '已在后台启动\n\n[子 Agent ID: child-bg]',
          presentation: {
            kind: 'subagent_dispatch',
            data: { subagent_run_id: 'child-bg', status: 'pending', background: true },
          },
        },
      ]),
    ])
    expect(runs[0]).toMatchObject({ subagentRunId: 'child-bg', status: 'pending', background: true })
  })

  it('后台派发后追加同 childId 的终态 message block → 合成为 completed', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('background-dispatch', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '后台调研', background: true } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '已在后台启动\n\n[子 Agent ID: child-bg]',
          presentation: {
            kind: 'subagent_dispatch',
            data: { subagent_run_id: 'child-bg', status: 'pending', background: true },
          },
        },
      ]),
      parentMsg('background-terminal', [
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '后台调研完成：推荐方案 B\n\n[子 Agent ID: child-bg]',
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'child-bg', status: 'completed' },
          },
        },
      ]),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'child-bg',
      status: 'completed',
      background: true,
      summary: '后台调研完成：推荐方案 B',
      archiveStatusSource: 'presentation_result',
    })
  })

  it('后台派发后追加同 childId 的失败终态 message block → 合成为 failed', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('background-dispatch', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '后台调研', background: true } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '已在后台启动\n\n[子 Agent ID: child-bg-failed]',
          presentation: {
            kind: 'subagent_dispatch',
            data: { subagent_run_id: 'child-bg-failed', status: 'pending', background: true },
          },
        },
      ]),
      parentMsg('background-terminal', [
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '子 Agent 执行失败\n\n[子 Agent ID: child-bg-failed]',
          is_error: true,
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'child-bg-failed', status: 'failed' },
          },
        },
      ]),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'child-bg-failed',
      status: 'failed',
      background: true,
      errorKind: 'failed',
      error: '子 Agent 执行失败',
    })
  })

  it('旧后台回执无 presentation 但 input.background=true → pending', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('legacy-background-dispatch', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '后台调研', background: true } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '已在后台启动\n\n[子 Agent ID: child-bg-legacy]',
        },
      ]),
    ])
    expect(runs[0]).toMatchObject({ subagentRunId: 'child-bg-legacy', status: 'pending', background: true })
  })

  it('旧后台失败回执无 presentation 但 is_error=true → failed', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('legacy-background-failed', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '后台调研', background: true } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '后台启动失败\n\n[子 Agent ID: child-bg-failed]',
          is_error: true,
        },
      ]),
    ])
    expect(runs[0]).toMatchObject({
      subagentRunId: 'child-bg-failed',
      status: 'failed',
      background: true,
      errorKind: 'failed',
    })
  })

  it('旧前台成功结果无 presentation / is_error / background → completed（兼容旧归档）', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('legacy-ambiguous', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { prompt: '旧任务' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: '旧回执\n\n[子 Agent ID: child-ambiguous]',
        },
      ]),
    ])
    expect(runs[0]).toMatchObject({ subagentRunId: 'child-ambiguous', status: 'completed' })
  })

  it('无 tool_result(运行中) → 不派生(由 live 覆盖)', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: {} },
      ]),
    ])
    expect(runs).toHaveLength(0)
  })

  it('tool_result 缺 [子 Agent ID] 标记 → 无法关联,跳过', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: {} },
        { type: 'tool_result', tool_use_id: 'agent:0', content: '没有标记' },
      ]),
    ])
    expect(runs).toHaveLength(0)
  })

  it('非 subagent 工具(read_file)不派生', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'read_file:0', name: 'read_file', input: { path: '/x' } },
        { type: 'tool_result', tool_use_id: 'read_file:0', content: 'data' },
      ]),
    ])
    expect(runs).toHaveLength(0)
  })

  it('check / wait 控制调用即使结果文本含 ID 也不派生子 Agent run', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('controls', [
        {
          type: 'tool_use',
          id: 'agent-check',
          name: 'agent',
          input: { check_agent_id: 'child-existing' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'agent-check',
          content: '运行中\n\n[子 Agent ID: child-existing]',
        },
        {
          type: 'tool_use',
          id: 'agent-wait',
          name: 'agent',
          input: { wait_agent_ids: ['child-existing'] },
        },
        {
          type: 'tool_result',
          tool_use_id: 'agent-wait',
          content: '已进入等待\n\n[子 Agent ID: child-existing]',
        },
      ]),
    ])

    expect(runs).toHaveLength(0)
  })

  it('resume 复用同一个子 Agent ID 时，按 parentToolCallId 派生两次运行并保留本次 prompt', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        {
          type: 'tool_use',
          id: 'agent:first',
          name: 'agent',
          input: { prompt: '首次任务', description: 'live-child-A' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'agent:first',
          content: 'FIRST-OK\n\n[子 Agent ID: child-resume]',
        },
        {
          type: 'tool_use',
          id: 'agent:resume',
          name: 'agent',
          input: {
            resume_agent_id: 'child-resume',
            prompt: '续跑任务，只回复 RESUME-OK',
            description: 'live-child-A-resumed',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'agent:resume',
          content: 'RESUME-OK\n\n[子 Agent ID: child-resume]',
        },
      ]),
    ])

    expect(runs).toHaveLength(2)
    expect(runs.map(run => run.parentToolCallId)).toEqual(['agent:first', 'agent:resume'])
    expect(runs.map(run => run.task)).toEqual(['首次任务', '续跑任务，只回复 RESUME-OK'])
    expect(runs.map(run => run.summary)).toEqual(['FIRST-OK', 'RESUME-OK'])
  })

  it('子代理自身消息(subagent_run_id 非空)可派生孙 Agent run', () => {
    const sub = parentMsg('s1', [
      { type: 'tool_use', id: 'agent:0', name: 'agent', input: {} },
      { type: 'tool_result', tool_use_id: 'agent:0', content: 'x\n\n[子 Agent ID: nested]' },
    ])
    ;(sub as { subagent_run_id?: string }).subagent_run_id = 'child-parent'
    const runs = deriveSubagentRunsFromMessages([sub])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'nested',
      parentToolCallId: 'agent:0',
      status: 'completed',
    })
  })

  it('主层 + 子层各派一个（tool_use id 全局唯一）都能派生', () => {
    const root = parentMsg('p1', [
      { type: 'tool_use', id: 'toolu_main_0', name: 'agent', input: { description: '直接子' } },
      { type: 'tool_result', tool_use_id: 'toolu_main_0', content: 'root\n\n[子 Agent ID: child-0]' },
    ])
    const nested = parentMsg('s1', [
      { type: 'tool_use', id: 'toolu_child_0', name: 'agent', input: { description: '孙代理' } },
      { type: 'tool_result', tool_use_id: 'toolu_child_0', content: 'nested\n\n[子 Agent ID: grandchild-0]' },
    ])
    ;(nested as { subagent_run_id?: string }).subagent_run_id = 'child-0'

    const runs = deriveSubagentRunsFromMessages([root, nested])

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'child-0',
      parentToolCallId: 'toolu_main_0',
      label: '直接子',
    })
    expect(runs[1]).toMatchObject({
      subagentRunId: 'grandchild-0',
      parentToolCallId: 'toolu_child_0',
      label: '孙代理',
    })
  })

  it('tool_use 和 tool_result 跨消息也能配对', () => {
    const use = parentMsg('s-use', [
      { type: 'tool_use', id: 'toolu_child_0', name: 'agent', input: { description: '孙代理' } },
    ])
    const result = parentMsg('s-result', [
      { type: 'tool_result', tool_use_id: 'toolu_child_0', content: 'nested\n\n[子 Agent ID: grandchild-cross-message]' },
    ])
    ;(use as { subagent_run_id?: string }).subagent_run_id = 'child-0'
    ;(result as { subagent_run_id?: string }).subagent_run_id = 'child-0'

    const runs = deriveSubagentRunsFromMessages([use, result])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      subagentRunId: 'grandchild-cross-message',
      parentToolCallId: 'toolu_child_0',
      label: '孙代理',
    })
  })

  it('多个子代理 + 去重', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('p1', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { description: 'A' } },
        { type: 'tool_use', id: 'agent:1', name: 'agent', input: { description: 'B' } },
        { type: 'tool_result', tool_use_id: 'agent:0', content: 'a [子 Agent ID: c0]' },
        { type: 'tool_result', tool_use_id: 'agent:1', content: 'b [子 Agent ID: c1]' },
      ]),
    ])
    expect(runs.map(r => r.subagentRunId)).toEqual(['c0', 'c1'])
  })

  it('Agent Runtime presentation 的 cancelled 终态是历史恢复权威值', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('cancelled', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { description: '被取消任务' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: 'Sub-agent cancelled by user: task\n\n[子 Agent ID: cancelled-1]',
          is_error: true,
          presentation: {
            kind: 'subagent_result',
            data: { subagent_run_id: 'cancelled-1', status: 'cancelled' },
          },
        },
      ]),
    ])

    expect(runs[0]).toMatchObject({ subagentRunId: 'cancelled-1', status: 'cancelled' })
  })

  it('旧历史缺 presentation 时，精确识别 Agent Runtime 的用户取消结果', () => {
    const runs = deriveSubagentRunsFromMessages([
      parentMsg('legacy-cancelled', [
        { type: 'tool_use', id: 'agent:0', name: 'agent', input: { description: '旧取消任务' } },
        {
          type: 'tool_result',
          tool_use_id: 'agent:0',
          content: 'Sub-agent cancelled by user: task\n\n[子 Agent ID: cancelled-legacy]',
          is_error: true,
        },
      ]),
    ])

    expect(runs[0]).toMatchObject({ subagentRunId: 'cancelled-legacy', status: 'cancelled' })
  })

  it('同一 parentToolCallId 跨轮/跨消息重复（agent_0）：顺序 FIFO 配对，两个 run 都恢复', () => {
    // 复现 provider 每轮从 agent_0 重编号：第 1 轮派孙 A、第 2 轮派孙 B，两次 tool_use
    // id 都是 agent_0，分处不同 message。旧「id→最后一个 result」实现会把孙 A 吞掉。
    const turn1Use = parentMsg('m1', [
      { type: 'tool_use', id: 'agent_0', name: 'agent', input: { description: '孙A' } },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'a\n\n[子 Agent ID: grand-A]' },
    ])
    const turn2Use = parentMsg('m2', [
      { type: 'tool_use', id: 'agent_0', name: 'agent', input: { description: '孙B' } },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'b\n\n[子 Agent ID: grand-B]' },
    ])
    const runs = deriveSubagentRunsFromMessages([turn1Use, turn2Use])
    expect(runs).toHaveLength(2)
    expect(runs.map(r => r.subagentRunId)).toEqual(['grand-A', 'grand-B'])
    // FIFO：第 1 个 agent_0 配第 1 个 result（孙A），第 2 个配第 2 个（孙B）
    expect(runs[0]).toMatchObject({ subagentRunId: 'grand-A', label: '孙A' })
    expect(runs[1]).toMatchObject({ subagentRunId: 'grand-B', label: '孙B' })
  })

  it('多 owner 同 id（agent_0）：按 owner 分桶配对，孙 Agent 不被别的组长偷走 result', () => {
    // 复现 session 70f65458：组长A / 组长C 各自派报数员，dispatch 都是 agent_0，
    // 各自的 tool_result（回执）落在各自 owner 的消息里。不分 owner 会把 组长C 的
    // result 错配给 组长A 的 use（角色错乱 / 丢卡）。
    const leaderA = parentMsg('mA', [
      { type: 'tool_use', id: 'agent_0', name: 'agent', input: { role: '报数员A1' } },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'A1\n\n[子 Agent ID: gc-A1]' },
    ], 'leaderA')
    const leaderC = parentMsg('mC', [
      { type: 'tool_use', id: 'agent_0', name: 'agent', input: { role: '报数员C1' } },
      { type: 'tool_result', tool_use_id: 'agent_0', content: 'C1\n\n[子 Agent ID: gc-C1]' },
    ], 'leaderC')
    const runs = deriveSubagentRunsFromMessages([leaderA, leaderC])
    expect(runs).toHaveLength(2)
    const byId = Object.fromEntries(runs.map(r => [r.subagentRunId, r.role]))
    expect(byId['gc-A1']).toBe('报数员A1') // 各归各 owner，不串
    expect(byId['gc-C1']).toBe('报数员C1')
  })
})
