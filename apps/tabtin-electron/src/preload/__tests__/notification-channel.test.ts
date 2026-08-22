import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcState } = vi.hoisted(() => ({
  ipcState: {
    listeners: new Map<string, Set<(...args: any[]) => void>>(),
  },
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: any[]) => void) => {
      const listeners = ipcState.listeners.get(channel) ?? new Set()
      listeners.add(listener)
      ipcState.listeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: (...args: any[]) => void) => {
      ipcState.listeners.get(channel)?.delete(listener)
    },
  },
}))

import {
  _resetNotificationNavigateChannelForTest,
  onNotificationNavigate,
} from '../notification-channel'

function emitNavigate(data: Record<string, unknown>): void {
  const listeners = ipcState.listeners.get('notification:navigate')
  if (!listeners) return
  for (const listener of listeners) {
    listener({}, data)
  }
}

describe('notification-channel', () => {
  beforeEach(() => {
    _resetNotificationNavigateChannelForTest()
  })

  it('dispatches immediately when listener is already registered', () => {
    const callback = vi.fn()
    const cleanup = onNotificationNavigate(callback)

    emitNavigate({ type: 'tracker', id: 'tracker-1' })

    expect(callback).toHaveBeenCalledWith({ type: 'tracker', id: 'tracker-1' })
    cleanup()
  })

  it('buffers notification navigate events until listener is registered', () => {
    emitNavigate({ type: 'settings', id: 'organization', route: 'notifications' })

    const callback = vi.fn()
    const cleanup = onNotificationNavigate(callback)

    expect(callback).toHaveBeenCalledWith({
      type: 'settings',
      id: 'organization',
      route: 'notifications',
    })
    cleanup()
  })

  it('only replays the latest buffered navigate event', () => {
    emitNavigate({ type: 'tracker', id: 'tracker-1' })
    emitNavigate({ type: 'tracker', id: 'tracker-2' })

    const callback = vi.fn()
    const cleanup = onNotificationNavigate(callback)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ type: 'tracker', id: 'tracker-2' })
    cleanup()
  })

  it('ignores invalid payloads and unsubscribes cleanly', () => {
    const callback = vi.fn()
    const cleanup = onNotificationNavigate(callback)

    emitNavigate({ type: 'tracker' })
    cleanup()
    emitNavigate({ type: 'tracker', id: 'tracker-2' })

    expect(callback).not.toHaveBeenCalled()
  })
})
