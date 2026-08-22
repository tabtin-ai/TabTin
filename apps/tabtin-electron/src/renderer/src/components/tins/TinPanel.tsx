/**
 * TinPanel - Tin 管理面板
 *
 * 主面板组件，显示已安装的 Tin 列表，管理状态，展示激活的 Tin 面板。
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, PanelLoadingState, Skeleton, StatusNotice } from '@tabtin/smartsheet-ui'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { useTinsStore } from '../../stores/useTinsStore'
import { useResolvedOrganizationId } from '../../hooks/useResolvedOrganizationId'
import { TinSandboxView } from './TinSandboxView'
import { TinEditor } from './TinEditor'
import { requestAgentForTin } from './requestAgentForTin'
import { cn } from '../../utils/cn'
import {
  Puzzle,
  Power,
  PowerOff,
  Pin,
  PinOff,
  Trash2,
  Edit,
  Loader2,
  Sparkles,
  ChevronRight,
} from 'lucide-react'

interface TinPanelProps {
  spaceId?: string | null
}

export const TinPanel: React.FC<TinPanelProps> = ({ spaceId }) => {
  const currentSpaceId = spaceId ?? ''
  const { t } = useTranslation('tins')
  const organizationId = useResolvedOrganizationId()

  const tins = useTinsStore((s) => s.tins)
  const instances = useTinsStore((s) => s.instances)
  const isLoading = useTinsStore((s) => s.isLoading)
  const loadError = useTinsStore((s) => s.loadError)
  const activationStates = useTinsStore((s) => s.activationStates)
  const selectedTinId = useTinsStore((s) => s.selectedTinId)
  const tinDetail = useTinsStore((s) => s.tinDetail)

  const editorOpen = useTinsStore((s) => s.editorOpen)
  const editorTinId = useTinsStore((s) => s.editorTinId)

  const {
    loadTins,
    loadInstances,
    loadTinDetail,
    selectTin,
    activateTin,
    disableTin,
    installTin,
    uninstallTin,
    toggleInstanceEnabled,
    toggleInstancePinned,
    openEditor,
    closeEditor,
    resetForOrganizationSwitch,
  } = useTinsStore.getState()

  const prevOrganizationRef = useRef(organizationId)
  useEffect(() => {
    if (!organizationId) return
    if (prevOrganizationRef.current !== organizationId) {
      resetForOrganizationSwitch()
      prevOrganizationRef.current = organizationId
    }
    void loadTins(organizationId, currentSpaceId)
    void loadInstances(organizationId, currentSpaceId)
  }, [organizationId, currentSpaceId])

  // 监听主进程激活状态变化
  useEffect(() => {
    const unsub = window.tabtin?.tins?.onActivationChanged((data: { states: any[] }) => {
      useTinsStore.getState().setActivationStates(data.states)
    })
    return () => { unsub?.() }
  }, [])

  // 监听变量持久化请求
  const organizationIdRef = useRef(organizationId)
  organizationIdRef.current = organizationId

  useEffect(() => {
    const unsub = window.tabtin?.tins?.onPersistVariable(
      async (data: { instanceId: string; name: string; value: unknown }) => {
        const wsId = organizationIdRef.current
        if (!wsId) return
        try {
          const instance = useTinsStore.getState().instances.find((i) => i.id === data.instanceId)
          if (!instance) return
          const newVars = { ...instance.user_variables, [data.name]: data.value }
          const { updateInstance } = await import('../../services/tinsApi')
          await updateInstance(wsId, data.instanceId, { user_variables: newVars })
        } catch (e) {
          console.error('[TinPanel] Failed to persist variable:', e)
          const { toast } = await import('@tabtin/smartsheet-ui')
          toast({ title: t('toast.persistVarFailed'), variant: 'destructive' })
        }
      }
    )
    return () => { unsub?.() }
  }, [])

  // 分类：已安装的 / 可用的（未安装的）
  const installedTinIds = useMemo(
    () => new Set(instances.map((i) => i.tin_id)),
    [instances]
  )

  const availableTins = useMemo(
    () => tins.filter((t) => !installedTinIds.has(t.id) && t.status === 'active'),
    [tins, installedTinIds]
  )

  const activeTinPanel = useMemo(() => {
    const activeState = activationStates.find((s) => s.panelVisible)
    if (!activeState) return null
    const instance = instances.find((i) => i.id === activeState.instanceId)
    return instance || null
  }, [activationStates, instances])

  const [sandboxPaths, setSandboxPaths] = useState<{
    htmlPath: string
    preloadPath: string
  } | null>(null)
  const [sandboxInstanceId, setSandboxInstanceId] = useState<string | null>(null)
  const [sandboxError, setSandboxError] = useState<string | null>(null)
  const [sandboxRetryCount, setSandboxRetryCount] = useState(0)
  const preparingIdRef = useRef<string | null>(null)
  const sandboxInstanceIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeTinPanel) {
      preparingIdRef.current = null
      setSandboxPaths(null)
      setSandboxInstanceId(null)
      setSandboxError(null)
      setSandboxRetryCount(0)
      return
    }
    if (activeTinPanel.id === sandboxInstanceId && sandboxPaths) return

    const targetId = activeTinPanel.id
    preparingIdRef.current = targetId
    setSandboxPaths(null)
    setSandboxInstanceId(targetId)
    setSandboxError(null)
    sandboxInstanceIdRef.current = targetId

    window.tabtin?.tins?.prepareSandbox(targetId)
      .then((result) => {
        if (preparingIdRef.current !== targetId) return
        if (result) setSandboxPaths(result)
        else setSandboxError('SANDBOX_PREPARE_FAILED')
      })
      .catch(() => {
        if (preparingIdRef.current === targetId) {
          setSandboxPaths(null)
          setSandboxError('SANDBOX_PREPARE_FAILED')
        }
      })

    return () => {
      if (sandboxInstanceIdRef.current) {
        window.tabtin?.tins?.cleanupSandbox(sandboxInstanceIdRef.current).catch(() => {})
      }
    }
  }, [activeTinPanel?.id, sandboxRetryCount])

  const handleSandboxError = useCallback((error: string) => {
    setSandboxError(error)
  }, [])

  const handleUninstall = useCallback((instanceId: string, tinName: string) => {
    if (!window.confirm(t('confirm.uninstall', { name: tinName }))) return
    void uninstallTin(instanceId)
  }, [uninstallTin, t])

  const handleAskAgentForTin = useCallback(() => {
    if (!currentSpaceId) return
    void requestAgentForTin(currentSpaceId)
  }, [currentSpaceId])

  const handleRetry = useCallback(() => {
    if (organizationId) {
      void loadTins(organizationId, currentSpaceId)
      void loadInstances(organizationId, currentSpaceId)
    }
  }, [organizationId, currentSpaceId, loadTins, loadInstances])

  // 编辑器模式：全屏覆盖列表视图
  if (editorOpen && editorTinId) {
    return <TinEditor tinId={editorTinId} onClose={closeEditor} />
  }

  if (isLoading && tins.length === 0 && instances.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Skeleton width={16} height={16} rounded="md" className="opacity-70" />
          <Skeleton width="22%" height={14} rounded="md" />
          <Skeleton width={54} height={10} rounded="full" className="ml-auto opacity-60" />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="space-y-4">
            <div>
              <Skeleton width={76} height={10} rounded="full" className="mb-2 opacity-65" />
              <DetailedRowListSkeleton count={4} compact />
            </div>
            <div>
              <Skeleton width={88} height={10} rounded="full" className="mb-2 opacity-55" />
              <DetailedRowListSkeleton count={3} compact />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <StatusNotice
          tone="danger"
          title={t('error.loadFailed', { defaultValue: 'Tin 加载失败' })}
          description={loadError}
          actions={(
            <Button variant="outline" size="sm" onClick={handleRetry}>
              {t('action.retry')}
            </Button>
          )}
          className="max-w-md"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Sparkles className="w-4 h-4 text-primary" />
        <h2 className="text-body font-semibold">{t('title')}</h2>
        <span className="ml-auto text-body text-muted-foreground">
          {t('installedCount', { count: instances.length })}
        </span>
      </div>

      {/* 激活的 Tin 面板 */}
      {activeTinPanel && (
        <div className="flex-1 border-b">
          <div className="flex items-center gap-2 px-3 py-2 bg-accent/60">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-body font-medium">{activeTinPanel.tin.name}</span>
          </div>
          {sandboxError ? (
            <div className="flex flex-col items-center justify-center h-40 px-4 text-muted-foreground">
              <StatusNotice
                tone="warning"
                title={t('error.sandboxFailed', { defaultValue: 'Tin 面板加载失败' })}
                description={t('error.sandboxFailedDesc', { defaultValue: '面板内容无法加载，请检查 Tin 配置或稍后重试。' })}
                actions={(
                  <Button variant="outline" size="sm" onClick={() => {
                    setSandboxError(null)
                    setSandboxPaths(null)
                    setSandboxInstanceId(null)
                    setSandboxRetryCount((c) => c + 1)
                  }}>
                    {t('action.retry')}
                  </Button>
                )}
                className="max-w-sm"
              />
            </div>
          ) : sandboxPaths ? (
            <TinSandboxView
              instanceId={activeTinPanel.id}
              panelHtml={activeTinPanel.tin.panel_html}
              htmlPath={sandboxPaths.htmlPath}
              preloadPath={sandboxPaths.preloadPath}
              width={activeTinPanel.tin.panel_width}
              onError={handleSandboxError}
            />
          ) : (
            <PanelLoadingState variant="detail" rows={3} showHeader={false} className="px-3 py-3" />
          )}
        </div>
      )}

      {/* 已安装的 Tin 列表 */}
      <div className="flex-1 overflow-y-auto">
        {instances.length > 0 && (
          <div className="px-3 py-2">
            <h3 className="text-body font-medium text-muted-foreground mb-2">{t('section.installed')}</h3>
            <div className="space-y-1">
              {instances.map((instance) => (
                <TinInstanceCard
                  key={instance.id}
                  instance={instance}
                  isActive={
                    activationStates.find((s) => s.instanceId === instance.id)?.isActive ?? false
                  }
                  onToggleEnabled={(enabled) => toggleInstanceEnabled(instance.id, enabled)}
                  onTogglePinned={(pinned) => toggleInstancePinned(instance.id, pinned)}
                  onUninstall={() => handleUninstall(instance.id, instance.tin.name)}
                  onEdit={() => openEditor(instance.tin_id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 可安装的 Tin */}
        {availableTins.length > 0 && (
          <div className="px-3 py-2">
            <h3 className="text-body font-medium text-muted-foreground mb-2">{t('section.available')}</h3>
            <div className="space-y-1">
              {availableTins.map((tin) => (
                <AvailableTinCard
                  key={tin.id}
                  tin={tin}
                  onInstall={() => installTin(tin.id, currentSpaceId)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {instances.length === 0 && availableTins.length === 0 && (
          <div className="flex flex-1 min-h-[280px] items-center justify-center px-6 py-12">
            <EmptyState
              icon={<Puzzle className="h-5 w-5" />}
              title={t('empty.title')}
              description={t('empty.description')}
              tone="info"
              className="max-w-[320px]"
              action={
                currentSpaceId ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-body"
                    onClick={handleAskAgentForTin}
                  >
                    <Sparkles className="h-3 w-3" />
                    {t('empty.askAgent')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── 子组件 ────────────────────────────────────────

interface TinInstanceCardProps {
  instance: {
    id: string
    is_enabled: boolean
    pinned: boolean
    tin: {
      name: string
      description: string
      icon_url: string
      status: string
      activation_mode: string
    }
  }
  isActive: boolean
  onToggleEnabled: (enabled: boolean) => void
  onTogglePinned: (pinned: boolean) => void
  onUninstall: () => void
  onEdit: () => void
}

const TinInstanceCard: React.FC<TinInstanceCardProps> = ({
  instance,
  isActive,
  onToggleEnabled,
  onTogglePinned,
  onUninstall,
  onEdit,
}) => {
  const { t } = useTranslation('tins')
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded-md',
        'hover:bg-accent transition-colors',
        isActive && 'bg-accent/60'
      )}
    >
      {instance.tin.icon_url ? (
        <img src={instance.tin.icon_url} alt="" className="w-5 h-5 rounded" />
      ) : (
        <Puzzle className="w-4 h-4 text-muted-foreground" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-body truncate">{instance.tin.name}</span>
          {isActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
          )}
        </div>
      </div>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onTogglePinned(!instance.pinned)
          }}
          className="p-1 rounded hover:bg-accent-foreground/10"
          title={instance.pinned ? t('action.unpin') : t('action.pin')}
        >
          {instance.pinned ? (
            <PinOff className="w-3 h-3" />
          ) : (
            <Pin className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleEnabled(!instance.is_enabled)
          }}
          className="p-1 rounded hover:bg-accent-foreground/10"
          title={instance.is_enabled ? t('action.disable') : t('action.enable')}
        >
          {instance.is_enabled ? (
            <PowerOff className="w-3 h-3" />
          ) : (
            <Power className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          className="p-1 rounded hover:bg-accent-foreground/10"
          title={t('action.edit')}
        >
          <Edit className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onUninstall()
          }}
          className="p-1 rounded hover:bg-destructive/20 text-destructive"
          title={t('action.uninstall')}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}

interface AvailableTinCardProps {
  tin: {
    id: string
    name: string
    description: string
    icon_url: string
  }
  onInstall: () => void
}

const AvailableTinCard: React.FC<AvailableTinCardProps> = ({ tin, onInstall }) => {
  const { t } = useTranslation('tins')
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent transition-colors">
      {tin.icon_url ? (
        <img src={tin.icon_url} alt="" className="w-5 h-5 rounded" />
      ) : (
        <Puzzle className="w-4 h-4 text-muted-foreground" />
      )}
      <div className="flex-1 min-w-0">
        <span className="text-body truncate">{tin.name}</span>
        {tin.description && (
          <p className="text-body text-muted-foreground truncate">{tin.description}</p>
        )}
      </div>
      <button
        onClick={onInstall}
        className="text-body px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
      >
        {t('action.install')}
      </button>
    </div>
  )
}
