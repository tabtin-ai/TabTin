import type { EmbeddingSceneItem } from '../../api/embedding'

interface RebuildTaskTrackerProps {
  scenes: EmbeddingSceneItem[]
}

/**
 * Tab 3 配套：当前进行中的重建任务列表。
 * v0.1 永远空（后端没有真实 rebuild 任务），保留组件结构便于 v0.2 接入。
 */
export function RebuildTaskTracker({ scenes }: RebuildTaskTrackerProps) {
  const inProgress = scenes.filter((s) => s.rebuild_in_progress)

  if (inProgress.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-body text-muted-foreground">
        当前没有进行中的重建任务。
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
            <th className="px-4 py-3 text-center font-medium">已索引</th>
            <th className="px-4 py-3 text-left font-medium">最近 rebuild</th>
            <th className="px-4 py-3 text-center font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {inProgress.map((s) => (
            <tr key={s.scene_key} className="border-b">
              <td className="px-4 py-3">
                <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                  {s.scene_key}
                </code>
              </td>
              <td className="px-4 py-3">{s.display_name}</td>
              <td className="px-4 py-3 text-center font-mono">
                {s.indexed_documents === null ? '—' : s.indexed_documents.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {s.last_rebuild_at
                  ? new Date(s.last_rebuild_at).toLocaleString()
                  : '从未'}
              </td>
              <td className="px-4 py-3 text-center">
                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-caption font-medium text-yellow-800">
                  重建中
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
