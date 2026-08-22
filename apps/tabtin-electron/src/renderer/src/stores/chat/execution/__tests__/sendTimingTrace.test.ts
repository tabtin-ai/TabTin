import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginSendTimingTrace,
  buildSendTimingPayload,
  clearSendTimingTrace,
  elapsedSinceSendClick,
  getActiveSendTimingTrace,
  trackSendTimingTelemetry,
} from '../sendTimingTrace'
import { resetChatTelemetry, getChatTelemetrySnapshot } from '../chatTelemetry'

describe('sendTimingTrace', () => {
  afterEach(() => {
    clearSendTimingTrace()
    resetChatTelemetry()
    vi.restoreAllMocks()
  })

  it('beginSendTimingTrace registers active trace with stable fields', () => {
    const trace = beginSendTimingTrace({ isNewSession: true })
    expect(trace.traceId).toMatch(/^send-/)
    expect(trace.isNewSession).toBe(true)
    expect(getActiveSendTimingTrace()?.traceId).toBe(trace.traceId)
  })

  it('clearSendTimingTrace only clears matching trace id', () => {
    const trace = beginSendTimingTrace({ isNewSession: false })
    clearSendTimingTrace('other-id')
    expect(getActiveSendTimingTrace()).not.toBeNull()
    clearSendTimingTrace(trace.traceId)
    expect(getActiveSendTimingTrace()).toBeNull()
  })

  it('buildSendTimingPayload includes elapsed_ms from click', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValueOnce(1000)
    const trace = beginSendTimingTrace({ isNewSession: true })
    nowSpy.mockReturnValue(1150)
    expect(buildSendTimingPayload(trace)).toEqual({
      sendTraceId: trace.traceId,
      isNewSession: true,
      elapsed_ms: 150,
    })
    expect(elapsedSinceSendClick(trace)).toBe(150)
    nowSpy.mockRestore()
  })

  it('trackSendTimingTelemetry merges payload into chat telemetry', () => {
    const trace = beginSendTimingTrace({ isNewSession: false })
    trackSendTimingTelemetry('message.send.click', { source: 'composer' }, trace, {
      counterKey: 'message.send.click',
      sessionId: 'sess-1',
    })
    const events = getChatTelemetrySnapshot().events
    expect(events.at(-1)).toMatchObject({
      name: 'message.send.click',
      sessionId: 'sess-1',
      payload: expect.objectContaining({
        source: 'composer',
        sendTraceId: trace.traceId,
        isNewSession: false,
        elapsed_ms: expect.any(Number),
      }),
    })
  })
})
