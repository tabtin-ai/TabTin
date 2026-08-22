import React from 'react'
import { Archive, Copy, GitFork, PenLine, Pin, PinOff, Share2, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from '@components/ui'

export interface SessionContextMenuProps {
  open: boolean
  x: number
  y: number
  sessionId: string | null
  forkingSessionId: string | null
  pinnedSessionIds?: Set<string>
  /** 外部档案展开会话：隐藏分叉，归档改为删除 */
  isExternalOpened?: boolean
  onClose: () => void
  onForkSession?: (sessionId: string) => void | Promise<void>
  onRenameSession?: (sessionId: string) => void
  onTogglePin?: (sessionId: string) => void
  onArchiveRequest?: (sessionId: string) => void
  onCopyReference: (sessionId: string) => void
  onShare: (sessionId: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const runSessionAction = (
  sessionId: string | null,
  onClose: () => void,
  action?: (sessionId: string) => void | Promise<void>,
) => {
  const sid = sessionId
  onClose()
  if (sid && action) void action(sid)
}

const SessionContextMenuSessionActions: React.FC<SessionContextMenuProps> = ({
  sessionId,
  forkingSessionId,
  pinnedSessionIds,
  isExternalOpened = false,
  onClose,
  onForkSession,
  onRenameSession,
  onTogglePin,
  onArchiveRequest,
  t,
}) => (
  <>
    {onForkSession && !isExternalOpened && (
      <ContextMenuItem
        icon={<GitFork className="h-4 w-4" />}
        label={t('session.forkSession')}
        disabled={forkingSessionId === sessionId}
        onClick={() => runSessionAction(sessionId, onClose, onForkSession)}
      />
    )}
    {onRenameSession && sessionId && (
      <ContextMenuItem
        icon={<PenLine className="h-4 w-4" />}
        label={t('session.renameTitle', { defaultValue: '重命名对话' })}
        onClick={() => runSessionAction(sessionId, onClose, onRenameSession)}
      />
    )}
    {onTogglePin && sessionId && (
      <ContextMenuItem
        icon={pinnedSessionIds?.has(sessionId) ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        label={pinnedSessionIds?.has(sessionId) ? t('session.unpin', { defaultValue: '取消置顶' }) : t('session.pin', { defaultValue: '置顶' })}
        onClick={() => runSessionAction(sessionId, onClose, onTogglePin)}
      />
    )}
    {onArchiveRequest && (
      (isExternalOpened ? (onRenameSession || onTogglePin) : (onForkSession || onRenameSession || onTogglePin))
    ) && <ContextMenuDivider />}
    {onArchiveRequest && (
      <ContextMenuItem
        icon={isExternalOpened ? <Trash2 className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        label={isExternalOpened
          ? t('sessionList.deleteExternalArchive', { defaultValue: '删除外部档案' })
          : t('session.archiveTitle', { defaultValue: '归档对话' })}
        onClick={() => runSessionAction(sessionId, onClose, onArchiveRequest)}
      />
    )}
  </>
)

const SessionContextMenuShareActions: React.FC<Pick<SessionContextMenuProps, 'sessionId' | 'onClose' | 'onCopyReference' | 'onShare' | 't'>> = ({
  sessionId,
  onClose,
  onCopyReference,
  onShare,
  t,
}) => {
  if (!sessionId) return null
  return (
    <>
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<Copy className="h-4 w-4" />}
        label={t('session.copyReference', { defaultValue: '复制对话引用' })}
        onClick={() => runSessionAction(sessionId, onClose, onCopyReference)}
      />
      <ContextMenuItem
        icon={<Share2 className="h-4 w-4" />}
        label={t('session.shareToIM', { defaultValue: '分享到私信' })}
        onClick={() => runSessionAction(sessionId, onClose, onShare)}
      />
    </>
  )
}

export const SessionContextMenu: React.FC<SessionContextMenuProps> = (props) => (
  <ContextMenu
    open={props.open}
    onClose={props.onClose}
    anchorPosition={{ x: props.x, y: props.y }}
    className="w-52"
  >
    <SessionContextMenuSessionActions {...props} />
    <SessionContextMenuShareActions
      sessionId={props.sessionId}
      onClose={props.onClose}
      onCopyReference={props.onCopyReference}
      onShare={props.onShare}
      t={props.t}
    />
  </ContextMenu>
)
