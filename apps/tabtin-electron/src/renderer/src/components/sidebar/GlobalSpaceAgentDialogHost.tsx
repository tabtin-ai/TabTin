/**
 * GlobalSpaceAgentDialogHost — 挂载在 AppLayout 的全局 CreateSpaceDialog 宿主
 */

import React from 'react'
import { CreateSpaceDialog } from '@components/sidebar/NewSpaceButton'
import { useSpaceAgentDialogStore } from '@stores/useSpaceAgentDialogStore'

export const GlobalSpaceAgentDialogHost: React.FC = () => {
  const isOpen = useSpaceAgentDialogStore((s) => s.isOpen)
  const mode = useSpaceAgentDialogStore((s) => s.mode)
  const spaceId = useSpaceAgentDialogStore((s) => s.spaceId)
  const daemonTarget = useSpaceAgentDialogStore((s) => s.daemonTarget)
  const setOpen = useSpaceAgentDialogStore((s) => s.setOpen)

  return (
    <CreateSpaceDialog
      open={isOpen}
      onOpenChange={setOpen}
      mode={mode}
      spaceId={spaceId}
      daemonTarget={daemonTarget}
    />
  )
}
