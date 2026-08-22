/**
 * /ai/providers — 渠道管理页（v0.1）
 *
 * 对照宪法 v0.1 §1.2：
 *   - 顶部按 capability_domain 切 8 个 Tab（chat / embedding / vision / asr / tts /
 *     image_gen / video_gen / audio_gen）
 *   - 列表展示各 Provider 含 BYOK Badge（scope!='global'）
 *   - 行内可触发：编辑 / 探测 / 重置健康 / 看密钥（展开 ProviderKeysSection）/ 探测日志 / 删除
 *   - 新建 Provider Modal 顶部按 scope 显示 BYOK 红色 banner（路线 B 强约束）
 *
 * 后端：apps/tabtin_django/apps/services/llm/api_admin_providers.py
 */

import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import type { LlmAdminModel } from '@/types/llm-admin'
import { Activity, KeyRound, Plus, RefreshCw, Server, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { modelsApi } from '../api/models'
import {
  type CapabilityDomain,
  type ProviderItem,
  type ProviderProbeResult,
  type ProviderScope,
  providersApi,
} from '../api/providers'
import { ProbeLogDialog } from '../components/providers/ProbeLogDialog'
import { ProviderCreateDialog } from '../components/providers/ProviderCreateDialog'
import { ProviderEditDialog } from '../components/providers/ProviderEditDialog'
import { ProviderKeysSection } from '../components/providers/ProviderKeysSection'
import { ProviderTable } from '../components/providers/ProviderTable'

const DOMAINS: { value: CapabilityDomain; label: string }[] = [
  { value: 'chat', label: '文本' },
  { value: 'embedding', label: '向量检索' },
  { value: 'vision', label: '视觉' },
  { value: 'asr', label: '语音识别' },
  { value: 'tts', label: '语音合成' },
  { value: 'image_gen', label: '图片' },
  { value: 'video_gen', label: '视频' },
  { value: 'audio_gen', label: '音频' },
]

const SCOPE_FILTERS: { value: '' | ProviderScope; label: string }[] = [
  { value: '', label: '全部归属' },
  { value: 'global', label: '平台' },
  { value: 'organization', label: '组织' },
  { value: 'user', label: '个人' },
]

function getDomainLabel(domain: string): string {
  return DOMAINS.find((item) => item.value === domain)?.label ?? domain
}

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: typeof Server
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[360px] break-words text-right">{displayValue}</span>
    </div>
  )
}

