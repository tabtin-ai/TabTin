import React from 'react'
import { cn } from '@tabtin/smartsheet-ui'
import { Lock, Pin } from 'lucide-react'
import { VIEW_TYPE_ICONS } from './viewTypeIcons'

interface ViewLike {
  id: string
  name: string
  view_type: string
  is_locked?: boolean
}

export interface ViewTabButtonProps {
  view: ViewLike
  isActive: boolean
  isPinned: boolean
  isLoading: boolean
  isRenaming: boolean
  isRenamingSubmitting: boolean
  renameDraftName: string
  renameInputRef: React.MutableRefObject<HTMLInputElement | null>
  onSelect: () => void
  onBeginRename: () => void
  onOpenContextMenu: () => void
  onRenameDraftChange: (value: string) => void
  onCommitRename: () => void
  /** 失焦提交；默认走 onCommitRename。菜单触发重命名时应接带 blur-guard 的路径 */
  onBlurRename?: () => void
  onCancelRename: () => void
  onRenameInputFocus?: () => void
  extraButtonClassName?: string
  /** 只读等场景禁止 F2 / 双击重命名 */
  canRename?: boolean
}

export const ViewTabButton: React.FC<ViewTabButtonProps> = React.memo(({
  view,
  isActive,
  isPinned,
  isLoading,
  isRenaming,
  isRenamingSubmitting,
  renameDraftName,
  renameInputRef,
  onSelect,
  onBeginRename,
  onOpenContextMenu,
  onRenameDraftChange,
  onCommitRename,
  onBlurRename,
  onCancelRename,
  onRenameInputFocus,
  extraButtonClassName,
  canRename = true,
}) => (
  <button
    type="button"
    onClick={() => { if (!isRenaming) onSelect() }}
    disabled={isLoading}
    onDoubleClick={() => {
      if (!canRename || isLoading || !isActive) return
      onBeginRename()
    }}
    onKeyDown={event => {
      if (isLoading || isRenaming) return
      if (event.key === 'F2') {
        if (!canRename) return
        event.preventDefault()
        onBeginRename()
        return
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        onOpenContextMenu()
      }
    }}
    className={cn(
      'flex select-none items-center gap-1 rounded px-1.5 py-0.5 transition-all duration-120',
      isActive
        ? 'bg-accent/20 text-foreground'
        : 'text-muted-foreground hover:bg-accent/8 hover:text-foreground',
      extraButtonClassName,
    )}
  >
    <span className={cn('flex-shrink-0 [&_svg]:h-3 [&_svg]:w-3', isActive ? 'text-foreground' : 'text-muted-foreground')}>
      {VIEW_TYPE_ICONS[view.view_type] ?? VIEW_TYPE_ICONS.grid}
    </span>

    {isRenaming ? (
      <input
        ref={node => { renameInputRef.current = node }}
        value={renameDraftName}
        autoFocus
        onChange={event => onRenameDraftChange(event.target.value)}
        onFocus={event => {
          event.currentTarget.select()
          onRenameInputFocus?.()
        }}
        onClick={event => event.stopPropagation()}
        onBlur={() => {
          const handler = onBlurRename ?? onCommitRename
          // 推迟到 macrotask：若同轮又被 focus 回来（菜单 teardown / guard refocus），则跳过提交
          window.setTimeout(() => {
            if (renameInputRef.current && document.activeElement === renameInputRef.current) {
              return
            }
            handler()
          }, 0)
        }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommitRename()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancelRename()
          }
        }}
        disabled={isRenamingSubmitting}
        className="h-5 min-w-[80px] rounded border border-border/70 bg-background px-1 text-body text-foreground outline-none"
      />
    ) : (
      <span className={cn(
        'whitespace-nowrap text-body',
        isActive ? 'font-medium text-foreground' : 'font-normal text-muted-foreground',
      )}>
        {view.name}
      </span>
    )}

    {view.is_locked && <Lock className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
    {isPinned && <Pin className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
  </button>
))
