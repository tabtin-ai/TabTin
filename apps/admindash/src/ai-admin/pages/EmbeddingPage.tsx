import { AdminPage } from '@/components/admin-page'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { embeddingApi } from '../api/embedding'
import type {
  EmbeddingOverview as EmbeddingOverviewData,
  EmbeddingSceneItem,
  EmbeddingTableItem,
} from '../api/embedding'
import { EmbeddingOverview } from '../components/embedding/EmbeddingOverview'
import { IndexStatusTable } from '../components/embedding/IndexStatusTable'
import { RebuildIndexDialog } from '../components/embedding/RebuildIndexDialog'
import { RebuildTaskTracker } from '../components/embedding/RebuildTaskTracker'

type SubTab = 'config' | 'index_status' | 'rebuild'

const TAB_LABELS: Record<SubTab, string> = {
  config: '默认配置',
  index_status: '索引状态',
  rebuild: '重建索引',
}

const TAB_DESCRIPTIONS: Record<SubTab, string> = {
  config: '8 个 embedding scene 的 binding 一览（点击单行跳转编辑）',
  index_status: '7 张物理 embedding 表的维度、文档数、最近 rebuild 时间',
  rebuild: 'v0.1 stub UI — 提交即被后端 422 FEATURE_NOT_IMPLEMENTED 拒绝',
}

/**
 * `/ai/embedding` — Embedding 配置页（宪法 v0.1 §1.5）
 *
 * 单页 3 个子 Tab：
 *   1. 默认配置 — `EmbeddingOverview` 显示 8 个 scene binding
 *   2. 索引状态 — `IndexStatusTable` 显示 7 张物理表
 *   3. 重建索引 — `RebuildIndexDialog`（v0.1 stub）+ `RebuildTaskTracker`
 *
 * 数据源：`GET /services/llm/admin/embedding/overview`
 */
export function EmbeddingPage() {
  const [activeTab, setActiveTab] = useState<SubTab>('config')
  const [scenes, setScenes] = useState<EmbeddingSceneItem[]>([])
  const [tables, setTables] = useState<EmbeddingTableItem[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuildOpen, setRebuildOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data: EmbeddingOverviewData = await embeddingApi.overview()
      setScenes(data.scenes || [])
      setTables(data.tables || [])
      setGeneratedAt(data.generated_at || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const headerSummary = useMemo(() => {
    const totalScenes = scenes.length
    const boundScenes = scenes.filter((s) => s.primary_model !== null).length
    const totalDocs = tables.reduce((sum, t) => sum + t.indexed_documents, 0)
    return { totalScenes, boundScenes, totalDocs }
  }, [scenes, tables])

  return (
    <AdminPage>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-heading font-bold tracking-tight">向量模型配置</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-body hover:bg-muted"
            onClick={load}
            disabled={loading}
          >
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>
      </div>

      {generatedAt && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border p-3">
            <div className="text-caption text-muted-foreground">向量场景数</div>
            <div className="text-title font-bold">{headerSummary.totalScenes}</div>
            <div className="text-caption text-muted-foreground">
              已绑定 {headerSummary.boundScenes} / {headerSummary.totalScenes}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-caption text-muted-foreground">物理表数</div>
            <div className="text-title font-bold">{tables.length}</div>
            <div className="text-caption text-muted-foreground">
              累计 {headerSummary.totalDocs.toLocaleString()} 条向量
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-caption text-muted-foreground">数据生成于</div>
            <div className="text-body font-mono">{new Date(generatedAt).toLocaleString()}</div>
            <div className="text-caption text-muted-foreground">每次刷新重新拉取</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-body text-red-900">
          加载概览失败：{error}
        </div>
      )}

      <div className="flex gap-1 border-b">
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

      <p className="text-caption text-muted-foreground">{TAB_DESCRIPTIONS[activeTab]}</p>

      {activeTab === 'config' && <EmbeddingOverview scenes={scenes} loading={loading} />}

      {activeTab === 'index_status' && <IndexStatusTable tables={tables} loading={loading} />}

      {activeTab === 'rebuild' && (
        <div className="space-y-4">
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-body text-yellow-900">
            <div className="font-medium mb-1">v0.1 stub 说明</div>
            <div className="text-caption">
              宪法 v0.1 §1.5.3 + §6.1.6 决议：v0.1 没有真实数据需要 rebuild， 本 Tab 仅保留 UI
              形态用于审视交互流程。点"启动重建"提交后， 后端会以{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                422 FEATURE_NOT_IMPLEMENTED
              </code>{' '}
              拒绝，前端会展示 toast 提示等待 v0.2。
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className="text-body">
              <span className="text-muted-foreground">当前进行中重建任务：</span>
              <span className="font-mono">
                {scenes.filter((s) => s.rebuild_in_progress).length} 个
              </span>
            </div>
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              onClick={() => setRebuildOpen(true)}
            >
              启动重建（v0.1 stub）
            </button>
          </div>

          <RebuildTaskTracker scenes={scenes} />
        </div>
      )}

      <RebuildIndexDialog
        open={rebuildOpen}
        scenes={scenes}
        onClose={() => setRebuildOpen(false)}
      />
    </AdminPage>
  )
}
