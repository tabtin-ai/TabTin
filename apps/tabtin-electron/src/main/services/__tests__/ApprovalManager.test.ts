import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handle = vi.fn()
const removeHandler = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
  net: { fetch: vi.fn() },
}))

vi.mock('../../auth', () => ({
  TokenManager: { getAccessToken: vi.fn(async () => null) },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://localhost',
}))

vi.mock('../../utils/guarded-handle', () => ({
  guardedOn: vi.fn(),
}))

describe('ApprovalManager HITL hook facade', () => {
  beforeEach(async () => {
    vi.resetModules()
    const { setHumanInteractionHooks } = await import('@tabtin/agent-runtime')
    setHumanInteractionHooks(undefined)
  })

  afterEach(async () => {
    const { setHumanInteractionHooks } = await import('@tabtin/agent-runtime')
    setHumanInteractionHooks(undefined)
  })

  it('fails closed when there is no runtime interaction context', async () => {
    const { requestApproval } = await import('../ApprovalManager')
    await expect(requestApproval({
      actionType: 'desktop_control',
      detail: 'control desktop',
    })).resolves.toEqual({ approved: false })
  })

  it('injects thread identity from the hook context instead of the request', async () => {
    const {
      runWithHumanInteractionContext,
      setHumanInteractionHooks,
    } = await import('@tabtin/agent-runtime')
    const requestPlatformApproval = vi.fn(async () => ({
      approved: true,
      scope: 'thread' as const,
    }))
    setHumanInteractionHooks({ requestPlatformApproval })
    const { requestApproval } = await import('../ApprovalManager')

    const result = await runWithHumanInteractionContext(
      {
        threadId: 'chat-session-11111111-1111-4111-8111-111111111111',
        interactionMode: 'interactive',
      },
      () => requestApproval({
        actionType: 'browser.click',
        detail: 'click submit',
        reason: 'mutates page state',
      }),
    )

    expect(result).toEqual({ approved: true, scope: 'thread' })
    expect(requestPlatformApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'chat-session-11111111-1111-4111-8111-111111111111',
      }),
      expect.objectContaining({
        actionType: 'browser.click',
        detail: 'click submit',
      }),
    )
  })
})
