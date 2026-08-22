/**
 * DirtyIndicator —— NormalTab / GroupTab 共享的 tabdoc dirty 指示符
 *
 * Hover 让位策略（Triple Review 真实用户视角 P0 修复）：
 *   - error 状态 → 永不让位（保存失败是高优先级警示）
 *   - active tab/segment → 永不让位（关闭按钮一直可见，圆点也无需藏）
 *   - 其他 → hover 时让位（关闭按钮 hover 才出露，避免视觉冲突）
 *
 * 通过 dataAttributePrefix 区分 DOM 属性名：
 *   - NormalTab 默认 'tab'  → data-tab-dirty-indicator
 *   - GroupTab 传 'segment' → data-segment-dirty-indicator
 */
import { Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { TabDocDirtyIndicatorStatus } from './hooks/useTabDocDirtyIndicator'
import type { ContextTabsT } from './NormalTab'

export interface DirtyIndicatorProps {
  status: TabDocDirtyIndicatorStatus
  /** true 时不应用 group-hover:opacity-0（永不让位） */
  forceVisible: boolean
  t: ContextTabsT
  /** 'tab' → data-tab-dirty-indicator，'segment' → data-segment-dirty-indicator */
  dataAttributePrefix?: string
}

export function DirtyIndicator({
  status,
  forceVisible,
  t,
  dataAttributePrefix = 'tab',
}: DirtyIndicatorProps) {
  if (status === 'idle') return null
  const hideOnHoverClass = forceVisible ? '' : 'group-hover:opacity-0'
  const dataAttr = `data-${dataAttributePrefix}-dirty-indicator`

  if (status === 'saving') {
    return (
      <span
        className={cn(
          'ml-0.5 inline-flex items-center justify-center text-muted-foreground/80 transition-opacity',
          hideOnHoverClass,
        )}
        title={t('tab.dirtyIndicator.saving', { defaultValue: '正在保存…' })}
        aria-label={t('tab.dirtyIndicator.saving', { defaultValue: '正在保存…' })}
        {...{ [dataAttr]: status }}
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      </span>
    )
  }
  const isError = status === 'error'
  return (
    <span
      className={cn(
        'ml-0.5 inline-flex items-center justify-center w-3 transition-opacity',
        hideOnHoverClass,
      )}
      title={
        isError
          ? t('tab.dirtyIndicator.error', { defaultValue: '保存失败' })
          : t('tab.dirtyIndicator.dirty', { defaultValue: '有未保存改动' })
      }
      aria-label={
        isError
          ? t('tab.dirtyIndicator.error', { defaultValue: '保存失败' })
          : t('tab.dirtyIndicator.dirty', { defaultValue: '有未保存改动' })
      }
      {...{ [dataAttr]: status }}
    >
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          isError ? 'bg-destructive' : 'bg-foreground/80',
        )}
      />
    </span>
  )
}
