/**
 *  子代理数据层统一 —— 集成回归。
 *
 * 守的不变量：`applyChildEvent`（子/孙 Agent 实时事件）把 reduce 结果落进父 session
 * 的 `messagesBySessionId`（带 `subagent_run_id`），使统一读模型的派生器
 * `deriveSubagentRunsFromMessages` **live 期**就能扫到子代理里派发孙 Agent 的
 * tool_use↔tool_result 标记 → 孙代理归属（`dispatchedByRunId`）匹配正确，不再依赖
 * reload 冷源。数据层不区分主/子/孙，只用 `subagent_run_id` 标身份。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useSubagentLiveStore, flushSubagentLiveBatch } from '../subagentLive'
import { useChatStore } from '../chat/useChatStore'
import { __resetMessageBlocks } from '../chat/messages/messageBlocks'
import { deriveSubagentRunsFromMessages } from '../chat/subagent/utils/subagentRunsFromMessages'

const PARENT = 'parent-session-unify'
const CHILD_RUN = 'child-run-1'
const GRANDCHILD_RUN = 'grandchild-run-1'

function ev(type: string, payload: Record<string, unknown>) {
  return { type: `agent.stream.${type}`, payload }
}

beforeEach(() => {
  useSubagentLiveStore.getState().clear()
  __resetMessageBlocks()
  useChatStore.setState({ messagesBySessionId: {} })
})

describe('#3005 子代理数据层统一', () => {
  it('子代理派发孙 Agent → 消息落父 messagesBySessionId（带 subagent_run_id）', () => {
    const store = useSubagentLiveStore.getState()
    // 子代理（CHILD_RUN）的一条 assistant 消息：agent tool_use（派孙）+ 其 tool_result（带孙 ID）
    store.applyChildEvent(CHILD_RUN, ev('message_start', { message_id: 'cm1', role: 'assistant' }), PARENT)
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'cm1', index: 0,
      block: { type: 'tool_use', id: 'agent_0', name: 'agent', input: { prompt: '做子任务' } },
    }))
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'cm1', index: 1,
      block: { type: 'tool_result', tool_use_id: 'agent_0', content: `[子 Agent ID: ${GRANDCHILD_RUN}] 完成`, is_error: false },
    }))

    flushSubagentLiveBatch() // ：同步父 session 现走 rAF flush，断言前强制 flush
    const parentMsgs = useChatStore.getState().messagesBySessionId[PARENT] ?? []
    const childMsg = parentMsgs.find((m) => m.id === 'cm1')
    expect(childMsg).toBeDefined()
    expect(childMsg!.subagent_run_id).toBe(CHILD_RUN)
    // 块已 commit 到统一读模型（message.blocks，内存 SSoT）
    const types = (childMsg!.blocks ?? []).map((e) => (e.block as { type?: string }).type)
    expect(types).toContain('tool_use')
    expect(types).toContain('tool_result')
    // 自足性：content_blocks_json（持久 / 兜底形态）也写全——与历史 / 主 Agent 消息
    // 结构完全一致，committed 被 evict / 刷新走 API 时读法不变（不会「修实时坏历史」）。
    const jsonTypes = (childMsg!.content_blocks_json ?? []).map((b) => (b as { type?: string }).type)
    expect(jsonTypes).toContain('tool_use')
    expect(jsonTypes).toContain('tool_result')
  })

  it('元字段完全统一：model_id/model_name/message_kind/stop_reason/usage_json 全落到消息', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent(CHILD_RUN, {
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'cm-meta', role: 'assistant',
        model_id: 'claude-x', model_name: 'Claude X', message_kind: 'llm',
      },
    }, PARENT)
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'cm-meta', index: 0, block: { type: 'text', text: '' },
    }))
    store.applyChildEvent(CHILD_RUN, ev('content_block_delta', {
      message_id: 'cm-meta', index: 0, delta: { type: 'text_delta', text: 'hi' },
    }))
    store.applyChildEvent(CHILD_RUN, {
      type: 'agent.stream.message_delta',
      payload: {
        message_id: 'cm-meta',
        delta: { stop_reason: 'aborted' },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })

    flushSubagentLiveBatch()
    const msg = (useChatStore.getState().messagesBySessionId[PARENT] ?? []).find((m) => m.id === 'cm-meta')
    expect(msg).toBeDefined()
    expect(msg!.model_id).toBe('claude-x')
    expect(msg!.model_name).toBe('Claude X')
    expect((msg as { message_kind?: string }).message_kind).toBe('llm')
    expect(msg!.stop_reason).toBe('aborted')
    expect(msg!.usage_json).toEqual({ input_tokens: 10, output_tokens: 5 })
    expect(msg!.text_summary).toBe('hi')
  })

  it('deriveSubagentRunsFromMessages live 期即匹配孙 Agent 归属到子（dispatchedByRunId=child）', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent(CHILD_RUN, ev('message_start', { message_id: 'cm1', role: 'assistant' }), PARENT)
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'cm1', index: 0,
      block: { type: 'tool_use', id: 'agent_0', name: 'agent', input: { prompt: '做子任务', role: '测试助手' } },
    }))
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'cm1', index: 1,
      block: { type: 'tool_result', tool_use_id: 'agent_0', content: `[子 Agent ID: ${GRANDCHILD_RUN}] 完成`, is_error: false },
    }))

    flushSubagentLiveBatch()
    const parentMsgs = useChatStore.getState().messagesBySessionId[PARENT] ?? []
    const runs = deriveSubagentRunsFromMessages(parentMsgs)
    const grandchild = runs.find((r) => r.subagentRunId === GRANDCHILD_RUN)
    expect(grandchild).toBeDefined()
    // 关键：孙归属到子（owner），不再错乱到主 Agent（空串）
    expect(grandchild!.dispatchedByRunId).toBe(CHILD_RUN)
    expect(grandchild!.status).toBe('completed')
    expect(grandchild!.role).toBe('测试助手')
  })
})

describe('#4632 rAF 合并高频子代理事件', () => {
  it('连续多个 delta 在 flush 前不写父 session；flush 后一次性产出累积文本', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent(CHILD_RUN, ev('message_start', { message_id: 'raf1', role: 'assistant' }), PARENT)
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'raf1', index: 0, block: { type: 'text', text: '' },
    }))
    for (const t of ['一', '二', '三', '四', '五']) {
      store.applyChildEvent(CHILD_RUN, ev('content_block_delta', {
        message_id: 'raf1', index: 0, delta: { type: 'text_delta', text: t },
      }))
    }
    // flush 前：父 session 尚未同步（reducer 已累积，但昂贵派生被推迟）
    expect(useChatStore.getState().messagesBySessionId[PARENT]).toBeUndefined()

    flushSubagentLiveBatch()
    // flush 后：一次性产出，文本为全部 delta 累积（不丢字、不重复）
    const msg = (useChatStore.getState().messagesBySessionId[PARENT] ?? []).find((m) => m.id === 'raf1')
    expect(msg).toBeDefined()
    expect(msg!.text_summary).toBe('一二三四五')
  })

  it('markRunTerminal 强制 flush pending，终态快照不丢尾', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent(CHILD_RUN, ev('message_start', { message_id: 'tail1', role: 'assistant' }), PARENT)
    store.applyChildEvent(CHILD_RUN, ev('content_block_start', {
      message_id: 'tail1', index: 0, block: { type: 'text', text: '' },
    }))
    store.applyChildEvent(CHILD_RUN, ev('content_block_delta', {
      message_id: 'tail1', index: 0, delta: { type: 'text_delta', text: '末尾token' },
    }))
    // 不手动 flush，直接标终态——应内部强制 flush 把末尾 token 落进快照
    store.markRunTerminal(CHILD_RUN)
    const msg = (useChatStore.getState().messagesBySessionId[PARENT] ?? []).find((m) => m.id === 'tail1')
    expect(msg).toBeDefined()
    expect(msg!.text_summary).toBe('末尾token')
  })
})
