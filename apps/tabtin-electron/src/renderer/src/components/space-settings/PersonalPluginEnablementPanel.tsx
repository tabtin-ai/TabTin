import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, StatusNotice, Switch, toast } from '@tabtin/smartsheet-ui'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  getPersonalPluginRuntimeStatus,
  listPersonalPluginEnablement,
  setPersonalPluginEnabled,
  stopPersonalPluginRuntime,
  type PersonalPluginEnablementRecord,
  type PersonalPluginRuntimeStatus,
} from '@/services/personalPluginMarketplaceClient'

interface PersonalPluginEnablementPanelProps {
  organizationId: string
  spaceId: string
  canManage?: boolean
}

function pluginDisplayName(record: PersonalPluginEnablementRecord): string {
  return record.capabilityManifest.plugin.name ?? record.pluginId
}

function capabilityLabels(record: PersonalPluginEnablementRecord): string[] {
  const skills = record.capabilityManifest.skills.map((skill) => `skill:${skill.id}`)
  const extras = [
    record.capabilityManifest.mcp ? `mcp:${record.capabilityManifest.mcp.serverCount}` : null,
    record.capabilityManifest.declaredHooks.length > 0
      ? `hooks:${record.capabilityManifest.declaredHooks.length}`
      : null,
    record.capabilityManifest.scripts.length > 0
      ? `scripts:${record.capabilityManifest.scripts.length}`
      : null,
  ].filter((value): value is string => Boolean(value))
  return [...skills, ...extras]
}

