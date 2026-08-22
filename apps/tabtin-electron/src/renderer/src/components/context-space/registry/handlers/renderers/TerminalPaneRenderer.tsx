import React from 'react'
import { TerminalSplitContainer } from '@components/terminal/TerminalSplitContainer'

interface TerminalPaneRendererProps {
  sessionId: string
  onPaneInteraction?: () => void
}

export const TerminalPaneRenderer: React.FC<TerminalPaneRendererProps> = ({
  sessionId,
  onPaneInteraction,
}) => {
  return (
    <div
      className="h-full w-full"
      onPointerDownCapture={() => onPaneInteraction?.()}
      onFocusCapture={() => onPaneInteraction?.()}
      onKeyDownCapture={() => onPaneInteraction?.()}
    >
      <TerminalSplitContainer
        rootSessionId={sessionId}
        onPaneInteraction={onPaneInteraction}
      />
    </div>
  )
}
