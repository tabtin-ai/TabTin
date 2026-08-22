import { ContentBlockEvents } from '@tabtin/agent-wire'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_REALTIME_EVENT_TYPES,
  AgentRealtime,
  conversationThreadForSession,
  conversationTopicForSession,
  deviceTopicForDevice,
  type AgentCommand,
  type AgentStreamEnvelope,
  type AgentStreamTarget,
  type AgentTransportEnvelope,
  type AgentTransportPort,
  type AgentTransportReadyInfo,
} from '../src/realtime/agent-realtime.js'

const EXPECTED_COMMAND_TYPES = [
  'agent.prompt.forward',
  'agent.prompt.cancel',
  'agent.subagent.cancel',
  'localrt.user_response',
  'agent.action.approval_response',
  'agent.action.approval_memo_updated',
  'agent.permission.response',
  'agent.permission.reset_session',
  'agent.permission.mode_update',
  'agent.action.request',
] as const

class FakeTransport implements AgentTransportPort {
  readonly subscribe = vi.fn(async (
    _topics: string[],
    _options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ) => ({ ok: true }))
  readonly unsubscribe = vi.fn(async (_topics: string[]) => ({ ok: true }))
  private envelopeHandlers = new Set<(envelope: AgentTransportEnvelope) => void>()
  private readyHandlers = new Set<(info: AgentTransportReadyInfo) => void>()

  onEnvelope(handler: (envelope: AgentTransportEnvelope) => void): () => void {
    this.envelopeHandlers.add(handler)
    return () => this.envelopeHandlers.delete(handler)
  }

  onReady(handler: (info: AgentTransportReadyInfo) => void): () => void {
    this.readyHandlers.add(handler)
    return () => this.readyHandlers.delete(handler)
  }

  emit(envelope: AgentTransportEnvelope): void {
    for (const handler of this.envelopeHandlers) handler(envelope)
  }

  ready(info: AgentTransportReadyInfo = { reconnected: true }): void {
    for (const handler of this.readyHandlers) handler(info)
  }

  get envelopeHandlerCount(): number {
    return this.envelopeHandlers.size
  }

  get readyHandlerCount(): number {
    return this.readyHandlers.size
  }
}

function createTarget(id: number): AgentStreamTarget & {
  envelopes: AgentStreamEnvelope[]
  destroyed: boolean
} {
  const target = {
    id,
    envelopes: [] as AgentStreamEnvelope[],
    destroyed: false,
    send(envelope: AgentStreamEnvelope) {
      target.envelopes.push(envelope)
    },
    isDestroyed() {
      return target.destroyed
    },
  }
  return target
}

function streamEnvelope(
  sessionId: string,
  payload: Record<string, unknown>,
  mapping: Partial<AgentTransportEnvelope> = {},
): AgentTransportEnvelope {
  return {
    type: ContentBlockEvents.MESSAGE_DELTA,
    payload,
    _topic: conversationTopicForSession(sessionId),
    ...mapping,
  }
}