export const PersonalPluginEnablementPanel: React.FC<PersonalPluginEnablementPanelProps> = ({
  organizationId,
  spaceId,
  canManage = true,
}) => {
  const { t } = useTranslation('space')
  const [records, setRecords] = useState<PersonalPluginEnablementRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingPluginId, setSavingPluginId] = useState<string | null>(null)
  const [stoppingPluginId, setStoppingPluginId] = useState<string | null>(null)
  const [runtimeStatuses, setRuntimeStatuses] = useState<Record<string, PersonalPluginRuntimeStatus>>({})
  const enabledCount = useMemo(() => records.filter((record) => record.enabled).length, [records])

  const refreshRuntimeStatuses = useCallback(async (nextRecords: PersonalPluginEnablementRecord[]) => {
    const entries = await Promise.all(nextRecords.map(async (record) => {
      try {
        const status = await getPersonalPluginRuntimeStatus({
          organizationId,
          spaceId,
          pluginId: record.pluginId,
        })
        return [record.pluginId, status] as const
      } catch {
        return null
      }
    }))
    setRuntimeStatuses(Object.fromEntries(entries.filter((entry): entry is [string, PersonalPluginRuntimeStatus] => entry !== null)))
  }, [spaceId, organizationId])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nextRecords = await listPersonalPluginEnablement(organizationId, spaceId)
      setRecords(nextRecords)
      await refreshRuntimeStatuses(nextRecords)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [refreshRuntimeStatuses, spaceId, organizationId])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleToggle = useCallback(async (record: PersonalPluginEnablementRecord, enabled: boolean) => {
    if (!canManage || savingPluginId) return
    setSavingPluginId(record.pluginId)
    setError(null)
    try {
      const next = await setPersonalPluginEnabled(organizationId, spaceId, record.pluginId, enabled)
      setRecords((current) =>
        current.map((item) => (item.pluginId === next.pluginId ? next : item)),
      )
      toast({
        title: enabled
          ? t('personalPlugins.enableSuccess', { name: pluginDisplayName(record), defaultValue: `${pluginDisplayName(record)} 已为这个 Agent 启用` })
          : t('personalPlugins.disableSuccess', { name: pluginDisplayName(record), defaultValue: `${pluginDisplayName(record)} 已为这个 Agent 禁用` }),
        description: t('personalPlugins.newConversationToast', {
          defaultValue: '变更只会在新对话中生效，当前对话不会热加载。',
        }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast({ title: message, variant: 'destructive' })
    } finally {
      setSavingPluginId(null)
    }
  }, [canManage, savingPluginId, spaceId, t, organizationId])

  const handleStopRuntime = useCallback(async (record: PersonalPluginEnablementRecord) => {
    if (!canManage || stoppingPluginId) return
    setStoppingPluginId(record.pluginId)
    setError(null)
    try {
      const status = await stopPersonalPluginRuntime({
        organizationId,
        spaceId,
        pluginId: record.pluginId,
      })
      setRuntimeStatuses((current) => ({ ...current, [record.pluginId]: status }))
      toast({
        title: t('personalPlugins.runtimeStopSuccess', {
          name: pluginDisplayName(record),
          defaultValue: `${pluginDisplayName(record)} 已停止`,
        }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast({ title: message, variant: 'destructive' })
    } finally {
      setStoppingPluginId(null)
    }
  }, [canManage, spaceId, stoppingPluginId, t, organizationId])

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <h3 className="text-body font-medium text-foreground">
              {t('personalPlugins.title', { defaultValue: 'Personal Plugins' })}
            </h3>
          </div>
          <p className="text-caption leading-relaxed text-muted-foreground/75">
            {t('personalPlugins.desc', {
              defaultValue: '为这个 Agent 启用已安装的 Personal Plugin。安装记录是全局的，启用状态只属于当前 Agent/Space。',
            })}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-caption text-primary">
          {t('personalPlugins.enabledCount', {
            count: enabledCount,
            total: records.length,
            defaultValue: `${enabledCount}/${records.length} enabled`,
          })}
        </span>
      </div>

      <StatusNotice
        tone="info"
        size="sm"
        description={t('personalPlugins.newConversationNotice', {
          defaultValue: '启用或禁用后只在新对话生效；当前对话不会热加载插件上下文。',
        })}
      />

      {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}

      {loading ? (
        <p className="py-3 text-caption text-muted-foreground/80">
          {t('personalPlugins.loading', { defaultValue: '正在读取已安装 Personal Plugin...' })}
        </p>
      ) : records.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={t('personalPlugins.emptyTitle', { defaultValue: '还没有安装 Personal Plugin' })}
          description={t('personalPlugins.emptyDesc', {
            defaultValue: '先到 Marketplace 安装 Superpowers，再回到这里为这个 Agent 启用。',
          })}
          size="sm"
          layout="card"
          className="py-5"
        />
      ) : (
        <div className="space-y-2">
          {records.map((record) => {
            const name = pluginDisplayName(record)
            const labels = capabilityLabels(record)
            const runtime = runtimeStatuses[record.pluginId]
            const mcpTools = runtime?.mcp?.tools ?? []
            return (
              <article
                key={record.pluginId}
                className="rounded-md border border-border/40 bg-background/80 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-body font-medium text-foreground">{name}</h4>
                      <span className="rounded bg-muted/60 px-1.5 py-0.5 text-caption text-muted-foreground">
                        {record.enabled
                          ? t('personalPlugins.enabledBadge', { defaultValue: '已启用' })
                          : t('personalPlugins.disabledBadge', { defaultValue: '未启用' })}
                      </span>
                    </div>
                    <p className="text-caption leading-relaxed text-muted-foreground/75">
                      {record.capabilityManifest.plugin.description
                        ?? t('personalPlugins.defaultPluginDesc', { defaultValue: 'Skill bundle for this Agent.' })}
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {labels.slice(0, 4).map((label) => (
                        <span
                          key={label}
                          className="rounded bg-muted/60 px-1.5 py-0.5 text-caption text-muted-foreground/80"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Switch
                    checked={record.enabled}
                    disabled={!canManage || savingPluginId === record.pluginId}
                    aria-label={t('personalPlugins.toggleAria', {
                      name,
                      defaultValue: `为这个 Agent 启用 ${name}`,
                    })}
                    onCheckedChange={(checked: boolean) => void handleToggle(record, checked)}
                  />
                </div>
                <div className="mt-3 rounded-md border border-border/40 bg-muted/20 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-caption font-medium text-foreground">
                      {t('personalPlugins.runtimeTitle', { defaultValue: '运行状态' })}
                    </p>
                    <span className="rounded bg-muted/60 px-1.5 py-0.5 text-caption text-muted-foreground">
                      {runtime?.state === 'running'
                        ? t('personalPlugins.runtimeRunning', { defaultValue: 'running' })
                        : t('personalPlugins.runtimeStopped', { defaultValue: 'stopped' })}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-1 text-caption text-muted-foreground/75">
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-muted-foreground/55">
                        {t('personalPlugins.runtimeUrlLabel', { defaultValue: 'URL' })}
                      </dt>
                      <dd className="truncate">{runtime?.url ?? '-'}</dd>
                    </div>
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-muted-foreground/55">
                        {t('personalPlugins.runtimeProjectDirLabel', { defaultValue: 'projectDir' })}
                      </dt>
                      <dd className="truncate">{runtime?.projectDir ?? '-'}</dd>
                    </div>
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-muted-foreground/55">
                        {t('personalPlugins.runtimeLocalServiceLabel', { defaultValue: 'local service' })}
                      </dt>
                      <dd className="truncate">
                        {runtime?.process
                          ? `${runtime.process.command} @ ${runtime.process.cwd}`
                          : t('personalPlugins.runtimeLocalServiceStopped', { defaultValue: 'stopped' })}
                      </dd>
                    </div>
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-muted-foreground/55">
                        {t('personalPlugins.runtimeMcpLabel', { defaultValue: 'MCP' })}
                      </dt>
                      <dd className="truncate">
                        {runtime?.mcp
                          ? `${runtime.mcp.state} · ${runtime.mcp.serverCount} server(s) · ${mcpTools.length} tool(s)`
                          : t('personalPlugins.runtimeMcpDetached', { defaultValue: 'detached' })}
                      </dd>
                    </div>
                  </dl>
                  {mcpTools.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {mcpTools.slice(0, 4).map((tool) => (
                        <span
                          key={tool.name}
                          className="rounded bg-primary/10 px-1.5 py-0.5 text-caption text-primary"
                        >
                          {tool.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {runtime?.state === 'running' ? (
                    <div className="mt-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canManage || stoppingPluginId === record.pluginId}
                        onClick={() => void handleStopRuntime(record)}
                      >
                        {stoppingPluginId === record.pluginId
                          ? t('personalPlugins.runtimeStopping', { defaultValue: '正在停止...' })
                          : t('personalPlugins.runtimeStopAction', { defaultValue: '停止' })}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
