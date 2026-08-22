import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bridge, requireBridgeAndSpace, sendExecutorResult, buildBrowserRequestScope, handleRouteError } = vi.hoisted(() => ({
  bridge: vi.fn(),
  requireBridgeAndSpace: vi.fn(),
  sendExecutorResult: vi.fn(),
  buildBrowserRequestScope: vi.fn(),
  handleRouteError: vi.fn(),
}))

vi.mock('../browser/_helpers', () => ({
  requireBridgeAndSpace,
  sendExecutorResult,
  buildBrowserRequestScope,
  handleRouteError,
}))

import { handleBrowserHomeRoute } from '../browser/home'

describe('handleBrowserHomeRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireBridgeAndSpace.mockReturnValue({ bridge, spaceId: 'space-1' })
    buildBrowserRequestScope.mockReturnValue({ tabScopeKey: 'scope-1' })
  })

  it('forwards the resolved Space and scope to open_browser_home', async () => {
    const result = { success: true, data: { target: 'tabweb_home', tabKey: 'apphome:tabweb' } }
    bridge.mockResolvedValue(result)

    await expect(handleBrowserHomeRoute('/home', { spaceId: 'space-1', tabScopeKey: 'scope-1' }, {} as never, vi.fn())).resolves.toBe(true)

    expect(bridge).toHaveBeenCalledWith('open_browser_home', {
      spaceId: 'space-1',
      tabScopeKey: 'scope-1',
    }, 15_000)
    expect(sendExecutorResult).toHaveBeenCalledWith(result, expect.anything(), expect.any(Function))
  })

  it('does not consume unrelated browser routes', async () => {
    await expect(handleBrowserHomeRoute('/open', {}, {} as never, vi.fn())).resolves.toBe(false)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('converts a rejected bridge call into the standard CLI error response', async () => {
    const error = new Error('renderer unavailable')
    bridge.mockRejectedValue(error)
    const sendJSON = vi.fn()

    await expect(handleBrowserHomeRoute('/home', {}, {} as never, sendJSON)).resolves.toBe(true)

    expect(handleRouteError).toHaveBeenCalledWith(error, sendJSON, expect.anything())
  })
})
