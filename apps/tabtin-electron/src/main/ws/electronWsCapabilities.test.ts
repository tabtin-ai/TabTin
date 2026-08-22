import { describe, expect, it } from 'vitest'
import { Capabilities, DomainEvents } from '@tabtin/ws-gateway-client'

import { DEFAULT_ELECTRON_WS_CAPABILITIES } from './electronWsCapabilities'

describe('DEFAULT_ELECTRON_WS_CAPABILITIES', () => {
  it('covers the renderer legacy realtime surface and local Agent control', () => {
    expect(DEFAULT_ELECTRON_WS_CAPABILITIES).toEqual([
      DomainEvents.CONTEXT_SYNC,
      Capabilities.AGENT_ACTION,
      Capabilities.AGENT_STREAM,
      Capabilities.TABLE_EVENTS,
      Capabilities.CONTEXT_SYNC,
      Capabilities.DOC_EVENTS,
      Capabilities.DOCPARSE_EVENTS,
      Capabilities.TRACKER_EVENTS,
      Capabilities.NOTIFICATIONS,
      Capabilities.EXTENSION_EVENTS,
      Capabilities.BILLING_EVENTS,
      Capabilities.ASR_STREAM,
      Capabilities.SESSION_COLLABORATION,
    ])
  })
})
