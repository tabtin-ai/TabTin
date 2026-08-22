import React from 'react'
import { Search } from 'lucide-react'
import { Input } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SEARCH_WIDTH,
  CONTEXT_PAGE_TOOLBAR_SEARCH_INPUT,
} from './constants'

interface ContextPageToolbarProps {
  /** 主列表操作按钮：新建（主）→ 次级；渲染在搜索框左侧 */
  actions?: React.ReactNode
  /** 传入后显示 320px 搜索框 */
  searchPlaceholder?: string
  searchValue?: string
  onSearchChange?: (value: string) => void
  searchAriaLabel?: string
  /** 紧挨搜索框右侧（状态下拉等） */
  searchTrailing?: React.ReactNode
  /** 工具行最右侧（范围切换、视图切换等） */
  trailing?: React.ReactNode
  className?: string
  /** 是否带页头间距；嵌在已有工具区时可关 */
  withHeaderGap?: boolean
  searchInputClassName?: string
}

/**
 * 应用主列表统一工具行：操作按钮 → 320px 搜索框 → searchTrailing →（弹性空白）→ trailing 居右。
 * 按钮组内顺序：新建（default / 主题色）→ 次级（outline）→ 搜索。
 */
export const ContextPageToolbar: React.FC<ContextPageToolbarProps> = ({
  actions,
  searchPlaceholder,
  searchValue = '',
  onSearchChange,
  searchAriaLabel,
  searchTrailing,
  trailing,
  className,
  withHeaderGap = true,
  searchInputClassName,
}) => {
  const showSearch = Boolean(searchPlaceholder && onSearchChange)

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2',
        withHeaderGap && CONTEXT_PAGE_HEADER_GAP,
        className,
      )}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {actions != null ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
        {showSearch ? (
          <div className={cn('relative shrink-0', CONTEXT_PAGE_SEARCH_WIDTH)}>
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={e => onSearchChange?.(e.target.value)}
              aria-label={searchAriaLabel ?? searchPlaceholder}
              className={cn(CONTEXT_PAGE_TOOLBAR_SEARCH_INPUT, searchInputClassName)}
            />
          </div>
        ) : null}
        {searchTrailing != null ? (
          <div className="flex shrink-0 items-center gap-1.5">{searchTrailing}</div>
        ) : null}
      </div>
      {trailing != null ? (
        <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-1.5 overflow-x-auto">
          {trailing}
        </div>
      ) : null}
    </div>
  )
}
