/**
 * BlockTimeline.checkAgentDispatch.test.tsx —  回归
 *
 * 现象：指令派发一个后台子 Agent 后，主 Agent 又用 `agent` 工具的
 * `check_agent_id` 纯查询模式查一次状态；对话内出现「派发了 2 个子任务」+
 * 两张完全一样的任务卡。
 *
 * 根因：`agent` 工具多态（派发 prompt / 续跑 resume_agent_id / 纯查询
 * check_agent_id）。前端「子 Agent 派发块」判定原本只看工具名、不看 input；
 * 且后端 handleCheckAgentStatus 的 tool_result 也复用 `[子 Agent ID: X]` marker。
 * 于是 spawn 块与 check 块都被当成派发块、都反查到同一 run X → 重复成两张卡。
 *
 * 修复：按 input 将 check 路由为独立紧凑状态行——不算派发、不进聚合组，
 * 也不再复用需要等待 SUBAGENT_STARTED 的任务卡。
 */

import React from 'react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; duration?: string }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
      let dv = opts?.defaultValue ?? key
      if (opts?.count !== undefined) dv = dv.replace(/\{\{count\}\}/g, String(opts.count))
      if (opts?.duration !== undefined) dv = dv.replace(/\{\{duration\}\}/g, opts.duration)
      return dv
    },
    i18n: { language: 'zh-CN' },
  }),
}))

// 就地展开详情面板重依赖——本测不点开，stub 掉。
vi.mock('../../subagent/SubagentDetailPane', () => ({
  SubagentDetailPane: () => <div data-testid="mock-detail-pane" />,
}))

// 模板 badge 反查——本测无模板派发，返回空。
vi.mock('../../hooks/useSubagentTemplateNames', () => ({
  useSubagentTemplateMeta: () => new Map(),
}))

// Space store —— SubagentAggregateView 只取 selectedSpace?.id。
vi.mock('@stores/useSpaceStore', () => {
  const state = { selectedSpace: { id: 'space-1' } }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useSpaceStore: Object.assign(useStore, { getState: () => state }) }
})

import { BlockTimeline } from '../BlockTimeline'
import type { ContentBlockEntry } from '../types'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import type { SubagentRun } from '../../../stores/chat/shared/types'

const SUB_ID = 'sub-af317126'

let _seq = 0
function entry(block: Record<string, unknown>): ContentBlockEntry {
  _seq++
  return {
    index: _seq,
    block_id: `blk-${_seq}`,
    block: { ...block } as ContentBlockEntry['block'],
    finalized: true,
    partial: false,
  }
}

function spawnBlock(id = 'call_spawn'): ContentBlockEntry {
  return entry({
    type: 'tool_use',
    id,
    name: 'agent',
    input: { role: '产品风险分析师', description: 'AI行业简报产品风险分析', prompt: '分析产品风险', background: true },
  })
}

function checkBlock(id: string, subId = SUB_ID): ContentBlockEntry {
  return entry({ type: 'tool_use', id, name: 'agent', input: { check_agent_id: subId } })
}

function waitBlock(id: string, childIds = [SUB_ID]): ContentBlockEntry {
  return entry({ type: 'tool_use', id, name: 'agent', input: { wait_agent_ids: childIds } })
}

function resultBlock(toolUseId: string, text: string, subId = SUB_ID): ContentBlockEntry {
  return entry({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `${text}\n\n[子 Agent ID: ${subId}]`,
    is_error: false,
  })
}

function checkResultBlock(
  toolUseId: string,
  subId: string,
  label: string,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'already_checked',
): ContentBlockEntry {
  return entry({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `状态：${status}`,
    is_error: status === 'failed' || status === 'already_checked',
    presentation: {
      kind: 'subagent_status_check',
      data: { childId: subId, label, status },
    },
  })
}

function completedRun(): SubagentRun {
  return {
    subagentRunId: SUB_ID,
    parentToolCallId: 'call_spawn',
    status: 'completed',
    label: 'AI行业简报产品风险分析',
    task: '分析产品风险',
    role: '产品风险分析师',
  }
}

function renderTimeline(blocks: ContentBlockEntry[]) {
  return render(
    <BlockTimeline
      blocks={blocks}
      sessionId="sess-1"
      messageId="msg-1"
      isLastAssistantMsg={false}
      isStreaming={false}
    />,
  )
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid^="subagent-inline-row-"]').length
}

beforeEach(() => {
  _seq = 0
  useChatStore.setState({ messagesBySessionId: {} })
  // 冷源 deriveSubagentRunsFromMessages 按 subagentRunId 去重 → store 里只有 1 条 run。
  useChatRuntimeStore.setState({ subagentRunsBySessionId: { 'sess-1': [completedRun()] } })
})

