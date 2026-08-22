/**
 * SpaceContextMenu — 群聊 / 私信的右键菜单
 *
 * 与 AgentContextMenu（workspace 专用）平行，为 group / dm 类型提供操作菜单。
 */

import React, { useState, useCallback } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
} from '@tabtin/smartsheet-ui'
import {
  Pin, PinOff, BellOff, Bell, CheckCheck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useIMStore } from '@stores/useIMStore'
import { togglePin, toggleMute, markRead } from '@services/tabchatApi'
import type { SpaceNavigationKind } from '@tabtin/app-shell'

interface SpaceContextMenuProps {
  children: React.ReactNode
  kind: SpaceNavigationKind
  rawId: string
  pinned?: boolean
  muted?: boolean
}

export const SpaceContextMenu: React.FC<SpaceContextMenuProps> = ({
  children,
  kind,
  rawId,
  pinned = false,
  muted = false,
}) => {
  const { t: tChat } = useTranslation('tabchat')
  const [open, setOpen] = useState(false)
  const [anchorPosition, setAnchorPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setAnchorPosition({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  if (kind === 'workspace' || kind === 'team') return <>{children}</>

  return (
    <>
      <div onContextMenu={handleContextMenu}>{children}</div>
      <ContextMenu open={open} onClose={close} anchorPosition={anchorPosition}>
        {(kind === 'dm' || kind === 'im-group') && (
          <DMMenuItems rawId={rawId} pinned={pinned} muted={muted} tChat={tChat} />
        )}
      </ContextMenu>
    </>
  )
}

function DMMenuItems({
  rawId, pinned, muted, tChat,
}: {
  rawId: string
  pinned: boolean
  muted: boolean
  tChat: (key: string) => string
}) {
  const handleTogglePin = async () => {
    try {
      const result = await togglePin(rawId, !pinned)
      useIMStore.getState().updateConversation(rawId, result)
    } catch (err) {
      console.warn('[SpaceContextMenu] togglePin failed:', err)
    }
  }

  const handleToggleMute = async () => {
    try {
      const result = await toggleMute(rawId, !muted)
      useIMStore.getState().updateConversation(rawId, { is_muted: result.muted })
    } catch (err) {
      console.warn('[SpaceContextMenu] toggleMute failed:', err)
    }
  }

  const handleMarkRead = async () => {
    try {
      await markRead(rawId)
      useIMStore.getState().markAsRead(rawId)
    } catch (err) {
      console.warn('[SpaceContextMenu] markRead failed:', err)
    }
  }

  return (
    <>
      <ContextMenuItem
        icon={pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        label={pinned ? tChat('unpin') : tChat('pin')}
        onClick={() => void handleTogglePin()}
      />
      <ContextMenuItem
        icon={muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
        label={muted ? tChat('unmute') : tChat('mute')}
        onClick={() => void handleToggleMute()}
      />
      <ContextMenuItem
        icon={<CheckCheck className="h-4 w-4" />}
        label={tChat('markAllRead')}
        onClick={() => void handleMarkRead()}
      />
    </>
  )
}
