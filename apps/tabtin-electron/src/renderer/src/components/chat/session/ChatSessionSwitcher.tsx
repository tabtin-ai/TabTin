import React from 'react'
import { ChatSessionSwitcherTabs } from './ChatSessionSwitcherTabs'
import { ChatSessionSwitcherList } from './ChatSessionSwitcherList'
import { useChatSessionSwitcherOrchestration } from './useChatSessionSwitcherOrchestration'
import type { ChatSessionSwitcherProps } from './ChatSessionSwitcher.types'

export type { ChatSessionSwitcherProps } from './ChatSessionSwitcher.types'

export const ChatSessionSwitcher: React.FC<ChatSessionSwitcherProps> = (props) => {
  const {
    variant,
    className,
    style,
    listFooter,
    onSelectSession,
    onCreateSession,
    onDeleteSession,
    onForkSession,
    onRenameSession,
  } = props

  const orchestration = useChatSessionSwitcherOrchestration(props)

  if (variant === 'tabs') {
    return (
      <>
        <ChatSessionSwitcherTabs
          className={className}
          style={style}
          sortedSessions={orchestration.sortedSessions}
          currentSessionId={props.currentSessionId}
          isDraftActive={orchestration.isDraftActive}
          draftTitle={orchestration.draftTitle}
          draftEntryTitle={orchestration.draftEntryTitle}
          draftBadge={orchestration.draftBadge}
          isAlreadyOnNewTask={orchestration.isAlreadyOnNewTask}
          alreadyOnNewTaskLabel={orchestration.alreadyOnNewTaskLabel}
          suspendedSessionIds={orchestration.suspendedSessionIds}
          forkingSessionId={orchestration.forkingSessionId}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          onForkSession={onForkSession}
          onRenameSession={onRenameSession ? orchestration.actions.handleRenameRequest : undefined}
          onShareToColleague={orchestration.actions.handleOpenShareToColleague}
          onArchiveRequest={orchestration.actions.setArchiveTarget}
          getTabLabel={orchestration.getTabLabel}
          t={orchestration.t}
        />
        {orchestration.overlays}
      </>
    )
  }

  if (orchestration.isTrackerRunsOnly && orchestration.flatListItems.length === 0) {
    return null
  }

  return (
    <>
      <ChatSessionSwitcherList
        className={className}
        isTrackerRunsOnly={orchestration.isTrackerRunsOnly}
        isLoading={orchestration.isLoading}
        isDraftActive={orchestration.isDraftActive}
        flatListItems={orchestration.flatListItems}
        listFooter={listFooter}
        newConversationEntry={orchestration.newConversationEntry}
        listParentRef={orchestration.listVirtualizer.listParentRef}
        virtualizer={orchestration.listVirtualizer.virtualizer}
        virtualItems={orchestration.listVirtualizer.virtualItems}
        virtualRowProps={orchestration.virtualRowProps}
        t={orchestration.t}
      />
      {orchestration.overlays}
    </>
  )
}
