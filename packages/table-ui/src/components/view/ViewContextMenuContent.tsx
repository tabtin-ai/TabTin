import React from 'react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@tabtin/smartsheet-ui'
import { Copy, Lock, Pin, PinOff, Unlock } from 'lucide-react'
import {
  isViewLockToggleDisabled,
  isViewMutationMenuDisabled,
} from '../../utils/viewLock'

interface ViewLike {
  id: string
  name: string
  view_type?: string
  is_locked?: boolean
  is_default?: boolean
}

export interface ViewContextMenuContentProps {
  view: ViewLike
  isPinned: boolean
  isFirstView: boolean
  canDelete: boolean
  isBusy: boolean
  tableId: string | null
  translate: (key: string, options?: Record<string, unknown>) => string
  onRename: () => void
  onEdit: () => void
  onDuplicate: () => void
  onTogglePin: () => void
  onToggleLock: () => void
  onSetFirstView: () => void
  onDelete: () => void
  onCloseAutoFocus?: (event: Event) => void
  extraItems?: React.ReactNode
  /** 表级只读：禁用所有会写库/写视图的菜单项（含解锁） */
  isReadonly?: boolean
  /**
   * 当前视图已锁定：禁用重命名/编辑/复制/置顶/设首页/删除等，
   * 但解锁（onToggleLock）仍可点，避免用户无法解除锁定。
   */
  isViewLocked?: boolean
}

export const ViewContextMenuContent: React.FC<ViewContextMenuContentProps> = ({
  view,
  isPinned,
  isFirstView,
  canDelete,
  isBusy,
  tableId,
  translate: t,
  onRename,
  onEdit,
  onDuplicate,
  onTogglePin,
  onToggleLock,
  onSetFirstView,
  onDelete,
  onCloseAutoFocus,
  extraItems,
  isReadonly = false,
  isViewLocked = false,
}) => {
  const mutationsDisabled = isViewMutationMenuDisabled(isReadonly, isViewLocked)
  const lockToggleDisabled = isViewLockToggleDisabled(isReadonly, isBusy)

  return (
    <DropdownMenuContent align="start" onCloseAutoFocus={onCloseAutoFocus}>
      <DropdownMenuLabel>{view.name}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={onRename} disabled={mutationsDisabled}>
        {t('view:switcher.rename')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onEdit} disabled={mutationsDisabled}>
        {t('view:switcher.edit')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onDuplicate} disabled={mutationsDisabled || isBusy}>
        <Copy className="h-3.5 w-3.5" />
        {t('view:switcher.duplicate')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onTogglePin} disabled={mutationsDisabled || !tableId}>
        {isPinned ? (
          <PinOff className="h-3.5 w-3.5" />
        ) : (
          <Pin className="h-3.5 w-3.5" />
        )}
        {isPinned ? t('view:switcher.unpin') : t('view:switcher.pin')}
      </DropdownMenuItem>
      {extraItems}
      {/* 解锁入口：仅表级只读 / busy 时禁用，不受视图锁定阻挡 */}
      <DropdownMenuItem onSelect={onToggleLock} disabled={lockToggleDisabled}>
        {view.is_locked ? (
          <Unlock className="h-3.5 w-3.5" />
        ) : (
          <Lock className="h-3.5 w-3.5" />
        )}
        {view.is_locked ? t('view:switcher.unlock') : t('view:switcher.lock')}
      </DropdownMenuItem>
      {!isFirstView && (
        <DropdownMenuItem onSelect={onSetFirstView} disabled={mutationsDisabled || isBusy}>
          {t('view:switcher.setFirst')}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={onDelete}
        disabled={mutationsDisabled || !canDelete}
      >
        {t('view:switcher.delete')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
