import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionSwitcherOverlays } from './SessionSwitcherOverlays'

vi.mock('./SessionArchiveDialog', () => ({
  SessionArchiveDialog: () => null,
}))

vi.mock('./ExternalArchiveDeleteDialog', () => ({
  ExternalArchiveDeleteDialog: () => null,
}))

vi.mock('./SessionRenameDialog', () => ({
  SessionRenameDialog: () => null,
}))

vi.mock('./SessionContextMenu', () => ({
  SessionContextMenu: ({
    sessionId,
    onShare,
  }: {
    sessionId: string | null
    onShare: (sessionId: string) => void
  }) => (
    <button type="button" onClick={() => sessionId && onShare(sessionId)}>
      分享到私信
    </button>
  ),
}))

vi.mock('../composer/ShareSessionDialog', () => ({
  ShareSessionDialog: ({
    open,
    sessionId,
  }: {
    open: boolean
    sessionId: string
  }) => (
    open
      ? <div role="dialog" data-testid="share-session-dialog" data-session-id={sessionId} />
      : null
  ),
}))

describe('SessionSwitcherOverlays', () => {
  it('routes share-to-DM through the shared task card dialog', () => {
    const handleOpenShareToColleague = vi.fn()
    const actions = {
      archiveTarget: null,
      setArchiveTarget: vi.fn(),
      externalArchiveDeleteTarget: null,
      setExternalArchiveDeleteTarget: vi.fn(),
      renameDialog: null,
      setRenameDialog: vi.fn(),
      isRenaming: false,
      handleRenameSubmit: vi.fn(),
      ctxMenu: { open: true, x: 0, y: 0, sessionId: 'session-1' },
      closeContextMenu: vi.fn(),
      isExternalOpenedSession: vi.fn(() => false),
      isSessionArchived: vi.fn(() => false),
      handleArchiveRequest: vi.fn(),
      commitArchiveWithRestoreToast: vi.fn(),
      handleCopySessionReference: vi.fn(),
      handleOpenShareToColleague,
      shareToColleagueSessionId: 'session-1',
      setShareToColleagueSessionId: vi.fn(),
    } as unknown as React.ComponentProps<typeof SessionSwitcherOverlays>['actions']

    render(
      <SessionSwitcherOverlays
        mode="list"
        actions={actions}
        forkingSessionId={null}
        t={(_key, options) => String(options?.defaultValue ?? '')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '分享到私信' }))

    expect(handleOpenShareToColleague).toHaveBeenCalledWith('session-1')
    expect(screen.getByTestId('share-session-dialog').getAttribute('data-session-id')).toBe('session-1')
    expect(screen.queryByText('共享给同事')).toBeNull()
  })
})
