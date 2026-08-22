/**
 * ParentTraceButton — LH2-A1（H3-C / Review S3 修复）
 *
 * 子 trace-detail 页顶部"父 trace"返回按钮。Review S3 发现：父按钮直接跳
 * `navigate(/agent-debug/trace/${parentTraceId})` 在孤儿 child trace（父 trace
 * 未到达 DB / 父写表失败）场景会跳到"Trace not found"页让运维误判"系统坏了"。
 *
 * 修复策略：
 *   - 加载组件时调一次 `agentDebugApi.getTrace(parentTraceId)` 做存在性预检
 *   - 父 trace 存在 → 蓝色可点按钮（与原行为一致）
 *   - 父 trace 不存在（404 / 网络错误）→ 灰色禁用 + tooltip "父 trace 未到达数据库
 *     （可能是 relay 异常或正在传输中）"
 *   - 加载中 → 蓝色按钮 + "检查中..." 文字（避免按钮闪烁）
 *
 * 不预先 prefetch 子 trace 列表 — 那是 SubagentTracesSection 的职责。
 */

import { agentDebugApi } from '@/api/agent-debug'
import { Layers, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { useNavigate } from 'react-router-dom'

interface ParentTraceButtonProps {
  parentTraceId: string | null
  /** trace-detail 页的 react-router navigate；通过 prop 注入便于单测 mock */
  navigate: ReturnType<typeof useNavigate>
}

type CheckState = 'loading' | 'exists' | 'missing' | 'error'

export function ParentTraceButton({ parentTraceId, navigate }: ParentTraceButtonProps) {
  const [state, setState] = useState<CheckState>(parentTraceId ? 'loading' : 'missing')

  useEffect(() => {
    if (!parentTraceId) {
      setState('missing')
      return
    }
    let cancelled = false
    setState('loading')
    void agentDebugApi
      .getTrace(parentTraceId)
      .then(() => {
        if (!cancelled) setState('exists')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        // 404 / Trace not found → missing；其他错误 → error（仍灰色但 tooltip 不同）
        if (message.includes('404') || message.toLowerCase().includes('not found')) {
          setState('missing')
        } else {
          setState('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [parentTraceId])

  if (!parentTraceId) return null

  const idShort = parentTraceId.substring(0, 8)
  const label = `父 trace: ${idShort}…`

  if (state === 'loading') {
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md border border-info/30 bg-info/10 px-2 py-1 text-body text-info opacity-70 cursor-wait"
        disabled
        title="正在校验父 trace 是否存在..."
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{label}</span>
      </button>
    )
  }

  if (state === 'exists') {
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md border border-info/30 bg-info/10 px-2 py-1 text-body text-info hover:bg-info/20 transition-colors"
        onClick={() => navigate(`/agent-debug/trace/${parentTraceId}`)}
        title="跳到父 Agent trace"
      >
        <Layers className="h-3.5 w-3.5" />
        <span>{label}</span>
      </button>
    )
  }

  // missing / error → 灰色禁用 + tooltip 解释原因，绝不弹 404
  const tooltip =
    state === 'missing'
      ? '父 trace 未在数据库中找到（可能是 relay 异常 / 父 trace 正在传输 / 写表失败）。请稍后刷新或联系运维。'
      : '校验父 trace 时网络或服务异常；可手动刷新页面重试。'
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md border border-muted bg-muted/20 px-2 py-1 text-body text-muted-foreground opacity-70 cursor-not-allowed"
      disabled
      title={tooltip}
    >
      <Layers className="h-3.5 w-3.5" />
      <span>{label}</span>
      <span className="text-caption">·{state === 'missing' ? '未找到' : '校验失败'}</span>
    </button>
  )
}
