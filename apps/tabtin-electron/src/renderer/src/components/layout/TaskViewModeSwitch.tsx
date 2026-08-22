import React from 'react'
import { Columns2, PanelLeft, PanelRight } from 'lucide-react'
import { cn } from '@utils/cn'
import {
  useSpaceViewPrefsStore,
  type TaskViewMode,
} from '@stores/useSpaceViewPrefsStore'
import { captureTaskViewModeMorph } from '@components/chat/capsule/chatCapsuleMorph'

const VIEW_OPTIONS: Array<{
  mode: TaskViewMode
  label: string
  Icon: React.FC<{ className?: string }>
}> = [
  { mode: 'chat-focus', label: '对话聚焦', Icon: PanelRight },
  { mode: 'split', label: '分屏', Icon: Columns2 },
  { mode: 'app-focus', label: '应用聚焦', Icon: PanelLeft },
]

export const TaskViewModeSwitch: React.FC<{
  scopeKey: string
  activeMode?: TaskViewMode
  className?: string
}> = React.memo(({ scopeKey, activeMode: projectedActiveMode, className }) => {
  const storedActiveMode = useSpaceViewPrefsStore(state => state.getTaskViewMode(scopeKey))
  const activeMode = projectedActiveMode ?? storedActiveMode
  const setTaskViewModeForScope = useSpaceViewPrefsStore(state => state.setTaskViewModeForScope)

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-interactive border border-border/40 bg-muted/20 p-0.5 no-drag',
        className,
      )}
      role="group"
      aria-label="任务视图"
    >
      {VIEW_OPTIONS.map(({ mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={activeMode === mode}
          onClick={() => {
            captureTaskViewModeMorph(activeMode, mode)
            setTaskViewModeForScope(scopeKey, mode)
          }}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-interactive transition-colors',
            activeMode === mode
              ? 'bg-background text-accent shadow-sm'
              : 'text-muted-foreground/60 hover:bg-background/80 hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  )
})

TaskViewModeSwitch.displayName = 'TaskViewModeSwitch'
