import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Cpu,
  Plug,
  RefreshCw,
  Wrench,
  Sparkles,
  Bot,
  Puzzle,
  ChevronDown,
  ArrowRight,
} from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL_SM, SETTINGS_SECTION_TITLE } from '@components/settings/settingsUi'
import type { Space } from '@tabtin/app-shell'
import {
  listConnections,
  listExtensions,
  type ExtensionConnection,
  type ExtensionManifest,
} from '@/services/extensionApi'
import { SubAgentTemplateApi, type SubAgentTemplate } from '@/services/subagentTemplateApi'
import { useDeviceStore } from '@/stores/useDeviceStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSkillsListQuery } from '@/hooks/queries/skills'
import type { CapabilityDiscoverySummary } from './shared'
import {
  snapshotToolNames,
  snapshotMcpToolNames,
  formatToolName,
  uniqById,
} from './shared'
import { buildSpaceCapabilitySemantics, type SpaceCapabilitySemanticsResult } from './spaceCapabilitySemantics'

interface ExecutionReadinessSummaryProps {
  space: Space
  onOpenSection?: (section: string) => void
}

export const ExecutionReadinessSummary: React.FC<ExecutionReadinessSummaryProps> = ({ space, onOpenSection }) => {
  const { t } = useTranslation('space')
  const {
    data: skills = [],
    isLoading: skillsLoading,
    isFetching: skillsFetching,
    isError: skillsError,
    refetch: refetchSkills,
  } = useSkillsListQuery(space.id)

  const requestVersionRef = useRef(0)
  const [discoverySummary, setDiscoverySummary] = useState<CapabilityDiscoverySummary | null>(null)
  const [subagents, setSubagents] = useState<SubAgentTemplate[]>([])
  const [extensions, setExtensions] = useState<ExtensionManifest[]>([])
  const [connections, setConnections] = useState<ExtensionConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    const version = requestVersionRef.current + 1
    requestVersionRef.current = version
    if (mode === 'initial') {
      setLoading(true)
      setDiscoverySummary(null)
      setSubagents([])
      setExtensions([])
      setConnections([])
    }
    if (mode === 'refresh') setRefreshing(true)
    setError(null)

    try {
      const results = await Promise.allSettled([
        window.tabtin.capabilityDiscovery.getSummary(space.id),
        SubAgentTemplateApi.list(space.id),
        listExtensions(space.organization_id),
        listConnections(space.organization_id),
        listConnections(space.organization_id, space.id),
      ])

      if (version !== requestVersionRef.current) return

      if (results[0].status === 'fulfilled') setDiscoverySummary(results[0].value as CapabilityDiscoverySummary)
      if (results[1].status === 'fulfilled') setSubagents(results[1].value)
      if (results[2].status === 'fulfilled') setExtensions(results[2].value.extensions ?? [])

      const mergedConnections = uniqById([
        ...(results[3].status === 'fulfilled' ? results[3].value.connections ?? [] : []),
        ...(results[4].status === 'fulfilled' ? results[4].value.connections ?? [] : []),
      ])
      setConnections(mergedConnections)

      if (results.some(r => r.status === 'rejected')) {
        setError(t('toolsCli.partialError', { defaultValue: '部分能力状态加载失败。' }))
      }
    } catch (err) {
      if (version !== requestVersionRef.current) return
      setError(t('toolsCli.partialError', { defaultValue: '加载能力状态失败。' }))
    } finally {
      if (version === requestVersionRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [space.id, space.organization_id, t])

  useEffect(() => { void loadData('initial') }, [loadData])
  useEffect(() => () => { requestVersionRef.current += 1 }, [])

  const selectedAgent = useSpaceStore((s) => s.selectedAgent)
  const boundId = selectedAgent?.control_device_id ?? selectedAgent?.bound_device_id
  const boundDeviceStatus = useDeviceStore((s) => {
    if (!boundId) return undefined
    return s.devices.find((d) => d.id === boundId)?.status
  })
  const deviceStatusChangeRef = useRef(true)
  useEffect(() => {
    if (deviceStatusChangeRef.current) {
      deviceStatusChangeRef.current = false
      return
    }
    if (boundDeviceStatus) void loadData('refresh')
  }, [boundDeviceStatus, loadData])

  const backendSummary = discoverySummary?.backend ?? null
  const executionBinding = backendSummary?.execution_binding ?? null
  const executionSnapshotInfo = backendSummary?.execution_snapshot ?? null
  const localHost = discoverySummary?.local_host ?? null
  const localRuntimeSnapshot = localHost?.runtime_snapshot ?? null
  const boundRuntimeSnapshot = executionSnapshotInfo?.snapshot ?? null

  const deviceBound = executionBinding?.bound === true
  const isCurrentElectronBound = Boolean(
    executionBinding?.device_fingerprint
    && localHost?.fingerprint
    && executionBinding.device_fingerprint === localHost.fingerprint,
  )

  const effectiveSnapshot = isCurrentElectronBound ? localRuntimeSnapshot : boundRuntimeSnapshot
  const effectiveRuntimeTools = snapshotToolNames(effectiveSnapshot)
  const effectiveMcpStatus = effectiveSnapshot?.mcp_server ?? null
  const effectiveMcpToolNames = snapshotMcpToolNames(effectiveSnapshot).map(formatToolName)

  const hasSnapshot = Boolean(effectiveSnapshot)
  const isUnbound = !deviceBound

  const localMcpConnections = localHost?.local_mcp_connections ?? []
  const spaceCapabilities: SpaceCapabilitySemanticsResult = useMemo(
    () => buildSpaceCapabilitySemantics({
      spaceId: space.id,
      agentId: selectedAgent?.id,
      skills,
      subagents,
      extensions,
      connections,
      localMcpConnections,
    }),
    [space.id, selectedAgent?.id, skills, subagents, extensions, connections, localMcpConnections],
  )

  if (isUnbound) {
    return null; // Don't show readiness if no device is bound
  }

  const renderStatusDot = (status: 'ready' | 'warning' | 'error' | 'offline') => {
    const colors = {
      ready: 'bg-success',
      warning: 'bg-warning',
      error: 'bg-destructive',
      offline: 'bg-muted-foreground/30',
    }
    return <div className={cn('h-2 w-2 rounded-full shrink-0', colors[status])} />
  }

  const mcpReady = effectiveMcpStatus?.running
  const mcpCount = effectiveMcpToolNames.length
  const isRefreshing = loading || refreshing || skillsLoading || skillsFetching
  const displayError = error || (
    skillsError ? t('toolsCli.partialError', { defaultValue: '部分能力状态加载失败。' }) : null
  )

  const skillsReady = spaceCapabilities.visibleSkills.filter(s => s.availability_state === 'available').length
  const skillsTotal = spaceCapabilities.visibleSkills.length

  const subagentsReady = spaceCapabilities.enabledSubagents.filter(s => s.availability_state === 'available').length
  const subagentsTotal = spaceCapabilities.enabledSubagents.length

  const extensionsReady = spaceCapabilities.connectedExtensions.filter(s => s.availability_state === 'available').length
  const extensionsTotal = spaceCapabilities.connectedExtensions.length

  return (
    <div className="mt-8 space-y-3">
      <div className="flex items-center justify-between">
        <div className={SETTINGS_SECTION_TITLE}>
          {t('toolsCli.readiness.title', { defaultValue: '执行能力就绪状态' })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void loadData('refresh')
            void refetchSkills()
          }}
          disabled={isRefreshing}
          className="h-7 w-7 p-0 text-muted-foreground/40 hover:text-foreground"
        >
          <RefreshCw className={cn('h-3 w-3', isRefreshing && 'animate-spin')} />
        </Button>
      </div>

      {displayError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-body text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{displayError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* Runtime Tools */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            {renderStatusDot(hasSnapshot ? 'ready' : 'warning')}
            <Wrench className="h-4 w-4 text-muted-foreground/60 shrink-0" />
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground truncate">
                {t('toolsCli.runtime.title', { defaultValue: '基础环境 (Runtime)' })}
              </div>
              <div className="text-caption text-muted-foreground/60 truncate mt-0.5">
                {hasSnapshot
                  ? t('executionReadiness.runtimeToolsAvailable', { defaultValue: '{{count}} runtime tools available', count: effectiveRuntimeTools.length })
                  : t('executionReadiness.waitingForSnapshot', { defaultValue: 'Waiting for device snapshot' })}
              </div>
            </div>
          </div>
        </div>

        {effectiveMcpStatus ? (
        <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            {renderStatusDot(mcpReady ? 'ready' : (hasSnapshot ? 'warning' : 'offline'))}
            <Plug className="h-4 w-4 text-muted-foreground/60 shrink-0" />
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground truncate">
                {t('toolsCli.mcpSection.title', { defaultValue: 'MCP 服务' })}
              </div>
              <div className="text-caption text-muted-foreground/60 truncate mt-0.5">
                {mcpReady
                  ? t('executionReadiness.mcpToolsMounted', { defaultValue: '{{count}} tools mounted', count: mcpCount })
                  : (hasSnapshot ? t('executionReadiness.mcpNotRunning', { defaultValue: 'Service not running' }) : t('executionReadiness.mcpWaitingStatus', { defaultValue: 'Waiting for status report' }))}
              </div>
            </div>
          </div>
        </div>
        ) : null}

        {/* Skills */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            {renderStatusDot(skillsTotal === 0 ? 'offline' : (skillsReady === skillsTotal ? 'ready' : 'warning'))}
            <Sparkles className="h-4 w-4 text-muted-foreground/60 shrink-0" />
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground truncate">
                Skills
              </div>
              <div className="text-caption text-muted-foreground/60 truncate mt-0.5">
                {skillsTotal === 0
                  ? t('executionReadiness.noSkillsEnabled', { defaultValue: 'No skills enabled' })
                  : t('executionReadiness.skillsReady', { defaultValue: '{{ready}}/{{total}} configured', ready: skillsReady, total: skillsTotal })}
              </div>
            </div>
          </div>
          {onOpenSection && (
            <Button variant="ghost" className={cn(SETTINGS_CONTROL_SM, 'px-2 text-muted-foreground hover:text-foreground shrink-0')} onClick={() => onOpenSection('skills')}>
              {t('executionReadiness.manageButton', { defaultValue: 'Manage' })}
            </Button>
          )}
        </div>

        {/* Subagents (only if workspace) */}
        {space.type === 'workspace' && (
          <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-card">
            <div className="flex items-center gap-3 min-w-0">
              {renderStatusDot(subagentsTotal === 0 ? 'offline' : (subagentsReady === subagentsTotal ? 'ready' : 'warning'))}
              <Bot className="h-4 w-4 text-muted-foreground/60 shrink-0" />
              <div className="min-w-0">
                <div className="text-body font-medium text-foreground truncate">
                  {t('tabs.subagents', { defaultValue: '子 Agent' })}
                </div>
                <div className="text-caption text-muted-foreground/60 truncate mt-0.5">
                  {subagentsTotal === 0
                    ? t('executionReadiness.noSubagentsEnabled', { defaultValue: 'No subagents enabled' })
                    : t('executionReadiness.subagentsReady', { defaultValue: '{{ready}}/{{total}} ready', ready: subagentsReady, total: subagentsTotal })}
                </div>
              </div>
            </div>
            {onOpenSection && (
              <Button variant="ghost" className={cn(SETTINGS_CONTROL_SM, 'px-2 text-muted-foreground hover:text-foreground shrink-0')} onClick={() => onOpenSection('subagents')}>
                {t('executionReadiness.manageButton', { defaultValue: 'Manage' })}
              </Button>
            )}
          </div>
        )}

        {/* Extensions */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            {renderStatusDot(extensionsTotal === 0 ? 'offline' : (extensionsReady === extensionsTotal ? 'ready' : 'warning'))}
            <Puzzle className="h-4 w-4 text-muted-foreground/60 shrink-0" />
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground truncate">
                {t('tabs.extensions', { defaultValue: '集成应用' })}
              </div>
              <div className="text-caption text-muted-foreground/60 truncate mt-0.5">
                {extensionsTotal === 0
                  ? t('executionReadiness.noExtensionsConnected', { defaultValue: 'No integrations connected' })
                  : t('executionReadiness.extensionsConnected', { defaultValue: '{{ready}}/{{total}} connected', ready: extensionsReady, total: extensionsTotal })}
              </div>
            </div>
          </div>
          {onOpenSection && (
            <Button variant="ghost" className={cn(SETTINGS_CONTROL_SM, 'px-2 text-muted-foreground hover:text-foreground shrink-0')} onClick={() => onOpenSection('extensions')}>
              {t('executionReadiness.manageButton', { defaultValue: 'Manage' })}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
