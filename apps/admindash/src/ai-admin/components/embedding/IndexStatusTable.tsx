import type { EmbeddingTableItem } from '../../api/embedding'

function formatTimeAgo(isoStr: string | null): string {
  if (!isoStr) return '从未重建'
  const diff = Date.now() - new Date(isoStr).getTime()
  if (diff < 0) return '刚刚'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

interface IndexStatusTableProps {
  tables: EmbeddingTableItem[]
  loading: boolean
}

/**
 * Tab 2：索引状态 — 按物理表（7 张）显示文档数 / 维度 / 最近 rebuild。
 * 数据源：宪法 §6.1.4 中列出的 7 张物理 embedding 表。
 */
export function IndexStatusTable({ tables, loading }: IndexStatusTableProps) {
  if (loading) {
    return (
      <div className="py-12 text-center text-muted-foreground">加载中...</div>
    )
  }

  const totalDocs = tables.reduce((sum, t) => sum + t.indexed_documents, 0)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 px-4 py-3 text-caption text-muted-foreground">
        7 张物理 embedding 表（pgvector 1024 维强约束 — 宪法 §6.1.5）。
        当前累计索引{' '}
        <span className="font-mono font-medium text-foreground">
          {totalDocs.toLocaleString()}
        </span>{' '}
        条向量。
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-4 py-3 text-left font-medium">物理表</th>
              <th className="px-4 py-3 text-left font-medium">用途</th>
              <th className="px-4 py-3 text-center font-medium">维度</th>
              <th className="px-4 py-3 text-center font-medium">索引文档数</th>
              <th className="px-4 py-3 text-left font-medium">最近 rebuild</th>
              <th className="px-4 py-3 text-center font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.table_name} className="border-b hover:bg-muted/20">
                <td className="px-4 py-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                    {t.table_name}
                  </code>
                </td>
                <td className="px-4 py-3">{t.display_name}</td>
                <td className="px-4 py-3 text-center font-mono">
                  <span className={t.dimensions === 1024 ? 'text-green-600' : 'text-yellow-600'}>
                    {t.dimensions}
                  </span>
                </td>
                <td className="px-4 py-3 text-center font-mono">
                  {t.indexed_documents.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatTimeAgo(t.last_rebuild_at)}
                </td>
                <td className="px-4 py-3 text-center">
                  {t.rebuild_in_progress ? (
                    <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-caption font-medium text-yellow-800">
                      重建中
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-caption font-medium text-green-800">
                      正常
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {tables.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  没有可用的物理表统计。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
