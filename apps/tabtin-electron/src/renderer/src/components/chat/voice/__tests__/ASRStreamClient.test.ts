import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WsGateway } from '@tabtin/chat-client'
import { ASRStreamClient, buildDialogContext, buildASRPayload } from '../ASRStreamClient'

describe('buildDialogContext', () => {
  it('should return undefined for empty messages', () => {
    expect(buildDialogContext([])).toBeUndefined()
  })

  it('should filter out non-user/assistant messages', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ]
    const result = buildDialogContext(messages)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!)
    expect(parsed.context_data).toHaveLength(1)
    expect(parsed.context_data[0].text).toContain('用户')
  })

  it('should truncate long content', () => {
    const longText = 'x'.repeat(300)
    const messages = [{ role: 'user', content: longText }]
    const result = buildDialogContext(messages)
    const parsed = JSON.parse(result!)
    expect(parsed.context_data[0].text).toContain('...')
    expect(parsed.context_data[0].text.length).toBeLessThan(300)
  })

  it('should respect maxRounds', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }))
    const result = buildDialogContext(messages, 5)
    const parsed = JSON.parse(result!)
    expect(parsed.context_data).toHaveLength(5)
  })

  it('should use correct prefixes', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const result = buildDialogContext(messages)
    const parsed = JSON.parse(result!)
    expect(parsed.context_data[0].text).toContain('用户')
    expect(parsed.context_data[1].text).toContain('助手')
  })

  it('should set context_type to dialog_ctx', () => {
    const messages = [{ role: 'user', content: 'test' }]
    const result = buildDialogContext(messages)
    const parsed = JSON.parse(result!)
    expect(parsed.context_type).toBe('dialog_ctx')
  })
})

describe('buildASRPayload', () => {
  it('should include default fields', () => {
    const payload = buildASRPayload()
    expect(payload.audio_format).toBe('pcm')
    expect(payload.sample_rate).toBe(16000)
    expect(payload.provider).toBe('bytedance')
    expect(payload.enable_itn).toBe(true)
    expect(payload.enable_punc).toBe(true)
    expect(payload.enable_ddc).toBe(true)
    expect(payload.show_utterances).toBe(true)
  })

  it('should include nonstream flag for bigmodel_async', () => {
    const payload = buildASRPayload()
    expect(payload.enable_nonstream).toBe(true)
  })

  it('should include emotion detection', () => {
    const payload = buildASRPayload()
    expect(payload.enable_emotion_detection).toBe(true)
  })

  it('should include accelerate text fields', () => {
    const payload = buildASRPayload()
    expect(payload.enable_accelerate_text).toBe(true)
    expect(payload.accelerate_score).toBe(10)
  })

  it('should clamp accelerate_score to [0,20]', () => {
    const payload = buildASRPayload({ accelerateScore: 100 })
    expect(payload.accelerate_score).toBe(20)

    const payload2 = buildASRPayload({ accelerateScore: -5 })
    expect(payload2.accelerate_score).toBe(0)
  })

  it('should include hotwords in context', () => {
    const payload = buildASRPayload({ hotwords: ['TabTin', 'Agent'] })
    expect(payload.context).toBeDefined()
    const parsed = JSON.parse(payload.context)
    expect(parsed.hotwords).toEqual([{ word: 'TabTin' }, { word: 'Agent' }])
  })

  it('should include context string', () => {
    const ctx = JSON.stringify({ context_type: 'dialog_ctx', context_data: [] })
    const payload = buildASRPayload({ context: ctx })
    const parsed = JSON.parse(payload.context)
    expect(parsed.context_type).toBe('dialog_ctx')
  })

  it('should merge context and hotwords', () => {
    const ctx = JSON.stringify({ context_type: 'test', extra: 'value' })
    const payload = buildASRPayload({ context: ctx, hotwords: ['word1'] })
    const parsed = JSON.parse(payload.context)
    expect(parsed.context_type).toBe('test')
    expect(parsed.extra).toBe('value')
    expect(parsed.hotwords).toEqual([{ word: 'word1' }])
  })

  it('should handle invalid context JSON gracefully', () => {
    const payload = buildASRPayload({ context: 'not-json', hotwords: ['w'] })
    const parsed = JSON.parse(payload.context)
    expect(parsed.hotwords).toEqual([{ word: 'w' }])
  })

  it('should not include context field when no context or hotwords', () => {
    const payload = buildASRPayload()
    expect(payload.context).toBeUndefined()
  })
})

