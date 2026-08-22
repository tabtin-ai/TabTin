import React from 'react'
import { FileExplorerPane } from '@components/context-space/folder/FileExplorerPane'
import type { FolderContextKind } from '@components/context-space/folder/types'
import type { GitFlowSwitchProps } from '@components/context-space/folder/FolderHeader'
import type { ContextTabKey } from '../../types'

interface FolderPaneRendererProps {
  rootPath: string
  kind: FolderContextKind
  title: string
  revealPath?: string
  gitFlowSwitch?: GitFlowSwitchProps
  contextScopeKey?: string | null
  contextTabKey?: ContextTabKey | null
}

export const FolderPaneRenderer: React.FC<FolderPaneRendererProps> = ({
  rootPath,
  kind,
  title,
  revealPath,
  gitFlowSwitch,
  contextScopeKey,
  contextTabKey,
}) => {
  return (
    <FileExplorerPane
      rootPath={rootPath}
      kind={kind}
      title={title}
      revealPath={revealPath}
      className="h-full w-full"
      gitFlowSwitch={gitFlowSwitch}
      contextScopeKey={contextScopeKey}
      contextTabKey={contextTabKey}
    />
  )
}
