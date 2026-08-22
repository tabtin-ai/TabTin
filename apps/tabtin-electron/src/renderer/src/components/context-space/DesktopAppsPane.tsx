import React, { useCallback, useMemo } from 'react'
import { Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button, toast } from '@components/ui'
import { cn } from '@utils/cn'
import {
  CANVAS_TEXT_META,
  CANVAS_TEXT_MICRO,
  CANVAS_TEXT_SECONDARY,
} from '@components/layout/canvasUi'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceContextActions, useSpaceContextState } from './SpaceContextAreaContext'
import { ContextPageHeader } from './ContextPageHeader'
import { CONTEXT_PAGE_HEADER_GAP, CONTEXT_PAGE_SHELL } from './constants'
import {
  useDesktopAppEntries,
  useGroupedDesktopAppEntries,
  usePinnedDesktopAppIds,
  type DesktopAppEntry,
} from './desktopAppsModel'
import { activateDesktopAppEntry } from './desktopAppActivation'
import { resolveAppIconPresentation, SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'

function appDistributionBadge(
  t: TFunction<'context'>,
  distribution: DesktopAppEntry['distribution'],
): { label: string; className: string } | null {
  if (distribution === 'builtin') {
    return {
      label: t('desktop.apps.badge.builtin', { defaultValue: '内置' }),
      className: 'bg-muted/30 text-muted-foreground/60',
    }
  }
  if (distribution === 'marketplace') {
    return {
      label: t('desktop.apps.badge.marketplace', { defaultValue: '应用市场' }),
      className: 'bg-accent/10 text-accent-text',
    }
  }
  return null
}

function appDescription(t: TFunction<'context'>, appId: string): string {
  const fallback = t('desktop.apps.defaultDesc', { defaultValue: '打开这个能力，放到桌面工作台使用。' })
  const descriptions: Record<string, string> = {
    'cloud-resources': t('desktop.apps.desc.cloudResources', { defaultValue: '集中管理文档、表格、演示和文件。' }),
    tabfolder: t('desktop.apps.desc.tabfolder', { defaultValue: '浏览本机目录和 本机工作空间工作目录。' }),
    tabweb: t('desktop.apps.desc.tabweb', { defaultValue: '打开网页，保存到桌面标签池。' }),
    terminal: t('desktop.apps.desc.terminal', { defaultValue: '在本机执行命令，和 Agent 工作流并行。' }),
    tabdoc: t('desktop.apps.desc.tabdoc', { defaultValue: '沉淀方案、资料和交付内容。' }),
    tabdata: t('desktop.apps.desc.tabdata', { defaultValue: '用表格整理线索、任务和结构化数据。' }),
    tabslide: t('desktop.apps.desc.tabslide', { defaultValue: '制作汇报和演示材料。' }),
    tabfiles: t('desktop.apps.desc.tabfiles', { defaultValue: '管理文件资源和交付附件。' }),
    tabsite: t('desktop.apps.desc.tabsite', { defaultValue: '管理站点和页面产物。' }),
    tabtracker: t('desktop.apps.desc.tabtracker', { defaultValue: '把周期性任务交给 Agent 跟踪。' }),
    marketplace: t('desktop.apps.desc.marketplace', { defaultValue: '发现更多工作能力与扩展。' }),
  }
  return descriptions[appId] ?? fallback
}

export const DesktopAppsPane: React.FC = () => {
  const { t } = useTranslation('context')
  const { createHandlers, onOpenAppHome } = useSpaceContextActions()
  const { spaceId } = useSpaceContextState()
  // 卡片标签只看 distribution；surface 仅用于过滤技能等非应用项。
  const spaceApps = useSpaceApps(state => state.appsBySpace[spaceId])
  const appEntries = useDesktopAppEntries(t, spaceApps)
  const groupedAppEntries = useGroupedDesktopAppEntries(appEntries, t)
  const { pinnedAppIds, pinApp, unpinApp } = usePinnedDesktopAppIds()

  const activateApp = useCallback(
    (entry: DesktopAppEntry) => activateDesktopAppEntry(entry, { createHandlers, onOpenAppHome }),
    [createHandlers, onOpenAppHome],
  )

  const togglePinned = useCallback((entry: DesktopAppEntry) => {
    if (pinnedAppIds.includes(entry.id)) {
      unpinApp(entry.id)
      toast({
        title: t('desktop.apps.unpinnedToast', {
          app: entry.label,
          defaultValue: '已从快捷入口移除「{{app}}」',
        }),
      })
      return
    }
    const removedAppId = pinApp(entry.id)
    if (removedAppId) {
      const removedApp = appEntries.find(item => item.id === removedAppId)
      toast({
        title: t('desktop.apps.pinLimitTitle', { defaultValue: '已更新快捷入口' }),
        description: t('desktop.apps.pinLimitDesc', {
          app: removedApp?.label ?? removedAppId,
          defaultValue: '最多置顶 5 个应用，已移除最早置顶的 {{app}}。',
        }),
      })
      return
    }
    toast({
      title: t('desktop.apps.pinnedToast', {
        app: entry.label,
        defaultValue: '已置顶「{{app}}」到侧栏快捷入口',
      }),
    })
  }, [appEntries, pinApp, pinnedAppIds, t, unpinApp])

  // 置顶项在组内靠前——保持单一数据源（不复制一个独立的「已置顶」分组卡，
  // 避免同一应用在页面出现两张卡）。
  const displayedGroups = useMemo(() => {
    return groupedAppEntries
      .map(group => {
        const entries = group.entries
          .slice()
          .sort(
            (a, b) =>
              (pinnedAppIds.includes(b.id) ? 1 : 0) - (pinnedAppIds.includes(a.id) ? 1 : 0),
          )
        return { ...group, entries }
      })
      .filter(group => group.entries.length > 0)
  }, [groupedAppEntries, pinnedAppIds])

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className={CONTEXT_PAGE_SHELL}>
        <ContextPageHeader
          icon={<SidebarTypeEmoji appIdOrType="desktop-apps" className="h-10 w-10" />}
          iconSurface="none"
          title={t('desktop.apps.catalogTitle', { defaultValue: '更多应用' })}
          titleAs="h1"
          description={t('desktop.apps.catalogSubtitle', {
            defaultValue: '按类别浏览全部应用。点图钉可置顶到侧栏快捷入口。',
          })}
        />

        <div className={cn(CONTEXT_PAGE_HEADER_GAP, 'space-y-8')}>
          {displayedGroups.map(group => (
            <section key={group.id}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-subtitle font-medium text-foreground">{group.label}</h2>
                <span className={CANVAS_TEXT_META}>
                  {t('desktop.apps.groupCount', { count: group.entries.length, defaultValue: '{{count}} 个应用' })}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-3">
                {group.entries.map(entry => {
                  const pinned = pinnedAppIds.includes(entry.id)
                  const badge = appDistributionBadge(t, entry.distribution)
                  return (
                    <div
                      key={entry.id}
                      data-testid="desktop-app-card"
                      className={cn(
                        'group flex flex-col rounded-interactive p-4 transition-colors',
                        'bg-foreground/[0.03] hover:bg-foreground/[0.05]',
                        'dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.07]',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={cn(
                          'flex h-14 w-14 shrink-0 items-center justify-center rounded-[13px] text-foreground [&>span]:h-12 [&>span]:w-12',
                          resolveAppIconPresentation(entry.id) !== 'selfContained'
                            && 'bg-foreground/[0.04] dark:bg-foreground/[0.06]',
                        )}>
                          {entry.icon}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            className={cn(
                              'flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive transition-colors hover:bg-foreground/[0.06]',
                              pinned
                                ? 'text-accent-text'
                                : 'text-muted-foreground/60 hover:text-foreground',
                            )}
                            aria-label={pinned
                              ? t('desktop.apps.unpinShortcut', { defaultValue: '取消快捷入口' })
                              : t('desktop.apps.pinShortcut', { defaultValue: '置顶到快捷入口' })}
                            title={pinned
                              ? t('desktop.apps.unpinShortcut', { defaultValue: '取消快捷入口' })
                              : t('desktop.apps.pinShortcut', { defaultValue: '置顶到快捷入口' })}
                            onClick={() => togglePinned(entry)}
                          >
                            <Pin className="h-3.5 w-3.5" />
                          </button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="shrink-0 border border-border/60 bg-background hover:bg-background active:bg-background"
                            onClick={() => activateApp(entry)}
                          >
                            {t('desktop.apps.open', { defaultValue: '打开' })}
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 flex min-w-0 items-center gap-1">
                        <span className="truncate text-body font-medium text-foreground">{entry.label}</span>
                        {badge && (
                          <span className={cn(
                            CANVAS_TEXT_MICRO,
                            'shrink-0 rounded-interactive px-1.5 py-0.5',
                            badge.className,
                          )}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      <div className={cn('mt-1 line-clamp-2', CANVAS_TEXT_SECONDARY)}>
                        {appDescription(t, entry.id)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

DesktopAppsPane.displayName = 'DesktopAppsPane'
