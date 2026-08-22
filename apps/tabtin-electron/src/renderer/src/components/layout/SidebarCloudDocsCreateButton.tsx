/**
 * 云文档侧栏新建 icon button（hover / click 均可打开菜单）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui'
import { contextRegistry } from '@components/context-space/registry'
import { createCloudResourceInFolder } from '@components/context-space/registry/homeSections/createCloudResourceInFolder'
import type { CreateResourceHandler, CreateResourceOptions } from '@components/context-space/hooks/useCreateHandlers'
import { cn } from '@utils/cn'
import {
  SIDEBAR_CHROME_ACTION,
  SIDEBAR_CHROME_ICON_SIZE,
  SIDEBAR_ICON_STROKE,
} from './sidebarUi'

/** 与云盘画布新建菜单同节奏：略延迟打开，关闭留缓冲避免闪退 */
const CREATE_MENU_OPEN_DELAY_MS = 180
const CREATE_MENU_CLOSE_DELAY_MS = 220

interface SidebarCloudDocsCreateButtonProps {
  onCreateResource: (appId: string, options?: CreateResourceOptions) => void
  onImportFeishu?: () => void
  className?: string
}

export const SidebarCloudDocsCreateButton: React.FC<SidebarCloudDocsCreateButtonProps> = ({
  onCreateResource,
  onImportFeishu,
  className,
}) => {
  const { t } = useTranslation(['context', 'sidebar'])
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const createMenuOpenRef = useRef(false)
  const createMenuHoveringRef = useRef(false)
  const createMenuOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const createHandlers = useMemo(() => {
    const wrap = (appId: string): CreateResourceHandler => (options?: CreateResourceOptions) => {
      onCreateResource(appId, options)
    }
    return {
      tabdoc: wrap('tabdoc'),
      tabdata: wrap('tabdata'),
    } satisfies Record<string, CreateResourceHandler>
  }, [onCreateResource])

  const cloudQuickActions = useMemo(
    () => contextRegistry.getQuickActions().filter(handler => {
      const appId = handler.appId ?? (handler.type as string)
      return appId === 'tabdoc' || appId === 'tabdata'
    }),
    [],
  )

  const clearCreateMenuTimers = useCallback(() => {
    if (createMenuOpenTimerRef.current != null) {
      clearTimeout(createMenuOpenTimerRef.current)
      createMenuOpenTimerRef.current = null
    }
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
  }, [])

  const setCreateMenuOpenSafe = useCallback((open: boolean) => {
    createMenuOpenRef.current = open
    setCreateMenuOpen(open)
  }, [])

  const scheduleOpenCreateMenu = useCallback(() => {
    createMenuHoveringRef.current = true
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
    if (createMenuOpenRef.current || createMenuOpenTimerRef.current != null) return
    createMenuOpenTimerRef.current = setTimeout(() => {
      createMenuOpenTimerRef.current = null
      if (!createMenuHoveringRef.current) return
      setCreateMenuOpenSafe(true)
    }, CREATE_MENU_OPEN_DELAY_MS)
  }, [setCreateMenuOpenSafe])

  const scheduleCloseCreateMenu = useCallback(() => {
    createMenuHoveringRef.current = false
    if (createMenuOpenTimerRef.current != null) {
      clearTimeout(createMenuOpenTimerRef.current)
      createMenuOpenTimerRef.current = null
    }
    if (createMenuCloseTimerRef.current != null) return
    createMenuCloseTimerRef.current = setTimeout(() => {
      createMenuCloseTimerRef.current = null
      if (createMenuHoveringRef.current) return
      setCreateMenuOpenSafe(false)
    }, CREATE_MENU_CLOSE_DELAY_MS)
  }, [setCreateMenuOpenSafe])

  const keepCreateMenuOpen = useCallback(() => {
    createMenuHoveringRef.current = true
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
    if (!createMenuOpenRef.current) setCreateMenuOpenSafe(true)
  }, [setCreateMenuOpenSafe])

  const openCreateMenuOnClick = useCallback(() => {
    clearCreateMenuTimers()
    createMenuHoveringRef.current = true
    setCreateMenuOpenSafe(true)
  }, [clearCreateMenuTimers, setCreateMenuOpenSafe])

  useEffect(() => () => clearCreateMenuTimers(), [clearCreateMenuTimers])

  const createActionLabel = t('home.assetBrowser.createAction', { defaultValue: '新建' })
  const externalResourcesLabel = t('home.assetBrowser.externalResources', { defaultValue: '外部资源' })
  const feishuLabel = t('home.assetBrowser.feishu', { defaultValue: '飞书' })

  return (
    <DropdownMenu
      modal={false}
      open={createMenuOpen}
      onOpenChange={(open) => {
        clearCreateMenuTimers()
        if (!open) createMenuHoveringRef.current = false
        setCreateMenuOpenSafe(open)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            SIDEBAR_CHROME_ACTION,
            'outline-none focus:outline-none focus-visible:outline-none',
            createMenuOpen && 'bg-foreground/[0.06] text-foreground dark:bg-foreground/[0.08]',
            className,
          )}
          aria-label={createActionLabel}
          aria-haspopup="menu"
          aria-expanded={createMenuOpen}
          title={createActionLabel}
          data-testid="cloud-docs-sidebar-create"
          onClick={openCreateMenuOnClick}
          onPointerEnter={scheduleOpenCreateMenu}
          onPointerLeave={scheduleCloseCreateMenu}
        >
          <Plus size={SIDEBAR_CHROME_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[168px]"
        sideOffset={4}
        onPointerEnter={keepCreateMenuOpen}
        onPointerLeave={scheduleCloseCreateMenu}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        {cloudQuickActions.map(handler => {
          const appId = handler.appId ?? (handler.type as string)
          return (
            <DropdownMenuItem
              key={appId}
              className="gap-2"
              onSelect={() => {
                createCloudResourceInFolder(createHandlers, appId, null)
                setCreateMenuOpenSafe(false)
              }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                {handler.quickAction.icon}
              </span>
              <span className="text-body text-foreground/80">
                {t(handler.quickAction.shortLabelKey ?? handler.quickAction.labelKey)}
              </span>
            </DropdownMenuItem>
          )
        })}
        {onImportFeishu ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-caption text-muted-foreground/60">
              {externalResourcesLabel}
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => {
                setCreateMenuOpenSafe(false)
                onImportFeishu()
              }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                <Link2 className="h-3.5 w-3.5" />
              </span>
              <span className="text-body text-foreground/80">{feishuLabel}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

SidebarCloudDocsCreateButton.displayName = 'SidebarCloudDocsCreateButton'
