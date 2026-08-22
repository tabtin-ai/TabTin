/**
 * ：Host 注入 hostRunId 后，envelope run_id / ToolContext.agentRunId /
 * file-history beginSnapshot 锚点必须同源；缺失时硬失败，禁止自造 UUID。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/runtime-assembly.js'
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js'
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js'
import type { LLMResponseChunk } from '../src/engine/contracts/model-llm.js'
import { AgentError, type EngineConfig, type QueryParams } from '../src/engine/contracts/kernel.js'
import type { FileHistorySink } from '../src/engine/contracts/tools.js'
import { ContentBlockEvents, StreamEvents } from '../src/engine/contracts/stream-events.js'

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function makeConfig(fileHistory?: FileHistorySink): EngineConfig {
  return {
    provider: {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'stop', stopReason: 'end_turn' }
      },
    },
    tools: createMockToolProvider([]),
    permissionHandler: createMockPermissionHandler('allow'),
    sessionConfig: {
      sessionDir: '/tmp/test-host-run-id-9040',
      threadId: 'sess-host-run-id-9040',
    },
    model: 'test',
    fileHistory,
  }
}

describe('#9040 hostRunId aligns file-history anchor with outbound run_id', () => {
  it('beginSnapshot / message_start.run_id / lifecycle run_id 使用同一 hostRunId', async () => {
    const hostRunId = 'business-run-fixed-9040'
    const beginSnapshot = vi.fn(async (_anchorId: string) => {})
    const fileHistory: FileHistorySink = {
      beginSnapshot,
      trackEdit: vi.fn(async () => {}),
    }

    const events = await collectEvents(
      createRuntime(makeConfig(fileHistory)).query({
        prompt: 'test',
        hostRunId,
      }),
    )

    expect(beginSnapshot).toHaveBeenCalledWith(hostRunId)

    const messageStart = events.find(
      (e) => e.type === ContentBlockEvents.MESSAGE_START,
    )
    expect(messageStart?.payload).toMatchObject({ run_id: hostRunId })

    const lifecycleStart = events.find(
      (e) =>
        e.type === StreamEvents.LIFECYCLE &&
        (e.payload as { phase?: string }).phase === 'start',
    )
    expect(lifecycleStart?.payload).toMatchObject({ run_id: hostRunId })
  })

  it('hostRunId 为空串时构造期抛错，禁止自造 UUID', async () => {
    const beginSnapshot = vi.fn(async (_anchorId: string) => {})
    const rt = createRuntime(makeConfig({
      beginSnapshot,
      trackEdit: vi.fn(async () => {}),
    }))

    await expect(async () => {
      await collectEvents(rt.query({ prompt: 'test', hostRunId: '   ' }))
    }).rejects.toSatisfy((err: unknown) => (
      err instanceof AgentError
      && err.code === 'INTERNAL'
      && /hostRunId is required/.test(err.message)
    ))
    expect(beginSnapshot).not.toHaveBeenCalled()
  })

  it('缺失 hostRunId 字段时构造期抛错', async () => {
    const beginSnapshot = vi.fn(async (_anchorId: string) => {})
    const rt = createRuntime(makeConfig({
      beginSnapshot,
      trackEdit: vi.fn(async () => {}),
    }))
    const params = { prompt: 'test' } as QueryParams

    await expect(async () => {
      await collectEvents(rt.query(params))
    }).rejects.toSatisfy((err: unknown) => (
      err instanceof AgentError
      && err.code === 'INTERNAL'
      && /hostRunId is required/.test(err.message)
    ))
    expect(beginSnapshot).not.toHaveBeenCalled()
  })
})
