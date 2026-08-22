import { describe, expect, it } from 'vitest'
import {
  buildMobileEnvironmentQrValue,
  deriveMobileCentrifugoUrl,
  deriveMobileWebsocketUrl,
  deriveMobileWebUrl,
  isLoopbackMobileEnvironment,
  replaceLoopbackHosts,
} from './mobileEnvironmentQr'

describe('mobile environment QR contract', () => {
  it('encodes every mobile endpoint in a versioned TabTin URL', () => {
    const value = buildMobileEnvironmentQrValue({
      apiUrl: 'https://api-test.example.com/api/',
      websocketUrl: 'wss://api-test.example.com/ws/v1/gateway',
      webUrl: 'https://web-test.example.com/',
      centrifugoUrl: 'wss://centrifugo-test.example.com/connection/websocket',
    })

    const parsed = new URL(value)
    expect(parsed.protocol).toBe('tabtin:')
    expect(parsed.hostname).toBe('mobile-environment')
    expect(parsed.searchParams.get('v')).toBe('1')
    expect(parsed.searchParams.get('api')).toBe(
      'https://api-test.example.com/api',
    )
    expect(parsed.searchParams.get('ws')).toBe(
      'wss://api-test.example.com/ws/v1/gateway',
    )
    expect(parsed.searchParams.get('web')).toBe('https://web-test.example.com')
    expect(parsed.searchParams.get('centrifugo')).toBe(
      'wss://centrifugo-test.example.com/connection/websocket',
    )
  })

  it('derives the mobile defaults from an API URL with a path prefix', () => {
    const api = 'http://192.168.1.8:6060/tabtin/api'

    expect(deriveMobileWebsocketUrl(api)).toBe(
      'ws://192.168.1.8:6060/tabtin/ws/v1/gateway',
    )
    expect(deriveMobileWebUrl(api)).toBe('http://192.168.1.8:6060/tabtin')
    expect(deriveMobileCentrifugoUrl(api)).toBe(
      'ws://192.168.1.8:8100/tabtin/connection/websocket',
    )
  })

  it('keeps a non-standard custom API port for a colocated Centrifugo proxy', () => {
    expect(
      deriveMobileCentrifugoUrl('https://dev.example.com:7443/tabtin/api'),
    ).toBe('wss://dev.example.com:7443/tabtin/connection/websocket')
  })

  it('warns when the desktop configuration cannot be reached from a phone', () => {
    expect(
      isLoopbackMobileEnvironment({
        apiUrl: 'http://127.0.0.1:6060/api',
        websocketUrl: 'ws://127.0.0.1:6060/ws/v1/gateway',
        webUrl: 'http://127.0.0.1:5176',
        centrifugoUrl: 'ws://127.0.0.1:8100/connection/websocket',
      }),
    ).toBe(true)
  })

  it('replaces only loopback hosts with the selected computer address', () => {
    expect(
      replaceLoopbackHosts(
        {
          apiUrl: 'http://[::1]:6060/api',
          websocketUrl: 'ws://localhost:6060/ws/v1/gateway',
          webUrl: 'https://web-test.example.com',
          centrifugoUrl: 'ws://0.0.0.0:8100/connection/websocket',
        },
        '192.168.1.20',
      ),
    ).toEqual({
      apiUrl: 'http://192.168.1.20:6060/api',
      websocketUrl: 'ws://192.168.1.20:6060/ws/v1/gateway',
      webUrl: 'https://web-test.example.com',
      centrifugoUrl: 'ws://192.168.1.20:8100/connection/websocket',
    })
  })
})
