/**
 * Regression test for WS-P0-1 / WS-P1-1:
 * Verifies that reconnection sends subscribe BEFORE resume,
 * ensuring the server has subscriptions when processing resume replay.
 */
import { describe, it, expect, vi } from 'vitest'
import { WsGatewayClient } from '@tabtin/ws-gateway-client'

class MockSocket {
  readyState = 1
  sentMessages: string[] = []
  onopen: ((e: any) => void) | null = null
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onclose: ((e: any) => void) | null = null

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    // no-op
  }
}

let latestSocket: MockSocket | null = null

function MockSocketFactory(_url: string): MockSocket {
  const socket = new MockSocket()
  latestSocket = socket
  return socket
}

function respondTo(socket: MockSocket, responseType: string) {
  const lastMsg = JSON.parse(socket.sentMessages[socket.sentMessages.length - 1])
  socket.onmessage?.({
    data: JSON.stringify({
      v: 1,
      type: responseType,
      request_id: lastMsg.request_id,
      ts: Math.floor(Date.now() / 1000),
      device_id: 'server',
      role: 'backend',
      payload: {},
    }),
  })
}

describe('WS-P0-1: subscribe before resume on reconnect', () => {
  it('should send subscribe before resume when reconnecting with lastEventId', async () => {
    latestSocket = null

    const client = new WsGatewayClient({
      role: 'daemon',
      capabilities: ['terminal'],
      wsBaseUrl: 'ws://localhost:8080',
      initialTopics: ['agent.action.thread-1'],
      WebSocketImpl: MockSocketFactory as any,
      requestTimeoutMs: 2000,
      connectTimeoutMs: 2000,
      reconnectMinDelayMs: 200,
    })

    // --- First connection ---
    const connectPromise = client.connect({
      token: 'test-token',
      organizationId: 'wt-1',
    })
    await new Promise(r => setTimeout(r, 10))

    const socket1 = latestSocket!
    expect(socket1).not.toBeNull()

    // Respond to auth
    respondTo(socket1, 'auth.ok')
    await new Promise(r => setTimeout(r, 10))

    // Respond to subscribe
    respondTo(socket1, 'subscribe.ok')
    await connectPromise

    expect(client.isConnected()).toBe(true)

    // Simulate receiving an event with event_id
    socket1.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'agent.action.request',
        request_id: 'evt_test-event-1',
        event_id: 'evt_test-event-1',
        ts: Math.floor(Date.now() / 1000),
        device_id: 'server',
        role: 'backend',
        payload: { action: 'test' },
      }),
    })

    expect(client.getLastEventId()).toBe('evt_test-event-1')

    // --- Simulate disconnect ---
    socket1.onclose?.({})
    await new Promise(r => setTimeout(r, 300))

    // --- Second connection (reconnect) ---
    const socket2 = latestSocket!
    expect(socket2).not.toBe(socket1)

    // Respond to auth
    respondTo(socket2, 'auth.ok')
    await new Promise(r => setTimeout(r, 10))

    // After auth, collect the message types in order
    const postAuthTypes = socket2.sentMessages
      .slice(1) // skip auth
      .map(m => JSON.parse(m).type)

    // subscribe MUST come before resume
    expect(postAuthTypes[0]).toBe('subscribe')

    // Respond to subscribe, then check for resume
    respondTo(socket2, 'subscribe.ok')
    await new Promise(r => setTimeout(r, 10))

    const allPostAuthTypes = socket2.sentMessages
      .slice(1)
      .map(m => JSON.parse(m).type)

    const subscribeIndex = allPostAuthTypes.indexOf('subscribe')
    const resumeIndex = allPostAuthTypes.indexOf('resume')

    expect(subscribeIndex).toBeGreaterThanOrEqual(0)
    expect(resumeIndex).toBeGreaterThan(subscribeIndex)

    // Verify resume payload has correct last_event_id
    const resumeMsg = socket2.sentMessages
      .map(m => JSON.parse(m))
      .find(m => m.type === 'resume')!
    expect(resumeMsg.payload.last_event_id).toBe('evt_test-event-1')

    client.close()
  })
})
