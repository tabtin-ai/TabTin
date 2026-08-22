/**
 * SortableRuleRow — 可拖拽规则行骨架
 *
 * 封装 @dnd-kit/sortable 的通用行模式：
 *   [拖拽手柄] [children] [删除按钮]
 *
 * 从 ViewSort/Group/FilterRulesEditor 中提炼。
 *
 * @example
 * <SortableRuleRow id={rule.id} canDrag onDelete={() => removeRule(idx)}>
 *   <ComboboxSelect ... />
 *   <ComboboxSelect ... />
 * </SortableRuleRow>
 */

import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from './button'
import { cn } from '../utils/cn'
import { GripVertical, Trash2 } from 'lucide-react'

export interface SortableRuleRowProps {
  /** 唯一行 ID（传给 useSortable） */
  id: string
  /** 是否启用拖拽 */
  canDrag?: boolean
  /** 是否禁用删除按钮 */
  disabled?: boolean
  /** 删除回调 */
  onDelete?: () => void
  /** 行内容 */
  children: React.ReactNode
  /** 额外 className */
  className?: string
  /** 是否隐藏删除按钮 */
  hideDelete?: boolean
}

export const SortableRuleRow: React.FC<SortableRuleRowProps> = ({
  id,
  canDrag = false,
  disabled = false,
  onDelete,
  children,
  className,
  hideDelete = false,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canDrag })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, scaleX: 1, scaleY: 1 } : null,
    ),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('flex items-center gap-2', className)}
    >
      {canDrag && (
        <div
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </div>
      )}

      {children}

      {!hideDelete && (
        <>
          {/* Spacer */}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={disabled}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  )
}

SortableRuleRow.displayName = 'SortableRuleRow'
