import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/utils'
import { Activity, Link2, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { type SceneDetailData, type SceneItem, scenesApi } from '../api/scenes'
import { PromptDetail } from '../components/prompts/PromptDetail'
import { SceneBindingDialog } from '../components/scenes/SceneBindingDialog'
import { SceneBulkBindingDialog } from '../components/scenes/SceneBulkBindingDialog'
import { DOMAIN_LABELS, SceneTable } from '../components/scenes/SceneTable'
import {
  groupSelectedScenes,
  toggleSceneSelection,
  toggleVisibleSceneSelection,
} from '../components/scenes/sceneBulkBinding'

const DOMAINS = [
  'chat',
  'embedding',
  'vision',
  'asr',
  'tts',
  'image_gen',
  'video_gen',
  'audio_gen',
] as const

type BindingFilter = 'all' | 'bound' | 'unbound'
type ValidationFilter = 'all' | 'satisfied' | 'unsatisfied'
type SortOrder = 'recent' | 'oldest'

function compactId(value: string, start = 14, end = 6): string {
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
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

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: typeof Activity
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

export function ScenesPage() {
  const [searchParams] = useSearchParams()
  const [scenes, setScenes] = useState<SceneItem[]>([])
  const [loading, setLoading] = useState(true)
  const [domain, setDomain] = useState<string>('')
  const [includeSystem, setIncludeSystem] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [bindingFilter, setBindingFilter] = useState<BindingFilter>('all')
  const [validationFilter, setValidationFilter] = useState<ValidationFilter>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('recent')
  const [selectedSceneKeys, setSelectedSceneKeys] = useState<Set<string>>(new Set())
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkSuccessMessage, setBulkSuccessMessage] = useState('')

  const [editScene, setEditScene] = useState<SceneItem | null>(null)
  const [detailScene, setDetailScene] = useState<SceneDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTab, setDetailTab] = useState('overview')
  const [focusHint, setFocusHint] = useState<string | null>(null)
  const autoOpenedSceneRef = useRef<string>('')

  const sceneKeyFromQuery = searchParams.get('scene_key') || searchParams.get('highlight') || ''

  const filteredScenes = useMemo(() => {
    return scenes
      .filter((scene) => {
        if (bindingFilter === 'bound' && !scene.binding) return false
        if (bindingFilter === 'unbound' && scene.binding) return false
        if (validationFilter !== 'all' && scene.capability_validation !== validationFilter)
          return false
        return true
      })
      .sort((a, b) => {
        const left = new Date(a.binding?.updated_at || a.last_call_at || 0).getTime()
        const right = new Date(b.binding?.updated_at || b.last_call_at || 0).getTime()
        return sortOrder === 'recent' ? right - left : left - right
      })
  }, [bindingFilter, scenes, sortOrder, validationFilter])

  const metrics = useMemo(() => {
    const bound = scenes.filter((scene) => Boolean(scene.binding)).length
    const validationIssues = scenes.filter(
      (scene) => scene.capability_validation === 'unsatisfied'
    ).length
    return {
      bound,
      total: scenes.length,
      unbound: scenes.length - bound,
      validationIssues,
    }
  }, [scenes])

  const selectedSceneGroups = useMemo(
    () => groupSelectedScenes(scenes, selectedSceneKeys),
    [scenes, selectedSceneKeys]
  )

  const selectedSceneItem = detailScene
    ? scenes.find((scene) => scene.scene_key === detailScene.scene_key)
    : null

  const fetchScenes = useCallback(async () => {
    setLoading(true)
    try {
      const data = await scenesApi.list({
        domain: domain || undefined,
        include_system: includeSystem,
        keyword: keyword || undefined,
      })
      setScenes(data.scenes)
      const selectableSceneKeys = new Set(
        data.scenes.filter((scene) => !scene.is_system).map((scene) => scene.scene_key)
      )
      setSelectedSceneKeys(
        (current) => new Set([...current].filter((sceneKey) => selectableSceneKeys.has(sceneKey)))
      )
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [domain, includeSystem, keyword])

  useEffect(() => {
    fetchScenes()
  }, [fetchScenes])

  const handleViewDetail = useCallback(async (scene: SceneItem) => {
    setDetailLoading(true)
    setDetailTab('overview')
    try {
      const data = await scenesApi.detail(scene.scene_key)
      setDetailScene(data)
    } catch {
      /* ignore */
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!sceneKeyFromQuery) {
      setFocusHint(null)
      autoOpenedSceneRef.current = ''
      return
    }
    setDomain('')
    setIncludeSystem(true)
    setKeyword(sceneKeyFromQuery)
    setFocusHint(`已从深链定位 scene：${sceneKeyFromQuery}`)
  }, [sceneKeyFromQuery])

  return (
    <AdminPage>
      <AdminPageHeader
        title="场景与能力"
        icon={Link2}
        actions={
          <Button variant="outline" type="button" onClick={fetchScenes} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="场景总数" value={metrics.total} icon={Link2} />
        <CompactMetric label="已绑定场景" value={metrics.bound} icon={Activity} />
        <CompactMetric label="未绑定场景" value={metrics.unbound} icon={Search} />
        <CompactMetric label="校验异常" value={metrics.validationIssues} icon={TriangleAlert} />
      </div>

      <div className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className="w-72 rounded-md border bg-background px-3 py-1.5 text-body"
            placeholder="场景名 / scene key / 模型"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            <option value="">全部能力</option>
            {DOMAINS.map((item) => (
              <option key={item} value={item}>
                {DOMAIN_LABELS[item] || item}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={bindingFilter}
            onChange={(e) => setBindingFilter(e.target.value as BindingFilter)}
          >
            <option value="all">全部绑定</option>
            <option value="bound">已绑定</option>
            <option value="unbound">未绑定</option>
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={validationFilter}
            onChange={(e) => setValidationFilter(e.target.value as ValidationFilter)}
          >
            <option value="all">全部校验</option>
            <option value="satisfied">通过</option>
            <option value="unsatisfied">异常</option>
          </select>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
          >
            <option value="recent">最近更新</option>
            <option value="oldest">最早更新</option>
          </select>
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
              className="rounded"
            />
            系统场景
          </label>
          <Button variant="outline" type="button" onClick={fetchScenes}>
            查询
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setKeyword('')
              setDomain('')
              setBindingFilter('all')
              setValidationFilter('all')
              setSortOrder('recent')
            }}
          >
            重置
          </Button>
        </div>
      </div>

      {focusHint && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-body text-blue-900">
          {focusHint}
        </div>
      )}

      {bulkSuccessMessage ? (
        <output className="block rounded-md border border-green-200 bg-green-50 px-3 py-2 text-body text-green-800">
          {bulkSuccessMessage}
        </output>
      ) : null}

      {selectedSceneKeys.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
          <span className="text-body">已选择 {selectedSceneKeys.size} 个场景</span>
          <div className="flex gap-2">
            <Button variant="ghost" type="button" onClick={() => setSelectedSceneKeys(new Set())}>
              取消选择
            </Button>
            <Button
              type="button"
              onClick={() => {
                setBulkSuccessMessage('')
                setBulkDialogOpen(true)
              }}
            >
              批量换绑主模型
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载中...</div>
      ) : (
        <SceneTable
          scenes={filteredScenes}
          selectedSceneKeys={selectedSceneKeys}
          onEditBinding={setEditScene}
          onViewDetail={handleViewDetail}
          onToggleSelection={(scene) =>
            setSelectedSceneKeys((current) => toggleSceneSelection(current, scene))
          }
          onToggleVisibleSelection={(checked) =>
            setSelectedSceneKeys((current) =>
              toggleVisibleSceneSelection(current, filteredScenes, checked)
            )
          }
        />
      )}

      {!loading && sceneKeyFromQuery && (
        <AutoOpenSceneDetail
          sceneKeyFromQuery={sceneKeyFromQuery}
          scenes={scenes}
          autoOpenedSceneRef={autoOpenedSceneRef}
          onViewDetail={handleViewDetail}
          onHint={setFocusHint}
        />
      )}

      <SceneBindingDialog
        scene={editScene}
        open={!!editScene}
        onClose={() => setEditScene(null)}
        onSaved={fetchScenes}
      />

      <SceneBulkBindingDialog
        groups={selectedSceneGroups}
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        onSaved={async (updatedCount) => {
          setBulkDialogOpen(false)
          setSelectedSceneKeys(new Set())
          setBulkSuccessMessage(`已成功换绑 ${updatedCount} 个场景的主模型`)
          await fetchScenes()
        }}
      />

      <Dialog
        open={Boolean(detailScene || detailLoading)}
        onOpenChange={(open) => {
          if (!open) setDetailScene(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <div className="flex min-h-full flex-col">
            <DialogHeader className="border-b px-6 py-5">
              <DialogTitle>{detailScene?.spec.display_name || '场景详情'}</DialogTitle>
              <DialogDescription>
                {detailScene ? <code>{compactId(detailScene.scene_key)}</code> : '加载中'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 px-6 py-4">
              {detailLoading ? (
                <div className="py-12 text-center text-muted-foreground">加载中...</div>
              ) : detailScene ? (
                <Tabs value={detailTab} onValueChange={setDetailTab}>
                  <TabsList className="flex flex-wrap">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="binding">绑定</TabsTrigger>
                    <TabsTrigger value="models">模型</TabsTrigger>
                    <TabsTrigger value="validation">校验</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="场景 key" value={<code>{detailScene.scene_key}</code>} />
                      <InfoRow
                        label="能力类型"
                        value={
                          DOMAIN_LABELS[detailScene.spec.capability_domain] ||
                          detailScene.spec.capability_domain
                        }
                      />
                      <InfoRow label="描述" value={detailScene.spec.description} />
                      <InfoRow label="系统场景" value={detailScene.spec.is_system ? '是' : '否'} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <CompactMetric
                        label="24h 调用"
                        value={detailScene.recent_usage.total_calls_24h}
                        icon={Activity}
                      />
                      <CompactMetric
                        label="成功率"
                        value={`${(detailScene.recent_usage.success_rate * 100).toFixed(1)}%`}
                        icon={TriangleAlert}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="binding" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow
                        label="当前绑定模型"
                        value={detailScene.binding?.primary_model?.display_name || '未绑定'}
                      />
                      <InfoRow
                        label="备用模型"
                        value={
                          detailScene.binding?.fallback_models?.length
                            ? `${detailScene.binding.fallback_models.length} 个`
                            : '无'
                        }
                      />
                      <InfoRow
                        label="超时"
                        value={
                          detailScene.binding?.timeout_sec
                            ? `${detailScene.binding.timeout_sec}s`
                            : '按策略推导'
                        }
                      />
                      <InfoRow
                        label="更新时间"
                        value={formatDateTime(detailScene.binding?.updated_at)}
                      />
                    </div>
                    {selectedSceneItem ? (
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => setEditScene(selectedSceneItem)}
                      >
                        编辑绑定
                      </Button>
                    ) : null}
                  </TabsContent>

                  <TabsContent value="models" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow
                        label="主模型"
                        value={detailScene.binding?.primary_model?.display_name || '未绑定'}
                      />
                      <InfoRow
                        label="模型名"
                        value={
                          detailScene.binding?.primary_model?.model_name ? (
                            <code>{detailScene.binding.primary_model.model_name}</code>
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow
                        label="默认参数"
                        value={
                          Object.keys(detailScene.binding?.default_params || {}).length
                            ? '已配置'
                            : '未配置'
                        }
                      />
                    </div>
                    <pre className="max-h-52 overflow-auto rounded bg-muted/50 p-3 text-caption">
                      {JSON.stringify(detailScene.binding?.default_params || {}, null, 2)}
                    </pre>
                  </TabsContent>

                  <TabsContent value="validation" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow
                        label="校验状态"
                        value={
                          selectedSceneItem?.capability_validation === 'satisfied' ? '通过' : '异常'
                        }
                      />
                      <InfoRow
                        label="平均延迟"
                        value={`${detailScene.recent_usage.avg_latency_ms}ms`}
                      />
                      <InfoRow
                        label="24h 成本"
                        value={`$${detailScene.recent_usage.total_cost_usd}`}
                      />
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="mb-2 text-body font-medium">能力要求</div>
                      <pre className="max-h-52 overflow-auto rounded bg-muted/50 p-3 text-caption">
                        {JSON.stringify(detailScene.spec.capability_requirements, null, 2)}
                      </pre>
                    </div>
                    {detailScene.prompt_bundle ? (
                      <div className="rounded-lg border p-4">
                        <div className="mb-2 text-body font-medium">Prompt Bundle</div>
                        <PromptDetail sceneKey={detailScene.scene_key} />
                      </div>
                    ) : null}
                  </TabsContent>

                  <TabsContent value="audit" className="mt-4 space-y-2">
                    {detailScene.recent_audit.length > 0 ? (
                      detailScene.recent_audit.map((item) => (
                        <div key={item.id} className="rounded-lg border p-3 text-body">
                          <div className="font-medium">{item.action}</div>
                          <div className="text-caption text-muted-foreground">
                            {item.operator} · {formatDateTime(item.created_at)}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                        暂无审计记录
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function AutoOpenSceneDetail({
  sceneKeyFromQuery,
  scenes,
  autoOpenedSceneRef,
  onViewDetail,
  onHint,
}: {
  sceneKeyFromQuery: string
  scenes: SceneItem[]
  autoOpenedSceneRef: MutableRefObject<string>
  onViewDetail: (scene: SceneItem) => Promise<void>
  onHint: (message: string) => void
}) {
  useEffect(() => {
    const matched = scenes.find((scene) => scene.scene_key === sceneKeyFromQuery)
    if (!matched) {
      onHint(`未找到 scene：${sceneKeyFromQuery}，请在列表中继续搜索或检查 key。`)
      return
    }

    if (autoOpenedSceneRef.current === sceneKeyFromQuery) {
      return
    }
    autoOpenedSceneRef.current = sceneKeyFromQuery
    onHint(`已定位 scene：${sceneKeyFromQuery}，并自动打开详情。`)
    void onViewDetail(matched)
  }, [autoOpenedSceneRef, onHint, onViewDetail, sceneKeyFromQuery, scenes])

  return null
}
