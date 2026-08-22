/**
 * VaultToolbar —— 通用顶部 toolbar。
 *
 * 两层：
 *  1. Segmented filter chip + 右侧 actions（slot, 由 panel 自定义）
 *  2. 搜索框
 *
 * 「同步」「新建」「更多」这些动作各 panel 语义不同，所以以 children 形式
 * 由 panel 自己塞进右侧 actions 区。
 */

import React from 'react'
import { Input } from '@components/ui'
import { cn } from '@utils/cn'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VaultFilterOption } from './types'
import { SETTINGS_CONTROL, SETTINGS_TEXT_MICRO } from '../../settingsUi'

interface VaultToolbarProps<F extends string> {
  filter: F
  onFilterChange: (f: F) => void
  filters: VaultFilterOption<F>[]
  search: string
  onSearchChange: (q: string) => void
  /** 右侧 actions（如 ⟳ + ⋯） */
  rightActions?: React.ReactNode
  searchPlaceholder?: string
}

export function VaultToolbar<F extends string>({
  filter,
  onFilterChange,
  filters,
  search,
  onSearchChange,
  rightActions,
  searchPlaceholder,
}: VaultToolbarProps<F>) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {filters.map((f) => {
          const active = filter === f.value
          if (f.hideWhenZero && f.count === 0) return null
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={cn(
                'h-7 inline-flex items-center gap-1.5 rounded-full px-3 transition-colors', SETTINGS_TEXT_MICRO,
                active
                  ? 'bg-foreground text-background font-medium'
                  : 'bg-muted/40 text-foreground/80 hover:bg-muted/60',
              )}
            >
              <span>{f.label}</span>
              {f.count > 0 && (
                <span
                  className={cn(
                    'tabular-nums', SETTINGS_TEXT_MICRO,
                    active ? 'text-background/80' : 'text-muted-foreground/60',
                  )}
                >
                  {f.count}
                </span>
              )}
            </button>
          )
        })}

        {rightActions && <div className="ml-auto flex items-center gap-1">{rightActions}</div>}
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder ?? t('vault.toolbar.searchPlaceholder', { defaultValue: '搜索…' })}
          className={cn(SETTINGS_CONTROL, 'pl-8')}
        />
      </div>
    </div>
  )
}
