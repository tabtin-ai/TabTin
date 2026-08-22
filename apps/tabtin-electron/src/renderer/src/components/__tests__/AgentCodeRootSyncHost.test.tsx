import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionCodeRootChangedEvent } from '@shared/session-code-root-events'

const applySessionCodeRootChange = vi.fn()
const mirrorSessionCodeRootBinding = vi.fn()

vi.mock('../context-space/code-workspace/switchSessionWorktree', () => ({
  applySessionCodeRootChange: (...args: unknown[]) => applySessionCodeRootChange(...args),
}))

vi.mock('@/services/sessionCodeRootBinding', () => ({
  mirrorSessionCodeRootBinding: (...args: unknown[]) => mirrorSessionCodeRootBinding(...args),
}))

import { AgentCodeRootSyncHost } from '../AgentCodeRootSyncHost'

describe('AgentCodeRootSyncHost', () => {
  let listener: ((event: SessionCodeRootChangedEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((callback: (event: SessionCodeRootChangedEvent) => void) => {
    listener = callback
    return unsubscribe
  })

  beforeEach(() => {
    listener = undefined
    unsubscribe.mockReset()
    subscribe.mockClear()
    applySessionCodeRootChange.mockReset()
    mirrorSessionCodeRootBinding.mockReset()
    Object.defineProperty(window, 'tabtin', {
      value: { agentEngine: { onSessionCodeRootChanged: subscribe } },
      writable: true,
      configurable: true,
    })
  })

  afterEach(cleanup)

  it('把 main 已提交的切换投影到 TabCode 和 Changes 共用副作用', () => {
    const view = render(<AgentCodeRootSyncHost />)
    expect(subscribe).toHaveBeenCalledOnce()

    act(() => {
      listener?.({
        sessionId: 'session-1',
        spaceId: 'space-1',
        tabScopeKey: 'conversation:session-1',
        previousRootPath: '/repo/main',
        rootPath: '/repo/wt',
        branch: 'feat/10498',
        revision: 3,
        created: false,
        source: 'agent_cli',
      })
    })

    expect(applySessionCodeRootChange).toHaveBeenCalledWith({
      sessionId: 'session-1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:session-1',
      previousRootPath: '/repo/main',
      rootPath: '/repo/wt',
    })
    expect(mirrorSessionCodeRootBinding).toHaveBeenCalledWith('session-1', {
      rootPath: '/repo/wt',
      tabKey: 'conversation:session-1',
      branch: 'feat/10498',
      title: 'feat/10498',
    })

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
