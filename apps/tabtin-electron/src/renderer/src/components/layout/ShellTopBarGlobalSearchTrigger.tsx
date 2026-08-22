import React, { useMemo } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { useUIStore } from '@stores/useUIStore'
import { GLOBAL_SEARCH_UI_ENABLED } from '@/utils/featureFlags'

/**
 * 顶栏居中搜索入口 — 点击 / 聚焦打开 overlay 全局搜索（Cmd+K 同源）。
 * 由 `GLOBAL_SEARCH_UI_ENABLED` / `VITE_ENABLE_GLOBAL_SEARCH_UI` 控制可见性。
 */
export function ShellTopBarGlobalSearchTrigger() {
  const { t } = useTranslation(['globalSearch', 'sidebar'])
  const setGlobalSearchOpen = useUIStore(state => state.setGlobalSearchOpen)

  const modKey = useMemo(() => {
    if (typeof navigator === 'undefined') return '⌘'
    return /Mac|Macintosh/i.test(navigator.platform || '')
      || /Mac OS X/i.test(navigator.userAgent || '')
      ? '⌘'
      : 'Ctrl'
  }, [])

  if (!GLOBAL_SEARCH_UI_ENABLED) {
    return null
  }

  const openSearch = () => setGlobalSearchOpen(true)

  return (
    <button
      type="button"
      onClick={openSearch}
      className={cn(
        'no-drag pointer-events-auto flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border/40',
        'bg-foreground/[0.03] px-2.5 text-left text-caption text-muted-foreground/70',
        'transition-colors hover:bg-foreground/[0.05] hover:text-muted-foreground/90',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30',
        'dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.08]',
      )}
      aria-label={t('globalSearch:shortcut.openSearch', { defaultValue: '打开搜索' })}
      title={t('sidebar:search.tooltip', { defaultValue: '搜索 (⌘K)' })}
      data-testid="shell-top-bar-global-search"
    >
      <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {t('globalSearch:placeholder', { defaultValue: '搜索消息、资源、Agent、Space、备忘录、IM...' })}
      </span>
      <kbd
        className="hidden shrink-0 rounded border border-border/40 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground/50 sm:inline"
        aria-hidden
      >
        {modKey}K
      </kbd>
    </button>
  )
}

ShellTopBarGlobalSearchTrigger.displayName = 'ShellTopBarGlobalSearchTrigger'
