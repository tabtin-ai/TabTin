/**
 * ：同一资源在多个 React surface 中只拥有一个物理协同运行时。
 *
 * @vitest-environment jsdom
 */

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hocuspocus/provider', () => {
  class MockHocuspocusProvider {
    disconnect = vi.fn()
    destroy = vi.fn()
    connect = vi.fn()
    setAwarenessField = vi.fn()
    sendStateless = vi.fn()
    constructor() {}
  }
  return { HocuspocusProvider: MockHocuspocusProvider }
})

vi.mock('y-indexeddb', () => {
  class MockIndexeddbPersistence {
    on = vi.fn()
    destroy = vi.fn()
    whenSynced = Promise.resolve()
    constructor() {}
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence }
})

import { CollabProvider } from '../provider.js'
import type { CollabProviderOptions } from '../types.js'
import { useCollabProvider } from '../useCollabProvider.js'

const SHARED_OPTIONS = {
  serverUrl: 'ws://localhost:4100',
  documentName: 'table:shared-table',
  token: 'test-token',
  user: { id: 'u1', name: 'Tester', color: '#FF5733' },
  enableIndexedDB: false,
  sharedRuntimeKey: 'tabdata:u1:shared-table',
} satisfies CollabProviderOptions

function Probe({ options = SHARED_OPTIONS }: { options?: CollabProviderOptions }) {
  useCollabProvider(options)
  return null
}

describe('useCollabProvider shared resource runtime', () => {
  let connectSpy: ReturnType<typeof vi.spyOn>
  let disconnectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    connectSpy = vi.spyOn(CollabProvider.prototype, 'connect')
    disconnectSpy = vi.spyOn(CollabProvider.prototype, 'disconnect')
  })

  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    connectSpy.mockRestore()
    disconnectSpy.mockRestore()
  })

  it('两个 surface 获取同一资源时只连接一次，最后一个 surface 释放后才断开', () => {
    const { rerender } = render(
      <>
        <Probe />
        <Probe />
      </>,
    )

    expect(connectSpy).toHaveBeenCalledTimes(1)

    rerender(<Probe />)
    expect(disconnectSpy).not.toHaveBeenCalled()

    rerender(<></>)
    expect(disconnectSpy).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('StrictMode 重挂载不会为同一资源重建物理连接', () => {
    render(
      <React.StrictMode>
        <Probe />
      </React.StrictMode>,
    )

    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('不同表资源保持独立物理连接', () => {
    render(
      <>
        <Probe />
        <Probe options={{
          ...SHARED_OPTIONS,
          documentName: 'table:another-table',
          sharedRuntimeKey: 'tabdata:u1:another-table',
        }} />
      </>,
    )

    expect(connectSpy).toHaveBeenCalledTimes(2)
  })
})