describe('AgentRealtime conversation routing', () => {
  it('首个 watcher 订阅、同 session 多 watcher 广播且只订阅一次', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const first = createTarget(1)
    const second = createTarget(2)

    realtime.watch('session-a', first)
    realtime.watch('session-a', second)
    const delivered = realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { text: 'hello' } },
    })

    expect(transport.subscribe).toHaveBeenCalledTimes(1)
    expect(transport.subscribe).toHaveBeenCalledWith([
      conversationTopicForSession('session-a'),
    ])
    expect(delivered).toBe(2)
    expect(first.envelopes).toEqual(second.envelopes)
  })

  it('共享入口订阅携带当前 shareId 的 topic context', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    const topic = conversationTopicForSession('session-shared')

    realtime.watch('session-shared', target, { shareId: 'share-1' })

    expect(transport.subscribe).toHaveBeenCalledWith(
      [topic],
      { topicContexts: { [topic]: { share_id: 'share-1' } } },
    )
  })

  it('renderer IPC watcher 可只登记 target，不订阅传输层会话流', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)

    realtime.watch('session-a', target, { observeTransport: false })
    const delivered = realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { text: 'local' } },
    })

    expect(transport.subscribe).not.toHaveBeenCalled()
    expect(delivered).toBe(1)
    expect(target.envelopes).toHaveLength(1)
  })

  it('主进程执行路径显式 observe 后才订阅传输层会话流', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    const topic = conversationTopicForSession('session-a')

    realtime.watch('session-a', target, { observeTransport: false })
    realtime.observe('session-a')

    expect(transport.subscribe).toHaveBeenCalledTimes(1)
    expect(transport.subscribe).toHaveBeenCalledWith([topic])
  })

  it('按 topic、thread 和 session 映射 stream envelope', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    transport.emit(streamEnvelope('session-a', { event_id: 'topic' }))
    transport.emit(streamEnvelope('ignored-topic', { event_id: 'thread' }, {
      _topic: 'unmatched',
      thread_id: conversationThreadForSession('session-a'),
    }))
    transport.emit(streamEnvelope('ignored-topic', { event_id: 'session' }, {
      _topic: 'unmatched',
      thread_id: undefined,
      session_id: 'session-a',
    }))

    expect(target.envelopes).toHaveLength(3)
    expect(target.envelopes.map((entry) => (
      'event' in entry ? entry.event.payload.event_id : undefined
    ))).toEqual(['topic', 'thread', 'session'])
  })

  it('publish 和 transport 跨源按 event_id、arrival_seq 去重', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { event_id: 'same-event' } },
    })
    transport.emit(streamEnvelope('session-a', { event_id: 'same-event', _seq: 1 }))
    realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { arrival_seq: 9 } },
    })
    transport.emit(streamEnvelope('session-a', { arrival_seq: 9, _seq: 2 }))

    expect(target.envelopes).toHaveLength(2)
  })

  it('无人观察时 publish 不污染后续 transport 去重', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })

    realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { event_id: 'same-event' } },
    })
    const target = createTarget(1)
    realtime.watch('session-a', target)
    transport.emit(streamEnvelope('session-a', { event_id: 'same-event', _seq: 1 }))

    expect(target.envelopes).toHaveLength(1)
  })

  it('_seq 在去重前推进，真实跳号发送 seq-gap', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    for (const [eventId, seq] of [['one', 1], ['two', 2]] as const) {
      realtime.publish('session-a', {
        event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { event_id: eventId } },
      })
      transport.emit(streamEnvelope('session-a', { event_id: eventId, _seq: seq }))
    }
    transport.emit(streamEnvelope('session-a', { event_id: 'four', _seq: 4 }))

    expect(target.envelopes).toHaveLength(4)
    expect(target.envelopes[2]).toEqual({
      sessionId: 'session-a',
      control: 'seq-gap',
    })
    expect(target.envelopes[3]).toMatchObject({
      sessionId: 'session-a',
      event: { payload: { event_id: 'four', _seq: 4 } },
    })
  })

  it('首见 seq 大于 1 发送 seq-gap', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    transport.emit(streamEnvelope('session-a', { event_id: 'late', _seq: 5 }))

    expect(target.envelopes[0]).toEqual({
      sessionId: 'session-a',
      control: 'seq-gap',
    })
  })

  it('coalesced_count 覆盖的连续 seq 不误报 gap，正文保持顺序且去重', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    transport.emit(streamEnvelope('session-a', {
      event_id: 'two',
      _seq: 2,
      coalesced_count: 2,
      delta: { type: 'text_delta', text: 'AB' },
    }))
    transport.emit(streamEnvelope('session-a', {
      event_id: 'five',
      _seq: 5,
      coalesced_count: 3,
      delta: { type: 'text_delta', text: 'CDE' },
    }))
    transport.emit(streamEnvelope('session-a', {
      event_id: 'five',
      _seq: 5,
      coalesced_count: 3,
      delta: { type: 'text_delta', text: 'CDE' },
    }))

    expect(target.envelopes).toHaveLength(2)
    expect(target.envelopes.map(envelope => (
      'event' in envelope
        ? (envelope.event.payload.delta as { text?: string } | undefined)?.text
        : undefined
    ))).toEqual(['AB', 'CDE'])
    expect(target.envelopes).not.toContainEqual({
      sessionId: 'session-a',
      control: 'seq-gap',
    })
  })

  it('最后一个 watcher 离开才退订 conversation topic', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    realtime.watch('session-a', createTarget(1))
    realtime.watch('session-a', createTarget(2))

    realtime.unwatch('session-a', 1)
    expect(transport.unsubscribe).not.toHaveBeenCalled()
    realtime.unwatch('session-a', 2)

    expect(transport.unsubscribe).toHaveBeenCalledTimes(1)
    expect(transport.unsubscribe).toHaveBeenCalledWith([
      conversationTopicForSession('session-a'),
    ])
  })

  it('销毁 target 时自动退订其最后一个 session', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)
    target.destroyed = true

    transport.emit(streamEnvelope('session-a', { event_id: 'event' }))

    expect(target.envelopes).toHaveLength(0)
    expect(transport.unsubscribe).toHaveBeenCalledWith([
      conversationTopicForSession('session-a'),
    ])
  })

  it('非 stream envelope 不进入 stream target', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    transport.emit({
      type: 'chat.message.created',
      payload: { event_id: 'not-stream' },
      _topic: conversationTopicForSession('session-a'),
    })

    expect(target.envelopes).toHaveLength(0)
  })
})