export function ProvidersPage() {
  const [domain, setDomain] = useState<CapabilityDomain>('chat')
  const [scopeFilter, setScopeFilter] = useState<'' | ProviderScope>('')
  const [keyword, setKeyword] = useState('')

  const [providers, setProviders] = useState<ProviderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<ProviderItem | null>(null)
  const [detailProvider, setDetailProvider] = useState<ProviderItem | null>(null)
  const [detailTab, setDetailTab] = useState('overview')
  const [probeLogProvider, setProbeLogProvider] = useState<ProviderItem | null>(null)
  const [resetHealthTarget, setResetHealthTarget] = useState<ProviderItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProviderItem | null>(null)
  const [deleteModels, setDeleteModels] = useState<LlmAdminModel[]>([])
  const [deleteError, setDeleteError] = useState('')
  const [sensitiveLoading, setSensitiveLoading] = useState(false)
  const { adminPermissions } = useAuthStore()

  const fetchProviders = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await providersApi.list({
        domain,
        scope: scopeFilter || undefined,
        keyword: keyword.trim() || undefined,
      })
      setProviders(data.providers)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [domain, scopeFilter, keyword])

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const counts = useMemo(() => {
    let available = 0
    let abnormal = 0
    let modelCount = 0
    for (const p of providers) {
      if (p.runtime_status === 'healthy') available += 1
      if (p.runtime_status === 'degraded' || p.runtime_status === 'unhealthy') abnormal += 1
      modelCount += p.model_count
    }
    return { abnormal, available, modelCount, total: providers.length }
  }, [providers])

  const openProviderDetail = (provider: ProviderItem, tab = 'overview') => {
    setDetailProvider(provider)
    setDetailTab(tab)
  }

  const handleProbed = (refreshed: ProviderItem, result: ProviderProbeResult) => {
    setProviders((prev) => prev.map((item) => (item.id === refreshed.id ? refreshed : item)))
    if (result.probe?.is_success === false) {
      const diagnostic = result.diagnostic
      setStatusMessage('')
      setError(
        diagnostic
          ? `探测失败 · ${diagnostic.failure_stage_label}：${diagnostic.summary} ${diagnostic.suggestion}`
          : `Provider ${refreshed.display_name} 探测失败，请打开“日志”查看详情`
      )
      return
    }
    setError('')
    setStatusMessage(`Provider ${refreshed.display_name} 探测成功`)
  }

  const handlePriorityChange = async (provider: ProviderItem, nextPriority: number) => {
    setError('')
    try {
      const updated = await providersApi.update(provider.id, { priority: nextPriority })
      setStatusMessage(`Provider ${provider.display_name} 优先级已更新为 ${nextPriority}`)
      setProviders((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }

  const canResetHealth = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.PROVIDER_UPDATE)
  const canDeleteProvider = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.PROVIDER_DELETE)

  const handleResetHealth = async (payload: { reason: string; ticket_id: string }) => {
    if (!resetHealthTarget) return
    setSensitiveLoading(true)
    setError('')
    try {
      await providersApi.resetHealth(resetHealthTarget.id, payload)
      setStatusMessage(`Provider ${resetHealthTarget.display_name} 健康状态已重置`)
      setResetHealthTarget(null)
      await fetchProviders()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSensitiveLoading(false)
    }
  }

  const handleDelete = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteTarget) return
    const force = deleteModels.length > 0
    setSensitiveLoading(true)
    setDeleteError('')
    try {
      await providersApi.remove(deleteTarget.id, { force, ...payload })
      setStatusMessage(`Provider ${deleteTarget.display_name} 已删除`)
      if (detailProvider?.id === deleteTarget.id) setDetailProvider(null)
      setDeleteTarget(null)
      setDeleteModels([])
      await fetchProviders()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setDeleteError(msg)
    } finally {
      setSensitiveLoading(false)
    }
  }

  const openDeleteDialog = async (provider: ProviderItem) => {
    setError('')
    setDeleteError('')
    try {
      const data = await modelsApi.listModels({
        providerId: provider.id,
        limit: 500,
      })
      if (data.returned < data.total) {
        throw new Error(
          `该渠道关联 ${data.total} 个模型，当前仅能预览 ${data.returned} 个，请先清理模型后再删除渠道。`
        )
      }
      setDeleteModels(data.models)
      setDeleteTarget(provider)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`无法加载待删除模型：${msg}`)
    }
  }

  const closeDeleteDialog = () => {
    setDeleteTarget(null)
    setDeleteModels([])
    setDeleteError('')
  }

  const handleToggleRouting = async (provider: ProviderItem) => {
    setError('')
    try {
      await providersApi.updateRuntime(provider.id, {
        routing_enabled: !provider.routing_enabled,
      })
      setStatusMessage(
        `Provider ${provider.display_name} 已${provider.routing_enabled ? '退出' : '加入'}轮询`
      )
      await fetchProviders()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }

  const selectedProvider = detailProvider
    ? (providers.find((provider) => provider.id === detailProvider.id) ?? detailProvider)
    : null
  const sceneBoundModelCount = deleteModels.filter((model) => model.related_scenes_count > 0).length
  const deleteBlockedReason =
    sceneBoundModelCount > 0
      ? `${sceneBoundModelCount} 个模型仍被业务场景引用，请先在场景中心改绑其他模型。`
      : undefined

  return (
    <AdminPage>
      <AdminPageHeader
        title="模型渠道"
        icon={Server}
        actions={
          <>
            <Button variant="outline" type="button" onClick={fetchProviders} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button type="button" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              新增
            </Button>
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="渠道总数" value={counts.total} icon={Server} />
        <CompactMetric label="可用渠道" value={counts.available} icon={Activity} />
        <CompactMetric label="异常渠道" value={counts.abnormal} icon={TriangleAlert} />
        <CompactMetric label="可用模型" value={counts.modelCount} icon={KeyRound} />
      </div>

      <div className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-md border bg-muted/30 p-0.5">
            {DOMAINS.map((d) => (
              <button
                key={d.value}
                type="button"
                data-testid={`domain-tab-${d.value}`}
                className={`rounded px-3 py-1.5 text-caption font-medium transition-colors ${
                  domain === d.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background/70'
                }`}
                onClick={() => setDomain(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value as '' | ProviderScope)}
          >
            {SCOPE_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="search"
            className="w-72 rounded-md border bg-background px-3 py-1.5 text-body"
            placeholder="渠道名称 / 标识 / API 地址"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button variant="outline" type="button" onClick={fetchProviders}>
            查询
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setKeyword('')
              setScopeFilter('')
            }}
          >
            重置
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-body text-red-700 dark:bg-red-950/40 dark:border-red-900/60 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-body text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900/60 dark:text-emerald-300">
          {statusMessage}
          <button
            type="button"
            className="ml-3 text-caption underline"
            onClick={() => setStatusMessage('')}
          >
            关闭
          </button>
        </div>
      )}

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-body font-semibold">相关配置</h2>
            <p className="text-caption text-muted-foreground">
              低频 AI 配置仍保留独立路由，从这里下钻。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/ai/prompts">提示词配置</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/ai/embedding">向量模型配置</Link>
            </Button>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载模型渠道列表…</div>
      ) : (
        <ProviderTable
          providers={providers}
          onOpenDetail={(provider) => openProviderDetail(provider)}
          onOpenKeys={(provider) => openProviderDetail(provider, 'keys')}
          onEdit={(p) => setEditProvider(p)}
          onProbed={handleProbed}
          onProbeError={(msg) => setError(msg)}
          onPriorityChange={handlePriorityChange}
          onResetHealth={(provider) => setResetHealthTarget(provider)}
          onDelete={openDeleteDialog}
          onToggleRouting={handleToggleRouting}
          onShowProbeLogs={(p) => setProbeLogProvider(p)}
          canResetHealth={canResetHealth}
          canDelete={canDeleteProvider}
        />
      )}

      <Dialog
        open={Boolean(selectedProvider)}
        onOpenChange={(open) => {
          if (!open) setDetailProvider(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          {selectedProvider ? (
            <div className="flex min-h-full flex-col">
              <DialogHeader className="border-b px-6 py-5">
                <DialogTitle>{selectedProvider.display_name}</DialogTitle>
                <DialogDescription>
                  渠道标识：<code>{selectedProvider.provider_key}</code>
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 px-6 py-4">
                <Tabs value={detailTab} onValueChange={setDetailTab}>
                  <TabsList className="flex flex-wrap">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="models">模型</TabsTrigger>
                    <TabsTrigger value="keys">密钥</TabsTrigger>
                    <TabsTrigger value="health">健康</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="状态" value={selectedProvider.runtime_status} />
                      <InfoRow
                        label="支持能力"
                        value={selectedProvider.capability_domains.map(getDomainLabel).join(' / ')}
                      />
                      <InfoRow label="模型数" value={selectedProvider.model_count} />
                      <InfoRow
                        label="密钥状态"
                        value={selectedProvider.api_key_masked || '未配置'}
                      />
                      <InfoRow label="归属" value={selectedProvider.scope} />
                      <InfoRow
                        label="路由"
                        value={selectedProvider.routing_enabled ? '启用' : '停用'}
                      />
                    </div>
                    <div className="rounded-lg border p-4">
                      <InfoRow label="渠道标识" value={selectedProvider.provider_key} />
                      <InfoRow label="服务类型" value={selectedProvider.name} />
                      <InfoRow label="API 地址" value={selectedProvider.base_url || '—'} />
                      <InfoRow
                        label="创建时间"
                        value={formatDateTime(selectedProvider.created_at)}
                      />
                      <InfoRow
                        label="更新时间"
                        value={formatDateTime(selectedProvider.updated_at)}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="models" className="mt-4 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <CompactMetric
                        label="模型数"
                        value={selectedProvider.model_count}
                        icon={Server}
                      />
                      <CompactMetric
                        label="支持能力"
                        value={selectedProvider.capability_domains.length}
                        icon={Activity}
                      />
                    </div>
                    <div className="rounded-lg border p-4 text-body">
                      <InfoRow
                        label="能力范围"
                        value={selectedProvider.capability_domains.map(getDomainLabel).join(' / ')}
                      />
                      <InfoRow label="限速" value={`${selectedProvider.rate_limit}/min`} />
                      <InfoRow label="优先级" value={selectedProvider.priority} />
                    </div>
                  </TabsContent>

                  <TabsContent value="keys" className="mt-4">
                    <ProviderKeysSection providerId={selectedProvider.id} />
                  </TabsContent>

                  <TabsContent value="health" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="健康状态" value={selectedProvider.runtime_status} />
                      <InfoRow
                        label="最近检查"
                        value={formatDateTime(selectedProvider.health_last_checked_at)}
                      />
                      <InfoRow
                        label="最近成功"
                        value={formatDateTime(selectedProvider.health_last_success_at)}
                      />
                      <InfoRow
                        label="最近失败"
                        value={formatDateTime(selectedProvider.health_last_failure_at)}
                      />
                      <InfoRow
                        label="平均延迟"
                        value={`${selectedProvider.health_avg_latency_ms || 0}ms`}
                      />
                      <InfoRow
                        label="成功率"
                        value={`${Math.round(selectedProvider.health_success_rate || 0)}%`}
                      />
                      <InfoRow
                        label="最近错误"
                        value={selectedProvider.health_last_error || '无'}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => setProbeLogProvider(selectedProvider)}
                      >
                        查看日志
                      </Button>
                      {canResetHealth ? (
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => setResetHealthTarget(selectedProvider)}
                        >
                          重置健康
                        </Button>
                      ) : null}
                    </div>
                  </TabsContent>

                  <TabsContent value="audit" className="mt-4">
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      审计记录保留在 AI 运维审计页，本页仅展示模型渠道的当前状态。
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ProviderCreateDialog
        open={createOpen}
        initialDomain={domain}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setStatusMessage('模型渠道已创建')
          fetchProviders()
        }}
      />

      <ProviderEditDialog
        provider={editProvider}
        open={!!editProvider}
        onClose={() => setEditProvider(null)}
        onSaved={() => {
          setStatusMessage('模型渠道已更新')
          fetchProviders()
        }}
      />

      <ProbeLogDialog
        provider={probeLogProvider}
        open={!!probeLogProvider}
        onClose={() => setProbeLogProvider(null)}
        onProviderRefreshed={(refreshed) => {
          setProbeLogProvider(refreshed)
          fetchProviders()
        }}
      />
      <SensitiveActionConfirmDialog
        open={Boolean(resetHealthTarget)}
        title="重置模型渠道健康状态"
        targetLabel={resetHealthTarget?.display_name ?? ''}
        impact="会清空当前健康状态与错误计数，影响运行治理判断和后续路由。"
        confirmText="重置健康"
        loading={sensitiveLoading}
        onCancel={() => setResetHealthTarget(null)}
        onConfirm={(payload) => void handleResetHealth(payload)}
      />
      <SensitiveActionConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除模型渠道"
        targetLabel={deleteTarget?.display_name ?? ''}
        impact={
          deleteModels.length > 0
            ? `删除渠道时，以下 ${deleteModels.length} 个关联模型会被一并删除。`
            : '删除后该渠道及相关路由能力将立即失效。'
        }
        extraContent={
          <div className="space-y-2">
            <div className="text-body font-medium">关联模型</div>
            {deleteModels.length > 0 ? (
              <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
                {deleteModels.map((model) => (
                  <li key={model.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium">{model.display_name}</div>
                      <code className="block truncate text-caption text-muted-foreground">
                        {model.model_name}
                      </code>
                    </div>
                    <div className="shrink-0 text-right text-caption text-muted-foreground">
                      <div>{getDomainLabel(model.capability_domain)}</div>
                      {model.related_scenes_count > 0 ? (
                        <div className="mt-1 text-amber-700">
                          被 {model.related_scenes_count} 个业务场景引用
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-2 text-body text-muted-foreground">
                该渠道当前未关联模型。
              </div>
            )}
            {deleteError ? (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-body text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
              >
                {deleteError}
              </div>
            ) : null}
          </div>
        }
        confirmText="删除模型渠道"
        blockedReason={deleteBlockedReason}
        loading={sensitiveLoading}
        onCancel={closeDeleteDialog}
        onConfirm={(payload) => void handleDelete(payload)}
      />
    </AdminPage>
  )
}
