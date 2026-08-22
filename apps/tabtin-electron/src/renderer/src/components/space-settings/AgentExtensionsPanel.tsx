/**
 * Space Extensions Panel
 *
 * 展示当前 Agent 可用的 Extension 列表，允许用户
 * 启用/禁用 Extension（创建/删除 space 级 connection）。
 * 支持配置弹窗、probe 测试、已配置字段指标。
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { ConfirmDialog, EmptyState, ScrollArea, StatusNotice, toast } from '@tabtin/smartsheet-ui'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { useTranslation } from 'react-i18next'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { useShallow } from 'zustand/react/shallow'
import { useExtensionStore } from '@stores/useExtensionStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { ExtensionManifest, ExtensionConnection } from '@/services/extensionApi'
import { ConnectionConfigDialog } from '@/components/extensions/ConnectionConfigDialog'
import { ExtensionCard } from '@/components/extensions/ExtensionCard'
import { useProbeConnection } from '@/hooks/useProbeConnection'
import { PersonalPluginEnablementPanel } from './PersonalPluginEnablementPanel'

interface Props {
  spaceId: string
  organizationId: string
  canManage?: boolean
}

export const AgentExtensionsPanel: React.FC<Props> = ({ spaceId, organizationId, canManage = true }) => {
  const { t } = useTranslation(['space', 'settings'])
  const space = useSpaceStore(state => state.spaces.find(item => item.id === spaceId) ?? null)
  const {
    extensions,
    extensionsLoading,
    extensionsError,
    connectionsError,
    fetchExtensions,
    fetchConnectionsBothLevels,
    getConnections,
    getConnectionsLoading,
    editConnection,
    removeConnection,
  } = useExtensionStore(useShallow((s) => ({
    extensions: s.extensions,
    extensionsLoading: s.extensionsLoading,
    extensionsError: s.extensionsError,
    connectionsError: s.connectionsError,
    fetchExtensions: s.fetchExtensions,
    fetchConnectionsBothLevels: s.fetchConnectionsBothLevels,
    getConnections: s.getConnections,
    getConnectionsLoading: s.getConnectionsLoading,
    editConnection: s.editConnection,
    removeConnection: s.removeConnection,
  })))

  const connections = getConnections(organizationId, spaceId)
  const connectionsLoading = getConnectionsLoading(organizationId, spaceId)
  const loading = extensionsLoading || connectionsLoading
  const error = extensionsError || connectionsError

  const [configDialogOpen, setConfigDialogOpen] = useState(false)
  const [configDialogExt, setConfigDialogExt] = useState<ExtensionManifest | null>(null)
  const [configDialogConn, setConfigDialogConn] = useState<ExtensionConnection | null>(null)
  const [deletingConn, setDeletingConn] = useState<ExtensionConnection | null>(null)

  const { probingConnId, probeResult, handleProbe } = useProbeConnection(organizationId)

  useEffect(() => {
    void fetchExtensions(organizationId)
    void fetchConnectionsBothLevels(organizationId, spaceId)
  }, [organizationId, spaceId, fetchExtensions, fetchConnectionsBothLevels])

  const visibleExtensions = useMemo(
    () => extensions.filter((ext) => ext.type !== 'channel'),
    [extensions],
  )
  const hiddenChannelCount = extensions.length - visibleExtensions.length

  const wsConnections = useMemo(() => connections.filter((c) => !c.space_id), [connections])
  const spaceConnections = useMemo(() => connections.filter((c) => c.space_id === spaceId), [connections, spaceId])

  const getWsConn = (extId: string) => wsConnections.find((c) => c.extension_id === extId)
  const getSpaceConn = (extId: string) => spaceConnections.find((c) => c.extension_id === extId)

  const handleOpenInstall = useCallback((ext: ExtensionManifest) => {
    setConfigDialogExt(ext); setConfigDialogConn(null); setConfigDialogOpen(true)
  }, [])

  const handleOpenEditConfig = useCallback((ext: ExtensionManifest, conn: ExtensionConnection) => {
    setConfigDialogExt(ext); setConfigDialogConn(conn); setConfigDialogOpen(true)
  }, [])

  const handleToggle = useCallback(async (conn: ExtensionConnection) => {
    try {
      await editConnection(organizationId, conn.id, { enabled: !conn.enabled })
      toast({ title: t('extensions.toggleSuccess', { ns: 'settings' }) })
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t('extensions.toggleFailed', { ns: 'settings' }),
        variant: 'destructive',
      })
    }
  }, [organizationId, editConnection, t])

  const handleConfirmRemove = useCallback(async () => {
    if (!deletingConn) return
    try {
      await removeConnection(organizationId, deletingConn.id)
      toast({ title: t('extensions.removeSuccess', { ns: 'settings' }) })
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t('extensions.removeFailed', { ns: 'settings' }),
        variant: 'destructive',
      })
    }
  }, [organizationId, deletingConn, removeConnection, t])

  const handleConfigSaved = useCallback(() => {
    void fetchConnectionsBothLevels(organizationId, spaceId)
  }, [organizationId, spaceId, fetchConnectionsBothLevels])

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-4">
        <div className="space-y-1">
          <SpaceSettingsSectionHeader
            marginBottomClassName="mb-0"
            title={t('tabs.extensions')}
            description={t('extensions.desc')}
          />
          {hiddenChannelCount > 0 && (
            <p className="text-caption text-muted-foreground/60 pl-0.5">
              {t('extensions.channelManagedInChannels', { ns: 'settings' })}
            </p>
          )}
        </div>

        <PersonalPluginEnablementPanel
          organizationId={organizationId}
          spaceId={spaceId}
          canManage={canManage}
        />

        {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}

        {loading && visibleExtensions.length === 0 ? (
          <div className="py-1">
            <ManagementCardListSkeleton count={4} />
          </div>
        ) : visibleExtensions.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={t('extensions.empty')}
            size="sm"
            layout="card"
            className="py-6"
          />
        ) : (
          <div className="space-y-1.5">
            {visibleExtensions.map((ext) => {
              const wsConn = getWsConn(ext.id)
              const spaceConn = getSpaceConn(ext.id)
              const isInherited = !!wsConn && !spaceConn
              const activeConn = spaceConn ?? wsConn

              return (
                <ExtensionCard
                  key={ext.id}
                  ext={ext}
                  conn={activeConn}
                  probingConnId={probingConnId}
                  probeResult={probeResult}
                  inherited={isInherited}
                  inheritedLabel={t('extensions.inherited')}
                  onInstall={canManage ? handleOpenInstall : undefined}
                  onEditConfig={canManage && spaceConn ? handleOpenEditConfig : undefined}
                  onProbe={spaceConn ? handleProbe : undefined}
                  onToggle={canManage && spaceConn ? handleToggle : undefined}
                  onRemove={canManage && spaceConn ? () => setDeletingConn(spaceConn) : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

      <ConnectionConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        extension={configDialogExt}
        existingConnection={configDialogConn}
        organizationId={organizationId}
        spaceId={spaceId}
        onSaved={handleConfigSaved}
      />

      <ConfirmDialog
        open={!!deletingConn}
        onOpenChange={(open) => !open && setDeletingConn(null)}
        title={t('extensions.deleteConnectionTitle', { ns: 'settings' })}
        description={t('extensions.deleteConnectionDesc', { ns: 'settings' })}
        onConfirm={handleConfirmRemove}
        variant="destructive"
      />
    </ScrollArea>
  )
}
