import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  PackageCheck,
  Palette,
  Puzzle,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Button, EmptyState, Input } from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useTranslation } from 'react-i18next'
import type { Organization } from '@tabtin/app-shell'
import {
  checkPersonalPluginUpdate,
  confirmPersonalPluginUpdate,
  installOfficialPersonalPlugin,
  listInstalledPersonalPlugins,
  uninstallPersonalPlugin,
  type InstalledPersonalPluginRecord,
  type PersonalPluginUpdateCheckResult,
} from '@services/personalPluginMarketplaceClient'
import { SettingsBadge } from '../SettingsBadge'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsPanelToolbar } from '../SettingsPanelToolbar'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_SOFT_SURFACE } from '../settingsUi'
import { cn } from '@utils/cn'

/**
 * 本机应用市场（Personal Plugin）。
 *
 * 三态分类中的「本机（local）」分区：个人安装到本机的应用（如 Cowart）。
 * 内置（builtin）不进市场（归「更多应用」总览）；协作（collaborative）由后端
 * app-catalog 承载（见 OrganizationAppCatalogPanel）。install 与 enable 分离（启用在
 * 工作空间设置）、官方 Release / 更新治理走 personalPluginMarketplaceClient 的 IPC，
 * 本组件只负责本机形态的信息架构与 UI 归类。
 */

interface Props {
  organization: Organization
  canManageOrganization?: boolean
  view?: 'marketplace' | 'installed'
  showHeader?: boolean
  className?: string
  /** 嵌入模式：不自带 SettingsPanelLayout 外壳，供统一「应用市场」的本机分区内嵌。 */
  embedded?: boolean
  /** 全宽市场内嵌场景使用更密的三列网格；窄设置页保持最多两列。 */
  wideGrid?: boolean
}

type PluginStatus = 'available' | 'installed'

interface PluginCapabilityManifest {
  source: 'official' | 'installed'
  version: string | null
  capabilities: string[]
}

interface MarketplacePlugin {
  id: string
  name: string
  description: string
  category: string
  status: PluginStatus
  icon: React.ComponentType<{ className?: string }>
  manifest: PluginCapabilityManifest
  sourceLabel?: string
  versionLabel?: string
  sourceDetails?: Array<{ label: string; value: string }>
}

const PERSONAL_PLUGIN_CATALOG: MarketplacePlugin[] = [
  {
    id: 'cowart',
    name: 'Cowart',
    description: '官方 Personal Plugin，本地启动无限画布 runtime，并为 Agent 提供画板 Skill 与 MCP 工具。',
    category: 'personal',
    status: 'available',
    icon: Palette,
    manifest: {
      source: 'official',
      version: '0.1.2',
      capabilities: ['canvas-runtime', 'mcp', 'local-service'],
    },
  },
]

const ALL_MARKETPLACE_PLUGINS = [...PERSONAL_PLUGIN_CATALOG]

const CATEGORY_LABELS: Record<string, string> = {
  personal: 'pluginMarketplace.categoryPersonal',
}

