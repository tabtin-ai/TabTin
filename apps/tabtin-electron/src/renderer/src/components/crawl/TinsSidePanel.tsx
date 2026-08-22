/**
 * TinsSidePanel - 浏览器右侧 Tins 面板
 *
 * 在 CrawlView 右侧展示激活的 Tin 插件。
 * 多个 Tin 激活时通过顶部 Tab 栏切换。
 * 布局参考 BrowserResourceCenter。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Puzzle, X, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, PanelLoadingState } from '@tabtin/smartsheet-ui'
import { useTinsStore, type TinActivationState } from '@stores/useTinsStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { TinSandboxView } from '@components/tins/TinSandboxView'
import { openTinsPanel } from '@components/tins/openTinsPanel'
import { cn } from '@utils/cn'
import type { TinInstance } from '@/services/tinsApi'

interface TinsSidePanelProps {
  open: boolean
  onClose: () => void
  spaceId?: string
}

export const TinsSidePanel: React.FC<TinsSidePanelProps> = ({
  open,
  onClose,
  spaceId,
}) => {
  const organizationId = useResolvedOrganizationId()
  const instances = useTinsStore((s) => s.instances)
  const activationStates = useTinsStore((s) => s.activationStates)

  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const [sandboxPaths, setSandboxPaths] = useState<{ htmlPath: string; preloadPath: string } | null>(null)
  const preparingIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !organizationId || !spaceId) return
    const { instances: current } = useTinsStore.getState()
    if (current.length === 0) {
      void useTinsStore.getState().loadInstances(organizationId, spaceId)
    }
  }, [open, organizationId, spaceId])

  useEffect(() => {
    const unsub = window.tabtin?.tins?.onActivationChanged((data: { states: unknown[] }) => {
      useTinsStore.getState().setActivationStates(data.states as TinActivationState[])
    })
    return () => { unsub?.() }
  }, [])

  const activeTins = useMemo(() => {
    const activeIds = new Set(
      activationStates.filter((s) => s.isActive).map((s) => s.instanceId)
    )
    return instances.filter((i) => activeIds.has(i.id))
  }, [instances, activationStates])

  const allEnabledTins = useMemo(() => {
    return instances.filter((i) => i.is_enabled)
  }, [instances])

  // 自动选中：优先选激活的第一个，或保持当前选中
  useEffect(() => {
    if (!open) return
    if (activeTins.length > 0) {
      const currentStillActive = activeTins.some((t) => t.id === selectedInstanceId)
      if (!currentStillActive) {
        setSelectedInstanceId(activeTins[0].id)
      }
    } else if (allEnabledTins.length > 0) {
      const currentStillExists = allEnabledTins.some((t) => t.id === selectedInstanceId)
      if (!currentStillExists) {
        setSelectedInstanceId(null)
      }
    } else {
      setSelectedInstanceId(null)
    }
  }, [open, activeTins, allEnabledTins, selectedInstanceId])

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId]
  )
  const selectedInstanceKey = selectedInstance?.id ?? null

  // 准备沙箱
  useEffect(() => {
    if (!selectedInstanceKey || !open) {
      preparingIdRef.current = null
      setSandboxPaths(null)
      return
    }

    const targetId = selectedInstanceKey
    preparingIdRef.current = targetId
    setSandboxPaths(null)

    const p = window.tabtin?.tins?.prepareSandbox?.(targetId)
    if (p) {
      p.then((result) => {
        if (preparingIdRef.current !== targetId) return
        if (result) setSandboxPaths(result)
      }).catch(() => {
        if (preparingIdRef.current === targetId) setSandboxPaths(null)
      })
    }

    return () => {
      window.tabtin?.tins?.cleanupSandbox?.(targetId)?.catch(() => {})
    }
  }, [selectedInstanceKey, open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const isActive = (id: string) => activationStates.some((s) => s.instanceId === id && s.isActive)

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Puzzle className="h-4 w-4 text-type-webhook" />
          <span className="text-body font-semibold">Tins</span>
          {activeTins.length > 0 && (
            <span className="flex items-center gap-1 text-body text-success">
              <Sparkles className="h-3 w-3" />
              {activeTins.length} 个激活
            </span>
          )}
        </div>
        <button
          type="button"
          className="rounded p-1 hover:bg-muted transition-colors"
          onClick={onClose}
          title="关闭 Tins 面板"
          aria-label="关闭 Tins 面板"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab 栏：多个激活 Tin 时显示 */}
      {activeTins.length > 1 && (
        <div className="flex gap-1 border-b border-border px-3 py-1.5 overflow-x-auto">
          {activeTins.map((instance) => (
            <button
              key={instance.id}
              onClick={() => setSelectedInstanceId(instance.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-body whitespace-nowrap transition-colors',
                selectedInstanceId === instance.id
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {instance.tin.icon_url ? (
                <img src={instance.tin.icon_url} alt="" className="w-3.5 h-3.5 rounded" />
              ) : (
                <Puzzle className="w-3 h-3" />
              )}
              {instance.tin.name}
            </button>
          ))}
        </div>
      )}

      {/* Sandbox 视图 / 空状态 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {selectedInstance && sandboxPaths ? (
          <TinSandboxView
            instanceId={selectedInstance.id}
            panelHtml={selectedInstance.tin.panel_html}
            htmlPath={sandboxPaths.htmlPath}
            preloadPath={sandboxPaths.preloadPath}
            width="100%"
            height="100%"
          />
        ) : selectedInstance && !sandboxPaths ? (
          <PanelLoadingState variant="detail" rows={4} showHeader={false} className="h-full p-3" />
        ) : (
          <TinSelectionState
            instances={allEnabledTins}
            onSelect={setSelectedInstanceId}
            isActive={isActive}
            spaceId={spaceId}
          />
        )}
      </div>
    </div>
  )
}

// ── 空状态 / Tin 列表（无激活时显示） ──

interface TinSelectionStateProps {
  instances: TinInstance[]
  onSelect: (id: string) => void
  isActive: (id: string) => boolean
  spaceId?: string
}

const TinSelectionState: React.FC<TinSelectionStateProps> = ({
  instances,
  onSelect,
  isActive,
  spaceId,
}) => {
  const { t } = useTranslation('tins')
  const openInstallPanel = useCallback(() => {
    if (spaceId) openTinsPanel(spaceId)
  }, [spaceId])

  if (instances.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          icon={<Puzzle className="h-5 w-5" />}
          title={t('sidePanel.emptyTitle')}
          description={t('sidePanel.emptyDescription')}
          tone="info"
          className="max-w-[280px]"
          action={
            spaceId ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-body"
                onClick={openInstallPanel}
              >
                <Sparkles className="h-3 w-3" />
                {t('sidePanel.openPanel')}
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  }

  return (
    <div className="p-3 space-y-1">
      <EmptyState
        icon={<Puzzle className="h-4 w-4" />}
        title="当前页面无自动匹配的 Tin"
        description="你可以手动选择一个已安装 Tin。"
        layout="card"
        size="sm"
        align="start"
        tone="info"
        className="mb-3 px-3"
      />
      {instances.map((instance) => {
        const active = isActive(instance.id)
        return (
          <button
            key={instance.id}
            onClick={() => onSelect(instance.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left transition-colors',
              'hover:bg-accent',
              active && 'bg-accent/60'
            )}
          >
            {instance.tin.icon_url ? (
              <img src={instance.tin.icon_url} alt="" className="w-5 h-5 rounded flex-shrink-0" />
            ) : (
              <Puzzle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-body truncate">{instance.tin.name}</span>
                {active && <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />}
              </div>
              {instance.tin.description && (
                <p className="text-body text-muted-foreground truncate">{instance.tin.description}</p>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
