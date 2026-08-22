/**
 * CredentialsAiPanel —— 凭据·AI 服务 tab。
 *
 * 用通用 vault 框架（与浏览器 tab 同款 master-detail）。
 *
 * 多种导入方法（toolbar ⟳ 下拉）：
 *  - 预设快速添加（OpenAI / Anthropic / Serper / SendGrid）
 *  - `.env` 文本粘贴批量导入（自动识别常见 ENV 变量名）
 *  - 添加自定义服务（手动输入）
 */

import React, { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import {
  VaultEmpty,
  VaultList,
  VaultPanelLayout,
  VaultToolbar,
  useVault,
} from './vault'
import { Button } from '@tabtin/smartsheet-ui'
import { useAiServiceVaultRows, type AiServiceVaultFilter, type AiServiceVaultRow } from './ai-service/useAiServiceVaultRows'
import { AiServiceSyncPopover } from './ai-service/AiServiceSyncPopover'
import { AiServiceVaultDetail } from './ai-service/AiServiceVaultDetail'
import { AiServiceFormDialog } from './ai-service/AiServiceFormDialog'
import { EnvImportDialog } from './ai-service/EnvImportDialog'

export const CredentialsAiPanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const data = useAiServiceVaultRows()
  const [formOpen, setFormOpen] = useState(false)
  const [formInitialPreset, setFormInitialPreset] = useState<string | undefined>(undefined)
  const [envOpen, setEnvOpen] = useState(false)

  const filterPredicate = (row: AiServiceVaultRow, filter: AiServiceVaultFilter) => {
    if (filter === 'all') return true
    if (filter === 'active') return row.raw.is_active
    if (filter === 'disabled') return !row.raw.is_active
    return true
  }

  const searchAccessor = (row: AiServiceVaultRow) => [
    row.primary,
    row.secondary,
    row.raw.service_name,
  ]

  const vault = useVault<AiServiceVaultRow['raw'], AiServiceVaultFilter>({
    rows: data.rows,
    filters: [
      { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
      { value: 'active', label: t('credentialVault.serviceKeys.active', { defaultValue: '启用' }), count: data.totals.active, hideWhenZero: true },
      { value: 'disabled', label: t('credentialVault.serviceKeys.disabled', { defaultValue: '禁用' }), count: data.totals.disabled, hideWhenZero: true },
    ],
    defaultFilter: 'all',
    filterPredicate,
    searchAccessor,
  })

  const openFormForPreset = (preset?: string) => {
    setFormInitialPreset(preset)
    setFormOpen(true)
  }

  if (data.totals.all === 0 && !data.isLoading) {
    return (
      <SettingsPanelLayout className="space-y-4">
        <SettingsPanelHeader
          icon={<Sparkles className="h-4 w-4" />}
          title={t('credentialsAi.title')}
          subtitle={t('credentialsAi.subtitle')}
        />
        <VaultEmpty
          icon={<Sparkles className="h-5 w-5" />}
          title={t('credentialVault.aiEmpty.title', { defaultValue: '还没有任何 AI 服务密钥' })}
          subtitle={t('credentialVault.aiEmpty.subtitle', { defaultValue: '快速添加 OpenAI / Anthropic 等预设服务，或从 .env 粘贴一次性导入' })}
          cta={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => openFormForPreset('openai')} className="h-9 px-4">
                {t('credentialVault.aiEmpty.cta', { defaultValue: '添加首个密钥' })}
              </Button>
              <Button variant="outline" onClick={() => setEnvOpen(true)} className="h-9 px-4">
                {t('credentialVault.aiSync.envPaste', { defaultValue: '从 .env 粘贴' })}
              </Button>
            </div>
          }
        />
        <AiServiceFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          initialPreset={formInitialPreset}
        />
        <EnvImportDialog open={envOpen} onOpenChange={setEnvOpen} />
      </SettingsPanelLayout>
    )
  }

  const rightActions = (
    <AiServiceSyncPopover
      onPickPreset={(preset) => openFormForPreset(preset)}
      onOpenEnvImport={() => setEnvOpen(true)}
      onPickCustom={() => openFormForPreset('custom')}
    />
  )

  return (
    <SettingsPanelLayout className="space-y-4">
      <SettingsPanelHeader
        icon={<Sparkles className="h-4 w-4" />}
        title={t('credentialsAi.title')}
        subtitle={t('credentialsAi.subtitle')}
      />

      <VaultPanelLayout
        toolbar={
          <VaultToolbar
            filter={vault.filter}
            onFilterChange={vault.setFilter}
            filters={[
              { value: 'all', label: t('credentialVault.filter.all', { defaultValue: '全部' }), count: data.totals.all },
              { value: 'active', label: t('credentialVault.serviceKeys.active', { defaultValue: '启用' }), count: data.totals.active, hideWhenZero: true },
              { value: 'disabled', label: t('credentialVault.serviceKeys.disabled', { defaultValue: '禁用' }), count: data.totals.disabled, hideWhenZero: true },
            ]}
            search={vault.search}
            onSearchChange={vault.setSearch}
            searchPlaceholder={t('credentialVault.aiToolbar.searchPlaceholder', { defaultValue: '搜索服务 / 备注…' })}
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
          <AiServiceVaultDetail row={vault.selectedRow} onAfterDelete={() => vault.setSelectedId(null)} />
        }
      />

      <AiServiceFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o)
          if (!o) setFormInitialPreset(undefined)
        }}
        initialPreset={formInitialPreset}
      />
      <EnvImportDialog open={envOpen} onOpenChange={setEnvOpen} />
    </SettingsPanelLayout>
  )
}
