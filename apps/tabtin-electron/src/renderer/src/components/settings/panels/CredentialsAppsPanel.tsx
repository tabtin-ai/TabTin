/**
 * CredentialsAppsPanel —— 凭据·应用 tab。
 *
 * 用通用 vault 框架，统一与浏览器 / AI 服务一致的视觉。
 *
 * 多种添加方法（toolbar ⟳ 下拉）：
 *  - 从当前 Space 关联设备扫描已安装 App（DeviceAppPickerDialog）
 *  - 手动添加
 */

import React, { useState } from 'react'
import { LayoutGrid, Smartphone } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import {
  VaultEmpty,
  VaultList,
  VaultPanelLayout,
  VaultToolbar,
  useVault,
} from './vault'
import {
  useAppVaultRows,
  type AppVaultFilter,
  type AppVaultRow,
} from './app-credential/useAppVaultRows'
import { AppVaultSyncPopover } from './app-credential/AppVaultSyncPopover'
import { AppVaultDetail } from './app-credential/AppVaultDetail'
import { AppCredentialFormDialog } from './app-credential/AppCredentialFormDialog'
import { DeviceAppPickerDialog } from './app-credential/DeviceAppPickerDialog'

export const CredentialsAppsPanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const selectedSpace = useSpaceStore((state) => state.selectedSpace)
  const spaceId = selectedSpace?.id ?? null

  const data = useAppVaultRows()
  const [formOpen, setFormOpen] = useState(false)
  const [formPrefill, setFormPrefill] = useState<{ pkg?: string; appName?: string }>({})
  const [pickerOpen, setPickerOpen] = useState(false)

  const vault = useVault<AppVaultRow['raw'], AppVaultFilter>({
    rows: data.rows,
    filters: [
      { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
    ],
    defaultFilter: 'all',
    filterPredicate: () => true,
    searchAccessor: (row) => [row.primary, row.secondary, row.raw.app_package, row.raw.app_name || ''],
  })

  const openForm = (prefill?: { pkg?: string; appName?: string }) => {
    setFormPrefill(prefill ?? {})
    setFormOpen(true)
  }

  if (data.totals.all === 0 && !data.isLoading) {
    return (
      <SettingsPanelLayout className="space-y-4">
        <SettingsPanelHeader
          icon={<LayoutGrid className="h-4 w-4" />}
          title={t('credentialsApps.title')}
          subtitle={t('credentialsApps.subtitle')}
        />
        <VaultEmpty
          icon={<Smartphone className="h-5 w-5" />}
          title={t('credentialVault.appEmpty.title', { defaultValue: '还没有任何应用凭据' })}
          subtitle={t('credentialVault.appEmpty.subtitle', { defaultValue: '从当前工作空间关联设备扫描已装应用，或手动添加' })}
          cta={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {spaceId && (
                <Button onClick={() => setPickerOpen(true)} className="h-9 px-4">
                  {t('credentialVault.appEmpty.scan', { defaultValue: '从设备扫描' })}
                </Button>
              )}
              <Button variant="outline" onClick={() => openForm()} className="h-9 px-4">
                {t('credentialVault.appEmpty.manual', { defaultValue: '手动添加' })}
              </Button>
            </div>
          }
        />
        <AppCredentialFormDialog
          open={formOpen}
          onOpenChange={(o) => {
            setFormOpen(o)
            if (!o) setFormPrefill({})
          }}
          prefillPackage={formPrefill.pkg}
          prefillAppName={formPrefill.appName}
        />
        <DeviceAppPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          spaceId={spaceId}
          onPicked={(app) => openForm({ pkg: app.package, appName: app.name })}
        />
      </SettingsPanelLayout>
    )
  }

  const rightActions = (
    <AppVaultSyncPopover
      hasSpace={!!spaceId}
      onScanDevice={() => setPickerOpen(true)}
      onPickManual={() => openForm()}
    />
  )

  return (
    <SettingsPanelLayout className="space-y-4">
      <SettingsPanelHeader
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t('credentialsApps.title')}
        subtitle={t('credentialsApps.subtitle')}
      />

      <VaultPanelLayout
        toolbar={
          <VaultToolbar
            filter={vault.filter}
            onFilterChange={vault.setFilter}
            filters={[
              { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
            ]}
            search={vault.search}
            onSearchChange={vault.setSearch}
            searchPlaceholder={t('credentialVault.appToolbar.searchPlaceholder', { defaultValue: '搜索应用 / 用户名…' })}
            rightActions={rightActions}
          />
        }
        list={
          <VaultList
            rows={vault.filteredRows}
            selectedId={vault.selectedId}
            onSelect={vault.setSelectedId}
            isLoading={data.isLoading}
            totalCount={data.totals.all}
            filterActive={vault.filterActive}
          />
        }
        detail={
          <AppVaultDetail row={vault.selectedRow} onAfterDelete={() => vault.setSelectedId(null)} />
        }
      />

      <AppCredentialFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o)
          if (!o) setFormPrefill({})
        }}
        prefillPackage={formPrefill.pkg}
        prefillAppName={formPrefill.appName}
      />
      <DeviceAppPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        spaceId={spaceId}
        onPicked={(app) => openForm({ pkg: app.package, appName: app.name })}
      />
    </SettingsPanelLayout>
  )
}
