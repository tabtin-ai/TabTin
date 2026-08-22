import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionArchiveDialog } from './SessionArchiveDialog'

const mocks = vi.hoisted(() => ({
  listSessionSharesBySession: vi.fn(),
  revokeSessionShare: vi.fn(),
  setSessionShare: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  listSessionSharesBySession: mocks.listSessionSharesBySession,
  revokeSessionShare: mocks.revokeSessionShare,
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({ setSessionShare: mocks.setSessionShare }),
  },
}))

vi.mock('@components/ui', () => ({
  toast: { error: vi.fn() },
  ConfirmDialog: ({
    open,
    description,
    confirmText,
    cancelText,
    onConfirm,
    isLoading,
  }: {
    open: boolean
    description: string
    confirmText?: string
    cancelText?: string
    onConfirm: () => void | Promise<void>
    isLoading?: boolean
  }) => open ? (
    <div>
      <p>{description}</p>
      <button type="button" disabled={isLoading} onClick={() => { void Promise.resolve(onConfirm()).catch(() => {}) }}>
        {confirmText ?? '确认'}
      </button>
      <button type="button">{cancelText ?? '取消'}</button>
    </div>
  ) : null,
}))

describe('SessionArchiveDialog', () => {
  beforeEach(() => {
    mocks.listSessionSharesBySession.mockReset()
    mocks.revokeSessionShare.mockReset()
    mocks.setSessionShare.mockReset()
  })

  it('stops active sharing before archiving after user confirmation', async () => {
    mocks.listSessionSharesBySession.mockResolvedValue([
      { id: 'share-1', status: 'active' },
      { id: 'share-2', status: 'revoked' },
    ])
    mocks.revokeSessionShare.mockResolvedValue({ id: 'share-1', status: 'revoked' })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onBeginArchive = vi.fn()

    render(
      <SessionArchiveDialog
        archiveTarget="session-1"
        onOpenChange={vi.fn()}
        onBeginArchive={onBeginArchive}
        onConfirm={onConfirm}
        t={(_key, options) => String(options?.defaultValue ?? '')}
      />,
    )

    expect(await screen.findByText('该任务正在共享中，是否停止共享并归档？')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(onBeginArchive).toHaveBeenCalledWith('session-1')
      expect(mocks.revokeSessionShare).toHaveBeenCalledWith('share-1')
      expect(onConfirm).toHaveBeenCalledWith('session-1')
    })
    expect(onBeginArchive.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revokeSessionShare.mock.invocationCallOrder[0],
    )
  })

  it('rolls back the optimistic archive when revoke fails', async () => {
    mocks.listSessionSharesBySession.mockResolvedValue([
      { id: 'share-1', status: 'active' },
    ])
    mocks.revokeSessionShare.mockRejectedValue(new Error('revoke-failed'))
    const onRollbackArchive = vi.fn()

    render(
      <SessionArchiveDialog
        archiveTarget="session-1"
        onOpenChange={vi.fn()}
        onBeginArchive={vi.fn()}
        onRollbackArchive={onRollbackArchive}
        onConfirm={vi.fn()}
        t={(_key, options) => String(options?.defaultValue ?? '')}
      />,
    )

    expect(await screen.findByText('该任务正在共享中，是否停止共享并归档？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(onRollbackArchive).toHaveBeenCalledWith('session-1')
    })
  })
})
