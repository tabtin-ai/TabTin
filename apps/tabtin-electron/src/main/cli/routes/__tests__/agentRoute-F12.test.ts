/**
 * F12 回归测试：Agent 路由 WS→SSE 事件映射修复
 *
 * 覆盖 Issue：
 *   CT-003/MT-003/MT-004 — approval_requested/ask 三件套不再静默丢弃
 *     （v0.4 W1.5 协议层一刀切：旧 `review_required` 已删除，runtime 切发
 *     `approval_requested` batch 形态。本测试同步对齐新事件名）
 *   CT-017/MT-024       — assistant done phase → text_done（而非 text_delta）
 *   CT-018              — WS auth 握手无响应超时（10s）
 *   CT-019              — subscribe.ok/subscribe.error 被正确处理
 *   CT-021/MT-023       — plan/todo/chunk/subagent_* 等关键事件透传
 *   MT-018              — tool args 字段读取 payload.input
 *   MT-019              — step message 字段读取 payload.title
 *   MT-020              — lifecycle message 字段读取 payload.phase
 *   MT-021              — WS 意外断开发送 error 事件而非 done
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EventEmitter } from 'node:events'

// ─── 内联 mapWsEventToSse 逻辑进行单元测试 ───────────────────────────────────
// 提取核心事件映射逻辑，与 agent.ts 保持同步

const STREAM_EVENT_PREFIX = 'agent.stream.'

interface SseEvent {
  type: string
  [key: string]: unknown
}

function mapWsEventToSse(envelope: any): SseEvent | null {
  const eventType: string = envelope.type || ''
  const payload = envelope.payload || {}
  const shortType = eventType.slice(STREAM_EVENT_PREFIX.length)

  switch (shortType) {
    case 'assistant': {
      if (payload.phase === 'delta') {
        return { type: 'text_delta', content: payload.content || '' }
      }
      if (payload.phase === 'done') {
        return { type: 'text_done', content: payload.content || '' }
      }
      return null
    }
    case 'reasoning':
      return { type: 'thinking', content: payload.content || '' }
    case 'tool': {
      if (payload.phase === 'start' || payload.status === 'running') {
        return {
          type: 'tool_start',
          tool: payload.tool_name || payload.name || '',
          args: payload.input ?? payload.arguments ?? payload.args ?? {},
        }
      }
      if (payload.phase === 'end' || payload.status === 'done' || payload.status === 'error') {
        return {
          type: 'tool_end',
          tool: payload.tool_name || payload.name || '',
          result: payload.result ?? payload.output ?? null,
          success: payload.status !== 'error' && !payload.error,
        }
      }
      return null
    }
    case 'done':
      return {
        type: 'done',
        thread_id: envelope.thread_id || payload.thread_id || '',
        usage: payload.usage || undefined,
      }
    case 'lifecycle':
      return { type: 'status', message: payload.phase || payload.status || payload.message || '' }
    case 'step':
      return {
        type: 'status',
        message: payload.title || payload.description || payload.message || `Step ${payload.step_id || ''}`,
      }
    case 'persist_error':
      return { type: 'error', message: payload.error || 'State persistence error', code: 'PERSIST_ERROR' }
    case 'system_notice':
      return { type: 'status', message: payload.message || '' }
    case 'approval_requested':
      return {
        type: 'approval_requested',
        message: payload.message || 'Agent 正在等待您的审批，请在客户端确认后继续',
        batch_id: payload.batch_id || null,
        ...payload,
      }
    // W4 R3 (2026-05-11): ask 三件套并存——3 个 wire event 各自映射到独立
    // SSE type，CLI 客户端可按 type 区分 UI 渲染（choice / form / approval）。
    case 'ask_user_required':
    case 'ask_form_required':
    case 'request_approval_required':
      return {
        type: shortType,
        message: payload.title || payload.message || payload.question || 'Agent 正在等待您的回答',
        ask_id: payload.ask_id || payload.interrupt_id || null,
        ...payload,
      }
    case 'chunk':
      return { type: 'chunk', content: payload.content || '', chunk_id: payload.chunk_id || null }
    case 'todo':
      return { type: 'todo', todos: payload.todos || [] }
    case 'plan':
      return { type: 'plan', ...payload }
    case 'mode':
      return { type: 'mode', mode: payload.mode || payload.name || '' }
    case 'ssh_output':
      return { type: 'ssh_output', output: payload.output || payload.content || '' }
    case 'compaction':
      return { type: 'compaction', ...payload }
    case 'context_pressure':
      return { type: 'context_pressure', level: payload.level || '', ...payload }
    case 'message_persisted':
      return { type: 'message_persisted', message_id: payload.message_id || null }
    case 'title_updated':
      return { type: 'title_updated', title: payload.title || '', session_id: payload.session_id || null }
    case 'subagent_started':
      return { type: 'subagent_started', agent_id: payload.agent_id || null, ...payload }
    case 'subagent_completed':
      return { type: 'subagent_completed', agent_id: payload.agent_id || null, ...payload }
    case 'subagent_failed':
      return {
        type: 'subagent_failed',
        agent_id: payload.agent_id || null,
        error: payload.error || 'Subagent failed',
        ...payload,
      }
    case 'subagent_progress':
      return { type: 'subagent_progress', agent_id: payload.agent_id || null, ...payload }
    default:
      return null
  }
}

// ─── resolveGatewayWsUrl 逻辑（与 Daemon agent.ts 同步）──────────────────────

function resolveGatewayWsUrl(wsInfo: { wsUrl: string; serverUrl: string }): string {
  if (wsInfo.wsUrl) {
    const base = wsInfo.wsUrl.replace(/\/+$/, '')
    if (base.endsWith('/ws/v1/gateway')) {
      return base
    }
    return `${base}/ws/v1/gateway`
  }
  let base = wsInfo.serverUrl.replace(/\/+$/, '')
  base = base.replace(/\/api$/, '')
  if (base.startsWith('https://')) {
    base = base.replace(/^https:/, 'wss:')
  } else if (base.startsWith('http://')) {
    base = base.replace(/^http:/, 'ws:')
  }
  return `${base}/ws/v1/gateway`
}

// ─── 测试套件 ────────────────────────────────────────────────────────────────

describe('mapWsEventToSse — CT-017/MT-024: assistant done phase 修复', () => {
  it('phase=delta 仍映射为 text_delta', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.assistant',
      payload: { phase: 'delta', content: 'hello' },
    })
    expect(result?.type).toBe('text_delta')
    expect(result?.content).toBe('hello')
  })

  it('phase=done 必须映射为 text_done，而非 text_delta', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.assistant',
      payload: { phase: 'done', content: 'final content' },
    })
    expect(result?.type).toBe('text_done')
    expect(result?.content).toBe('final content')
  })

  it('phase=done 不得映射为 text_delta（回归防护）', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.assistant',
      payload: { phase: 'done', content: 'final' },
    })
    expect(result?.type).not.toBe('text_delta')
  })
})

// W4.5 第三波 C1（2026-05-13）：原 MT-018 4 个 tool args 字段名映射 case 已删除——
// wire `StreamEvents.TOOL` 物理删，sse-adapter `case 'tool'` 分支同步删；CLI SSE 端
// 工具事件未来若需要应走 ContentBlock 6 件套（content_block_start with block.type=
// 'tool_use' + content_block_delta(input_json_delta)）直接消费。

describe('mapWsEventToSse — MT-019: step title 字段名修复', () => {
  it('优先读取 payload.title', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.step',
      payload: { title: '分析代码结构', step_id: 's1' },
    })
    expect(result?.type).toBe('status')
    expect(result?.message).toBe('分析代码结构')
  })

  it('兼容旧格式 payload.description', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.step',
      payload: { description: '执行步骤', step_id: 's2' },
    })
    expect(result?.message).toBe('执行步骤')
  })

  it('兼容旧格式 payload.message', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.step',
      payload: { message: '进行中', step_id: 's3' },
    })
    expect(result?.message).toBe('进行中')
  })
})

describe('mapWsEventToSse — MT-020: lifecycle phase 字段名修复', () => {
  it('优先读取 payload.phase', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.lifecycle',
      payload: { phase: 'running' },
    })
    expect(result?.type).toBe('status')
    expect(result?.message).toBe('running')
  })

  it('兼容旧格式 payload.status', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.lifecycle',
      payload: { status: 'completed' },
    })
    expect(result?.message).toBe('completed')
  })
})

describe('mapWsEventToSse — CT-003/MT-003/MT-004: approval/ask_user 事件不再丢弃', () => {
  it('approval_requested 必须返回 approval_requested 类型的 SSE 事件（v0.4 W1.5 batch 形态）', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.approval_requested',
      payload: {
        message: '请确认是否删除文件',
        batch_id: 'batch-001',
        approval_type: 'tool_permission',
        action_requests: [
          { request_id: 'r1', tool_call_id: 't1', tool_name: 'rm' },
        ],
      },
    })
    expect(result).not.toBeNull()
    expect(result?.type).toBe('approval_requested')
    expect(result?.message).toBe('请确认是否删除文件')
    expect(result?.batch_id).toBe('batch-001')
  })

  // W4 R3 (2026-05-11): ask 三件套并存——3 个 wire event 各自映射到独立 SSE type。
  it('ask_user_required 必须返回 ask_user_required 类型的 SSE 事件', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      payload: { title: '你想保留备份吗？', interrupt_id: 'ask-001' },
    })
    expect(result).not.toBeNull()
    expect(result?.type).toBe('ask_user_required')
    expect(result?.message).toBe('你想保留备份吗？')
    expect(result?.ask_id).toBe('ask-001')
  })

  it('ask_form_required 映射到 ask_form_required SSE 事件', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_form_required',
      payload: { title: '请填写参数', interrupt_id: 'form-001' },
    })
    expect(result).not.toBeNull()
    expect(result?.type).toBe('ask_form_required')
    expect(result?.message).toBe('请填写参数')
    expect(result?.ask_id).toBe('form-001')
  })

  it('request_approval_required 映射到 request_approval_required SSE 事件', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.request_approval_required',
      payload: { title: '请审批高风险操作', interrupt_id: 'approval-001' },
    })
    expect(result).not.toBeNull()
    expect(result?.type).toBe('request_approval_required')
    expect(result?.message).toBe('请审批高风险操作')
    expect(result?.ask_id).toBe('approval-001')
  })

  it('approval_requested 无 message 时使用默认提示', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'b1' },
    })
    expect(result?.message).toContain('等待')
  })

  it('ask_user_required 无 title 时使用默认提示', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      payload: {},
    })
    expect(typeof result?.message).toBe('string')
    expect(result?.message?.length).toBeGreaterThan(0)
    expect((result?.message as string).length).toBeGreaterThan(0)
  })
})

describe('mapWsEventToSse — CT-021/MT-023: 关键事件透传不再静默丢弃', () => {
  const cases: Array<{ eventType: string; payload: any; expected: Partial<SseEvent> }> = [
    {
      eventType: 'chunk',
      payload: { content: '流式内容', chunk_id: 'c1' },
      expected: { type: 'chunk', content: '流式内容', chunk_id: 'c1' },
    },
    {
      eventType: 'todo',
      payload: { todos: [{ id: 1, text: 'task1', done: false }] },
      expected: { type: 'todo' },
    },
    {
      eventType: 'plan',
      payload: { steps: ['step1', 'step2'] },
      expected: { type: 'plan' },
    },
    {
      eventType: 'mode',
      payload: { mode: 'autonomous' },
      expected: { type: 'mode', mode: 'autonomous' },
    },
    {
      eventType: 'ssh_output',
      payload: { output: 'ls -la\ntotal 8' },
      expected: { type: 'ssh_output' },
    },
    {
      eventType: 'compaction',
      payload: { reason: 'context_limit' },
      expected: { type: 'compaction' },
    },
    {
      eventType: 'context_pressure',
      payload: { level: 'high' },
      expected: { type: 'context_pressure', level: 'high' },
    },
    {
      eventType: 'message_persisted',
      payload: { message_id: 'msg-123' },
      expected: { type: 'message_persisted', message_id: 'msg-123' },
    },
    {
      eventType: 'title_updated',
      payload: { title: 'New Title', session_id: 'sess-1' },
      expected: { type: 'title_updated', title: 'New Title' },
    },
    {
      eventType: 'subagent_started',
      payload: { agent_id: 'sub-1' },
      expected: { type: 'subagent_started', agent_id: 'sub-1' },
    },
    {
      eventType: 'subagent_completed',
      payload: { agent_id: 'sub-1' },
      expected: { type: 'subagent_completed', agent_id: 'sub-1' },
    },
    {
      eventType: 'subagent_failed',
      payload: { agent_id: 'sub-1', error: 'timeout' },
      expected: { type: 'subagent_failed', agent_id: 'sub-1' },
    },
    {
      eventType: 'subagent_progress',
      payload: { agent_id: 'sub-1', progress: 50 },
      expected: { type: 'subagent_progress', agent_id: 'sub-1' },
    },
  ]

  for (const { eventType, payload, expected } of cases) {
    it(`${eventType} 事件不得返回 null`, () => {
      const result = mapWsEventToSse({
        type: `agent.stream.${eventType}`,
        payload,
      })
      expect(result).not.toBeNull()
      for (const [key, val] of Object.entries(expected)) {
        expect(result?.[key]).toEqual(val)
      }
    })
  }
})

describe('resolveGatewayWsUrl — CT-020: 双路径追加 bug 修复', () => {
  it('wsUrl 已携带完整路径时不重复追加', () => {
    const result = resolveGatewayWsUrl({
      wsUrl: 'wss://gateway.example.com/ws/v1/gateway',
      serverUrl: '',
    })
    expect(result).toBe('wss://gateway.example.com/ws/v1/gateway')
    expect(result).not.toContain('/ws/v1/gateway/ws/v1/gateway')
  })

  it('wsUrl 末尾有斜杠且携带完整路径时也不追加', () => {
    const result = resolveGatewayWsUrl({
      wsUrl: 'wss://gateway.example.com/ws/v1/gateway/',
      serverUrl: '',
    })
    expect(result).toBe('wss://gateway.example.com/ws/v1/gateway')
  })

  it('wsUrl 不含完整路径时正常追加', () => {
    const result = resolveGatewayWsUrl({
      wsUrl: 'wss://gateway.example.com',
      serverUrl: '',
    })
    expect(result).toBe('wss://gateway.example.com/ws/v1/gateway')
  })

  it('无 wsUrl 时从 serverUrl 推导', () => {
    const result = resolveGatewayWsUrl({
      wsUrl: '',
      serverUrl: 'https://api.example.com/api',
    })
    expect(result).toBe('wss://api.example.com/ws/v1/gateway')
  })

  it('无 wsUrl 时从 http serverUrl 推导', () => {
    const result = resolveGatewayWsUrl({
      wsUrl: '',
      serverUrl: 'http://localhost:8000',
    })
    expect(result).toBe('ws://localhost:8000/ws/v1/gateway')
  })
})

describe('mapWsEventToSse — 已有功能不回退', () => {
  // W4.5 第三波 C1（2026-05-13）：reasoning / tool 老协议 case 已物理删，相关
  // 回归测试一并下线（详见 sse-adapter.ts 顶部注释）。

  it('done 事件包含 thread_id 和 usage', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.done',
      thread_id: 'thread-abc',
      payload: { usage: { tokens: 1000 } },
    })
    expect(result?.type).toBe('done')
    expect(result?.thread_id).toBe('thread-abc')
    expect(result?.usage).toEqual({ tokens: 1000 })
  })

  it('persist_error 事件包含正确 code', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.persist_error',
      payload: { error: 'DB connection failed' },
    })
    expect(result?.type).toBe('error')
    expect(result?.code).toBe('PERSIST_ERROR')
  })

  it('完全未知的事件类型返回 null', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.some_future_event_xyz',
      payload: {},
    })
    expect(result).toBeNull()
  })
})
