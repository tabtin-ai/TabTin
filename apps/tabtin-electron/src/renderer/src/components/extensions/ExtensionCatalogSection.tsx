/**
 * Extension Catalog 区块：展示扩展列表，包含安装/配置/probe/开关/删除操作。
 * 复用于 OrganizationExtensionsPanel。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionManifest, ExtensionConnection } from '@/services/extensionApi'
import { ExtensionCard } from './ExtensionCard'
import { useProbeConnection } from '@/hooks/useProbeConnection'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'

export interface ExtensionCatalogSectionProps {
  extensions: ExtensionManifest[]
  getConnection: (extId: string) => ExtensionConnection | undefined
  organizationId: string
  loading: boolean
  canManageOrganization?: boolean
  onInstall: (ext: ExtensionManifest) => void
  onEditConfig: (ext: ExtensionManifest, conn: ExtensionConnection) => void
  onToggle: (conn: ExtensionConnection) => void
  onDelete: (connId: string) => void
}

export const ExtensionCatalogSection: React.FC<ExtensionCatalogSectionProps> = ({
  extensions,
  getConnection,
  organizationId,
  loading,
  canManageOrganization = true,
  onInstall,
  onEditConfig,
  onToggle,
  onDelete,
}) => {
  const { t } = useTranslation(['settings', 'common'])
  const { probingConnId, probeResult, handleProbe } = useProbeConnection(organizationId)

  if (loading && extensions.length === 0) {
    return (
      <ManagementCardListSkeleton count={4} />
    )
  }

  if (extensions.length === 0) {
    return (
      <p className="text-caption text-muted-foreground py-4">
        {t('extensions.empty', { ns: 'settings' })}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {extensions.map((ext) => (
        <ExtensionCard
          key={ext.id}
          ext={ext}
          conn={getConnection(ext.id)}
          probingConnId={probingConnId}
          probeResult={probeResult}
          canManageOrganization={canManageOrganization}
          onInstall={canManageOrganization ? onInstall : undefined}
          onEditConfig={onEditConfig}
          onProbe={handleProbe}
          onToggle={onToggle}
          onRemove={onDelete}
        />
      ))}
    </div>
  )
}
