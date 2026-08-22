import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Download,
  LayoutGrid,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Button, ConfirmDialog, Input, Skeleton, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Organization } from '@tabtin/app-shell'
import {
  useOrganizationAppCatalog,
  type CatalogApp,
  type CatalogCategory,
} from '@stores/useOrganizationAppCatalog'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsPanelToolbar } from '../SettingsPanelToolbar'
import { SettingsBadge } from '../SettingsBadge'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { cn } from '@utils/cn'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function CatalogTooltip({
  content,
  children,
  fullWidth = false,
}: {
  content: React.ReactNode
  children: React.ReactNode
  fullWidth?: boolean
}) {
  const TriggerWrapper = fullWidth ? 'div' : 'span'
  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <TriggerWrapper className={fullWidth ? 'w-full min-w-0' : 'inline-flex'}>
            {children}
          </TriggerWrapper>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-body leading-relaxed">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function getAppCardTooltipContent(app: CatalogApp): string {
  const detail = app.detail_description?.trim()
  if (detail) return detail
  return app.description?.trim() || app.name
}

const CARD_WIDTHS = ['62%', '74%', '58%', '68%', '52%', '66%'] as const
const pickWidth = (widths: readonly string[], index: number) =>
  widths[index % widths.length]

const ICON_MAP: Record<string, string> = {
  table: '📊',
  'file-text': '📄',
  palette: '🎨',
  presentation: '📽️',
  code: '💻',
  video: '🎬',
  globe: '🌐',
  folder: '📁',
  terminal: '⌨️',
  bot: '🤖',
  target: '🎯',
  frame: '🖼️',
  'sticky-note': '📝',
  layout: '🏗️',
  function: '⚡',
  phone: '📱',
  puzzle: '🧩',
  cube: '🧊',
  music: '🎹',
  'home-decor': '🏠',
  gamepad: '🎮',
  'view-3d': '👓',
  mic: '🎙️',
}

