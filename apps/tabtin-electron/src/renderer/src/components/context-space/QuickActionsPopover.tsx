/**
 * QuickActionsPopover — 快捷创建资源的弹出菜单
 *
 * 由 SidebarHeader 和 ContextHome 共享，避免重复渲染相同的 Popover 结构。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button, Popover, PopoverTrigger, PopoverContent } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSpaceApps } from '@stores/useSpaceApps'
import { contextRegistry } from './registry'
import type { CreateResourceHandler } from './hooks/createResourceTypes'
import { useSpaceContextState } from './SpaceContextAreaContext'

interface QuickActionsPopoverProps {
  spaceId: string
  createHandlers: Record<string, CreateResourceHandler>
  align?: 'start' | 'center' | 'end'
}

export const QuickActionsPopover: React.FC<QuickActionsPopoverProps> = React.memo(({
  spaceId,
  createHandlers,
  align = 'end',
}) => {
  const { t } = useTranslation('context')
  const [open, setOpen] = useState(false)
  const quickActions = useMemo(() => contextRegistry.getQuickActions(), [])
  const { creatingAppIds } = useSpaceContextState()
  const spaceApps = useSpaceApps(s => s.appsBySpace[spaceId])
  const isAppEnabled = useCallback((appId: string | undefined) => {
    if (!appId || !spaceApps) return true
    return spaceApps.find(a => a.id === appId)?.enabled ?? true
  }, [spaceApps])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 w-7 p-0">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[160px] p-1" sideOffset={8}>
        <div className="flex flex-col">
          {quickActions.map(handler => {
            const appId = handler.appId ?? (handler.type as string)
            const isCreating = creatingAppIds.has(appId)
            const disabled = !isAppEnabled(appId) || isCreating
            return (
              <button
                key={appId}
                type="button"
                disabled={disabled}
                aria-busy={isCreating || undefined}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-30 disabled:pointer-events-none"
                onClick={() => { createHandlers[appId]?.(); setOpen(false) }}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                  {isCreating
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : handler.quickAction.icon}
                </span>
                <span className="text-body text-foreground/80">
                  {t(handler.quickAction.shortLabelKey ?? handler.quickAction.labelKey)}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
})
QuickActionsPopover.displayName = 'QuickActionsPopover'
