/**
 * Provider 探测日志 Dialog（v0.1）
 *
 * v0.1 §6 删了 LLMProviderProbeLog 表（详见 SSoT Phase A1），探测历史改走
 * LLMAdminAuditLog（action='provider.runtime.probe'）+ Provider.health_* 字段。
 *
 * 这个 Dialog 显示：
 *   1. 当前 Provider 的健康概览（last_checked_at / last_error / consecutive_failures 等）
 *   2. 最近 N 条来自 audit log 的探测/重置记录
 *   3. 可在 Dialog 内直接触发一次探测
 */

import { llmAdminApi } from '@/api/llm-admin'
import type { LlmAdminAuditLog } from '@/types/llm-admin'
import { useCallback, useEffect, useState } from 'react'
import { type ProbeDiagnostic, type ProviderItem, providersApi } from '../../api/providers'

interface ProbeLogDialogProps {
  provider: ProviderItem | null
  open: boolean
  onClose: () => void
  onProviderRefreshed: (provider: ProviderItem) => void
}

const PROBE_ACTIONS = new Set([
  'provider.runtime.probe',
  'provider.runtime.reset',
  'provider.runtime.update',
])

function formatTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function ProbeLogDialog({
  provider,
  open,
  onClose,
  onProviderRefreshed,
}: ProbeLogDialogProps) {
  const [logs, setLogs] = useState<LlmAdminAuditLog[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [probing, setProbing] = useState(false)
  const [latestDiagnostic, setLatestDiagnostic] = useState<ProbeDiagnostic | null>(null)

  const fetchLogs = useCallback(async () => {
    if (!provider) return
    setLoading(true)
    setError('')
    try {
      const data = await llmAdminApi.listAuditLogs({
        targetType: 'provider',
        targetId: provider.id,
        page: 1,
        pageSize: 30,
      })
      const filtered = data.logs.filter((log) => PROBE_ACTIONS.has(log.action))
      setLogs(filtered)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [provider])

  useEffect(() => {
    if (open) {
      setLatestDiagnostic(null)
      fetchLogs()
    }
  }, [open, fetchLogs])

  const handleProbe = async () => {
    if (!provider) return
    setProbing(true)
    setError('')
    try {
      const result = await providersApi.probe(provider.id)
      onProviderRefreshed(result.provider)
      setLatestDiagnostic(result.probe.diagnostic ?? null)
      await fetchLogs()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setProbing(false)
    }
  }

  if (!open || !provider) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        className="w-full max-w-3xl rounded-lg bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-subtitle font-semibold">探测日志</h2>
            <p className="text-caption text-muted-foreground mt-1">
              <code>{provider.provider_key}</code> · {provider.display_name}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-caption font-medium hover:bg-muted disabled:opacity-50 transition-colors"
              onClick={handleProbe}
              disabled={probing}
            >
              {probing ? '探测中…' : '立即探测'}
            </button>
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-caption font-medium hover:bg-muted transition-colors"
              onClick={fetchLogs}
              disabled={loading}
            >
              刷新
            </button>
          </div>
        </div>

        {/* 健康概览 */}
        <div className="mb-4 grid grid-cols-2 gap-3 text-caption">
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">runtime_status</p>
            <p className="font-semibold">{provider.runtime_status}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">连续失败</p>
            <p className="font-semibold">{provider.health_consecutive_failures}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">最近探测</p>
            <p className="font-semibold">{formatTime(provider.health_last_checked_at)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">最近成功</p>
            <p className="font-semibold">{formatTime(provider.health_last_success_at)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">最近延迟</p>
            <p className="font-semibold">
              {provider.health_last_latency_ms != null
                ? `${provider.health_last_latency_ms}ms`
                : '—'}
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">成功率</p>
            <p className="font-semibold">
              {Number.isFinite(provider.health_success_rate)
                ? `${provider.health_success_rate.toFixed(1)}%`
                : '—'}
            </p>
          </div>
        </div>

        {provider.health_last_error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700 dark:bg-red-950/40 dark:border-red-900/60 dark:text-red-300">
            <span className="font-medium">最近错误：</span>
            <code className="ml-1 font-mono break-all">{provider.health_last_error}</code>
          </div>
        )}

        {latestDiagnostic && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-caption text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
          >
            <p className="font-semibold">失败位置：{latestDiagnostic.failure_stage_label}</p>
            <p className="mt-1">{latestDiagnostic.summary}</p>
            <p className="mt-1">
              <span className="font-medium">建议处理：</span>
              {latestDiagnostic.suggestion}
            </p>
            <p className="mt-1 text-[10px] opacity-80">
              {latestDiagnostic.model_name ? `模型：${latestDiagnostic.model_name}` : '模型：—'}
              {latestDiagnostic.http_status != null
                ? ` · HTTP ${latestDiagnostic.http_status}`
                : ''}
              {latestDiagnostic.error_code ? ` · ${latestDiagnostic.error_code}` : ''}
            </p>
          </div>
        )}

        {/* 历史日志 */}
        <div>
          <h3 className="text-body font-semibold mb-2">最近 30 条 Runtime Audit</h3>
          {loading ? (
            <div className="py-6 text-center text-caption text-muted-foreground">加载中…</div>
          ) : logs.length === 0 ? (
            <div className="rounded-md border border-dashed py-6 text-center text-caption text-muted-foreground">
              暂无相关 audit 记录
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border max-h-72 overflow-y-auto">
              <table className="w-full text-caption">
                <thead className="sticky top-0 bg-muted/40">
                  <tr className="border-b">
                    <th className="px-2.5 py-2 text-left font-medium">action</th>
                    <th className="px-2.5 py-2 text-left font-medium">operator</th>
                    <th className="px-2.5 py-2 text-left font-medium">关键字段</th>
                    <th className="px-2.5 py-2 text-left font-medium">created_at</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const probeData = (log.extra_data?.probe as Record<string, unknown>) ?? {}
                    const successFlag = log.after_data?.probe_success
                    return (
                      <tr key={log.id} className="border-b hover:bg-muted/10">
                        <td className="px-2.5 py-2">
                          <code className="rounded bg-muted px-1 text-[10px] font-mono">
                            {log.action}
                          </code>
                          {typeof successFlag === 'boolean' && (
                            <span
                              className={`ml-1 inline-flex rounded px-1 text-[10px] ${
                                successFlag
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-red-100 text-red-700'
                              }`}
                            >
                              {successFlag ? 'success' : 'failed'}
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-2 text-muted-foreground">
                          {log.operator_username}
                        </td>
                        <td className="px-2.5 py-2 max-w-xs">
                          {Object.keys(probeData).length > 0 ? (
                            <code className="text-[10px] font-mono break-all line-clamp-2">
                              {JSON.stringify(probeData).slice(0, 120)}
                            </code>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2.5 py-2 text-muted-foreground">
                          {formatTime(log.created_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700 dark:bg-red-950/40 dark:border-red-900/60 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-body font-medium hover:bg-muted transition-colors"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
