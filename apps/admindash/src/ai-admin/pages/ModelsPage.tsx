/**
 * `/ai/models` — 模型管理页面（宪法 07 §1.3）。
 *
 * 替换旧 `apps/admindash/src/ai-admin/pages/ModelsPage.tsx` (75 行 stub)。
 *
 * 顶层结构：
 *
 * ```
 * <Header>
 *   ├── 标题 + 模型总数
 *   └── 操作区：[从 LiteLLM 搜索导入] [新建模型]
 * <DomainTabs>  8 个 capability_domain Tab
 * <Filters>     keyword / wave_status
 * <ModelTable>  10 列（display_name / model_name / provider / domain / capabilities /
 *                       context / billing / related_scenes / wave_status / actions）
 * <Modals>
 *   ├── ModelCreateDialog（含内嵌 LiteLlmSearchPicker）
 *   ├── ModelEditDialog
 *   ├── TokenEstimateDialog
 *   ├── CapabilityProfileDialog
 *   └── ConfirmDialog (删除)
 * ```
 *
 * 数据流：
 *
 * - 切 Tab → 重新调 listModels({ domain })
 * - 创建 / 编辑 / 删除 成功 → 调用 fetchModels() refetch（不假设乐观更新，避免
 *   "前端拼字段对不上后端 _serialize_model"的常见 bug）
 *
 * 状态管理：本页用 React state，没有 Zustand store。理由：
 *
 * - 模型数据是页面级，没有跨页面共享需求
 * - useEffect 触发 refetch 比 store 更直观（Tab 切换 = 新参数）
 * - D3-D6 的 Page 后续如需 store，可独立添加 useModelsStore
 */

import { llmAdminApi } from '@/api/llm-admin'
import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageSizeSelect } from '@/components/ui/pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/utils'
import type { LlmAdminModel } from '@/types/llm-admin'
import type { LiteLlmSearchModelItem } from '@/types/llm-admin'
import { Database, Plus, RefreshCw, Search, Server, Sparkles, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { type CapabilityDomain, type CapabilityProfileResponse, modelsApi } from '../api/models'
import { CapabilityBadges } from '../components/models/CapabilityBadges'
import { LiteLlmSearchPicker } from '../components/models/LiteLlmSearchPicker'
import { ModelCreateDialog } from '../components/models/ModelCreateDialog'
import { ModelEditDialog } from '../components/models/ModelEditDialog'
import { ModelTable } from '../components/models/ModelTable'
import { TokenEstimateDialog } from '../components/models/TokenEstimateDialog'

const DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  chat: '文本',
  embedding: 'Embedding',
  vision: '视觉',
  asr: '语音识别',
  tts: '语音合成',
  image_gen: '图片',
  video_gen: '视频',
  audio_gen: '音频',
}

const ALL_DOMAINS: CapabilityDomain[] = [
  'chat',
  'embedding',
  'vision',
  'asr',
  'tts',
  'image_gen',
  'video_gen',
  'audio_gen',
]