describe('AgentRealtime device commands', () => {
  it('把全部已知 device 指令归一为 discriminated union', () => {
    const transport = new FakeTransport()
    const commands: AgentCommand[] = []
    new AgentRealtime({
      transport,
      deviceId: 'device-a',
      onCommand: (command) => commands.push(command),
    })

    for (const type of EXPECTED_COMMAND_TYPES) {
      transport.emit({
        type,
        payload: { marker: type },
        _topic: deviceTopicForDevice('device-a'),
      })
    }

    expect(transport.subscribe).toHaveBeenCalledWith([
      deviceTopicForDevice('device-a'),
    ])
    expect(commands.map((command) => command.type)).toEqual(
      EXPECTED_COMMAND_TYPES,
    )
    expect(commands.every((command) => command.payload.marker === command.type)).toBe(true)
  })

  it('未知事件忽略，非法 payload 归一为空对象', () => {
    const transport = new FakeTransport()
    const onCommand = vi.fn()
    new AgentRealtime({ transport, onCommand })

    transport.emit({ type: 'agent.unknown', payload: { ignored: true } })
    transport.emit({
      type: AGENT_REALTIME_EVENT_TYPES.PROMPT_CANCEL,
      payload: null,
    })

    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand.mock.calls[0][0]).toMatchObject({
      type: AGENT_REALTIME_EVENT_TYPES.PROMPT_CANCEL,
      payload: {},
    })
  })

  it('ready 只通知上层，不重复 subscribe desiredTopics', () => {
    const transport = new FakeTransport()
    const onReady = vi.fn()
    const realtime = new AgentRealtime({
      transport,
      deviceId: 'device-a',
      onReady,
    })
    realtime.watch('session-a', createTarget(1))
    expect(transport.subscribe).toHaveBeenCalledTimes(2)

    transport.ready({ reconnected: true })

    expect(onReady).toHaveBeenCalledWith({ reconnected: true })
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
  })
})

describe('AgentRealtime client broadcast exclude ', () => {
  it('audit_cap / persist_message / llm_snapshot / llm_usage 不投递给 watcher；普通事件仍投递', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    const excludedDelivered = [
      realtime.publish('session-a', {
        event: { type: 'agent.stream.audit_cap', payload: { phase: 'iteration_end' } },
      }),
      realtime.publish('session-a', {
        event: { type: 'agent.stream.persist_message', payload: { message_id: 'm1' } },
      }),
      realtime.publish('session-a', {
        event: { type: 'agent.stream.llm_snapshot', payload: { run_id: 'r1' } },
      }),
      realtime.publish('session-a', {
        event: { type: 'agent.stream.llm_usage', payload: { run_id: 'r1', iteration: 0 } },
      }),
    ]
    const kept = realtime.publish('session-a', {
      event: { type: ContentBlockEvents.MESSAGE_DELTA, payload: { text: 'ok' } },
    })
    const terminal = realtime.publish('session-a', {
      terminal: { reason: 'completed' },
    })

    expect(excludedDelivered).toEqual([0, 0, 0, 0])
    expect(kept).toBe(1)
    expect(terminal).toBe(1)
    expect(target.envelopes).toHaveLength(2)
    expect(target.envelopes[0]).toMatchObject({
      event: { type: ContentBlockEvents.MESSAGE_DELTA },
    })
    expect(target.envelopes[1]).toMatchObject({ terminal: { reason: 'completed' } })
  })

  it('transport 入站的 audit_cap 经 handleStreamEnvelope 也不投递给 watcher', () => {
    const transport = new FakeTransport()
    const realtime = new AgentRealtime({ transport })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    transport.emit({
      type: 'agent.stream.audit_cap',
      payload: { phase: 'agent_end', event_id: 'audit-1' },
      _topic: conversationTopicForSession('session-a'),
    })
    transport.emit(streamEnvelope('session-a', { event_id: 'delta-1' }))

    expect(target.envelopes).toHaveLength(1)
    expect(target.envelopes[0]).toMatchObject({
      event: { payload: { event_id: 'delta-1' } },
    })
  })
})

describe('AgentRealtime lifecycle', () => {
  it('dispose 退订全部 topic、解除 transport handler 且幂等', () => {
    const transport = new FakeTransport()
    const onReady = vi.fn()
    const realtime = new AgentRealtime({
      transport,
      deviceId: 'device-a',
      onReady,
    })
    const target = createTarget(1)
    realtime.watch('session-a', target)

    realtime.dispose()
    realtime.dispose()
    transport.emit(streamEnvelope('session-a', { event_id: 'after-dispose' }))
    transport.ready()

    expect(transport.unsubscribe).toHaveBeenCalledTimes(1)
    expect(new Set(transport.unsubscribe.mock.calls[0][0])).toEqual(new Set([
      deviceTopicForDevice('device-a'),
      conversationTopicForSession('session-a'),
    ]))
    expect(transport.envelopeHandlerCount).toBe(0)
    expect(transport.readyHandlerCount).toBe(0)
    expect(target.envelopes).toHaveLength(0)
    expect(onReady).not.toHaveBeenCalled()
  })
})
