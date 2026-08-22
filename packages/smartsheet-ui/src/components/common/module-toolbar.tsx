/**
 * ModuleToolbar — 通用模块工具栏组件
 *
 * 从 GridToolbar / DocEditorView status bar / InsertToolbar 中提炼的共性布局模式。
 * 提供标准的「左-中-右」三分区水平工具栏，内置分隔符。
 *
 * @example
 * // Table 工具栏
 * <ModuleToolbar
 *   left={<><UndoRedoButtons /><ToolbarSeparator /><FilterButton /></>}
 *   right={<><SearchButton /><ToolbarSeparator /><SaveStateIndicator state="saved" /></>}
 * />
 *
 * // Docs 状态栏
 * <ModuleToolbar
 *   height={32}
 *   left={<SaveStateIndicator state={saveState} />}
 *   right={<><WordCount /><ToolbarSeparator /><ExportButton /><HistoryButton /></>}
 * />
 *
 * // Design 插入工具栏
 * <ModuleToolbar
 *   left={<><InsertTextBtn /><InsertImageBtn /><ToolbarSeparator /><InsertShapeBtn /></>}
 *   right={<SaveStateIndicator state="dirty" variant="dot" />}
 * />
 */

import * as React from 'react'
import { cn } from '../../utils/cn'

export interface ModuleToolbarProps {
  /** 左侧区域（操作按钮、状态等） */
  left?: React.ReactNode
  /** 中间区域（标题、面包屑等） */
  center?: React.ReactNode
  /** 右侧区域（搜索、设置、保存状态等） */
  right?: React.ReactNode
  /** 工具栏高度（px），默认 40 */
  height?: number
  /** 是否显示底部边框（默认 true） */
  bordered?: boolean
  /** 额外 className */
  className?: string
  /** 内容区域的 className */
  contentClassName?: string
}

/**
 * 工具栏分隔符。
 *
 * @example
 * <ToolbarSeparator />
 */
export const ToolbarSeparator: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('mx-1 h-4 w-px bg-border', className)} />
)

ToolbarSeparator.displayName = 'ToolbarSeparator'

/**
 * 工具栏按钮（统一尺寸和交互样式）。
 *
 * @example
 * <ToolbarButton icon={<Undo2 className="h-3.5 w-3.5" />} label="撤销" onClick={undo} disabled={!canUndo} />
 */
export interface ToolbarButtonProps {
  /** 图标 */
  icon: React.ReactNode
  /** 标签（title 提示） */
  label?: string
  /** 快捷键提示（附加到 title） */
  shortcut?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 是否激活（高亮状态） */
  active?: boolean
  /** 点击回调 */
  onClick?: () => void
  /** 额外 className */
  className?: string
}

export const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  icon,
  label,
  shortcut,
  disabled = false,
  active = false,
  onClick,
  className,
}) => {
  const title = label
    ? shortcut
      ? `${label} (${shortcut})`
      : label
    : undefined

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-primary/10 text-primary',
        className,
      )}
    >
      {icon}
    </button>
  )
}

ToolbarButton.displayName = 'ToolbarButton'

/**
 * 工具栏按钮组（将多个按钮紧密排列）。
 *
 * @example
 * <ToolbarGroup>
 *   <ToolbarButton icon={<Bold />} label="加粗" />
 *   <ToolbarButton icon={<Italic />} label="斜体" />
 * </ToolbarGroup>
 */
export const ToolbarGroup: React.FC<{
  children: React.ReactNode
  className?: string
}> = ({ children, className }) => (
  <div className={cn('flex items-center gap-0.5', className)}>{children}</div>
)

ToolbarGroup.displayName = 'ToolbarGroup'

/**
 * 通用模块工具栏。
 *
 * 所有模块的顶部/底部工具栏（Table Toolbar、Docs Status Bar、Design Insert Toolbar）
 * 都应使用此组件作为容器。
 */
export const ModuleToolbar: React.FC<ModuleToolbarProps> = ({
  left,
  center,
  right,
  height = 40,
  bordered = true,
  className,
  contentClassName,
}) => {
  return (
    <div
      className={cn(
        'flex items-center flex-shrink-0',
        bordered && 'border-b',
        className,
      )}
      style={{ height }}
    >
      <div
        className={cn(
          'flex w-full items-center justify-between px-2 gap-2',
          contentClassName,
        )}
      >
        {/* Left */}
        {left && (
          <div className="flex items-center gap-1 min-w-0 flex-shrink-0">
            {left}
          </div>
        )}

        {/* Center */}
        {center && (
          <div className="flex items-center justify-center flex-1 min-w-0">
            {center}
          </div>
        )}

        {/* Spacer when no center */}
        {!center && <div className="flex-1" />}

        {/* Right */}
        {right && (
          <div className="flex items-center gap-1 min-w-0 flex-shrink-0">
            {right}
          </div>
        )}
      </div>
    </div>
  )
}

ModuleToolbar.displayName = 'ModuleToolbar'
