/**
 * CredentialsBrowserPanel —— 凭据·浏览器 tab。
 *
 * 走通用 vault 框架（master-detail 双栏 + filter chip + toolbar）。
 */

import React, { useMemo, useState } from 'react'
import { AlertTriangle, Globe, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useCrawlspaceRegistry } from '@/crawlspace/registry/useCrawlspaceRegistry'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { VaultFavicon } from './credentials/VaultFavicon'
import {
  VaultEmpty,
  VaultToolbar,
  useVault,
} from './vault'
import { BROWSER_ICONS, BROWSER_CREDENTIAL_IMPORT_ENABLED } from './credentials/constants'
import { BrowserSyncPopover } from './credentials/BrowserSyncPopover'
import { BrowserVaultDetailBody } from './credentials/BrowserVaultDetail'
import { BlacklistDialog } from './credentials/BlacklistDialog'
import { PasswordFormDialog } from './credentials/PasswordFormDialog'
import {
  useBrowserVaultRows,
  type BrowserVaultFilter,
  type BrowserVaultRow,
} from './credentials/useBrowserVaultRows'
import { useBrowserSync } from './credentials/useBrowserSync'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../settingsUi'

export const CredentialsBrowserPanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const selectedSpace = useSpaceStore((state) => state.selectedSpace)
  const { getSpacePartition } = useCrawlspaceRegistry()
  const currentPartition = useMemo(
    () => getSpacePartition(selectedSpace?.id ?? null),
    [getSpacePartition, selectedSpace?.id],
  )

  const data = useBrowserVaultRows(currentPartition)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [blacklistDialogOpen, setBlacklistDialogOpen] = useState(false)
  const [morePopoverOpen, setMorePopoverOpen] = useState(false)
  const [editRowId, setEditRowId] = useState<string | null>(null)

  const filterPredicate = (row: BrowserVaultRow, filter: BrowserVaultFilter) => {
    if (filter === 'all') return true
    if (filter === 'passwords') return row.raw.kind === 'password'
    if (filter === 'cookies') return row.raw.kind === 'cookie'
    if (filter === 'warnings') return row.raw.kind === 'cookie' && row.raw.hasExpired
    return true
  }

  const searchAccessor = (row: BrowserVaultRow) => {
    const fields = [row.primary, row.secondary, row.raw.hostKey]
    if (row.raw.kind === 'password') fields.push(row.raw.username, row.raw.displayName)
    return fields
  }

  const vault = useVault<BrowserVaultRow['raw'], BrowserVaultFilter>({
    rows: data.rows,
    filters: [
      { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
      { value: 'passwords', label: t('credentialVault.filter.passwords', { defaultValue: '密码' }), count: data.totals.passwords },
      { value: 'cookies', label: t('credentialVault.filter.cookies', { defaultValue: 'Cookie' }), count: data.totals.cookies },
      { value: 'warnings', label: t('credentialVault.filter.warnings', { defaultValue: '警告' }), count: data.totals.warnings, hideWhenZero: true },
    ],
    defaultFilter: 'all',
    filterPredicate,
    searchAccessor,
  })

  if (data.totals.all === 0 && !data.isLoading) {
    return (
      <SettingsPanelLayout className="space-y-4">
        <SettingsPanelHeader
          icon={<Globe className="h-4 w-4" />}
          title={t('credentialsBrowser.title')}
          subtitle={t('credentialsBrowser.subtitle')}
        />
        <BrowserVaultEmptyState
          onSynced={() => void data.refresh()}
          onCreatePassword={() => setCreateDialogOpen(true)}
        />
        <PasswordFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        <BlacklistDialog open={blacklistDialogOpen} onOpenChange={setBlacklistDialogOpen} />
      </SettingsPanelLayout>
    )
  }

  const rightActions = (
    <>
      {BROWSER_CREDENTIAL_IMPORT_ENABLED ? (
        <BrowserSyncPopover partition={currentPartition} onSynced={() => void data.refresh()} />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground"
        onClick={() => setCreateDialogOpen(true)}
        aria-label={t('credentialVault.toolbar.add', { defaultValue: '新建密码' })}
        title={t('credentialVault.toolbar.add', { defaultValue: '新建密码' })}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
      <Popover open={morePopoverOpen} onOpenChange={setMorePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground"
            aria-label={t('credentialVault.toolbar.more', { defaultValue: '更多' })}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1">
          <button
            type="button"
            onClick={() => {
              setMorePopoverOpen(false)
              setBlacklistDialogOpen(true)
            }}
            className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'w-full inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors')}
          >
            <ShieldOff className="h-3.5 w-3.5" />
            <span>{t('credentialVault.toolbar.manageBlacklist', { defaultValue: '管理屏蔽列表' })}</span>
          </button>
        </PopoverContent>
      </Popover>
    </>
  )

  const editRow = editRowId ? data.rows.find((r) => r.id === editRowId) ?? null : null
  const editKindLabel = editRow
    ? editRow.raw.kind === 'cookie'
      ? t('credentialVault.detail.cookieKind', { defaultValue: '浏览器 Cookie' })
      : t('credentialVault.detail.passwordKind', { defaultValue: '网站密码' })
    : ''

  return (
    <SettingsPanelLayout className="space-y-4">
      <SettingsPanelHeader
        icon={<Globe className="h-4 w-4" />}
        title={t('credentialsBrowser.title')}
        subtitle={t('credentialsBrowser.subtitle')}
      />

      <VaultToolbar
        filter={vault.filter}
        onFilterChange={vault.setFilter}
        filters={[
          { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
          { value: 'passwords', label: t('credentialVault.filter.passwords', { defaultValue: '密码' }), count: data.totals.passwords },
          { value: 'cookies', label: t('credentialVault.filter.cookies', { defaultValue: 'Cookie' }), count: data.totals.cookies },
          { value: 'warnings', label: t('credentialVault.filter.warnings', { defaultValue: '警告' }), count: data.totals.warnings, hideWhenZero: true },
        ]}
        search={vault.search}
        onSearchChange={vault.setSearch}
        searchPlaceholder={t('credentialVault.toolbar.searchPlaceholder', { defaultValue: '搜索域名 / 用户名…' })}
        rightActions={rightActions}
      />

      {/* 单列网址列表：每行右侧「编辑」按钮打开详情弹窗（cookie 清除 / 密码编辑删除） */}
      <SettingsSectionCard bodyClassName="space-y-0.5">
        {data.isLoading && data.totals.all === 0 ? (
          <ManagementCardListSkeleton count={6} />
        ) : vault.filteredRows.length === 0 ? (
          <p className={cn(SETTINGS_HINT, 'py-8 text-center')}>
            {vault.filterActive
              ? t('vault.list.filteredEmpty', { defaultValue: '当前筛选下没有匹配项' })
              : t('vault.list.empty', { defaultValue: '暂无项目' })}
          </p>
        ) : (
          vault.filteredRows.map((row) => {
            const warning = row.badges?.find((b) => b.kind === 'warning')
            return (
              <div
                key={row.id}
                className="group flex items-center gap-3 rounded-interactive px-2 py-2 transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
              >
                <VaultFavicon host={row.faviconKey} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-body text-foreground">{row.primary}</span>
                    {row.kindIcon && (
                      <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
                        {row.kindIcon}
                      </span>
                    )}
                  </div>
                  <div className={cn(SETTINGS_HINT, 'mt-0.5 truncate')}>{row.secondary}</div>
                </div>
                {warning && (
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning"
                    title={warning.label}
                  >
                    <AlertTriangle className="h-3 w-3" />
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditRowId(row.id)}
                  className={cn(SETTINGS_HINT, 'h-7 shrink-0 gap-1 px-2 hover:text-foreground')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('credentialVault.detail.edit', { defaultValue: '编辑' })}
                </Button>
              </div>
            )
          })
        )}
      </SettingsSectionCard>

      <Dialog open={!!editRow} onOpenChange={(open) => { if (!open) setEditRowId(null) }}>
        <DialogContent className="max-w-md">
          {editRow && (
            <>
              <DialogHeader>
                <div className="flex flex-col items-center gap-1 text-center">
                  <VaultFavicon host={editRow.faviconKey} size="lg" />
                  <DialogTitle className="mt-2 break-all">{editRow.primary}</DialogTitle>
                  <p className={cn(SETTINGS_HINT, 'inline-flex items-center gap-1.5')}>
                    {editRow.kindIcon}
                    {editKindLabel}
                  </p>
                </div>
              </DialogHeader>
              <BrowserVaultDetailBody
                row={editRow}
                partition={currentPartition}
                onAfterDelete={() => {
                  setEditRowId(null)
                  void data.refresh()
                }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      <PasswordFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <BlacklistDialog open={blacklistDialogOpen} onOpenChange={setBlacklistDialogOpen} />
    </SettingsPanelLayout>
  )
}

// ── 空状态：导入关闭时引导 TabWeb 自行登录；开启时保留同步 CTA ──

const BrowserVaultEmptyState: React.FC<{
  onSynced: () => void
  onCreatePassword: () => void
}> = ({ onSynced, onCreatePassword }) => {
  if (!BROWSER_CREDENTIAL_IMPORT_ENABLED) {
    return <BrowserVaultEmptyManualHint onCreatePassword={onCreatePassword} />
  }
  return <BrowserVaultEmptySyncCTA onSynced={onSynced} />
}

const BrowserVaultEmptyManualHint: React.FC<{ onCreatePassword: () => void }> = ({ onCreatePassword }) => {
  const { t } = useTranslation('settings')
  return (
    <VaultEmpty
      icon={<Globe className="h-5 w-5" />}
      title={t('credentialVault.empty.title', { defaultValue: '还没有任何登录态' })}
      subtitle={t('credentialVault.empty.subtitleManualLogin', {
        defaultValue:
          '在 TabWeb 中打开网站并自行登录。登录成功后 Cookie 会进入共享环境；需要保存密码时我们会询问你是否存入。',
      })}
      cta={
        <div className="flex flex-col items-center gap-2">
          <Button onClick={onCreatePassword} className="h-9 gap-2 px-4">
            <Plus className="h-4 w-4" />
            {t('credentialVault.toolbar.add', { defaultValue: '新建密码' })}
          </Button>
          <span className={cn(SETTINGS_HINT, 'max-w-md text-center')}>
            {t('credentialVault.empty.loginHint', {
              defaultValue: '从工作空间打开「浏览器」App 即可开始登录',
            })}
          </span>
        </div>
      }
    />
  )
}

const BrowserVaultEmptySyncCTA: React.FC<{ onSynced: () => void }> = ({ onSynced }) => {
  const { t } = useTranslation('settings')
  const sync = useBrowserSync()
  const browserIcon = sync.selectedBrowser
    ? BROWSER_ICONS[sync.selectedBrowser.name] ?? <Globe className="h-3.5 w-3.5" />
    : <Globe className="h-3.5 w-3.5" />

  const handleSync = async () => {
    const result = await sync.sync()
    if (result) onSynced()
  }

  const cta = sync.detecting ? (
    <span className={cn(SETTINGS_HINT, 'inline-flex items-center gap-2')}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {t('credentialVault.browserCookies.detecting')}
    </span>
  ) : sync.availableBrowsers.length === 0 ? (
    <span className={SETTINGS_HINT}>
      {t('credentialVault.onboarding.noBrowsersDetected')}
    </span>
  ) : (
    <Button onClick={handleSync} disabled={sync.isSyncing} className="h-9 gap-2 px-4">
      {sync.isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      <span className={cn('inline-flex items-center gap-1.5')}>
        {browserIcon}
        {t('credentialVault.empty.cta', {
          browser: sync.selectedBrowser?.displayName || sync.selectedBrowser?.name || '',
          defaultValue: '同步 {{browser}}',
        })}
      </span>
    </Button>
  )

  return (
    <VaultEmpty
      icon={<Globe className="h-5 w-5" />}
      title={t('credentialVault.empty.title', { defaultValue: '还没有任何登录态' })}
      subtitle={t('credentialVault.empty.subtitle', { defaultValue: '从你的浏览器一键同步 Cookie 和保存的密码' })}
      cta={cta}
    />
  )
}
