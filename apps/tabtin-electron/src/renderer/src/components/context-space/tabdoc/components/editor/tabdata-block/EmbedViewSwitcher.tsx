import React, { useCallback, useEffect, useRef, useState } from 'react'
import { VIEW_SWITCH_TIMEOUT_MS } from '@tabtin/tabdoc-ui/editor'
import { useViewStore } from '@stores/useViewStore'
import { Button, cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, toast } from '@tabtin/smartsheet-ui'
import { Grid2x2, Columns3, CalendarDays, LayoutGrid, Layers, ClipboardList } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ViewType } from '@tabtin/table-core'

const VIEW_TYPE_ICON: Partial<Record<ViewType, React.ElementType>> = {
  grid: Grid2x2,
  kanban: Columns3,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  flashcard: Layers,
  form: ClipboardList,
}

const VIEW_TYPE_I18N_KEY: Partial<Record<ViewType, string>> = {
  grid: 'tabdataBlock.viewTypeGrid',
  kanban: 'tabdataBlock.viewTypeKanban',
  calendar: 'tabdataBlock.viewTypeCalendar',
  gallery: 'tabdataBlock.viewTypeGallery',
  flashcard: 'tabdataBlock.viewTypeFlashcard',
  form: 'tabdataBlock.viewTypeForm',
}

export const EmbedViewSwitcher: React.FC = () => {
  const { t } = useTranslation(['tabdoc', 'view'])
  const views = useViewStore((state) => state.views)
  const currentViewId = useViewStore((state) => state.currentViewId)
  const selectView = useViewStore((state) => state.selectView)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const generationRef = useRef(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    }
  }, [])

  const handleSelect = useCallback(
    (viewId: string) => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      const gen = ++generationRef.current
      setSwitchingId(viewId)
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        if (gen === generationRef.current) {
          setSwitchingId(null)
          toast({ title: t('tabdoc:tabdataBlock.switchViewTimeout', { defaultValue: '切换视图超时' }), variant: 'destructive' })
        }
      }, VIEW_SWITCH_TIMEOUT_MS)
      selectView(viewId)
        .then(() => {
          if (timeoutRef.current !== null) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
          if (gen === generationRef.current) setSwitchingId(null)
        })
        .catch(() => {
          if (timeoutRef.current !== null) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
          if (gen === generationRef.current) {
            setSwitchingId(null)
            toast({ title: t('tabdoc:tabdataBlock.switchViewFailed', { defaultValue: '切换视图失败' }), variant: 'destructive' })
          }
        })
    },
    [selectView, t],
  )

  if (views.length <= 1) return null

  return (
    <div className="flex items-center gap-0.5 mr-1">
      {views.map((view) => {
        const Icon = VIEW_TYPE_ICON[view.view_type] ?? Grid2x2
        const isActive = switchingId ? view.id === switchingId : view.id === currentViewId
        const label = view.name || t(VIEW_TYPE_I18N_KEY[view.view_type] ?? 'tabdataBlock.viewTypeGrid') || view.view_type
        return (
          <TooltipProvider key={view.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={switchingId !== null}
                  aria-pressed={isActive}
                  aria-label={label}
                  className={cn(
                    'h-6 w-6 p-0 transition-colors',
                    isActive && 'bg-primary/10 text-primary',
                  )}
                  onClick={() => handleSelect(view.id)}
                >
                  <Icon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      })}
    </div>
  )
}

EmbedViewSwitcher.displayName = 'EmbedViewSwitcher'
