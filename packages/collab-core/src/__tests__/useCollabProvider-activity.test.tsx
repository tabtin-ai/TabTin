/**
 * ：Activity hidden 会 cleanup effect → useCollabProvider disconnect 销毁 Y.Doc。
 * 本测试钉死当前生命周期（切回会新建 Y.Doc），供 visibility 保活 / SessionPool 修复对照。
 *
 * @vitest-environment jsdom
 */

import React, { Activity, useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

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

import { useCollabProvider } from '../useCollabProvider.js'
import { CollabProvider } from '../provider.js'
import type { CollabProviderOptions } from '../types.js'

const BASE_OPTIONS: CollabProviderOptions = {
  serverUrl: 'ws://localhost:4100',
  documentName: 'docs:activity-lifecycle',
  token: 'test-token',
  user: { id: 'u1', name: 'Tester', color: '#FF5733' },
  enableIndexedDB: false,
}

type ProbeSnap = {
  ydoc: unknown
  provider: unknown
  clientID: number | null
}

function CollabInner({ onReady }: { onReady: (snap: ProbeSnap) => void }) {
  const collab = useCollabProvider(BASE_OPTIONS)
  useEffect(() => {
    const ydoc = collab.ydoc as { clientID?: number } | null
    onReady({
      ydoc: collab.ydoc,
      provider: collab.provider,
      clientID: typeof ydoc?.clientID === 'number' ? ydoc.clientID : null,
    })
  }, [collab.ydoc, collab.provider, onReady])
  return <div data-testid="collab-inner" />
}

function ActivityProbe({
  mode,
  onReady,
}: {
  mode: 'visible' | 'hidden'
  onReady: (snap: ProbeSnap) => void
}) {
  return (
    <Activity mode={mode}>
      <CollabInner onReady={onReady} />
    </Activity>
  )
}

describe('useCollabProvider × Activity hidden ', () => {
  let disconnectSpy: ReturnType<typeof vi.spyOn>
  let ctorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    disconnectSpy = vi.spyOn(CollabProvider.prototype, 'disconnect')
    ctorSpy = vi.spyOn(CollabProvider.prototype, 'connect')
  })

  afterEach(() => {
    disconnectSpy.mockRestore()
    ctorSpy.mockRestore()
    cleanup()
  })

  it('Activity visible → hidden → visible 会 disconnect 并新建 Provider/Y.Doc（当前基线）', () => {
    let latest: ProbeSnap | null = null
    const onReady = (snap: ProbeSnap) => {
      latest = snap
    }

    const { rerender } = render(<ActivityProbe mode="visible" onReady={onReady} />)

    expect(latest?.ydoc).toBeTruthy()
    expect(latest?.provider).toBeTruthy()
    expect(ctorSpy).toHaveBeenCalled()
    const firstYdoc = latest!.ydoc
    const firstProvider = latest!.provider
    const connectCountAfterFirst = ctorSpy.mock.calls.length

    act(() => {
      rerender(<ActivityProbe mode="hidden" onReady={onReady} />)
    })

    // Activity hidden → effect cleanup → disconnect（销毁 Y.Doc）
    expect(disconnectSpy).toHaveBeenCalled()

    act(() => {
      rerender(<ActivityProbe mode="visible" onReady={onReady} />)
    })

    expect(latest?.ydoc).toBeTruthy()
    expect(latest?.provider).toBeTruthy()
    // 切回会再次 connect；Y.Doc / provider 实例被重建
    expect(ctorSpy.mock.calls.length).toBeGreaterThan(connectCountAfterFirst)
    expect(latest!.ydoc === firstYdoc && latest!.provider === firstProvider).toBe(false)
  })
})
