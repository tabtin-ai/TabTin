import { Link } from 'react-router-dom'
import type { EmbeddingSceneItem } from '../../api/embedding'

function formatTimeAgo(isoStr: string | null): string {
  if (!isoStr) return '从未重建'
  const diff = Date.now() - new Date(isoStr).getTime()
  if (diff < 0) return '刚刚'
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

interface EmbeddingOverviewProps {
  scenes: EmbeddingSceneItem[]
  loading: boolean
}

/**
 * Tab 1：默认配置 — 显示当前 8 个 embedding scene 的 binding 一览。
 * 每行可点跳到 `/ai/scenes?scene_key=<scene_key>` 编辑 binding（宪法 §1.5.1）。
 */
export function EmbeddingOverview({ scenes, loading }: EmbeddingOverviewProps) {
  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">加载中...</div>
  }

  if (scenes.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 px-4 py-8 text-center text-body text-muted-foreground">
        没有任何 embedding scene 注册。请检查{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
          apps/services/llm/scenes/registry.py
        </code>{' '}
        是否漏注册。
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-4 py-3 text-left font-medium">Scene Key</th>
            <th className="px-4 py-3 text-left font-medium">显示名</th>
            <th className="px-4 py-3 text-left font-medium">Primary Model</th>
            <th className="px-4 py-3 text-center font-medium">维度</th>
            <th className="px-4 py-3 text-center font-medium">索引文档数</th>
            <th className="px-4 py-3 text-left font-medium">最近 rebuild</th>
            <th className="px-4 py-3 text-center font-medium">状态</th>
            <th className="px-4 py-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {scenes.map((s) => (
            <tr key={s.scene_key} className="border-b hover:bg-muted/20 transition-colors">
              <td className="px-4 py-3">
                <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                  {s.scene_key}
                </code>
              </td>
              <td className="px-4 py-3" title={s.description}>
                {s.display_name}
              </td>
              <td className="px-4 py-3">
                {s.primary_model ? (
                  <div>
                    <div className="font-medium">{s.primary_model.display_name}</div>
                    <div className="text-caption text-muted-foreground font-mono">
                      {s.primary_model.model_name}
                    </div>
                  </div>
                ) : (
                  <span className="text-red-500">未绑定</span>
                )}
              </td>
              <td className="px-4 py-3 text-center font-mono">
                {s.primary_model?.dimensions ? (
                  <span
                    className={
                      s.primary_model.dimensions === 1024 ? 'text-green-600' : 'text-yellow-600'
                    }
                  >
                    {s.primary_model.dimensions}
                  </span>
                ) : (
                  '-'
                )}
              </td>
              <td className="px-4 py-3 text-center font-mono">
                {s.indexed_documents === null ? (
                  <span className="text-muted-foreground" title="该 scene 是查询类，没有物理表">
                    —
                  </span>
                ) : (
                  s.indexed_documents.toLocaleString()
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatTimeAgo(s.last_rebuild_at)}
              </td>
              <td className="px-4 py-3 text-center">
                {s.rebuild_in_progress ? (
                  <span
                    className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-caption font-medium text-yellow-800"
                    title="重建任务进行中"
                  >
                    重建中
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-caption font-medium text-green-800"
                    title="正常服务"
                  >
                    正常
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  to={`/ai/scenes?scene_key=${encodeURIComponent(s.scene_key)}`}
                  className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
                >
                  编辑绑定
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
