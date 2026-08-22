import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getViewState: vi.fn(),
  getWebContents: vi.fn(),
}))

vi.mock('../view-factory', () => ({
  getViewFactory: () => ({
    getViewState: mocks.getViewState,
    getWebContents: mocks.getWebContents,
  }),
}))

import { refreshLoginRelayTab } from './refresh-tab'

class FakeWebContents extends EventEmitter {
  url = 'https://login.example.com/feed'
  reloadIgnoringCache = vi.fn(() => queueMicrotask(() => this.emit('did-finish-load')))
  isDestroyed = vi.fn(() => false)
  getURL = vi.fn(() => this.url)
}

describe('refreshLoginRelayTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reloads only the matching organization tab and waits for its load', async () => {
    const contents = new FakeWebContents()
    mocks.getViewState.mockReturnValue({
      config: { partition: 'persist:tabtin:organization:org-1:browser' },
    })
    mocks.getWebContents.mockReturnValue(contents)

    await expect(refreshLoginRelayTab({
      tabId: 'view-login-wall',
      expectedPartition: 'persist:tabtin:organization:org-1:browser',
      expectedDomain: 'example.com',
    })).resolves.toEqual({ ok: true })

    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce()
  })

  it('treats the bare View partition as the same persistent Electron partition', async () => {
    const contents = new FakeWebContents()
    mocks.getViewState.mockReturnValue({
      config: { partition: 'tabtin:organization:org-1:browser' },
    })
    mocks.getWebContents.mockReturnValue(contents)

    await expect(refreshLoginRelayTab({
      tabId: 'view-login-wall',
      expectedPartition: 'persist:tabtin:organization:org-1:browser',
      expectedDomain: 'example.com',
    })).resolves.toEqual({ ok: true })

    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce()
  })

  it('refuses a tab from another browser partition without reloading it', async () => {
    const contents = new FakeWebContents()
    mocks.getViewState.mockReturnValue({ config: { partition: 'persist:tabtin:organization:other:browser' } })
    mocks.getWebContents.mockReturnValue(contents)

    await expect(refreshLoginRelayTab({
      tabId: 'other-tab',
      expectedPartition: 'persist:tabtin:organization:org-1:browser',
      expectedDomain: 'example.com',
    })).resolves.toEqual({ ok: false, errorCode: 'target_tab_mismatch' })

    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('treats a persisted tab whose web contents was evicted as unavailable', async () => {
    mocks.getViewState.mockReturnValue({
      config: { partition: 'persist:tabtin:organization:org-1:browser' },
    })
    mocks.getWebContents.mockReturnValue(undefined)

    await expect(refreshLoginRelayTab({
      tabId: 'evicted-tab',
      expectedPartition: 'persist:tabtin:organization:org-1:browser',
      expectedDomain: 'example.com',
    })).resolves.toEqual({ ok: false, errorCode: 'target_tab_unavailable' })
  })
})
