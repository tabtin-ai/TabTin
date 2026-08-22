/**
 * SpaceAppManagementPanel — Space 级应用启用/禁用管理面板
 *
 * 展示当前 Organization 已安装的所有应用，按分类分组为可折叠列表，
 * 每行提供 Toggle 开关。支持全选/全清快捷操作，乐观更新 + 异步提交。
 *
 * 乐观更新策略：维护本地 optimisticDisabled 覆盖层，
 * toggle 后立即反映 UI，异步提交后由 store 接管真实状态。
 * 若 store 更新失败（不抛错，仅 console.error），本地覆盖清除后
 * UI 自动回退到 store 中的旧状态，实现无感回滚。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Table, FileText, Palette, Presentation, Code, Video,
  Globe, Folder, FolderTree, Terminal, Bot, Target, Workflow,
  StickyNote, Globe2, Zap, Smartphone, LayoutGrid, Package,
  ChevronDown, CheckSquare, XSquare, RefreshCw,
} from 'lucide-react'
import { Button, EmptyState, ScrollArea, Switch } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSpaceApps, EMPTY_APPS, EMPTY_DISABLED_APPS, type AppInfo } from '@stores/useSpaceApps'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SETTINGS_CONTROL_SM, SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { cn } from '@utils/cn'

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

type IconComponent = React.FC<{ className?: string }>

const APP_ICON_MAP: Record<string, IconComponent> = {
  table: Table,
  'file-text': FileText,
  palette: Palette,
  presentation: Presentation,
  code: Code,
  video: Video,
  globe: Globe,
  folder: Folder,
  'folder-tree': FolderTree,
  terminal: Terminal,
  bot: Bot,
  target: Target,
  workflow: Workflow,
  'sticky-note': StickyNote,
  'globe-2': Globe2,
  zap: Zap,
  smartphone: Smartphone,
}

function resolveAppIcon(iconName: string): IconComponent {
  return APP_ICON_MAP[iconName] ?? Package
}

// ---------------------------------------------------------------------------
// Category mapping (CORE_APPS 分类来自 CONTEXT.md §六)
// ---------------------------------------------------------------------------

const APP_CATEGORY_MAP: Record<string, string> = {
  tabdata: 'data',
  tabdoc: 'creation',
  tabslide: 'creation',
  tabsite: 'creation',
  tabcode: 'development',
  tabweb: 'development',
  terminal: 'development',
  orchestration: 'intelligence',
  tabtracker: 'intelligence',
  tabfolder: 'tools',
  tabdesktop: 'tools',
}

const CATEGORY_ORDER = ['data', 'creation', 'development', 'intelligence', 'tools'] as const

function getAppCategory(appId: string): string {
  return APP_CATEGORY_MAP[appId] ?? 'tools'
}

const RUNTIME_UNAVAILABLE_APPS: Record<string, Set<string>> = {
  daemon: new Set(['tabfolder', 'tabdesktop']),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryGroup {
  id: string
  apps: AppInfo[]
}

interface Props {
  spaceId: string
  canManage?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SpaceAppManagementPanel: React.FC<Props> = ({ spaceId, canManage = true }) => {
  const { t } = useTranslation('space')
  const agent = useSpaceStore(state => state.selectedAgent)

  const allApps = useSpaceApps(s => s.appsBySpace[spaceId] ?? EMPTY_APPS)
  const runtimeType = agent?.runtime_type ?? null
  const unavailableSet = (runtimeType && RUNTIME_UNAVAILABLE_APPS[runtimeType]) || null
  const apps = useMemo(
    () => unavailableSet ? allApps.filter(a => !unavailableSet.has(a.id)) : allApps,
    [allApps, unavailableSet],
  )
  const disabledApps = useSpaceApps(s => s.disabledBySpace[spaceId] ?? EMPTY_DISABLED_APPS)
  const isLoading = useSpaceApps(s => s.loadingSpaces.has(spaceId))
  const loadSpaceApps = useSpaceApps(s => s.loadSpaceApps)
  const updateDisabledApps = useSpaceApps(s => s.updateDisabledApps)

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  /**
   * 乐观更新覆盖层。
   * 非 null 时表示有待提交的更新，UI 从此处计算启用状态；
   * 提交完成后置回 null，UI 由 store 真实状态驱动。
   */
  const [optimisticDisabled, setOptimisticDisabled] = useState<string[] | null>(null)

  const effectiveDisabled = optimisticDisabled ?? disabledApps

  useEffect(() => {
    void loadSpaceApps(spaceId)
  }, [spaceId, loadSpaceApps])

  const isAppEnabled = useCallback(
    (appId: string) => !effectiveDisabled.includes(appId),
    [effectiveDisabled],
  )

  const categoryGroups = useMemo((): CategoryGroup[] => {
    const grouped = new Map<string, AppInfo[]>()

    for (const app of apps) {
      const cat = getAppCategory(app.id)
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push(app)
    }

    return CATEGORY_ORDER
      .filter(cat => grouped.has(cat))
      .map(cat => ({ id: cat, apps: grouped.get(cat)! }))
  }, [apps])

  const enabledCount = useMemo(
    () => apps.filter(a => isAppEnabled(a.id)).length,
    [apps, isAppEnabled],
  )

  const submitDisabledApps = useCallback(
    async (newDisabled: string[]) => {
      setOptimisticDisabled(newDisabled)
      await updateDisabledApps(spaceId, newDisabled)
      setOptimisticDisabled(null)
    },
    [spaceId, updateDisabledApps],
  )

  const toggleApp = useCallback(
    (appId: string) => {
      if (!canManage) return
      const currentlyEnabled = isAppEnabled(appId)
      const newDisabled = currentlyEnabled
        ? [...effectiveDisabled, appId]
        : effectiveDisabled.filter(id => id !== appId)

      void submitDisabledApps(newDisabled)
    },
    [canManage, effectiveDisabled, isAppEnabled, submitDisabledApps],
  )

  const handleEnableAll = useCallback(() => {
    if (!canManage) return
    void submitDisabledApps([])
  }, [canManage, submitDisabledApps])

  const handleDisableAll = useCallback(() => {
    if (!canManage) return
    void submitDisabledApps(apps.map(a => a.id))
  }, [canManage, apps, submitDisabledApps])

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }, [])

  const handleRetry = useCallback(() => {
    void loadSpaceApps(spaceId)
  }, [spaceId, loadSpaceApps])

  // --- Loading state ---
  if (isLoading && apps.length === 0) {
    return (
      <div className="space-y-4">
        <SpaceSettingsSectionHeader
          marginBottomClassName="mb-0"
          title={t('appManagement.title')}
          description={t('appManagement.loading')}
        />
        <ManagementCardListSkeleton count={6} />
      </div>
    )
  }

  // --- Empty state ---
  if (!isLoading && apps.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <SpaceSettingsSectionHeader
          title={t('appManagement.title')}
          description={t('appManagement.subtitle')}
        />
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<LayoutGrid className="h-8 w-8 text-muted-foreground/60" />}
            title={t('appManagement.empty')}
            description={t('appManagement.emptyDesc')}
            action={
              <Button variant="outline" onClick={handleRetry} className={cn(SETTINGS_CONTROL_SM, 'mt-2 gap-1.5')}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t('appManagement.retry')}
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 mb-4 space-y-1">
        <SpaceSettingsSectionHeader
          marginBottomClassName="mb-0"
          title={t('appManagement.title')}
          description={t('appManagement.subtitle')}
        />
        {unavailableSet && unavailableSet.size > 0 && (
          <p className="text-caption text-foreground/60">
            {runtimeType === 'daemon'
              ? t('appManagement.runtimeFilterDaemon', { defaultValue: '服务器 Agent 不支持部分应用，已从列表中隐藏' })
              : t('appManagement.runtimeFilterGeneric', { defaultValue: `${runtimeType} 型 Agent 不支持部分应用，已从列表中隐藏`, type: runtimeType })}
          </p>
        )}
      </div>

      {/* Quick actions */}
      {canManage && (
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <Button
            variant="outline"
            onClick={handleEnableAll}
            disabled={enabledCount === apps.length}
            className={cn(SETTINGS_CONTROL_SM, 'gap-1.5')}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {t('appManagement.enableAll')}
          </Button>
          <Button
            variant="outline"
            onClick={handleDisableAll}
            disabled={enabledCount === 0}
            className={cn(SETTINGS_CONTROL_SM, 'gap-1.5')}
          >
            <XSquare className="h-3.5 w-3.5" />
            {t('appManagement.disableAll')}
          </Button>
          <span className="text-caption text-muted-foreground/60 ml-auto">
            {enabledCount}/{apps.length} {t('appManagement.enabled')}
          </span>
        </div>
      )}

      {/* Category groups */}
      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="space-y-1">
          {categoryGroups.map(group => {
            const isCollapsed = collapsedGroups.has(group.id)
            const groupEnabled = group.apps.filter(a => isAppEnabled(a.id)).length
            const categoryLabel = t(`appManagement.categories.${group.id}`, { defaultValue: group.id })

            return (
              <div key={group.id}>
                {/* Group header */}
                <button
                  type="button"
                  onClick={() => toggleGroupCollapse(group.id)}
                  className="w-full flex items-center gap-2 py-2 px-1 group"
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 text-muted-foreground/60 transition-transform',
                      isCollapsed && '-rotate-90',
                    )}
                  />
                  <span className={SETTINGS_GROUP_LABEL}>{categoryLabel}</span>
                  <span className="text-caption text-muted-foreground/60">
                    {groupEnabled}/{group.apps.length}
                  </span>
                </button>

                {/* App toggle rows */}
                {!isCollapsed && (
                  <div className="ml-1 space-y-0.5">
                    {group.apps.map(app => {
                      const Icon = resolveAppIcon(app.icon)
                      const enabled = isAppEnabled(app.id)

                      return (
                        <div
                          key={app.id}
                          className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/20 transition-colors"
                        >
                          <Icon className={cn(
                            'h-4 w-4 shrink-0',
                            enabled ? 'text-foreground/80' : 'text-muted-foreground/60',
                          )} />
                          <span className={cn(
                            'text-body flex-1 truncate',
                            enabled ? 'text-foreground' : 'text-muted-foreground/60',
                          )}>
                            {app.name}
                          </span>
                          <Switch
                            checked={enabled}
                            onCheckedChange={() => toggleApp(app.id)}
                            disabled={!canManage || optimisticDisabled !== null}
                            className="shrink-0"
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
