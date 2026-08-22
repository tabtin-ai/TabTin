import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Download, Check, ExternalLink, Sparkles, BookText } from 'lucide-react'
import {
  Button,
  Input,
  ScrollArea,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import {
  useEnableSkillMutation,
  useSkillsListQuery,
  useSkillMarketQuery,
  type MarketSkillItem,
} from '@/hooks/queries/skills'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'
import { normalizeSkillSource, type SkillIndexEntry } from '@/skills/types'
import { isBuiltinCatalogSkill } from './skillProductState'
import { SKILL_CONSUMER_CATEGORIES } from './skillCategory'
import { formatSkillVersionLabel } from './skillSemver'
import { resolveSkillDisplayName } from './skillSlug'
import { filterSkillsBySearch } from './skillPanelFilters'
import { createLogger } from '@/utils/logger'
import { localizeRecommendedMarketSkill } from '../capability-marketplace/recommendedSkillCatalogLocale'

const log = createLogger('Skills')

type MarketSkill = MarketSkillItem

const CATEGORY_IDS = ['all', ...SKILL_CONSUMER_CATEGORIES] as const

function MarketSkillTooltip({
  content,
  children,
}: {
  content: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <div className="w-full min-w-0">{children}</div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-body leading-relaxed">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function getMarketSkillTooltipContent(skill: MarketSkill): string {
  const description = skill.description?.trim()
  if (description) return description
  return resolveSkillDisplayName(skill)
}

function isBuiltinSkill(skill: MarketSkill): boolean {
  return isBuiltinCatalogSkill(skill)
}

function isInstalledListSkill(skill: SkillIndexEntry): boolean {
  const source = normalizeSkillSource(skill.source)
  if (source === 'platform') return true
  if (source === 'app') return skill.installed === true || skill.enabled === true
  // 本机扫描：出现在本地 catalog 即视为已发现/已安装，启用态另走 enablement
  if (source === 'device') return true
  return skill.enabled === true || skill.installed === true || skill.installed_version_seq != null
}

interface SkillMarketplaceProps {
  spaceId?: string
  /** 侧栏内嵌：强制窄列列表布局，不按视口 sm 启双栏宫格 */
  embedded?: boolean
  /** 面板内全宽布局：占满父容器高度，隐藏独立页头 */
  fillPanel?: boolean
  /** 当前用户是否能把 Skill 安装到目标 Space。默认允许，兼容旧入口。 */
  canInstall?: boolean
  installDisabledReason?: string
  onManageInstalled?: (skill: MarketSkill) => void
}

interface MarketSkillCardProps {
  skill: MarketSkill
  embedded: boolean
  installing: boolean
  installed: boolean
  canInstall: boolean
  installDisabledReason?: string
  onInstall: (skill: MarketSkill) => void
  onManageInstalled?: (skill: MarketSkill) => void
  t: (key: string, o?: Record<string, unknown>) => string
}

function MarketSkillCard({
  skill,
  embedded,
  installing,
  installed,
  canInstall,
  installDisabledReason,
  onInstall,
  onManageInstalled,
  t,
}: MarketSkillCardProps) {
  const displayVersion = skill.latest_version_label || ''
  const showVersion = !isBuiltinSkill(skill) && Boolean(displayVersion)
  const installControl = installed ? (
    onManageInstalled ? (
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-7', 'shrink-0', 'px-2', 'text-success', CANVAS_TEXT_MICRO)}
        onClick={(e) => {
          e.stopPropagation()
          onManageInstalled(skill)
        }}
      >
        <Check className="mr-1 h-3 w-3 shrink-0" />
        {t('skillMarket.manageInstalled')}
      </Button>
    ) : (
      <span className={cn('inline-flex', 'items-center', 'justify-center', 'gap-1', 'text-success', 'shrink-0', CANVAS_TEXT_MICRO)}>
        <Check className="h-3 w-3 shrink-0" />
        {t('skillMarket.installed')}
      </span>
    )
  ) : (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-7', 'shrink-0', CANVAS_TEXT_META)}
      disabled={installing || !canInstall}
      title={!canInstall ? installDisabledReason : undefined}
      onClick={(e) => {
        e.stopPropagation()
        onInstall(skill)
      }}
    >
      <Download className="mr-1 h-3 w-3 shrink-0" />
      {installing ? t('skillMarket.installing') : t('skillMarket.install')}
    </Button>
  )

  const tags = (skill.tags || []).slice(0, 4)
  const cardClassName = cn(
    'group flex min-w-0 w-full max-w-full rounded-[12px] p-3.5 transition-colors',
    embedded ? 'flex-col gap-2' : 'items-center gap-3',
    'bg-foreground/[0.03] hover:bg-foreground/[0.045] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]',
  )

  const contentBlock = (
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center leading-none" aria-hidden>
        {skill.emoji ? (
          <span className="text-body">{skill.emoji}</span>
        ) : (
          <BookText className="h-4 w-4 text-muted-foreground/40" strokeWidth={1.5} absoluteStrokeWidth />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-body font-medium text-foreground">
            {resolveSkillDisplayName(skill)}
          </span>
          {showVersion ? (
            <span className={cn('shrink-0', CANVAS_TEXT_META)}>
              {formatSkillVersionLabel(displayVersion)}
            </span>
          ) : null}
        </div>
        {skill.description ? (
          <p className={cn('break-words', 'line-clamp-1', CANVAS_TEXT_SECONDARY)}>
            {skill.description}
          </p>
        ) : null}
        {(tags.length > 0 || skill.homepage) ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className={cn('max-w-full', 'truncate', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-px', CANVAS_TEXT_META)}
                title={tag}
              >
                {tag}
              </span>
            ))}
            {skill.homepage ? (
              <a
                href={skill.homepage}
                onClick={(e) => {
                  e.stopPropagation()
                  handleResourceLinkClick(e, skill.homepage!)
                }}
                onContextMenu={(e) => handleResourceLinkContextMenu(e, skill.homepage!)}
                className={cn('shrink-0 text-muted-foreground hover:text-foreground', tags.length > 0 ? '' : 'ml-auto')}
                title={skill.homepage}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )

  return (
    <MarketSkillTooltip content={getMarketSkillTooltipContent(skill)}>
      <div className={cardClassName}>
        {contentBlock}
        <div
          className={cn(
            'flex shrink-0',
            embedded ? 'min-w-0 w-full justify-center' : 'items-center',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {installControl}
        </div>
      </div>
    </MarketSkillTooltip>
  )
}

export function SkillMarketplace({
  spaceId,
  embedded = false,
  fillPanel = false,
  canInstall = true,
  installDisabledReason,
  onManageInstalled,
}: SkillMarketplaceProps) {
  const { t, i18n } = useTranslation('context')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [category, setCategory] = useState('all')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])
  const [localInstalled, setLocalInstalled] = useState<Set<string>>(new Set())
  const enableMutation = useEnableSkillMutation()
  const { data: installedSkills = [] } = useSkillsListQuery(spaceId ?? null)

  const { data: skills = [], isLoading: loading, isError, refetch } = useSkillMarketQuery({
    search: debouncedSearch,
    category,
  })

  const handleInstall = useCallback(
    async (skill: MarketSkill) => {
      const key = skill.skill_key || skill.skill_id
      if (!key) return
      if (!spaceId || !canInstall) {
        toast({ title: installDisabledReason || t('skillMarket.installUnavailable'), variant: 'destructive' })
        return
      }
      try {
        await enableMutation.mutateAsync({
          canonicalKey: key,
          spaceId,
          skill,
        })
        toast({ title: t('skillMarket.installSuccess', { name: resolveSkillDisplayName(skill) }), variant: 'success' })
        setLocalInstalled((prev) => new Set([...prev, key]))
      } catch (err) {
        log.error('从市场安装 Skill 失败', { canonicalKey: key, spaceId }, err)
        toast({ title: t('skillMarket.installFailed'), variant: 'destructive' })
      }
    },
    [enableMutation, t, spaceId, canInstall, installDisabledReason],
  )

  const installedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const skill of installedSkills) {
      if (!isInstalledListSkill(skill)) continue
      const key = skill.skill_key || skill.skill_id
      if (key) keys.add(key)
    }
    for (const skill of skills) {
      const key = skill.skill_key || skill.skill_id
      if (key && skill.installed) keys.add(key)
    }
    for (const key of localInstalled) {
      keys.add(key)
    }
    return keys
  }, [installedSkills, localInstalled, skills])

  // 安装后仍留在市场列表，用卡片上的「已安装」态区分，不隐藏。
  const localizedSkills = useMemo(
    () => skills.map((skill) => localizeRecommendedMarketSkill(
      skill,
      i18n?.resolvedLanguage || i18n?.language,
    )),
    [i18n?.language, i18n?.resolvedLanguage, skills],
  )

  const displayed = useMemo(
    () => filterSkillsBySearch(localizedSkills, search),
    [localizedSkills, search],
  )

  const marketplaceSearchClassNames = 'h-7 min-w-0 w-full max-w-full pl-8 text-body'

  const categoryRow = (
    <div
      className={cn(
        'flex min-w-0 w-full max-w-full max-h-[5.75rem] flex-wrap gap-1 overflow-y-auto pr-1',
        embedded ? '' : '-mx-0.5 px-0.5',
      )}
    >
      {CATEGORY_IDS.map((catId) => (
        <Button
          key={catId}
          variant={category === catId ? 'secondary' : 'ghost'}
          size="sm"
          className={cn(
            'h-7 shrink-0 whitespace-nowrap px-2', CANVAS_TAB_TEXT,
            !embedded && 'px-2.5 text-body',
            category === catId && 'text-foreground',
          )}
          onClick={() => setCategory(catId)}
        >
          {t(`skillMarket.category.${catId}`)}
        </Button>
      ))}
    </div>
  )

  const listSection = (
    <>
      {isError ? (
        <div className="py-8 text-center text-body text-destructive/80">
          {t('skillMarket.loadError', { defaultValue: t('skillMarket.emptyState') })}
        </div>
      ) : displayed.length === 0 ? (
        <div className="py-8 text-center text-body text-muted-foreground">
          {loading ? t('skillMarket.loading') : t('skillMarket.emptyState')}
        </div>
      ) : (
        <div
          className={cn(
            'grid min-w-0 grid-cols-1 gap-3.5 sm:grid-cols-2',
            embedded && 'pt-1',
          )}
        >
          {displayed.map((skill) => {
            const key = skill.skill_key || skill.skill_id
            const installing =
              (enableMutation.isPending && enableMutation.variables?.canonicalKey === key) ||
              false
            const installed = Boolean(key && installedKeys.has(key))
            return (
              <MarketSkillCard
                key={key}
                skill={skill}
                embedded={embedded}
                installing={installing}
                installed={installed}
                canInstall={Boolean(spaceId) && canInstall}
                installDisabledReason={installDisabledReason}
                onInstall={handleInstall}
                onManageInstalled={onManageInstalled}
                t={t}
              />
            )
          })}
        </div>
      )}
    </>
  )

  const scrollAreaListClassName =
    'min-h-0 w-full min-w-0 flex-1 [&>[data-radix-scroll-area-viewport]]:min-w-0 [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]>div]:!min-w-0 [&>[data-radix-scroll-area-viewport]>div]:!w-full [&>[data-radix-scroll-area-viewport]>div]:!max-w-full'

  const searchBlock = (
    <div className="relative min-w-0 w-full">
      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
      <Input
        className={marketplaceSearchClassNames}
        placeholder={fillPanel ? t('skillMarket.searchPlaceholder') : t('skills.panel.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </div>
  )

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden overflow-x-hidden">
        <div className="min-w-0 shrink-0 space-y-2 px-3 py-2">
          {searchBlock}
          {categoryRow}
        </div>
        <ScrollArea className={scrollAreaListClassName}>
          <div className="min-w-0 w-full px-3 pb-4">{listSection}</div>
        </ScrollArea>
      </div>
    )
  }

  if (fillPanel) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="min-w-0 shrink-0 space-y-2 pb-2 pt-0">
          <div className="flex min-w-0 items-center justify-between gap-2">
            {searchBlock}
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => refetch()} disabled={loading}>
              {loading ? t('skillMarket.loading') : t('skillMarket.refresh')}
            </Button>
          </div>
          {categoryRow}
        </div>
        <ScrollArea className={scrollAreaListClassName}>
          <div className="min-w-0 w-full py-3 pb-4">{listSection}</div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="box-border min-w-0 w-full max-w-full space-y-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-subtitle font-semibold">
            <Sparkles className="h-4 w-4 shrink-0" />
            {t('skillMarket.title')}
          </h3>
          <p className="mt-0.5 text-body text-muted-foreground">{t('skillMarket.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => refetch()} disabled={loading}>
          {loading ? t('skillMarket.loading') : t('skillMarket.refresh')}
        </Button>
      </div>

      <div className="min-w-0 space-y-2">
        {searchBlock}
        {categoryRow}
      </div>

      {listSection}
    </div>
  )
}
