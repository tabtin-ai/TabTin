/**
 * VaultList —— 通用 master list。
 *
 * 接受统一的 VaultRow[]，支持：
 *  - 单选 + 选中态左侧 accent 竖线
 *  - 键盘 ↑ ↓ 导航
 *  - 选中行自动滚动到可视区
 *  - 加载 / 空 / 筛选无结果三种状态
 *
 * 不依赖任何业务数据形态——业务 panel 通过 `VaultRow` 映射后传入。
 */

import React, { useEffect, useRef } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { AlertTriangle, CircleSlash } from 'lucide-react'
import { VaultFavicon } from '../credentials/VaultFavicon'
import type { VaultRow } from './types'
import { SETTINGS_HINT } from '../../settingsUi'

interface VaultListProps<T> {
  rows: VaultRow<T>[]
  selectedId: string | null
  onSelect: (id: string) => void
  isLoading: boolean
  /** 全局总数（用于区分"没数据" vs "筛选无结果"） */
  totalCount: number
  /** 当前是否处在筛选 / 搜索态 */
  filterActive: boolean
  /** 列表为空时的 placeholder（外层一般已用 VaultEmpty，所以这里只对 totalCount > 0 才走） */
  emptyHint?: string
}

export function VaultList<T>({
  rows,
  selectedId,
  onSelect,
  isLoading,
  totalCount,
  filterActive,
  emptyHint,
}: VaultListProps<T>) {
  const { t } = useTranslation('settings')
  const listRef = useRef<HTMLDivElement>(null)

  const handleKey = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const idx = rows.findIndex((r) => r.id === selectedId)
    const next =
      e.key === 'ArrowDown'
        ? Math.min(idx + 1, rows.length - 1)
        : Math.max(idx - 1, 0)
    if (next !== idx && next >= 0) onSelect(rows[next].id)
  }

  useEffect(() => {
    if (!selectedId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-row-id="${CSS.escape(selectedId)}"]`)
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (isLoading && totalCount === 0) {
    return (
      <div className="px-2 py-3">
        <ManagementCardListSkeleton count={6} />
      </div>
    )
  }

  if (totalCount === 0) {
    return null // 外层 VaultEmpty 接管
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className={SETTINGS_HINT}>
          {filterActive
            ? t('vault.list.filteredEmpty', { defaultValue: '当前筛选下没有匹配项' })
            : emptyHint ?? t('vault.list.empty', { defaultValue: '暂无项目' })}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className="h-full overflow-y-auto scrollbar-hover focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKey}
      role="listbox"
    >
      <div className="py-1">
        {rows.map((row) => {
          const active = row.id === selectedId
          const warning = row.badges?.find((b) => b.kind === 'warning')
          const disabled = row.badges?.find((b) => b.kind === 'disabled')
          return (
            <button
              key={row.id}
              type="button"
              data-row-id={row.id}
              onClick={() => onSelect(row.id)}
              className={cn(
                'group relative w-full flex items-center gap-3 pl-3 pr-3 py-2 text-left transition-colors',
                active ? 'bg-accent/[0.08]' : 'hover:bg-muted/30',
              )}
              role="option"
              aria-selected={active}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent" aria-hidden="true" />
              )}
              <VaultFavicon host={row.faviconKey} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={cn('truncate text-body', disabled ? 'text-muted-foreground/60' : 'text-foreground')}>
                    {row.primary}
                  </span>
                  {row.kindIcon && (
                    <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
                      {row.kindIcon}
                    </span>
                  )}
                </div>
                <div className={cn(SETTINGS_HINT, 'mt-0.5 truncate')}>{row.secondary}</div>
              </div>
              {warning && (
                <span
                  className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning/15 text-warning"
                  title={warning.label}
                >
                  <AlertTriangle className="h-3 w-3" />
                </span>
              )}
              {disabled && (
                <span
                  className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/60"
                  title={disabled.label}
                >
                  <CircleSlash className="h-3 w-3" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
