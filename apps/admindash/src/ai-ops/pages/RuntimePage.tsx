import { llmAdminApi } from '@/api/llm-admin'
import { AdminPage } from '@/components/admin-page'
import type { LlmAdminRuntimeModel } from '@/types/llm-admin'
import { useEffect, useState } from 'react'

export function RuntimePage() {
  const [models, setModels] = useState<LlmAdminRuntimeModel[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    llmAdminApi
      .listRuntimeModels({})
      .then((data) => setModels(data.models))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <AdminPage>
      <div>
        <h1 className="text-heading font-bold">运行治理</h1>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载中...</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-4 py-3 text-left font-medium">Provider</th>
                <th className="px-4 py-3 text-center font-medium">请求数</th>
                <th className="px-4 py-3 text-center font-medium">成功率</th>
                <th className="px-4 py-3 text-center font-medium">平均延迟</th>
                <th className="px-4 py-3 text-center font-medium">P95 延迟</th>
                <th className="px-4 py-3 text-center font-medium">健康</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className="border-b hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{m.display_name}</td>
                  <td className="px-4 py-3">{m.provider_display_name}</td>
                  <td className="px-4 py-3 text-center">{m.total_requests}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={m.success_rate < 0.95 ? 'text-red-500 font-medium' : ''}>
                      {(m.success_rate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">{m.avg_latency_ms}ms</td>
                  <td className="px-4 py-3 text-center">{m.p95_latency_ms}ms</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`rounded-full px-2 py-0.5 text-caption font-medium ${
                        m.runtime_status === 'healthy'
                          ? 'bg-green-100 text-green-800'
                          : m.runtime_status === 'degraded'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {m.runtime_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  )
}
