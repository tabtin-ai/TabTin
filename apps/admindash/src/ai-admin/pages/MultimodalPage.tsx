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
import { Activity, Boxes, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { multimodalApi } from '../api/multimodal'
import type {
  MultimodalDomain,
  MultimodalOverview as MultimodalOverviewData,
  SpeechSubPageData,
  VisionSubPageData,
} from '../api/multimodal'
import { scenesApi } from '../api/scenes'
import { MediaTasksTable } from '../components/multimodal/MediaTasksTable'
import { SpeechSubPage } from '../components/multimodal/SpeechSubPage'
import { VisionSubPage } from '../components/multimodal/VisionSubPage'

type SubTab = 'speech' | 'vision' | 'tasks'

const TAB_LABELS: Record<SubTab, string> = {
  speech: '语音能力',
  vision: '视觉能力',
  tasks: '媒体生成',
}

const TAB_DESCRIPTIONS: Record<SubTab, string> = {
  speech: '语音合成与语音识别场景绑定',
  vision: '视觉理解场景与可用模型',
  tasks: '图片、视频、音频生成任务',
}

const TAB_DOMAIN_FOCUS: Record<SubTab, MultimodalDomain[]> = {
  speech: ['tts', 'asr'],
  vision: ['vision'],
  tasks: ['image_gen', 'video_gen', 'audio_gen'],
}

const RELATED_LINKS: Record<SubTab, Array<{ label: string; href: string; hint: string }>> = {
  speech: [
    { label: 'TTS Provider', href: '/ai/providers?domain=tts', hint: '密钥 / 健康 / 限速' },
    { label: 'ASR Provider', href: '/ai/providers?domain=asr', hint: '密钥 / 健康 / 限速' },
    {
      label: 'TTS 模型',
      href: '/ai/models?domain=tts',
      hint: '查看可用语音合成模型',
    },
    {
      label: 'ASR 模型',
      href: '/ai/models?domain=asr',
      hint: '查看可用语音识别模型',
    },
  ],
  vision: [
    {
      label: '视觉 Provider',
      href: '/ai/providers?domain=vision',
      hint: '查看视觉理解 Provider',
    },
    {
      label: '视觉模型',
      href: '/ai/models?domain=vision',
      hint: '查看支持视觉能力的模型',
    },
    {
      label: 'Scene 详情',
      href: '/ai/scenes?scene_key=vision_parse_document',
      hint: '跳转 Scene 列表并定位',
    },
  ],
  tasks: [
    {
      label: '图片模型',
      href: '/ai/models?domain=image_gen',
      hint: '查看图片生成模型',
    },
    { label: '视频模型', href: '/ai/models?domain=video_gen', hint: '查看视频生成模型' },
    { label: '音频模型', href: '/ai/models?domain=audio_gen', hint: '查看音频生成模型' },
  ],
}

type AbilityMeta = {
  domain: MultimodalDomain
  label: string
  code: string
  tab: SubTab
  issueName: string
}

const ABILITIES: AbilityMeta[] = [
  { domain: 'tts', label: '语音合成', code: 'tts', tab: 'speech', issueName: 'TTS' },
  { domain: 'asr', label: '语音识别', code: 'asr', tab: 'speech', issueName: 'ASR' },
  { domain: 'vision', label: '视觉理解', code: 'vlm', tab: 'vision', issueName: 'VLM' },
  {
    domain: 'image_gen',
    label: '图片生成',
    code: 'media_image_generate',
    tab: 'tasks',
    issueName: '图片生成',
  },
  {
    domain: 'video_gen',
    label: '视频生成',
    code: 'media_video_generate',
    tab: 'tasks',
    issueName: '视频生成',
  },
  {
    domain: 'audio_gen',
    label: '音频生成',
    code: 'media_bgm_generate',
    tab: 'tasks',
    issueName: '音频生成',
  },
]

type TodoItem = {
  key: string
  problem: string
  count: number
  priority: '高' | '中'
  domain: MultimodalDomain
}

type AbilityScene = {
  scene_key: string
  display_name: string
  description: string
  binding: unknown
  capability_validation: 'satisfied' | 'unsatisfied'
  capability_issues?: string[]
}

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: typeof Boxes
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

function SceneList({ scenes }: { scenes: AbilityScene[] }) {
  if (scenes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
        暂无场景
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {scenes.map((scene) => (
        <div key={scene.scene_key} className="rounded-lg border p-3 text-body">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{scene.display_name}</div>
              <code className="text-caption text-muted-foreground">{scene.scene_key}</code>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-caption ${
                scene.binding ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
              }`}
            >
              {scene.binding ? '已绑定' : '未绑定'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * `/ai/multimodal` — 多模态聚合页（宪法 v0.1 §1.6）
 *
 * 单页 3 个子 Tab：
 *   1. Speech — TTS/ASR scene + 模型 + 默认音色
 *   2. Vision — VLM scene + capability 校验
 *   3. 异步任务 — image_gen/video_gen/audio_gen 任务管理（详情 + 重试）
 *
 * 顶部固定显示 6 个 capability_domain 的总览卡片，下方按 Tab 切换聚焦。
 */
export function MultimodalPage() {
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<SubTab>('speech')
  const [overview, setOverview] = useState<MultimodalOverviewData | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [speechData, setSpeechData] = useState<SpeechSubPageData | null>(null)
  const [visionData, setVisionData] = useState<VisionSubPageData | null>(null)
  const [mediaScenes, setMediaScenes] = useState<Partial<Record<MultimodalDomain, AbilityScene[]>>>(
    {}
  )
  const [detailDomain, setDetailDomain] = useState<MultimodalDomain | null>(null)
  const [detailTab, setDetailTab] = useState('overview')

  const loadOverview = useCallback(() => {
    setOverviewLoading(true)
    setOverviewError(null)
    const mediaDomains: MultimodalDomain[] = ['image_gen', 'video_gen', 'audio_gen']
    Promise.all([
      multimodalApi.overview(),
      multimodalApi.speech().catch(() => null),
      multimodalApi.vision().catch(() => null),
      Promise.all(
        mediaDomains.map((domain) =>
          scenesApi
            .list({ domain, include_system: true })
            .then((data) => [domain, data.scenes] as const)
            .catch(() => [domain, []] as const)
        )
      ),
    ])
      .then(([nextOverview, nextSpeech, nextVision, nextMediaScenes]) => {
        setOverview(nextOverview)
        setSpeechData(nextSpeech)
        setVisionData(nextVision)
        setMediaScenes(
          Object.fromEntries(nextMediaScenes) as Partial<Record<MultimodalDomain, AbilityScene[]>>
        )
      })
      .catch((err) => {
        setOverviewError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setOverviewLoading(false))
  }, [])

  useEffect(() => {
    loadOverview()
  }, [loadOverview])

  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab === 'speech' || tab === 'vision' || tab === 'tasks') {
      setActiveTab(tab)
    }
  }, [searchParams])

  const focusedSummary = useMemo(() => {
    if (!overview) return null
    const domains = TAB_DOMAIN_FOCUS[activeTab]
    let totalScenes = 0
    let totalBindings = 0
    let healthyModels = 0
    for (const d of domains) {
      const stat = overview[d]
      if (stat) {
        totalScenes += stat.active_scenes
        totalBindings += stat.active_bindings
        healthyModels += stat.healthy_models
      }
    }
    return { domains, totalScenes, totalBindings, healthyModels }
  }, [overview, activeTab])

  const allSceneMap = useMemo(() => {
    const map = new Map<MultimodalDomain, AbilityScene[]>()
    map.set('tts', speechData?.tts.scenes || [])
    map.set('asr', speechData?.asr.scenes || [])
    map.set('vision', visionData?.scenes || [])
    map.set('image_gen', mediaScenes.image_gen || [])
    map.set('video_gen', mediaScenes.video_gen || [])
    map.set('audio_gen', mediaScenes.audio_gen || [])
    return map
  }, [mediaScenes, speechData, visionData])

  const availableModelsByDomain = useMemo(() => {
    const map = new Map<MultimodalDomain, number>()
    map.set('tts', speechData?.tts.available_models.length ?? overview?.tts.healthy_models ?? 0)
    map.set('asr', speechData?.asr.available_models.length ?? overview?.asr.healthy_models ?? 0)
    map.set('vision', visionData?.available_models.length ?? overview?.vision.healthy_models ?? 0)
    map.set('image_gen', overview?.image_gen.healthy_models ?? 0)
    map.set('video_gen', overview?.video_gen.healthy_models ?? 0)
    map.set('audio_gen', overview?.audio_gen.healthy_models ?? 0)
    return map
  }, [overview, speechData, visionData])

  const metrics = useMemo(() => {
    if (!overview) {
      return { domains: ABILITIES.length, bound: 0, unbound: 0, models: 0 }
    }
    return ABILITIES.reduce(
      (acc, ability) => {
        const stat = overview[ability.domain]
        acc.bound += stat?.active_bindings ?? 0
        acc.unbound += Math.max((stat?.active_scenes ?? 0) - (stat?.active_bindings ?? 0), 0)
        acc.models += availableModelsByDomain.get(ability.domain) ?? stat?.healthy_models ?? 0
        return acc
      },
      { domains: ABILITIES.length, bound: 0, unbound: 0, models: 0 }
    )
  }, [availableModelsByDomain, overview])

  const todoItems = useMemo<TodoItem[]>(() => {
    if (!overview) return []
    const items: TodoItem[] = []
    for (const ability of ABILITIES) {
      const stat = overview[ability.domain]
      const unbound = Math.max((stat?.active_scenes ?? 0) - (stat?.active_bindings ?? 0), 0)
      const modelCount = availableModelsByDomain.get(ability.domain) ?? stat?.healthy_models ?? 0
      const scenes = allSceneMap.get(ability.domain) || []
      const validationFailed = scenes.filter(
        (scene) => scene.capability_validation === 'unsatisfied'
      ).length
      if (unbound > 0) {
        items.push({
          key: `${ability.domain}:unbound`,
          problem: `未绑定 ${ability.issueName}`,
          count: unbound,
          priority: '中',
          domain: ability.domain,
        })
      }
      if ((stat?.active_scenes ?? 0) > 0 && modelCount === 0) {
        items.push({
          key: `${ability.domain}:models`,
          problem: '无可用模型',
          count: stat?.active_scenes ?? 0,
          priority: '高',
          domain: ability.domain,
        })
      }
      if (validationFailed > 0) {
        items.push({
          key: `${ability.domain}:validation`,
          problem: '校验失败',
          count: validationFailed,
          priority: '高',
          domain: ability.domain,
        })
      }
    }
    return items
  }, [allSceneMap, availableModelsByDomain, overview])

  const detailAbility = detailDomain
    ? ABILITIES.find((ability) => ability.domain === detailDomain) || null
    : null
  const detailScenes = detailDomain ? allSceneMap.get(detailDomain) || [] : []
  const detailStat = detailDomain && overview ? overview[detailDomain] : null
  const detailModels = detailDomain ? availableModelsByDomain.get(detailDomain) || 0 : 0

  const openAbility = useCallback((domain: MultimodalDomain) => {
    const ability = ABILITIES.find((item) => item.domain === domain)
    setDetailDomain(domain)
    setDetailTab('overview')
    if (ability) setActiveTab(ability.tab)
  }, [])

  return (
    <AdminPage>
      <AdminPageHeader
        title="多模态服务"
        icon={Boxes}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={loadOverview}
              disabled={overviewLoading}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button asChild variant="outline">
              <Link to="/ai/scenes">管理场景</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/ai/models">管理模型</Link>
            </Button>
          </div>
        }
      />

      {overviewError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-body text-red-900">
          加载概览失败：{overviewError}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="能力域" value={metrics.domains} icon={Boxes} />
        <CompactMetric label="已绑定场景" value={metrics.bound} icon={Activity} />
        <CompactMetric label="未绑定场景" value={metrics.unbound} icon={TriangleAlert} />
        <CompactMetric label="可用模型" value={metrics.models} icon={RefreshCw} />
      </div>

      <section className="rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-body font-semibold">待处理任务</h2>
            <p className="text-caption text-muted-foreground">未绑定、无模型和校验失败</p>
          </div>
          <span className="text-caption text-muted-foreground">{todoItems.length} 项</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-2 text-left font-medium">问题</th>
                <th className="px-4 py-2 text-left font-medium">数量</th>
                <th className="px-4 py-2 text-left font-medium">优先级</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {todoItems.slice(0, 8).map((item) => (
                <tr key={item.key} className="border-b">
                  <td className="px-4 py-2">{item.problem}</td>
                  <td className="px-4 py-2 tabular-nums">{item.count}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-caption ${
                        item.priority === '高'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {item.priority}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                      onClick={() => openAbility(item.domain)}
                    >
                      查看
                    </button>
                    <Link
                      to="/ai/scenes"
                      className="rounded px-2 py-1 text-caption font-medium text-blue-700 hover:bg-blue-50"
                    >
                      处理
                    </Link>
                  </td>
                </tr>
              ))}
              {todoItems.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    暂无待处理任务
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <h2 className="text-body font-semibold">能力域</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">能力</th>
                <th className="px-4 py-3 text-left font-medium">场景数</th>
                <th className="px-4 py-3 text-left font-medium">已绑定</th>
                <th className="px-4 py-3 text-left font-medium">未绑定</th>
                <th className="px-4 py-3 text-left font-medium">可用模型</th>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {ABILITIES.map((ability) => {
                const stat = overview?.[ability.domain]
                const scenes = stat?.active_scenes ?? 0
                const bindings = stat?.active_bindings ?? 0
                const unbound = Math.max(scenes - bindings, 0)
                const modelCount = availableModelsByDomain.get(ability.domain) ?? 0
                const status =
                  scenes === 0 ? '未配置' : unbound > 0 || modelCount === 0 ? '需处理' : '可用'
                return (
                  <tr
                    key={ability.domain}
                    className="cursor-pointer border-b hover:bg-muted/20"
                    onClick={() => openAbility(ability.domain)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openAbility(ability.domain)
                      }
                    }}
                    tabIndex={0}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{ability.label}</div>
                      <code className="text-caption text-muted-foreground">{ability.code}</code>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{scenes}</td>
                    <td className="px-4 py-3 tabular-nums">{bindings}</td>
                    <td className="px-4 py-3 tabular-nums">{unbound}</td>
                    <td className="px-4 py-3 tabular-nums">{modelCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-caption ${
                          status === '可用'
                            ? 'bg-green-100 text-green-800'
                            : status === '需处理'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                        onClick={(event) => {
                          event.stopPropagation()
                          openAbility(ability.domain)
                        }}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex gap-1 border-b mt-4">
        {(Object.keys(TAB_LABELS) as SubTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-body font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-body font-medium">{TAB_LABELS[activeTab]}</span>
          <span className="text-caption text-muted-foreground">{TAB_DESCRIPTIONS[activeTab]}</span>
        </div>

        {focusedSummary && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
            <span>
              能力：
              {focusedSummary.domains.map((d) => (
                <code
                  key={d}
                  className="rounded bg-muted px-1.5 py-0.5 mx-1 font-mono text-foreground"
                >
                  {d}
                </code>
              ))}
            </span>
            <span>
              Scene：<span className="font-mono text-foreground">{focusedSummary.totalScenes}</span>
            </span>
            <span>
              已绑定：
              <span className="font-mono text-foreground">{focusedSummary.totalBindings}</span>
            </span>
            <span>
              可用模型：
              <span className="font-mono text-foreground">{focusedSummary.healthyModels}</span>
            </span>
          </div>
        )}

        {RELATED_LINKS[activeTab].length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption">
            {RELATED_LINKS[activeTab].map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className="text-primary hover:underline"
                title={link.hint}
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4">
        {activeTab === 'speech' && <SpeechSubPage />}
        {activeTab === 'vision' && <VisionSubPage />}
        {activeTab === 'tasks' && <MediaTasksTable />}
      </div>

      <Dialog open={Boolean(detailDomain)} onOpenChange={(open) => !open && setDetailDomain(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <div className="flex min-h-full flex-col">
            <DialogHeader className="border-b px-6 py-5">
              <DialogTitle>{detailAbility?.label || '能力详情'}</DialogTitle>
              <DialogDescription>
                {detailAbility ? <code>{detailAbility.code}</code> : '加载中'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 px-6 py-4">
              {detailAbility ? (
                <Tabs value={detailTab} onValueChange={setDetailTab}>
                  <TabsList className="flex flex-wrap">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="scenes">场景</TabsTrigger>
                    <TabsTrigger value="models">模型</TabsTrigger>
                    <TabsTrigger value="validation">校验</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="能力类型" value={detailAbility.label} />
                      <InfoRow label="技术 code" value={<code>{detailAbility.domain}</code>} />
                      <InfoRow label="场景数" value={detailStat?.active_scenes ?? 0} />
                      <InfoRow label="已绑定" value={detailStat?.active_bindings ?? 0} />
                      <InfoRow
                        label="未绑定"
                        value={Math.max(
                          (detailStat?.active_scenes ?? 0) - (detailStat?.active_bindings ?? 0),
                          0
                        )}
                      />
                      <InfoRow label="可用模型" value={detailModels} />
                    </div>
                  </TabsContent>
                  <TabsContent value="scenes" className="mt-4 space-y-3 text-body">
                    <SceneList scenes={detailScenes} />
                    <Button asChild variant="outline">
                      <Link to="/ai/scenes">管理场景</Link>
                    </Button>
                  </TabsContent>
                  <TabsContent value="models" className="mt-4 space-y-3 text-body">
                    <div className="rounded-lg border p-4">
                      <InfoRow label="可用模型" value={detailModels} />
                      <InfoRow label="相关能力" value={<code>{detailAbility.domain}</code>} />
                    </div>
                    <Button asChild variant="outline">
                      <Link to={`/ai/models?domain=${detailAbility.domain}`}>管理模型</Link>
                    </Button>
                  </TabsContent>
                  <TabsContent value="validation" className="mt-4 space-y-2">
                    {detailScenes.length > 0 ? (
                      detailScenes.map((scene) => (
                        <div key={scene.scene_key} className="rounded-lg border p-3 text-body">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="font-medium">{scene.display_name}</div>
                              <code className="text-caption text-muted-foreground">
                                {scene.scene_key}
                              </code>
                            </div>
                            <span
                              className={`rounded-full px-2 py-0.5 text-caption ${
                                scene.capability_validation === 'satisfied'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {scene.capability_validation === 'satisfied' ? '通过' : '异常'}
                            </span>
                          </div>
                          {scene.capability_issues?.length ? (
                            <div className="mt-2 text-caption text-red-700">
                              {scene.capability_issues.join(' / ')}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                        暂无校验明细
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="audit" className="mt-4">
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      审计记录请在场景详情查看
                    </div>
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
