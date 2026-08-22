/**
 * ：abort 终态须补发 persist_message(partial:true)，
 * 空 blocks（无正文/工具）时 no-op，避免破坏  撤回路径。
 */
import { describe, it, expect } from 'vitest'
import { createRuntime } from '../src/runtime-assembly.js'
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js'
import { type StreamEvent } from '../src/engine/contracts/wire-protocol.js'
import {
  type LLMRequest,
  type LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js'
import type { Tool } from '../src/engine/contracts/tools.js'
import type { ToolRiskPolicyPort } from '../src/engine/contracts/tool-risk-policy.js'
import { AgentError, type EngineConfig } from '../src/engine/contracts/kernel.js'
import { ContentBlockEvents, StreamEvents } from '../src/engine/contracts/stream-events.js'
import { extractTerminalOrphanToolUses } from '../src/engine/context/orphan-tool-results.js'

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

async function collectEventsUntilError(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  try {
    for await (const event of gen) events.push(event)
  } catch {
    // Runtime errors are rethrown after terminal events have been emitted.
  }
  return events
}

const allowToolRiskPolicy: ToolRiskPolicyPort = {
  resolveSnapshot: () => undefined,
  judge: () => ({ behavior: 'allow', reason: { type: 'test_allow' } }),
  buildMemoPatternKey: () => 'test',
  forWorkspaceRoot: () => allowToolRiskPolicy,
  forReadonlyChild: () => allowToolRiskPolicy,
}

describe('#5878 abort partial persist', () => {
  it('thinking 后正在生成的 text 被 abort → partial persist 保留全部可见内容', async () => {
    const abortController = new AbortController()
    const mockProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        yield { type: 'thinking', text: '先分析' }
        yield { type: 'text_delta', text: '正在回答' }
        abortController.abort()
        throw new AgentError('Run aborted by test', 'ABORT')
      },
    }

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: {
        sessionDir: '/tmp/test-abort-thinking-text-persist',
        threadId: 'sess-abort-thinking-text-persist',
      },
      model: 'test',
      abortSignal: abortController.signal,
    }

    const events = await collectEvents(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: 'test',
      initialMessages: [{ role: 'user', content: '上一轮问题' }],
    }))
    const terminalPersist = events
      .filter((event) => event.type === StreamEvents.PERSIST_MESSAGE)
      .find((event) => {
        const payload = event.payload as { partial?: boolean; stop_reason?: string }
        return payload.partial === true && payload.stop_reason === 'aborted'
      })
    expect(terminalPersist).toBeDefined()
    const blocks = (terminalPersist!.payload as {
      blocks_json?: Array<{ type?: string; text?: string; thinking?: string }>
    }).blocks_json ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual(expect.objectContaining({
      type: 'thinking',
      thinking: '先分析',
    }))
    expect(blocks[1]).toEqual(expect.objectContaining({
      type: 'text',
      text: '正在回答',
    }))
  })

  it('thinking 后正在生成的 text 遇到 runtime error → partial persist 保留全部可见内容', async () => {
    const mockProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        yield { type: 'thinking', text: '先分析' }
        yield { type: 'text_delta', text: '回答到一半' }
        throw new Error('provider stream failed')
      },
    }

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: {
        sessionDir: '/tmp/test-error-thinking-text-persist',
        threadId: 'sess-error-thinking-text-persist',
      },
      model: 'test',
    }

    const events = await collectEventsUntilError(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: 'test',
      initialMessages: [{ role: 'user', content: '上一轮问题' }],
    }))
    const terminalPersist = events
      .filter((event) => event.type === StreamEvents.PERSIST_MESSAGE)
      .find((event) => {
        const payload = event.payload as { partial?: boolean; stop_reason?: string }
        return payload.partial === true && payload.stop_reason === 'error'
      })
    expect(terminalPersist).toBeDefined()
    const blocks = (terminalPersist!.payload as {
      blocks_json?: Array<{ type?: string; text?: string; thinking?: string }>
    }).blocks_json ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual(expect.objectContaining({
      type: 'thinking',
      thinking: '先分析',
    }))
    expect(blocks[1]).toEqual(expect.objectContaining({
      type: 'text',
      text: '回答到一半',
    }))
  })

  it('有 inflight 正文时 abort → 发出 persist_message(partial:true)', async () => {
    const abortController = new AbortController()
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_abort_persist',
          })
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          })
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: '已经开始写了' },
          })
        }
        yield { type: 'text_delta', text: '已经开始写了' }
        await new Promise((r) => setTimeout(r, 5))
        abortController.abort()
        throw new AgentError('Run aborted by test', 'ABORT')
      },
    }

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-abort-persist', threadId: 'sess-abort-persist' },
      model: 'test',
      abortSignal: abortController.signal,
    }

    const events = await collectEvents(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: 'test',
      initialMessages: [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: [{ type: 'text', text: '上一轮回答' }] },
      ],
    }))
    const persists = events.filter((e) => e.type === StreamEvents.PERSIST_MESSAGE)
    expect(persists.length).toBeGreaterThanOrEqual(1)
    const payload = persists[persists.length - 1]!.payload as {
      partial?: boolean
      stop_reason?: string
      blocks_json?: Array<{ type?: string; text?: string }>
    }
    expect(payload.partial).toBe(true)
    expect(payload.stop_reason).toBe('aborted')
    const text = (payload.blocks_json ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    expect(text).toBe('已经开始写了')
  })

  it('无实质输出时 abort → 不发 persist（保护 ）', async () => {
    const abortController = new AbortController()
    const mockProvider = {
      async *createStream(_req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        await new Promise((r) => setTimeout(r, 5))
        abortController.abort()
        throw new AgentError('Run aborted by test', 'ABORT')
      },
    }

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-abort-persist-empty', threadId: 'sess-abort-empty' },
      model: 'test',
      abortSignal: abortController.signal,
    }

    const events = await collectEvents(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: 'test',
      initialMessages: [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: [{ type: 'text', text: '上一轮回答' }] },
      ],
    }))
    const persists = events.filter((e) => e.type === StreamEvents.PERSIST_MESSAGE)
    expect(persists).toHaveLength(0)
  })

  it('工具执行时 abort → 持久化当前轮完整 blocks 并闭环 tool_use', async () => {
    const abortController = new AbortController()
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        yield { type: 'text_delta', text: '本轮准备调用工具' }
        yield {
          type: 'tool_use',
          toolUse: { id: 'tool-current', name: 'aborter', input: {} },
        }
        yield { type: 'stop', stopReason: 'tool_use' }
      },
    }
    const aborter: Tool = {
      name: 'aborter',
      description: 'abort current run',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => {
        abortController.abort()
        return { content: 'unreachable' }
      },
    }
    const config: EngineConfig = {
      provider,
      tools: createMockToolProvider([aborter]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: {
        sessionDir: '/tmp/test-abort-tool-persist',
        threadId: 'sess-abort-tool-persist',
      },
      model: 'test',
      abortSignal: abortController.signal,
      toolRiskPolicy: allowToolRiskPolicy,
    }

    const events = await collectEvents(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: '调用工具',
      signal: abortController.signal,
      initialMessages: [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: [{ type: 'text', text: '上一轮回答' }] },
      ],
    }))
    const persists = events.filter((event) => event.type === StreamEvents.PERSIST_MESSAGE)
    const terminalPersist = persists.find((event) => {
      const payload = event.payload as { partial?: boolean; stop_reason?: string }
      return payload.partial === true && payload.stop_reason === 'aborted'
    })
    expect(terminalPersist).toBeDefined()
    const payload = terminalPersist!.payload as {
      partial?: boolean
      stop_reason?: string
      blocks_json?: Array<{
        type?: string
        text?: string
        id?: string
        tool_use_id?: string
        is_error?: boolean
      }>
    }
    const blocks = payload.blocks_json ?? []

    expect(payload.partial).toBe(true)
    expect(payload.stop_reason).toBe('aborted')
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '本轮准备调用工具',
    }))
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      id: 'tool-current',
    }))
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      tool_use_id: 'tool-current',
      is_error: true,
    }))
    expect(JSON.stringify(blocks)).not.toContain('上一轮回答')
  })
})

describe('#5878 terminal orphan tool_use merge', () => {
  const toolUse = {
    type: 'tool_use' as const,
    id: 'tool-completed',
    name: 'reader',
    input: {},
  }

  it('state 已有成功 tool_result 时不把 inflight tool_use 重新判为 orphan', () => {
    const messages = [
      { role: 'assistant' as const, content: [toolUse] },
      {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: 'success',
        }],
      },
    ]

    expect(extractTerminalOrphanToolUses(messages, [toolUse])).toEqual([])
  })

  it('tool_use 尚未进入 state 时保留 inflight orphan 供终态闭环', () => {
    expect(extractTerminalOrphanToolUses([], [toolUse])).toEqual([toolUse])
  })
})