describe('ASRStreamClient.start', () => {
  afterEach(() => {
    ASRStreamClient.cancelPreconnect()
  })

  const createGateway = (response: unknown) => {
    const listeners = new Set<(envelope: unknown) => void>()
    return {
      connect: vi.fn(async () => true),
      request: vi.fn(async () => response),
      send: vi.fn(),
      addListener: vi.fn((listener: (envelope: unknown) => void) => {
        listeners.add(listener)
      }),
      removeListener: vi.fn((listener: (envelope: unknown) => void) => {
        listeners.delete(listener)
      }),
      emit(envelope: unknown) {
        for (const listener of listeners) listener(envelope)
      },
    }
  }

  it('starts through gateway.request and activates the returned stream', async () => {
    const gateway = createGateway({
      ok: true,
      type: 'asr.stream.started',
      requestId: 'evt_start',
      payload: { stream_id: 'asr_test' },
    })
    const client = new ASRStreamClient(gateway as unknown as WsGateway, 'wt_1')

    await expect(client.start({ hotwords: ['TabTin'] })).resolves.toBe('asr_test')

    expect(gateway.request).toHaveBeenCalledWith(
      'asr.stream.start',
      expect.objectContaining({
        provider: 'bytedance',
        context: expect.stringContaining('TabTin'),
      }),
      { organizationId: 'wt_1', timeoutMs: 10_000 },
    )
    expect(gateway.send).not.toHaveBeenCalledWith(
      'asr.stream.start',
      expect.anything(),
      expect.anything(),
    )

    client.sendAudio(new ArrayBuffer(2))
    expect(gateway.send).toHaveBeenCalledWith(
      'asr.stream.audio',
      expect.objectContaining({ stream_id: 'asr_test' }),
      { organizationId: 'wt_1' },
    )
  })

  it('surfaces backend start errors instead of waiting for local timeout', async () => {
    const gateway = createGateway({
      ok: false,
      type: 'error',
      requestId: 'evt_start',
      error: {
        code: 'WS_1010_INTERNAL_ERROR',
        message: '语音识别服务未配置，请联系管理员',
      },
    })
    const client = new ASRStreamClient(gateway as unknown as WsGateway)

    await expect(client.start()).rejects.toThrow('语音识别服务未配置，请联系管理员')
    expect(gateway.removeListener).toHaveBeenCalled()
  })

  it('keeps ASR start timeout for true gateway request timeouts', async () => {
    const gateway = createGateway({
      ok: false,
      type: 'error',
      requestId: 'evt_start',
      error: {
        code: 'WS_REQUEST_TIMEOUT',
        message: 'request timeout',
      },
    })
    const client = new ASRStreamClient(gateway as unknown as WsGateway)

    await expect(client.start()).rejects.toThrow('ASR start timeout')
  })

  it('keeps processing stream events after request-based start succeeds', async () => {
    const gateway = createGateway({
      ok: true,
      type: 'asr.stream.started',
      requestId: 'evt_start',
      payload: { stream_id: 'asr_test' },
    })
    const client = new ASRStreamClient(gateway as unknown as WsGateway)
    const onTranscript = vi.fn()
    client.onTranscript = onTranscript

    await client.start()
    gateway.emit({
      type: 'asr.stream.event',
      payload: { stream_id: 'asr_test', text: 'hello' },
    })
    gateway.emit({
      type: 'asr.stream.done',
      payload: { stream_id: 'asr_test', text: 'final' },
    })

    expect(onTranscript).toHaveBeenCalledWith('hello', false)
    expect(onTranscript).toHaveBeenCalledWith('final', true)
    expect(gateway.removeListener).toHaveBeenCalled()
  })

  it('surfaces active stream errors and removes the listener', async () => {
    const gateway = createGateway({
      ok: true,
      type: 'asr.stream.started',
      requestId: 'evt_start',
      payload: { stream_id: 'asr_test' },
    })
    const client = new ASRStreamClient(gateway as unknown as WsGateway)
    const onError = vi.fn()
    client.onError = onError

    await client.start()
    gateway.emit({
      type: 'asr.stream.error',
      payload: { stream_id: 'asr_test', error: 'upstream failed' },
    })

    expect(onError).toHaveBeenCalledWith('upstream failed')
    expect(gateway.removeListener).toHaveBeenCalled()
  })

  it('cleans failed preconnect attempts so click can retry normally', async () => {
    const gateway = createGateway({
      ok: false,
      type: 'error',
      requestId: 'evt_start',
      error: {
        code: 'WS_1010_INTERNAL_ERROR',
        message: '语音识别服务未配置，请联系管理员',
      },
    })

    await ASRStreamClient.preconnect(gateway as unknown as WsGateway, {}, 'wt_1')

    expect(ASRStreamClient.consumePreconnected('wt_1')).toBeNull()
    expect(gateway.removeListener).toHaveBeenCalled()
  })
})
