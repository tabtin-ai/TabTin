import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const defaultSession = { kind: 'default-session' }
  return {
    defaultSession,
    fromPartition: vi.fn((partition: string) => ({ kind: `partition:${partition}` })),
    getView: vi.fn(),
  }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: mocks.defaultSession,
    fromPartition: mocks.fromPartition,
  },
}))

vi.mock('../../embedded-crawl-view', () => ({
  getView: mocks.getView,
}))

import { resolveResourceRequestSession } from '../resourceRequestContext'

describe('resolveResourceRequestSession', () => {
  beforeEach(() => {
    mocks.fromPartition.mockClear()
    mocks.getView.mockReset()
  })

  it('优先复用 live view 的 session', () => {
    const liveSession = { kind: 'live-session' }
    mocks.getView.mockReturnValue({
      webContents: {
        session: liveSession,
      },
    })

    const resolved = resolveResourceRequestSession({
      viewId: 'view-live',
      resource: {
        viewId: 'view-live',
        authContextRef: {
          viewId: 'view-live',
          requiresSession: true,
          sessionPartition: 'persist:space-1',
        },
      } as any,
    })

    expect(resolved).toBe(liveSession)
    expect(mocks.fromPartition).not.toHaveBeenCalled()
  })

  it('在 live view 不存在时回退到 partition session', () => {
    mocks.getView.mockReturnValue(undefined)

    const resolved = resolveResourceRequestSession({
      resource: {
        viewId: 'view-missing',
        authContextRef: {
          viewId: 'view-missing',
          requiresSession: true,
          sessionPartition: 'persist:space-2',
        },
      } as any,
    })

    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:space-2')
    expect(resolved).toEqual({ kind: 'partition:persist:space-2' })
  })

  it('无 partition 但声明 requiresSession 时回退到 defaultSession', () => {
    mocks.getView.mockReturnValue(undefined)

    const resolved = resolveResourceRequestSession({
      resource: {
        viewId: 'view-default',
        authContextRef: {
          viewId: 'view-default',
          requiresSession: true,
        },
      } as any,
    })

    expect(resolved).toBe(mocks.defaultSession)
    expect(mocks.fromPartition).not.toHaveBeenCalled()
  })
})