describe(' —— check_agent_id 状态查询不应被当成第二次派发', () => {
  it('spawn + check（同一子 Agent）只渲染 1 张任务卡、头部「派发了 1」', () => {
    const { container } = renderTimeline([
      spawnBlock(),
      resultBlock('call_spawn', '已在后台启动子 Agent「AI行业简报产品风险分析」。'),
      checkBlock('call_check'),
      resultBlock('call_check', '子 Agent「AI行业简报产品风险分析」当前状态：运行中（后台）。'),
    ])
    expect(rowCount(container)).toBe(1)
    expect(container.querySelectorAll('[data-testid="block-subagent-check"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="block-subagent-check"] [data-testid="shiny-text"]'))
      .toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-check"] .animate-spin')).toBeNull()
    const header = container.querySelector('[data-testid="subagent-dispatch-header"]')
    // 仅 1 张派发卡时不聚合（走 SubagentBlockEntry 单卡），header 可能不存在；
    // 若存在必须是「派发了 1」，绝不能是 2。
    if (header) expect(header.textContent).toContain('派发了 1 个子任务')
  })

  it('spawn + 连续多次 check → 恒 1 张卡', () => {
    const { container } = renderTimeline([
      spawnBlock(),
      resultBlock('call_spawn', '已在后台启动子 Agent。'),
      checkBlock('call_check_1'),
      resultBlock('call_check_1', '运行中。'),
      checkBlock('call_check_2'),
      resultBlock('call_check_2', '运行中。'),
      checkBlock('call_check_3'),
      resultBlock('call_check_3', '已完成。'),
    ])
    expect(rowCount(container)).toBe(1)
    expect(container.querySelectorAll('[data-testid="block-subagent-check"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="block-subagent-check-group"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="block-subagent-check-group"]')?.getAttribute('data-count'))
      .toBe('3')
    expect(container.querySelector('[data-testid="block-subagent-check-group"] .animate-spin')).toBeNull()
  })

  it('只查不派（无 spawn）→ 不出派发卡/聚合头', () => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: { 'sess-1': [] } })
    const { container } = renderTimeline([
      checkBlock('call_check'),
      resultBlock('call_check', '子 Agent 当前状态：运行中。'),
    ])
    expect(rowCount(container)).toBe(0)
    expect(container.querySelector('[data-testid="subagent-dispatch-header"]')).toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-aggregate"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="block-subagent-check"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="block-subagent-check"]')?.getAttribute('data-state'))
      .toBe('checked')
  })

  it('同一批查询两个不同子 Agent → 聚合成一条有数量和共同状态的摘要', () => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: { 'sess-1': [] } })
    const OTHER = 'sub-other'
    const { container } = renderTimeline([
      checkBlock('call_check_a', SUB_ID),
      checkResultBlock('call_check_a', SUB_ID, '后台子代理 A', 'running'),
      checkBlock('call_check_b', OTHER),
      checkResultBlock('call_check_b', OTHER, '后台子代理 B', 'running'),
    ])

    expect(container.querySelectorAll('[data-testid="block-subagent-check"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="block-subagent-check-group"]')).toHaveLength(1)
    const group = container.querySelector('[data-testid="block-subagent-check-group"]')
    expect(group?.getAttribute('data-count')).toBe('2')
    expect(group?.getAttribute('data-child-ids')).toContain(SUB_ID)
    expect(group?.getAttribute('data-child-ids')).toContain(OTHER)
    expect(group?.getAttribute('data-state')).toBe('running')
    expect(group?.textContent).toContain('已查看 2 个子 Agent 状态 · 查询时均在运行')
    expect(group?.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(group?.querySelector('[data-testid="shiny-text"]')).toBeNull()
    expect(group?.querySelector('.animate-spin')).toBeNull()
  })

  it('同一批查询状态不一致 → 保留单条聚合摘要并明确结果各异', () => {
    const OTHER = 'sub-other'
    const { container } = renderTimeline([
      checkBlock('call_check_a', SUB_ID),
      checkResultBlock('call_check_a', SUB_ID, '后台子代理 A', 'running'),
      checkBlock('call_check_b', OTHER),
      checkResultBlock('call_check_b', OTHER, '后台子代理 B', 'completed'),
    ])

    const group = container.querySelector('[data-testid="block-subagent-check-group"]')
    expect(group?.getAttribute('data-state')).toBe('mixed')
    expect(group?.textContent).toContain('已查看 2 个子 Agent 状态 · 查询结果各异')
  })

  it('跨 message 聚合重复查询时，already_checked 不进入查询摘要', () => {
    const B = 'sub-b'
    const C = 'sub-c'
    const { container } = renderTimeline([
      checkBlock('call_check_a1', SUB_ID),
      checkResultBlock('call_check_a1', SUB_ID, '后台子代理 A', 'running'),
      checkBlock('call_check_b1', B),
      checkResultBlock('call_check_b1', B, '后台子代理 B', 'completed'),
      checkBlock('call_check_c1', C),
      checkResultBlock('call_check_c1', C, '后台子代理 C', 'running'),
      checkBlock('call_check_a2', SUB_ID),
      checkResultBlock('call_check_a2', SUB_ID, '后台子代理 A', 'already_checked'),
      checkBlock('call_check_c2', C),
      checkResultBlock('call_check_c2', C, '后台子代理 C', 'already_checked'),
    ])

    const group = container.querySelector('[data-testid="block-subagent-check-group"]')
    expect(group?.getAttribute('data-count')).toBe('3')
    expect(group?.getAttribute('data-child-ids')).toBe(`${SUB_ID},${B},${C}`)
    expect(group?.textContent).toContain('已查看 3 个子 Agent 状态 · 查询结果各异')
    expect(group?.textContent).not.toContain('5 个子 Agent')
  })

  it('两个真实不同派发（不同子 Agent）→ 2 张卡（不误伤正常聚合）', () => {
    const OTHER = 'sub-other'
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        'sess-1': [
          completedRun(),
          { subagentRunId: OTHER, parentToolCallId: 'call_spawn2', status: 'completed', label: '另一个任务', task: '任务2' } as SubagentRun,
        ],
      },
    })
    const { container } = renderTimeline([
      spawnBlock('call_spawn'),
      resultBlock('call_spawn', '已启动子 Agent A。'),
      entry({ type: 'tool_use', id: 'call_spawn2', name: 'agent', input: { description: '另一个任务', prompt: '任务2' } }),
      resultBlock('call_spawn2', '已启动子 Agent B。', OTHER),
    ])
    expect(rowCount(container)).toBe(2)
    const header = container.querySelector('[data-testid="subagent-dispatch-header"]')
    expect(header?.textContent).toContain('派发了 2 个子任务')
  })
})

