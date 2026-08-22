/**
 * useChatRuntimeStore.reconcileSubagentRunsFromArchive — 子 Agent run 索引从
 * chat_message 派生的归档恢复回归。
 *
 * 改造后链路（统一 chat_message SSoT，废弃本地 jsonl）：父消息的 subagent
 * `tool_use`(input.role/prompt/description) + 配对 `tool_result`(文本含
 * `[子 Agent ID: <id>]`、is_error) → deriveSubagentRunsFromMessages → 本 reconcile
 * 灌进 SubagentRun → 对话内派发标记 / SubagentDetailPane header 读 run.role。
 *
 * 守的不变量：
 *   ① 已有实时 run 但缺 role：派生回填 role；
 *   ② 已有实时 run 且 role 有值：派生**不覆盖**实时角色；
 *   ③ 派生终态（completed）覆盖内存 stale 非终态（running）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useChatRuntimeStore } from './useChatRuntimeStore'
import { useChatStore } from './chat/useChatStore'

const SESSION = 'sess-role-reconcile'
const CHILD = 'child-role-1'

function roleOf(): string | undefined {
  return useChatRuntimeStore
    .getState()
    .subagentRunsBySessionId[SESSION]?.find(r => r.subagentRunId === CHILD)?.role
}

function statusOf(): string | undefined {
  return useChatRuntimeStore
    .getState()
    .subagentRunsBySessionId[SESSION]?.find(r => r.subagentRunId === CHILD)?.status
}

/** 在父 session 落一条 assistant 消息：含 subagent tool_use + 配对 tool_result。 */
function setParentMessage(
  role: string | undefined,
  isError = false,
  presentationStatus: 'completed' | 'failed' | 'cancelled' | 'running' | null = 'completed',
  background = false,
): void {
  const blocks = [
    {
      type: 'tool_use',
      id: 'agent:1',
      name: 'agent',
      input: {
        prompt: '撰写内行星科普文章',
        description: '子1',
        ...(role ? { role } : {}),
        ...(background ? { background: true } : {}),
      },
    },
    {
      type: 'tool_result',
      tool_use_id: 'agent:1',
      content: `报数完毕\n\n[子 Agent ID: ${CHILD}]`,
      is_error: isError,
      ...(presentationStatus !== null
        ? {
            presentation: {
              kind: presentationStatus === 'running' ? 'subagent_dispatch' : 'subagent_result',
              data: { subagent_run_id: CHILD, status: presentationStatus, background },
            },
          }
        : {}),
    },
  ]
  useChatStore.setState({
    messagesBySessionId: {
      [SESSION]: [
        {
          id: 'parent-1',
          role: 'assistant',
          content: '',
          created_at: '2026-06-28T00:00:00.000Z',
          content_blocks_json: blocks,
          blocks: blocks.map((block, index) => ({
            index,
            block_id: `block-${index}`,
            block,
            finalized: true,
            partial: false,
          })),
        },
      ] as never,
    },
  })
}

describe('reconcileSubagentRunsFromArchive — 从 chat_message 派生 role/status', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
    useChatStore.setState({ messagesBySessionId: {} })
  })

  afterEach(() => {
    useChatStore.setState({ messagesBySessionId: {} })
  })

  it('已有 run 缺 role：派生回填', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
    })
    setParentMessage('数据整理员')
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    expect(roleOf()).toBe('数据整理员')
  })

  it('已有 run 且 role 有值：派生不覆盖实时角色', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
      role: '实时角色',
    })
    setParentMessage('块里旧角色')
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    expect(roleOf()).toBe('实时角色')
  })

  it('④ input 无 role → 不写 role（消费方回落），不抛', async () => {
    setParentMessage(undefined)
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    expect(roleOf()).toBeUndefined()
  })

  it('⑤ 真终态 presentation（completed）覆盖内存 stale running —— 背景子 Agent 完成事件没到前端时不卡「运行中」', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
    })
    setParentMessage('科普撰稿人') // 有 tool_result → 派生为 completed
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    expect(statusOf()).toBe('completed')
  })

  it('⑥ 后台派发回执不得覆盖 live running', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
      stepCount: 3,
    })
    setParentMessage('科普撰稿人', false, 'running', true)
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    const run = useChatRuntimeStore
      .getState()
      .subagentRunsBySessionId[SESSION]?.find(item => item.subagentRunId === CHILD)
    expect(run?.status).toBe('running')
    expect(run?.stepCount).toBe(3)
  })

  it('⑥-b 旧后台回执无 presentation 不得覆盖 live running', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
      stepCount: 5,
    })
    setParentMessage('科普撰稿人', false, null, true)
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    const run = useChatRuntimeStore
      .getState()
      .subagentRunsBySessionId[SESSION]?.find(item => item.subagentRunId === CHILD)
    expect(run?.status).toBe('running')
    expect(run?.stepCount).toBe(5)
  })

  it('⑦ upsert 入口不允许不同状态覆盖已终态 run', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'completed',
      summary: '已完成',
    })
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
      latestTool: 'run_terminal_command',
    })
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'failed',
      error: 'late failure',
    })

    const run = useChatRuntimeStore
      .getState()
      .subagentRunsBySessionId[SESSION]?.find(item => item.subagentRunId === CHILD)
    expect(run).toMatchObject({
      status: 'completed',
      summary: '已完成',
    })
    expect(run?.latestTool).toBeUndefined()
    expect(run?.error).toBeUndefined()
  })

  it('#11158 jsonl 终态覆盖 dispatch 卡住的 pending，即使父消息只有派发回执', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'pending',
      background: true,
    })
    setParentMessage('科普撰稿人', false, 'running', true)
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: {
          listSubagentRuns: async () => ({
            ok: true,
            runs: [{
              subagentRunId: CHILD,
              parentToolCallId: 'agent:1',
              status: 'completed',
              endedAt: 1,
            }],
          }),
        },
      },
    })
    await useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(SESSION)
    expect(statusOf()).toBe('completed')
  })
})
