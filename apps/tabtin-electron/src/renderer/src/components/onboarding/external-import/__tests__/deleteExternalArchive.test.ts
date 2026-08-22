import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bump: vi.fn(),
  forgetExternalOpenedSession: vi.fn(),
}))

vi.mock('../useExternalArchiveIndexStore', () => ({
  useExternalArchiveIndexStore: {
    getState: () => ({ bump: mocks.bump }),
  },
}))

vi.mock('../externalOpenedSessionRegistry', () => ({
  forgetExternalOpenedSession: mocks.forgetExternalOpenedSession,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}))

import { deleteExternalArchive } from '../deleteExternalArchive'

describe('deleteExternalArchive', () => {
  beforeEach(() => {
    mocks.bump.mockReset()
    mocks.forgetExternalOpenedSession.mockReset()
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      import: {
        deleteArchive: vi.fn(async () => ({ deleted: 1 })),
      },
    }
  })

  it('calls IPC, forgets opened session, bumps index', async () => {
    const result = await deleteExternalArchive({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'src-1',
      openedSessionId: 'chat-1',
    })

    expect(result).toEqual({ deleted: 1 })
    expect(window.tabtin.import.deleteArchive).toHaveBeenCalledWith({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'src-1',
    })
    expect(mocks.forgetExternalOpenedSession).toHaveBeenCalledWith('chat-1')
    expect(mocks.bump).toHaveBeenCalledTimes(1)
  })

  it('does not forget or bump when deleted is 0', async () => {
    ;(window as unknown as { tabtin: { import: { deleteArchive: ReturnType<typeof vi.fn> } } }).tabtin = {
      import: {
        deleteArchive: vi.fn(async () => ({ deleted: 0 })),
      },
    }
    const result = await deleteExternalArchive({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'missing',
      openedSessionId: 'chat-1',
    })
    expect(result).toEqual({ deleted: 0 })
    expect(mocks.forgetExternalOpenedSession).not.toHaveBeenCalled()
    expect(mocks.bump).not.toHaveBeenCalled()
  })

  it('throws when deleteArchive API missing', async () => {
    ;(window as unknown as { tabtin: unknown }).tabtin = { import: {} }
    await expect(
      deleteExternalArchive({
        organizationId: 'org-1',
        source: 'cursor',
        sourceSessionId: 'src-1',
      }),
    ).rejects.toThrow(/未暴露删除外部档案接口/)
  })
})