describe('后台等待协议 —— wait_agent_ids 不是子任务派发', () => {
  it('wait-only 显示等待步骤，不渲染派发卡或连接中骨架', () => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: { 'sess-1': [] } })
    const { container } = renderTimeline([
      waitBlock('call_wait', ['sub-a', 'sub-b']),
      resultBlock('call_wait', '已进入等待：2 个后台子 Agent 全部结束后会自动继续。', 'unused'),
    ])

    expect(rowCount(container)).toBe(0)
    expect(container.querySelector('[data-testid="subagent-dispatch-header"]')).toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-aggregate"]')).toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-wait"]')?.textContent)
      .toContain('等待子任务完成 · 0/2')
    expect(container.querySelector('[data-testid="block-subagent-wait"]')?.getAttribute('data-state'))
      .toBe('waiting')
    expect(container.querySelector('[data-testid="block-subagent-wait"] [data-testid="subagent-orchestration-icon"]'))
      .not.toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-wait"] [data-testid="shiny-text"]')?.textContent)
      .toContain('等待子任务完成 · 0/2')
    expect(container.querySelector('[data-testid="block-subagent-wait"] .animate-spin')).toBeNull()
    expect(container.textContent).not.toContain('连接中')
  })

  it('两个派发后调用 wait，派发数量仍为 2，wait 独立显示', () => {
    const OTHER = 'sub-other'
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        'sess-1': [
          completedRun(),
          {
            subagentRunId: OTHER,
            parentToolCallId: 'call_spawn2',
            status: 'completed',
            label: '任务 B',
            task: '任务 B',
          } as SubagentRun,
        ],
      },
    })
    const { container } = renderTimeline([
      spawnBlock('call_spawn'),
      resultBlock('call_spawn', '已启动子 Agent A。'),
      entry({
        type: 'tool_use',
        id: 'call_spawn2',
        name: 'agent',
        input: { description: '任务 B', prompt: '任务 B', background: true },
      }),
      resultBlock('call_spawn2', '已启动子 Agent B。', OTHER),
      waitBlock('call_wait', [SUB_ID, OTHER]),
      resultBlock('call_wait', '已进入等待。', 'unused'),
    ])

    expect(rowCount(container)).toBe(2)
    expect(container.querySelector('[data-testid="subagent-dispatch-header"]')?.textContent)
      .toContain('派发了 2 个子任务')
    expect(container.querySelectorAll('[data-testid="block-subagent-wait"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="block-subagent-wait"]')?.textContent)
      .toContain('2 个子任务已完成')
    expect(container.querySelector('[data-testid="block-subagent-wait"]')?.getAttribute('data-state'))
      .toBe('completed')
    expect(container.querySelector('[data-testid="block-subagent-wait"] [data-testid="subagent-orchestration-icon"]'))
      .not.toBeNull()
    expect(container.querySelector('[data-testid="block-subagent-wait"] [data-testid="shiny-text"]'))
      .toBeNull()
    expect(container.textContent).not.toContain('派发了 3 个子任务')
    expect(container.textContent).not.toContain('连接中')
  })
})
