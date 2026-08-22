import React from 'react'
import { ShareSessionDialog } from '../composer/ShareSessionDialog'
import { SessionArchiveDialog } from './SessionArchiveDialog'
import {
  ExternalArchiveDeleteDialog,
  type ExternalArchiveDeleteTarget,
} from './ExternalArchiveDeleteDialog'
import { SessionRenameDialog } from './SessionRenameDialog'
import { SessionContextMenu } from './SessionContextMenu'
import type { useSessionSwitcherActions } from './useSessionSwitcherActions'

type SessionSwitcherActions = ReturnType<typeof useSessionSwitcherActions>

export interface SessionSwitcherOverlaysProps {
  mode: 'tabs' | 'list'
  actions: SessionSwitcherActions
  forkingSessionId: string | null
  pinnedSessionIds?: Set<string>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onDeleteExternalArchive?: (archive: ExternalArchiveDeleteTarget) => void | Promise<void>
  onForkSession?: (sessionId: string) => void | Promise<void>
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>
  onTogglePin?: (sessionId: string) => void
  externalOpenedSessionIds?: ReadonlySet<string>
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const SessionSwitcherOverlays: React.FC<SessionSwitcherOverlaysProps> = ({
  mode,
  actions,
  forkingSessionId,
  pinnedSessionIds,
  onDeleteSession,
  onDeleteExternalArchive,
  onForkSession,
  onRenameSession,
  onTogglePin,
  externalOpenedSessionIds,
  t,
}) => (
  <>
    <SessionArchiveDialog
      archiveTarget={actions.archiveTarget}
      onOpenChange={(open) => { if (!open) actions.setArchiveTarget(null) }}
      onBeginArchive={actions.beginArchiveNow}
      onRollbackArchive={actions.rollbackArchiveNow}
      onConfirm={(sessionId) => actions.commitArchiveWithRestoreToast(sessionId)}
      t={t}
    />
    <ExternalArchiveDeleteDialog
      target={actions.externalArchiveDeleteTarget}
      onOpenChange={(open) => { if (!open) actions.setExternalArchiveDeleteTarget(null) }}
      onConfirm={(target) => {
        actions.setExternalArchiveDeleteTarget(null)
        if (onDeleteExternalArchive) void onDeleteExternalArchive(target)
      }}
      t={t}
    />
    <SessionRenameDialog
      renameDialog={actions.renameDialog}
      isRenaming={actions.isRenaming}
      onOpenChange={(open) => { if (!open && !actions.isRenaming) actions.setRenameDialog(null) }}
      onValueChange={(value) => {
        actions.setRenameDialog(prev => prev ? { ...prev, value, error: null } : prev)
      }}
      onSubmit={() => { void actions.handleRenameSubmit() }}
      onCancel={() => actions.setRenameDialog(null)}
      t={t}
    />
    {mode === 'list' && (
      <SessionContextMenu
        open={actions.ctxMenu.open}
        x={actions.ctxMenu.x}
        y={actions.ctxMenu.y}
        sessionId={actions.ctxMenu.sessionId}
        forkingSessionId={forkingSessionId}
        pinnedSessionIds={pinnedSessionIds}
        isExternalOpened={
          Boolean(actions.ctxMenu.sessionId
            && (externalOpenedSessionIds?.has(actions.ctxMenu.sessionId)
              || actions.isExternalOpenedSession(actions.ctxMenu.sessionId)))
        }
        onClose={actions.closeContextMenu}
        onForkSession={onForkSession}
        onRenameSession={onRenameSession ? actions.handleRenameRequest : undefined}
        onTogglePin={onTogglePin}
        onArchiveRequest={
          onDeleteSession && !actions.isSessionArchived(actions.ctxMenu.sessionId)
            ? actions.handleArchiveRequest
            : undefined
        }
        onCopyReference={actions.handleCopySessionReference}
        onShare={actions.handleOpenShareToColleague}
        t={t}
      />
    )}
    {/* 任务右键「分享到私信」与 tabs「共享给同事」共用共享卡/交接弹窗。 */}
    {actions.shareToColleagueSessionId && (
      <ShareSessionDialog
        open
        onOpenChange={(open) => { if (!open) actions.setShareToColleagueSessionId(null) }}
        sessionId={actions.shareToColleagueSessionId}
      />
    )}
  </>
)