function PluginCard({
  plugin,
  action,
}: {
  plugin: MarketplacePlugin
  action?: React.ReactNode
}) {
  const { t } = useTranslation('settings')
  const Icon = plugin.icon
  const isInstalled = plugin.status === 'installed'

  return (
    <article
      className={cn('flex h-full flex-col justify-between p-3', SETTINGS_SOFT_SURFACE)}
      data-plugin-kind="personal"
      data-plugin-surface="local"
      data-plugin-status={plugin.status}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-interactive bg-muted/30 text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-body font-medium text-foreground">{plugin.name}</h3>
              <p className={cn(SETTINGS_HINT, 'mt-1')}>
                {t(CATEGORY_LABELS[plugin.category] ?? 'pluginMarketplace.categoryPersonal')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 本机形态：绿底轻角标（design-system §16.2 小面积语义色）。 */}
            <SettingsBadge tone="success">{t('appMarket.surface.local')}</SettingsBadge>
            <SettingsBadge tone={isInstalled ? 'success' : 'accent'}>
              {isInstalled
                ? t('pluginMarketplace.installedBadge')
                : t('pluginMarketplace.officialBadge')}
            </SettingsBadge>
          </div>
        </div>

        <p className="text-body leading-relaxed text-foreground-secondary">
          {plugin.description}
        </p>

        <div className="flex flex-wrap gap-1">
          {plugin.manifest.capabilities.slice(0, 3).map((capability) => (
            <SettingsBadge key={capability} tone="muted">
              {capability}
            </SettingsBadge>
          ))}
        </div>

        <dl className={cn(SETTINGS_HINT, 'grid gap-1')}>
          {(plugin.sourceDetails ?? [
            { label: t('pluginMarketplace.sourceLabel'), value: plugin.sourceLabel ?? plugin.manifest.source },
            { label: t('pluginMarketplace.versionLabel'), value: plugin.versionLabel ?? plugin.manifest.version ?? t('pluginMarketplace.versionUnknown') },
          ]).map((detail) => (
            <div key={detail.label} className="flex min-w-0 gap-1">
              <dt className="shrink-0 text-muted-foreground/60">{detail.label}</dt>
              <dd className="truncate">{detail.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className={SETTINGS_HINT}>
          {isInstalled
            ? t('pluginMarketplace.installedReady')
            : t('pluginMarketplace.personalPlugin')}
        </span>
        {action}
      </div>
    </article>
  )
}

function capabilitySummary(record: InstalledPersonalPluginRecord): string[] {
  const manifest = record.capabilityManifest
  const skills = manifest.skills.map((skill) => `skill:${skill.id}`)
  const extras = [
    manifest.mcp ? `mcp:${manifest.mcp.serverCount}` : null,
    manifest.declaredHooks.length > 0 ? `hooks:${manifest.declaredHooks.length}` : null,
    manifest.scripts.length > 0 ? `scripts:${manifest.scripts.length}` : null,
  ].filter((value): value is string => Boolean(value))

  return [...skills, ...extras].slice(0, 3)
}

function installedSourceDetails(
  record: InstalledPersonalPluginRecord,
  t: ReturnType<typeof useTranslation>['t'],
): Array<{ label: string; value: string }> {
  const source = record.source
  if (record.officialRelease) {
    return [
      { label: t('pluginMarketplace.sourceLabel'), value: source.uri },
      { label: t('pluginMarketplace.officialReleaseLabel'), value: record.officialRelease.id },
      { label: t('pluginMarketplace.officialVersionLabel'), value: record.officialRelease.version },
      { label: t('pluginMarketplace.channelLabel'), value: record.officialRelease.channel },
      { label: t('pluginMarketplace.upstreamRepoLabel'), value: record.upstream?.repository ?? t('pluginMarketplace.versionUnknown') },
      { label: t('pluginMarketplace.upstreamVersionLabel'), value: record.upstream?.version ?? t('pluginMarketplace.versionUnknown') },
      { label: t('pluginMarketplace.upstreamRevisionLabel'), value: record.upstream?.commit ?? t('pluginMarketplace.versionUnknown') },
      { label: t('pluginMarketplace.adapterLabel'), value: record.adapter ? `${record.adapter.id}@${record.adapter.version}` : t('pluginMarketplace.versionUnknown') },
    ]
  }
  if (source.kind === 'github') {
    return [
      { label: t('pluginMarketplace.sourceLabel'), value: 'GitHub' },
      { label: t('pluginMarketplace.repoLabel'), value: source.repoUrl ?? source.uri },
      { label: t('pluginMarketplace.refLabel'), value: source.ref ?? t('pluginMarketplace.versionUnknown') },
      { label: t('pluginMarketplace.commitLabel'), value: record.commit ?? source.commit ?? t('pluginMarketplace.versionUnknown') },
      { label: t('pluginMarketplace.versionPinLabel'), value: record.versionPin ?? source.versionPin ?? t('pluginMarketplace.versionUnknown') },
    ]
  }

  return [
    { label: t('pluginMarketplace.sourceLabel'), value: record.source.uri },
    { label: t('pluginMarketplace.versionLabel'), value: record.versionPin ?? record.capabilityManifest.plugin.version ?? t('pluginMarketplace.versionUnknown') },
  ]
}

function installedRecordToPlugin(
  record: InstalledPersonalPluginRecord,
  t: ReturnType<typeof useTranslation>['t'],
): MarketplacePlugin {
  const catalogPlugin = PERSONAL_PLUGIN_CATALOG.find((plugin) => plugin.id === record.pluginId)
  const manifest = record.capabilityManifest
  return {
    id: record.pluginId,
    name: manifest.plugin.name ?? catalogPlugin?.name ?? record.pluginId,
    description: manifest.plugin.description ?? catalogPlugin?.description ?? '',
    category: catalogPlugin?.category ?? 'personal',
    status: 'installed',
    icon: catalogPlugin?.icon ?? Sparkles,
    manifest: {
      source: 'installed',
      version: record.versionPin ?? manifest.plugin.version ?? null,
      capabilities: capabilitySummary(record),
    },
    sourceLabel: record.source.uri,
    versionLabel: record.versionPin ?? manifest.plugin.version ?? undefined,
    sourceDetails: installedSourceDetails(record, t),
  }
}

function mergeInstalledRecords(
  current: InstalledPersonalPluginRecord[],
  incoming: InstalledPersonalPluginRecord[],
): InstalledPersonalPluginRecord[] {
  const byId = new Map<string, InstalledPersonalPluginRecord>()
  for (const record of current) byId.set(record.pluginId, record)
  for (const record of incoming) byId.set(record.pluginId, record)
  return Array.from(byId.values()).sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const LocalPluginMarketplacePanel: React.FC<Props> = ({
  organization,
  canManageOrganization = true,
  view = 'marketplace',
  showHeader = true,
  className,
  embedded = false,
  wideGrid = false,
}) => {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  const [installedRecords, setInstalledRecords] = useState<InstalledPersonalPluginRecord[]>([])
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null)
  const [checkingUpdatePluginId, setCheckingUpdatePluginId] = useState<string | null>(null)
  const [updatingPluginId, setUpdatingPluginId] = useState<string | null>(null)
  const [uninstallingPluginId, setUninstallingPluginId] = useState<string | null>(null)
  const [updateChecks, setUpdateChecks] = useState<Record<string, PersonalPluginUpdateCheckResult>>({})
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const locallyUninstalledPluginIdsRef = useRef(new Set<string>())
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const normalizedQuery = query.trim().toLowerCase()
  const installedIds = useMemo(
    () => new Set(installedRecords.map((record) => record.pluginId)),
    [installedRecords],
  )
  const marketplacePlugins = useMemo(
    () => ALL_MARKETPLACE_PLUGINS.map((plugin) => (
      installedIds.has(plugin.id)
        ? { ...plugin, status: 'installed' as const }
        : plugin
    )),
    [installedIds],
  )

  useEffect(() => {
    let cancelled = false
    locallyUninstalledPluginIdsRef.current.clear()
    setInstalledRecords([])
    setUpdateChecks({})
    setNotice(null)
    listInstalledPersonalPlugins(organization.id)
      .then((records) => {
        if (!cancelled) {
          setInstalledRecords(
            mergeInstalledRecords([], records)
              .filter((record) => !locallyUninstalledPluginIdsRef.current.has(record.pluginId)),
          )
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({
            kind: 'error',
            message: tRef.current('pluginMarketplace.loadFailed', { message: errorMessage(error) }),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [organization.id])

  const handleInstall = useCallback(async (plugin: MarketplacePlugin) => {
    if (!canManageOrganization || installingPluginId) return
    setInstallingPluginId(plugin.id)
    setNotice(null)
    try {
      const result = await installOfficialPersonalPlugin(organization.id, plugin.id)
      locallyUninstalledPluginIdsRef.current.delete(result.plugin.pluginId)
      setInstalledRecords((records) => mergeInstalledRecords(records, [result.plugin]))
      const message = result.status === 'already-installed'
        ? t('pluginMarketplace.alreadyInstalledNotice', { name: plugin.name })
        : t('pluginMarketplace.installSuccessNotice', { name: plugin.name })
      setNotice({ kind: 'success', message })
      toast.success(message)
    } catch (error) {
      const message = t('pluginMarketplace.installFailedNotice', {
        name: plugin.name,
        message: errorMessage(error),
      })
      setNotice({ kind: 'error', message })
      toast.error(message)
    } finally {
      setInstallingPluginId(null)
    }
  }, [canManageOrganization, installingPluginId, t, organization.id])

  const handleCheckUpdate = useCallback(async (record: InstalledPersonalPluginRecord) => {
    if (!canManageOrganization || checkingUpdatePluginId || updatingPluginId) return
    setCheckingUpdatePluginId(record.pluginId)
    setNotice(null)
    try {
      const result = await checkPersonalPluginUpdate(organization.id, record.pluginId)
      setUpdateChecks((checks) => ({ ...checks, [record.pluginId]: result }))
      const name = record.capabilityManifest.plugin.name ?? record.pluginId
      const message = result.status === 'update-available'
        ? t('pluginMarketplace.updateAvailableNotice', { name, release: result.candidate?.releaseId ?? '' })
        : result.status === 'not-official'
          ? t('pluginMarketplace.updateNotOfficialNotice', { name })
          : t('pluginMarketplace.updateUpToDateNotice', { name })
      setNotice({ kind: 'success', message })
    } catch (error) {
      const message = t('pluginMarketplace.updateCheckFailedNotice', {
        name: record.capabilityManifest.plugin.name ?? record.pluginId,
        message: errorMessage(error),
      })
      setNotice({ kind: 'error', message })
      toast.error(message)
    } finally {
      setCheckingUpdatePluginId(null)
    }
  }, [canManageOrganization, checkingUpdatePluginId, t, updatingPluginId, organization.id])

  const handleConfirmUpdate = useCallback(async (record: InstalledPersonalPluginRecord) => {
    if (!canManageOrganization || updatingPluginId) return
    const check = updateChecks[record.pluginId]
    if (check?.status !== 'update-available') return
    const name = record.capabilityManifest.plugin.name ?? record.pluginId
    const confirmed = globalThis.confirm?.(
      t('pluginMarketplace.confirmUpdatePrompt', {
        name,
        current: check.current.releaseId ?? check.current.version ?? t('pluginMarketplace.versionUnknown'),
        next: check.candidate?.releaseId ?? check.candidate?.version ?? t('pluginMarketplace.versionUnknown'),
      }),
    ) ?? false
    if (!confirmed) return

    setUpdatingPluginId(record.pluginId)
    setNotice(null)
    try {
      const updated = await confirmPersonalPluginUpdate(organization.id, record.pluginId)
      setInstalledRecords((records) => mergeInstalledRecords(records, [updated]))
      setUpdateChecks((checks) => {
        const next = { ...checks }
        delete next[record.pluginId]
        return next
      })
      const message = t('pluginMarketplace.updateSuccessNotice', {
        name: updated.capabilityManifest.plugin.name ?? updated.pluginId,
        release: updated.officialRelease?.id ?? updated.versionPin ?? '',
      })
      setNotice({ kind: 'success', message })
      toast.success(message)
    } catch (error) {
      const message = t('pluginMarketplace.updateFailedNotice', {
        name,
        message: errorMessage(error),
      })
      setNotice({ kind: 'error', message })
      toast.error(message)
    } finally {
      setUpdatingPluginId(null)
    }
  }, [canManageOrganization, t, updateChecks, updatingPluginId, organization.id])

  const handleUninstall = useCallback(async (record: InstalledPersonalPluginRecord) => {
    if (!canManageOrganization || uninstallingPluginId) return
    const name = record.capabilityManifest.plugin.name ?? record.pluginId
    const confirmed = globalThis.confirm?.(
      t('pluginMarketplace.confirmUninstallPrompt', { name }),
    ) ?? false
    if (!confirmed) return

    setUninstallingPluginId(record.pluginId)
    setNotice(null)
    try {
      await uninstallPersonalPlugin(organization.id, record.pluginId)
      locallyUninstalledPluginIdsRef.current.add(record.pluginId)
      setInstalledRecords((records) => records.filter((item) => item.pluginId !== record.pluginId))
      setUpdateChecks((checks) => {
        const next = { ...checks }
        delete next[record.pluginId]
        return next
      })
      const message = t('pluginMarketplace.uninstallSuccessNotice', { name })
      setNotice({ kind: 'success', message })
      toast.success(message)
    } catch (error) {
      const message = t('pluginMarketplace.uninstallFailedNotice', {
        name,
        message: errorMessage(error),
      })
      setNotice({ kind: 'error', message })
      toast.error(message)
    } finally {
      setUninstallingPluginId(null)
    }
  }, [canManageOrganization, t, uninstallingPluginId, organization.id])

  const searchedMarketplacePlugins = useMemo(() => {
    if (!normalizedQuery) return marketplacePlugins

    return marketplacePlugins.filter((plugin) => {
      const haystack = [
        plugin.name,
        plugin.description,
        plugin.category,
        ...plugin.manifest.capabilities,
      ].join(' ').toLowerCase()

      return haystack.includes(normalizedQuery)
    })
  }, [marketplacePlugins, normalizedQuery])

  const installedPersonalPlugins = installedRecords.map((record) => ({
    record,
    plugin: installedRecordToPlugin(record, t),
  }))
  const headerSubtitle = view === 'installed'
    ? t('pluginMarketplace.installedSubtitle', { organization: organization.name })
    : t('pluginMarketplace.localSubtitle')

  const body = (
    <>
      {showHeader ? (
        <SettingsPanelHeader
          icon={<Puzzle className="h-4 w-4" />}
          title={view === 'installed' ? t('pluginMarketplace.installedTab') : t('appMarket.localSection')}
          subtitle={headerSubtitle}
        />
      ) : null}

      {view === 'marketplace' ? (
        <SettingsPanelToolbar>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              aria-label={t('pluginMarketplace.searchPlaceholder')}
              value={query}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
              placeholder={t('pluginMarketplace.searchPlaceholder')}
              className={cn(SETTINGS_CONTROL, 'pl-8')}
            />
          </div>
        </SettingsPanelToolbar>
      ) : null}

      {notice ? (
        <div
          role="status"
          className={cn(
            'flex items-start gap-2 rounded-interactive border px-3 py-2 text-body',
            notice.kind === 'success'
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <AlertCircle className="mt-0.5 h-[1em] w-[1em] shrink-0" />
          <span>{notice.message}</span>
        </div>
      ) : null}

      {view === 'marketplace' ? (
        <>
          {searchedMarketplacePlugins.length > 0 ? (
            <div className={cn(
              'grid min-w-0 grid-cols-1 gap-3',
              wideGrid ? 'md:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2',
            )}>
              {searchedMarketplacePlugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canManageOrganization || plugin.status === 'installed' || installingPluginId === plugin.id}
                      onClick={() => void handleInstall(plugin)}
                    >
                      <PackageCheck className="mr-1 h-[1em] w-[1em]" />
                      {installingPluginId === plugin.id
                        ? t('pluginMarketplace.installing')
                        : plugin.status === 'installed'
                          ? t('pluginMarketplace.installedAction')
                          : t('pluginMarketplace.install')}
                    </Button>
                  }
                />
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-body text-foreground-secondary">
              {t('pluginMarketplace.noSearchResults')}
            </p>
          )}
        </>
      ) : (
        <SettingsSectionCard
          icon={<PackageCheck className="h-3.5 w-3.5" />}
          title={t('pluginMarketplace.installedPersonalPlugins')}
          subtitle={t('pluginMarketplace.installedPersonalPluginsDesc')}
        >
          {installedPersonalPlugins.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {installedPersonalPlugins.map(({ plugin, record }) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  action={
                    <div className="flex shrink-0 items-center gap-2">
                      {updateChecks[record.pluginId]?.status === 'update-available' ? (
                        <Button
                          variant="default"
                          size="sm"
                          disabled={!canManageOrganization || updatingPluginId === record.pluginId || uninstallingPluginId === record.pluginId}
                          onClick={() => void handleConfirmUpdate(record)}
                        >
                          {updatingPluginId === record.pluginId
                            ? t('pluginMarketplace.updating')
                            : t('pluginMarketplace.updateAction')}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canManageOrganization || checkingUpdatePluginId === record.pluginId || updatingPluginId === record.pluginId || uninstallingPluginId === record.pluginId}
                        onClick={() => void handleCheckUpdate(record)}
                      >
                        {checkingUpdatePluginId === record.pluginId
                          ? t('pluginMarketplace.checkingUpdate')
                          : t('pluginMarketplace.checkUpdateAction')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canManageOrganization || uninstallingPluginId === record.pluginId || updatingPluginId === record.pluginId}
                        onClick={() => void handleUninstall(record)}
                      >
                        <Trash2 className="mr-1 h-[1em] w-[1em]" />
                        {uninstallingPluginId === record.pluginId
                          ? t('pluginMarketplace.uninstalling')
                          : t('pluginMarketplace.uninstallAction')}
                      </Button>
                    </div>
                  }
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<PackageCheck className="h-4 w-4" />}
              title={t('pluginMarketplace.installedEmptyTitle')}
              description={t('pluginMarketplace.installedEmptyDesc')}
              layout="card"
              size="sm"
            />
          )}
        </SettingsSectionCard>
      )}
    </>
  )

  if (embedded) {
    return <div className={cn('space-y-4', className)}>{body}</div>
  }

  return <SettingsPanelLayout className={className}>{body}</SettingsPanelLayout>
}
