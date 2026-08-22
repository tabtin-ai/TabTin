/**
 * 智能体空间右键菜单
 */

import React, { useState, useCallback } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
} from '@tabtin/smartsheet-ui'
import { Table, Settings2, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface AgentContextMenuProps {
  children: React.ReactNode
  spaceId?: string
  onNewTable?: () => void
  onSettings: () => void
  onShare?: () => void
}

export const AgentContextMenu: React.FC<AgentContextMenuProps> = ({
  children,
  spaceId,
  onNewTable,
  onSettings,
  onShare,
}) => {
  const { t } = useTranslation('space')
  const [open, setOpen] = useState(false)
  const [anchorPosition, setAnchorPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setAnchorPosition({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <div onContextMenu={handleContextMenu}>{children}</div>
      <ContextMenu open={open} onClose={close} anchorPosition={anchorPosition}>
        {onNewTable && (
          <>
            <ContextMenuItem
              icon={<Table className="h-4 w-4" />}
              label={t('menu.newTable')}
              onClick={() => { onNewTable() }}
            />
            <ContextMenuDivider />
          </>
        )}
        {onShare && (
          <ContextMenuItem
            icon={<Share2 className="h-4 w-4" />}
            label={t('menu.share', { defaultValue: '分享' })}
            onClick={() => { onShare() }}
          />
        )}
        <ContextMenuItem
          icon={<Settings2 className="h-4 w-4" />}
          label={t('menu.settings')}
          onClick={() => { onSettings() }}
        />
      </ContextMenu>
    </>
  )
}