const COMING_SOON_APPS: CatalogApp[] = [
  {
    id: 'tab3d',
    name: 'Tab3D',
    icon: 'cube',
    description: '3D 建模与场景渲染，支持 AI 辅助生成三维模型和实时预览',
    detail_description: '集成 Three.js 渲染引擎，支持从文字描述生成 3D 模型、场景编辑、材质调整和渲染输出。',
    screenshots: [],
    category: 'creation',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 100,
    version: null,
  },
  {
    id: 'tabmidi',
    name: 'TabMIDI',
    icon: 'music',
    description: 'AI 音乐创作与 MIDI 编辑，支持旋律生成、编曲和音效设计',
    detail_description: '基于 AI 的音乐工作站：输入文字描述即可生成旋律，支持 MIDI 钢琴卷帘编辑、多轨编曲、音色选择和实时试听。可导出 MIDI/WAV 格式。',
    screenshots: [],
    category: 'creation',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 101,
    version: null,
  },
  {
    id: 'tabspace3d',
    name: 'TabSpace',
    icon: 'home-decor',
    description: 'AI 空间设计，从户型到全屋方案一步到位，VR 沉浸式预览',
    detail_description: '智能空间设计工具：上传户型图或输入尺寸即可生成 3D 户型，AI 推荐家具布局、配色方案和风格搭配，支持 VR 全景漫游和高清效果图渲染导出。',
    screenshots: [],
    category: 'creation',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 102,
    version: null,
  },
  {
    id: 'tabgame',
    name: 'TabGame',
    icon: 'gamepad',
    description: '可视化游戏编辑器，用 AI 和拖拽快速构建 2D/3D 互动游戏',
    detail_description: '零代码/低代码游戏开发：支持场景编辑、角色行为脚本、物理引擎配置和 AI 对话 NPC。可一键导出为 Web 游戏，嵌入 TabSite 或独立发布。',
    screenshots: [],
    category: 'development',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 103,
    version: null,
  },
  {
    id: 'tabar',
    name: 'TabAR',
    icon: 'view-3d',
    description: 'AR 内容创作，将数字内容叠加到真实世界，扫一扫即可体验',
    detail_description: '创建增强现实场景：放置 3D 模型、信息标注、交互热点到真实环境中。可与 TabPhone 联动实时预览，支持导出 AR 体验链接，用户扫码即可在手机上查看。',
    screenshots: [],
    category: 'creation',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 104,
    version: null,
  },
  {
    id: 'tabpodcast',
    name: 'TabPodcast',
    icon: 'mic',
    description: 'AI 播客制作，自动生成脚本、配音、剪辑和发布',
    detail_description: '端到端的播客工作流：从主题生成脚本，支持多角色 AI 配音、背景音乐自动匹配、智能剪辑和一键发布到主流播客平台。',
    screenshots: [],
    category: 'creation',
    source: 'core',
    installed: false,
    is_default_enabled: false,
    order: 105,
    version: null,
  },
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const AppIconBadge: React.FC<{ icon: string; name: string }> = ({ icon, name }) => {
  const emoji = ICON_MAP[icon]
  if (emoji) {
    return (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-interactive bg-foreground/[0.08] text-subtitle text-muted-foreground/80 dark:bg-foreground/[0.12]">
        {emoji}
      </span>
    )
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-interactive bg-foreground/[0.08] text-body font-medium text-muted-foreground/80 dark:bg-foreground/[0.12]">
      {(name || '?')[0]}
    </span>
  )
}

interface CategoryFilterProps {
  categories: CatalogCategory[]
  selected: string
  onSelect: (id: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const CategoryFilter: React.FC<CategoryFilterProps> = ({
  categories,
  selected,
  onSelect,
  t,
}) => (
  <div className="flex flex-wrap gap-2">
    {categories.map((cat) => (
      <button
        key={cat.id}
        onClick={() => onSelect(cat.id)}
        className={cn(
          'inline-flex items-center gap-1 rounded-interactive px-3 py-1 text-body font-medium transition-colors',
          selected === cat.id
            ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground'
            : 'bg-muted/30 text-muted-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
        )}
      >
        {t(`appCatalog.categories.${cat.id}`, { defaultValue: cat.name })}
        <span
          className={cn(
            SETTINGS_TEXT_MICRO,
            'tabular-nums',
            selected === cat.id ? 'text-muted-foreground/60' : 'text-muted-foreground/60',
          )}
        >
          {cat.count}
        </span>
      </button>
    ))}
  </div>
)

// ---------------------------------------------------------------------------
// Skeleton Grid
// ---------------------------------------------------------------------------

const APP_CATALOG_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-3 min-w-0'

const SkeletonGrid: React.FC<{ count?: number }> = ({ count = 6 }) => (
  <div className={APP_CATALOG_GRID_CLASS} aria-hidden="true">
    {Array.from({ length: count }).map((_, i) => (
      <div
        key={i}
        className="flex flex-col rounded-interactive bg-foreground/[0.03] p-4 dark:bg-foreground/[0.05]"
      >
        <Skeleton width={36} height={36} rounded="lg" />
        <Skeleton width={pickWidth(CARD_WIDTHS, i)} height={13} rounded="md" className="mt-3" />
        <Skeleton width="90%" height={10} rounded="full" className="mt-2 opacity-75" />
      </div>
    ))}
  </div>
)

// ---------------------------------------------------------------------------
// App Card
// ---------------------------------------------------------------------------

interface AppCardProps {
  app: CatalogApp
  canManage: boolean
  installingId: string | null
  uninstallingId: string | null
  onInstall: (appId: string) => void
  onRequestUninstall: (app: CatalogApp) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const AppCard: React.FC<AppCardProps> = ({
  app,
  canManage,
  installingId,
  uninstallingId,
  onInstall,
  onRequestUninstall,
  t,
}) => {
  const isInstalling = installingId === app.id
  const isUninstalling = uninstallingId === app.id
  const isBusy = isInstalling || isUninstalling

  const renderAction = () => {
    if (app.order >= 100) {
      return (
        <SettingsBadge tone="muted">
          {t('appCatalog.comingSoon', { defaultValue: '即将推出' })}
        </SettingsBadge>
      )
    }

    // 只有 marketplace 应用可安装/卸载；其余（core / builtin / 未知来源、或
    // 后端标记不可安装的）一律按预置应用处理，仅展示徽章、不暴露卸载按钮。
    // 否则内置应用会显示卸载按钮，点击后被后端「内置应用不可卸载」400 拒绝。
    const isUninstallable = app.source === 'marketplace' && app.installable !== false
    if (!isUninstallable) {
      // 预置第一方应用：与「更多应用」卡片一致，右上角不展示「协作」等来源徽章。
      return null
    }

    if (app.installed) {
      return (
        <div className="flex items-center gap-2">
          <SettingsBadge tone="success">
            {t('appCatalog.installed')}
          </SettingsBadge>
          {canManage ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-muted-foreground hover:text-destructive"
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation()
                onRequestUninstall(app)
              }}
            >
              {isUninstalling ? (
                <Loader2 className="h-[1em] w-[1em] animate-spin" />
              ) : (
                <Trash2 className="h-[1em] w-[1em]" />
              )}
            </Button>
          ) : (
            <CatalogTooltip content={t('appCatalog.requiresAdmin')}>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-muted-foreground/60 cursor-not-allowed"
                disabled
              >
                <Trash2 className="h-[1em] w-[1em]" />
              </Button>
            </CatalogTooltip>
          )}
        </div>
      )
    }

    if (canManage) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-body"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation()
            onInstall(app.id)
          }}
        >
          {isInstalling ? (
            <Loader2 className="h-[1em] w-[1em] mr-1 animate-spin" />
          ) : (
            <Download className="h-[1em] w-[1em] mr-1" />
          )}
          {isInstalling ? t('appCatalog.installing') : t('appCatalog.install')}
        </Button>
      )
    }

    return (
      <CatalogTooltip content={t('appCatalog.requiresAdmin')}>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-body opacity-40 cursor-not-allowed"
          disabled
        >
          <Download className="h-[1em] w-[1em] mr-1" />
          {t('appCatalog.install')}
        </Button>
      </CatalogTooltip>
    )
  }

  const isComingSoon = app.order >= 100

  const topAction = renderAction()
  const tooltipContent = getAppCardTooltipContent(app)

  return (
    <CatalogTooltip content={tooltipContent} fullWidth>
      <div
        className={cn(
          'group flex flex-col rounded-interactive p-4 transition-colors',
          'bg-foreground/[0.03] hover:bg-foreground/[0.05]',
          'dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.07]',
          isComingSoon && 'opacity-60',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <AppIconBadge icon={app.icon} name={app.name} />
          {topAction ? <div className="shrink-0">{topAction}</div> : null}
        </div>

        <div className="mt-3 flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-medium text-foreground">{app.name}</span>
          {app.version ? (
            <span className={cn(SETTINGS_HINT, 'shrink-0')}>
              v{app.version}
            </span>
          ) : null}
        </div>

        <p className={cn(SETTINGS_TEXT_META, 'mt-1 line-clamp-2')}>
          {app.description}
        </p>
      </div>
    </CatalogTooltip>
  )
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

interface OrganizationAppCatalogPanelProps {
  organization: Organization
  canManageOrganization?: boolean
  showHeader?: boolean
  className?: string
  /**
   * 嵌入模式：不自带 SettingsPanelLayout / ScrollArea 外壳，仅渲染工具栏 + 卡片，
   * 供统一「应用市场」的协作分区内嵌。滚动由外层统一承接。
   */
  embedded?: boolean
  /** 全宽市场内嵌场景使用更密的三列网格；窄设置页保持最多两列。 */
  wideGrid?: boolean
}

export const OrganizationAppCatalogPanel: React.FC<OrganizationAppCatalogPanelProps> = ({
  organization,
  canManageOrganization = false,
  showHeader = true,
  className,
  embedded = false,
  wideGrid: _wideGrid = false,
}) => {
  const { t } = useTranslation('settings')

  const {
    apps,
    categories,
    canManage: storeCanManage,
    isLoading,
    error,
    searchQuery,
    selectedCategory,
    installingAppId,
    uninstallingAppId,
    loadCatalog,
    installApp,
    uninstallApp,
    setSearchQuery,
    setSelectedCategory,
    getFilteredApps,
  } = useOrganizationAppCatalog(
    useShallow((s) => ({
      apps: s.apps,
      categories: s.categories,
      canManage: s.canManage,
      isLoading: s.isLoading,
      error: s.error,
      searchQuery: s.searchQuery,
      selectedCategory: s.selectedCategory,
      installingAppId: s.installingAppId,
      uninstallingAppId: s.uninstallingAppId,
      loadCatalog: s.loadCatalog,
      installApp: s.installApp,
      uninstallApp: s.uninstallApp,
      setSearchQuery: s.setSearchQuery,
      setSelectedCategory: s.setSelectedCategory,
      getFilteredApps: s.getFilteredApps,
    })),
  )

  const effectiveCanManage = canManageOrganization && storeCanManage

  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)

  useEffect(() => {
    if (organization.id) {
      void loadCatalog(organization.id)
    }
  }, [organization.id, loadCatalog])

  const filteredApps = useMemo(() => {
    const realApps = getFilteredApps()
    const q = searchQuery.trim().toLowerCase()
    const cat = selectedCategory
    let comingSoon = COMING_SOON_APPS.filter((app) => {
      if (cat && cat !== 'all' && app.category !== cat) return false
      if (q && !(app.name.toLowerCase().includes(q) || app.description.toLowerCase().includes(q))) return false
      return true
    })
    return [...realApps, ...comingSoon]
  }, [apps, searchQuery, selectedCategory, getFilteredApps])

  const handleRefresh = useCallback(() => {
    void loadCatalog(organization.id)
  }, [organization.id, loadCatalog])

  const handleInstall = useCallback(
    (appId: string) => {
      void installApp(organization.id, appId)
    },
    [organization.id, installApp],
  )

  const handleConfirmUninstall = useCallback(async () => {
    if (!uninstallTarget) return
    await uninstallApp(organization.id, uninstallTarget.id)
    setUninstallTarget(null)
  }, [organization.id, uninstallTarget, uninstallApp])

  const body = (
    <>
      {showHeader ? (
        <SettingsPanelHeader
          icon={<LayoutGrid className="h-4 w-4" />}
          title={t('appCatalog.title')}
          subtitle={t('appCatalog.subtitle')}
          meta={
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </Button>
          }
        />
      ) : null}

      {/* Search + Category Filter（钉在滚动区域外） */}
      <SettingsPanelToolbar className="space-y-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className={cn(SETTINGS_CONTROL, 'pl-8')}
              placeholder={t('appCatalog.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery('')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {!showHeader ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              {t('appCatalog.refreshShort', { defaultValue: '刷新' })}
            </Button>
          ) : null}
        </div>

        {categories.length > 0 && (
          <CategoryFilter
            categories={categories}
            selected={selectedCategory}
            onSelect={setSelectedCategory}
            t={t}
          />
        )}
      </SettingsPanelToolbar>

      {/* Error State */}
      {error && (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 p-4 text-center space-y-2">
          <p className="text-body text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            {t('appCatalog.retry')}
          </Button>
        </div>
      )}

      {/* Loading State */}
      {isLoading && !error && <SkeletonGrid />}

      {/* Empty Search State */}
      {!isLoading && !error && filteredApps.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Package className="h-8 w-8 text-muted-foreground/60 mb-3" />
          <p className="text-body text-foreground-secondary">
            {searchQuery || selectedCategory !== 'all'
              ? t('appCatalog.noResults')
              : t('appCatalog.emptyState')}
          </p>
          <p className={cn(SETTINGS_HINT, 'mt-1')}>
            {searchQuery || selectedCategory !== 'all'
              ? t('appCatalog.noResultsHint')
              : t('appCatalog.emptyStateHint')}
          </p>
        </div>
      )}

      {/* App Grid */}
      {!isLoading && !error && filteredApps.length > 0 && (
        <div className={APP_CATALOG_GRID_CLASS}>
          {filteredApps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              canManage={effectiveCanManage}
              installingId={installingAppId}
              uninstallingId={uninstallingAppId}
              onInstall={handleInstall}
              onRequestUninstall={setUninstallTarget}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Uninstall Confirmation Dialog */}
      <ConfirmDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        title={t('appCatalog.uninstallConfirmTitle')}
        description={t('appCatalog.uninstallConfirmDesc')}
        onConfirm={handleConfirmUninstall}
        variant="destructive"
        confirmText={t('appCatalog.uninstallConfirm')}
        cancelText={t('appCatalog.cancel')}
      />
    </>
  )

  if (embedded) {
    return <div className={cn('space-y-4', className)}>{body}</div>
  }

  return (
    <SettingsPanelLayout className={cn('max-w-3xl', className)}>{body}</SettingsPanelLayout>
  )
}