function formatTokens(value: number | undefined | null): string {
  if (!value || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1000)}k`
  return String(value)
}

function formatBilling(model: LlmAdminModel): string {
  if (model.billing_type === 'request')
    return `$${Number(model.price_per_request || 0).toFixed(4)} / 次`
  if (model.billing_type === 'time')
    return `$${Number(model.price_per_second || 0).toFixed(4)} / 秒`
  const input = Number(model.input_price_per_1k) || 0
  const output = Number(model.output_price_per_1k) || 0
  if (input === 0 && output === 0) return '免费'
  return `$${input.toFixed(4)} / $${output.toFixed(4)}`
}

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: typeof Database
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

export function ModelsPage() {
  const [searchParams] = useSearchParams()
  const queryModel = searchParams.get('model') || ''
  const queryProvider = searchParams.get('provider') || ''
  const [models, setModels] = useState<LlmAdminModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // 顶部 Tab：默认 chat
  const [domain, setDomain] = useState<CapabilityDomain>('chat')
  const [keyword, setKeyword] = useState(queryModel || queryProvider)
  const [providerFilter, setProviderFilter] = useState('')
  const [waveFilter, setWaveFilter] = useState<'' | 'ready' | 'w2_pending' | 'w3_pending'>('')
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Modal 持有状态
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<LlmAdminModel | null>(null)
  const [estimateTarget, setEstimateTarget] = useState<LlmAdminModel | null>(null)
  const [profileTarget, setProfileTarget] = useState<LlmAdminModel | null>(null)
  const [profileData, setProfileData] = useState<CapabilityProfileResponse | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [detailModel, setDetailModel] = useState<LlmAdminModel | null>(null)
  const [detailTab, setDetailTab] = useState('overview')
  const [deleteTarget, setDeleteTarget] = useState<LlmAdminModel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 顶部 LiteLLM picker 选中的项，会被透传给 ModelCreateDialog 的 initialLiteLlmPick
  // prop。Dialog 在 open=true 时立即把字段（model_name / display_name / context /
  // max_in_out / vision flag）刷到 form 上——不让"按了顶部按钮但表单还是空的"成为
  // 死按钮（修复 D2 Review B P1-1）。
  const [pendingLitellmPick, setPendingLitellmPick] = useState<LiteLlmSearchModelItem | null>(null)

  const fetchModels = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await modelsApi.listModels({
        domain,
        keyword: keyword.trim() || undefined,
        limit: 200,
      })
      setModels(data.models || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setModels([])
    } finally {
      setLoading(false)
    }
  }, [domain, keyword])

  useEffect(() => {
    const nextKeyword = queryModel || queryProvider
    if (nextKeyword) {
      setKeyword(nextKeyword)
    }
  }, [queryModel, queryProvider])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const filteredModels = useMemo(() => {
    const filtered = models.filter((m) => {
      if (waveFilter && m.wave_status !== waveFilter) return false
      if (providerFilter && m.provider_id !== providerFilter) return false
      return true
    })
    return filtered.sort((a, b) => {
      const left = new Date(a.updated_at).getTime()
      const right = new Date(b.updated_at).getTime()
      return sortOrder === 'newest' ? right - left : left - right
    })
  }, [models, providerFilter, sortOrder, waveFilter])

  const providerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const model of models) {
      map.set(model.provider_id, model.provider_display_name || model.provider_name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [models])

  const metrics = useMemo(() => {
    const ready = models.filter((model) => model.wave_status === 'ready').length
    const abnormal = models.filter((model) => model.wave_status !== 'ready').length
    const unbound = models.filter((model) => !model.provider_id).length
    return { abnormal, ready, total: models.length, unbound }
  }, [models])

  const totalPages = Math.max(1, Math.ceil(filteredModels.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedModels = filteredModels.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const handleProbe = async (model: LlmAdminModel) => {
    setStatusMessage(`正在探测 ${model.display_name}...`)
    try {
      const result = await llmAdminApi.probeRuntimeModel(model.id)
      const probe = result.probe as {
        probe?: { is_success?: boolean }
        diagnostic?: {
          failure_stage_label?: string
          summary?: string
          suggestion?: string
        } | null
      }
      if (probe.probe?.is_success === false) {
        const diagnostic = probe.diagnostic
        setStatusMessage(null)
        setError(
          diagnostic
            ? `探测失败 · ${diagnostic.failure_stage_label}：${diagnostic.summary} ${diagnostic.suggestion}`
            : `模型 ${model.display_name} 探测失败，请到渠道管理查看探测日志`
        )
        return
      }
      setError('')
      setStatusMessage(`模型 ${model.display_name} 探测成功`)
      setTimeout(() => setStatusMessage(null), 3000)
    } catch (err) {
      setStatusMessage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleProfileOpen = async (model: LlmAdminModel) => {
    setProfileTarget(model)
    setProfileData(null)
    setProfileLoading(true)
    try {
      const data = await modelsApi.getCapabilityProfile(model.id)
      setProfileData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProfileLoading(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await modelsApi.deleteModel(deleteTarget.id)
      setStatusMessage(`已删除模型 ${deleteTarget.display_name}`)
      setTimeout(() => setStatusMessage(null), 3000)
      setDeleteTarget(null)
      fetchModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const handlePickerToCreate = (item: LiteLlmSearchModelItem) => {
    setPendingLitellmPick(item)
    setCreateOpen(true)
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="模型管理"
        icon={Database}
        actions={
          <>
            <Button variant="outline" type="button" onClick={fetchModels} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => setPickerOpen(true)}
              className="gap-1.5"
            >
              <Search className="h-3.5 w-3.5" />
              导入
              <Sparkles className="h-3 w-3 text-amber-500" />
            </Button>
            <Button
              type="button"
              onClick={() => {
                setPendingLitellmPick(null)
                setCreateOpen(true)
              }}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              新增
            </Button>
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="模型总数" value={metrics.total} icon={Database} />
        <CompactMetric label="已就绪" value={metrics.ready} icon={Server} />
        <CompactMetric label="异常模型" value={metrics.abnormal} icon={TriangleAlert} />
        <CompactMetric label="未绑定 Provider" value={metrics.unbound} icon={Search} />
      </div>

      <div className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className="w-72 rounded-md border bg-background px-3 py-1.5 text-body"
            placeholder="模型名 / Provider / 能力"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
          >
            <option value="">全部 Provider</option>
            {providerOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={domain}
            onChange={(e) => setDomain(e.target.value as CapabilityDomain)}
          >
            {ALL_DOMAINS.map((item) => (
              <option key={item} value={item}>
                {DOMAIN_LABELS[item]}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={waveFilter}
            onChange={(e) => setWaveFilter(e.target.value as typeof waveFilter)}
          >
            <option value="">全部状态</option>
            <option value="ready">可用</option>
            <option value="w2_pending">待配置</option>
            <option value="w3_pending">待验证</option>
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
          >
            <option value="newest">最近更新</option>
            <option value="oldest">最早更新</option>
          </select>
          <Button variant="outline" type="button" onClick={fetchModels}>
            查询
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setKeyword('')
              setProviderFilter('')
              setWaveFilter('')
              setSortOrder('newest')
            }}
          >
            重置
          </Button>
        </div>
      </div>

      {/* ────── 状态消息 ────── */}
      {statusMessage && (
        <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-caption text-green-800">
          {statusMessage}
        </div>
      )}
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700">
          <span className="whitespace-pre-wrap">{error}</span>
          <button
            type="button"
            className="text-red-700/70 hover:text-red-700"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* ────── 列表 ────── */}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载中...</div>
      ) : (
        <>
          <ModelTable
            models={pagedModels}
            onDetail={setDetailModel}
            onEdit={setEditTarget}
            onProbe={handleProbe}
            onEstimate={setEstimateTarget}
            onProfile={handleProfileOpen}
            onDelete={setDeleteTarget}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
            <div className="text-caption text-muted-foreground">
              共 {filteredModels.length} 个模型，第 {currentPage} / {totalPages} 页
            </div>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={pageSize}
                onChange={(nextPageSize) => {
                  setPageSize(nextPageSize)
                  setPage(1)
                }}
              />
              <Button
                variant="outline"
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={Boolean(detailModel)}
        onOpenChange={(open) => {
          if (!open) setDetailModel(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          {detailModel ? (
            <div className="flex min-h-full flex-col">
              <DialogHeader className="border-b px-6 py-5">
                <DialogTitle>{detailModel.display_name}</DialogTitle>
                <DialogDescription>
                  <code>{detailModel.model_name}</code> ·{' '}
                  {DOMAIN_LABELS[detailModel.capability_domain as CapabilityDomain] ??
                    detailModel.capability_domain}
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 px-6 py-4">
                <Tabs value={detailTab} onValueChange={setDetailTab}>
                  <TabsList className="flex flex-wrap">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="capability">能力</TabsTrigger>
                    <TabsTrigger value="provider">Provider</TabsTrigger>
                    <TabsTrigger value="runtime">调用配置</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow
                        label="状态"
                        value={detailModel.wave_status === 'ready' ? '可用' : '待处理'}
                      />
                      <InfoRow label="模型名" value={<code>{detailModel.model_name}</code>} />
                      <InfoRow
                        label="能力类型"
                        value={
                          DOMAIN_LABELS[detailModel.capability_domain as CapabilityDomain] ??
                          detailModel.capability_domain
                        }
                      />
                      <InfoRow label="关联场景" value={detailModel.related_scenes_count} />
                      <InfoRow label="创建时间" value={formatDateTime(detailModel.created_at)} />
                      <InfoRow label="更新时间" value={formatDateTime(detailModel.updated_at)} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => setEditTarget(detailModel)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => handleProbe(detailModel)}
                      >
                        探测
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => setEstimateTarget(detailModel)}
                      >
                        估算
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="capability" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow
                        label="上下文"
                        value={formatTokens(detailModel.context_window_tokens)}
                      />
                      <InfoRow
                        label="输入上限"
                        value={formatTokens(detailModel.max_input_tokens)}
                      />
                      <InfoRow
                        label="输出上限"
                        value={formatTokens(detailModel.max_output_tokens)}
                      />
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="mb-2 text-body font-medium">能力配置</div>
                      <CapabilityBadges
                        capabilitiesConfig={detailModel.capabilities_config || {}}
                      />
                      <pre className="mt-3 max-h-56 overflow-auto rounded bg-muted/50 p-3 text-caption">
                        {JSON.stringify(detailModel.capabilities_config || {}, null, 2)}
                      </pre>
                    </div>
                  </TabsContent>

                  <TabsContent value="provider" className="mt-4 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="Provider" value={detailModel.provider_display_name} />
                      <InfoRow label="Provider code" value={detailModel.provider_key} />
                      <InfoRow label="归属" value={detailModel.provider_scope} />
                      <InfoRow
                        label="Provider 绑定"
                        value={detailModel.provider_id ? '已绑定' : '未绑定'}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="runtime" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="base URL" value={detailModel.base_url || '—'} />
                      <InfoRow label="计费" value={formatBilling(detailModel)} />
                      <InfoRow label="计费类型" value={detailModel.billing_type || 'token'} />
                      <InfoRow
                        label="能力类型"
                        value={
                          DOMAIN_LABELS[detailModel.capability_domain as CapabilityDomain] ??
                          detailModel.capability_domain
                        }
                      />
                    </div>
                    <div className="rounded-lg border p-4">
                      <InfoRow label="input / 1k" value={detailModel.input_price_per_1k} />
                      <InfoRow label="output / 1k" value={detailModel.output_price_per_1k} />
                      <InfoRow label="per request" value={detailModel.price_per_request} />
                      <InfoRow label="per second" value={detailModel.price_per_second} />
                    </div>
                  </TabsContent>

                  <TabsContent value="audit" className="mt-4">
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      模型变更审计保留在 AI 运维审计页，本页展示当前配置快照。
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ────── 全局 LiteLLM Picker（顶部按钮） ────── */}
      <LiteLlmSearchPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickerToCreate}
      />

      {/* ────── 创建对话框 ────── */}
      <ModelCreateDialog
        open={createOpen}
        initialDomain={domain}
        initialLiteLlmPick={pendingLitellmPick}
        onClose={() => {
          setCreateOpen(false)
          setPendingLitellmPick(null)
        }}
        onCreated={() => {
          setStatusMessage('模型创建成功')
          setTimeout(() => setStatusMessage(null), 3000)
          fetchModels()
        }}
      />

      {/* ────── 编辑对话框 ────── */}
      <ModelEditDialog
        open={!!editTarget}
        model={editTarget}
        onClose={() => setEditTarget(null)}
        onUpdated={() => {
          setStatusMessage('模型更新成功')
          setTimeout(() => setStatusMessage(null), 3000)
          fetchModels()
        }}
      />

      {/* ────── Token 估算对话框 ────── */}
      <TokenEstimateDialog
        open={!!estimateTarget}
        model={estimateTarget}
        onClose={() => setEstimateTarget(null)}
      />

      {/* ────── Capability Profile 对话框 ────── */}
      <Dialog
        open={!!profileTarget}
        onOpenChange={(o) => {
          if (!o) {
            setProfileTarget(null)
            setProfileData(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Capability Profile</DialogTitle>
            <DialogDescription>
              {profileTarget && (
                <>
                  <code>{profileTarget.model_name}</code> · {profileTarget.capability_domain}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {profileLoading ? (
            <div className="py-8 text-center text-muted-foreground">加载中...</div>
          ) : profileData ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-body font-semibold">能力 Badge</h3>
                <CapabilityBadges capabilitiesConfig={profileData.declared.capabilities_config} />
              </div>
              <div className="space-y-2">
                <h3 className="text-body font-semibold">Declared</h3>
                <div className="grid grid-cols-2 gap-2 text-caption">
                  <KV k="capability_domain" v={profileData.capability_domain} />
                  <KV k="context_window_tokens" v={profileData.declared.context_window_tokens} />
                  <KV k="max_input_tokens" v={profileData.declared.max_input_tokens} />
                  <KV k="max_output_tokens" v={profileData.declared.max_output_tokens} />
                  <KV k="billing_type" v={profileData.declared.billing_type} />
                  <KV k="input_price_per_1k" v={profileData.declared.input_price_per_1k} />
                  <KV k="output_price_per_1k" v={profileData.declared.output_price_per_1k} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-body font-semibold">capabilities_config (JSON)</h3>
                <pre className="rounded bg-muted/50 p-3 text-caption font-mono overflow-auto max-h-60">
                  {JSON.stringify(profileData.declared.capabilities_config, null, 2)}
                </pre>
              </div>
              <div className="space-y-2">
                <h3 className="text-body font-semibold">Resolved Capabilities</h3>
                <pre className="rounded bg-muted/50 p-3 text-caption font-mono overflow-auto max-h-40">
                  {JSON.stringify(profileData.resolved_capabilities, null, 2)}
                </pre>
              </div>
              <div className="text-caption text-muted-foreground italic">
                v0.1 删了 LLMCapabilityDrift 表，没有 probed 字段对比；
                想看实际行为，请用「探测」按钮（probe runtime）。
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setProfileTarget(null)
                setProfileData(null)
              }}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ────── 删除确认对话框 ──────
          后端 v0.1 LLMSceneBinding.primary_model FK = on_delete=PROTECT（migration 0022），
          有引用时直接删 = ProtectedError → 500。所以前端在 related_scenes_count > 0 时
          直接禁用确认按钮，引导运营到 ScenesPage 改绑。后端也有 pre-check 兜底（409）。 */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除模型</DialogTitle>
            <DialogDescription>
              确定要删除 <code>{deleteTarget?.model_name}</code> 吗？
              {deleteTarget && deleteTarget.related_scenes_count > 0 && (
                <span className="block mt-2 text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  ⚠️ 当前有 <strong>{deleteTarget.related_scenes_count}</strong> 个 Scene 把它作为
                  primary_model。 必须先到{' '}
                  <a
                    href={`/ai/scenes?model_id=${deleteTarget.id}`}
                    className="underline font-medium"
                  >
                    Scene 中心
                  </a>{' '}
                  把这些 Scene 改绑别的模型，再回来删除。
                </span>
              )}
              {deleteTarget && deleteTarget.related_scenes_count === 0 && (
                <span className="block mt-2 text-muted-foreground">
                  当前没有 Scene 引用此模型，可以安全删除。
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button
              type="button"
              onClick={handleDeleteConfirm}
              disabled={deleting || (deleteTarget?.related_scenes_count ?? 0) > 0}
              className="bg-red-600 hover:bg-red-700"
              title={
                (deleteTarget?.related_scenes_count ?? 0) > 0 ? '请先解除 Scene 引用' : undefined
              }
            >
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="rounded bg-muted/30 p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{k}</div>
      <div className="font-mono">{String(v)}</div>
    </div>
  )
}
