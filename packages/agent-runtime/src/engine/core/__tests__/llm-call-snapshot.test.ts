import { describe, expect, it } from 'vitest'
import { INTERNAL_MESSAGE_MARKERS, setInternalMarker } from '../../contracts/conversation.js'
import { buildLLMCallSnapshot } from '../llm-call-snapshot.js'

describe('buildLLMCallSnapshot', () => {
  it('内部注入在 snapshots.jsonl 投影中记录 system，但不修改 LLM 请求角色', () => {
    const injected = setInternalMarker(
      { role: 'user' as const, content: '<context type="environment">now</context>' },
      INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
    )
    const request = {
      model: 'test-model',
      maxTokens: 100,
      messages: [injected, { role: 'user' as const, content: '你好' }],
    }

    const snapshot = buildLLMCallSnapshot(request, 0, 'run-1', [])

    expect(snapshot.iterationId).toBe('run-1:0')
    expect(snapshot.phase).toBe('request')
    expect(request.messages.map(message => message.role)).toEqual(['user', 'user'])
    expect(snapshot.messages).toMatchObject([
      { role: 'system', source: 'context_injection' },
      { role: 'user', source: 'user_input' },
    ])
  })

  it('所有带内部标记的合成消息都在快照中记录为 system', () => {
    const messages = Object.values(INTERNAL_MESSAGE_MARKERS).map((marker) =>
      setInternalMarker(
        { role: 'user' as const, content: `<synthetic>${marker}</synthetic>` },
        marker,
      ),
    )
    const request = {
      model: 'test-model',
      maxTokens: 100,
      messages: [...messages, { role: 'user' as const, content: '真实用户输入' }],
    }

    const snapshot = buildLLMCallSnapshot(request, 0, 'run-2', [])

    expect(request.messages.map(message => message.role)).toEqual(
      Array.from({ length: request.messages.length }, () => 'user'),
    )
    expect(snapshot.messages.slice(0, -1).every(message => message.role === 'system')).toBe(true)
    expect(snapshot.messages.slice(0, -1).every(message => message.source !== 'history')).toBe(true)
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'user', source: 'user_input' })
  })

  it('relevant_cli 在快照中记录为 relevant_recall + system', () => {
    const relevantCli = setInternalMarker(
      { role: 'user' as const, content: '<relevant_cli>tabtin agent history</relevant_cli>' },
      INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION,
    )
    const request = {
      model: 'test-model',
      maxTokens: 100,
      messages: [relevantCli, { role: 'user' as const, content: '你好' }],
    }

    const snapshot = buildLLMCallSnapshot(request, 0, 'run-3', [])

    expect(request.messages[0]?.role).toBe('user')
    expect(snapshot.messages[0]).toMatchObject({ role: 'system', source: 'relevant_recall' })
  })
})
