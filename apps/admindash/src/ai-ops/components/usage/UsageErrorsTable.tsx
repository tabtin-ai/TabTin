import { AlertTriangle, ShieldAlert } from 'lucide-react'
import type { UsageErrorItem } from '../../api/usage'
import { formatNumber, formatPercent } from './formatters'

interface UsageErrorsTableProps {
  items: UsageErrorItem[]
  loading: boolean
}

// 错误码颜色：
// E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY → 红（合规问题）
// E15_BYOK_PROVIDER_NOT_AVAILABLE        → 橙
// E16_CAPABILITY_MISMATCH                → 红
// E17_BYOK_RATE_LIMIT                    → 橙
// E22_PROVIDER_TIMEOUT                   → 黄
// 其他                                    → 灰
function classifyErrorCode(code: string): {
  badge: string
  label: string
} {
  const upper = code.toUpperCase()
  if (upper.includes('E14') || upper.includes('CAPABILITY_MISMATCH') || upper.includes('E16')) {
    return {
      badge: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-900/40 dark:text-rose-200 dark:border-rose-800',
      label: '合规',
    }
  }
  if (upper.includes('E15') || upper.includes('E17') || upper.includes('BYOK')) {
    return {
      badge: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/40 dark:text-orange-200 dark:border-orange-800',
      label: 'BYOK',
    }
  }
  if (upper.includes('E22') || upper.includes('TIMEOUT')) {
    return {
      badge: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800',
      label: '超时',
    }
  }
  if (upper.includes('MISSING') || upper.includes('FEATURE_NOT_IMPLEMENTED')) {
    return {
      badge: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/40 dark:text-purple-200 dark:border-purple-800',
      label: '缺失',
    }
  }
  return {
    badge: 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800/60 dark:text-zinc-200 dark:border-zinc-700',
    label: '其他',
  }
}

export function UsageErrorsTable({ items, loading }: UsageErrorsTableProps) {
  const total = items.reduce((acc, it) => acc + it.total, 0)
  const top = items[0]

  return (
    <section className="rounded-lg border bg-card p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-500" />
          <span className="text-body font-semibold">错误码分布</span>
          <span className="text-caption text-muted-foreground">
            （Top {items.length}，总错误 {formatNumber(total)}）
          </span>
        </div>
        {top && (
          <span className="flex items-center gap-1 rounded-md border bg-rose-50 px-2 py-1 text-caption text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            最高：{top.error_code}（{formatNumber(top.total)}）
          </span>
        )}
      </header>

      <div className="mt-3 overflow-auto rounded-md border">
        <table className="w-full text-body">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">错误分类</th>
              <th className="px-3 py-2 font-medium">错误码</th>
              <th className="px-3 py-2 text-right font-medium">次数</th>
              <th className="px-3 py-2 text-right font-medium">占比</th>
              <th className="px-3 py-2 font-medium" style={{ width: '30%' }}>
                占比可视化
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-caption text-muted-foreground">
                  加载中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-caption text-muted-foreground">
                  当前时间窗口没有失败请求 ✅
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const ratio = total > 0 ? (item.total / total) * 100 : 0
                const cls = classifyErrorCode(item.error_code)
                return (
                  <tr key={`${item.error_category}:${item.error_code}`} className="border-t">
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-medium ${cls.badge}`}
                      >
                        {cls.label} · {item.error_category || 'other'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-caption">{item.error_code}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatNumber(item.total)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatPercent(ratio)}</td>
                    <td className="px-3 py-2">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-rose-500/70"
                          style={{ width: `${Math.min(100, ratio).toFixed(1)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-caption text-muted-foreground">
        宪法 v0.1 §4 错误码：E14/E16 合规问题（前端拦截 BYOK / capability 校验）；E15/E17 BYOK
        渠道层（FE 必须展示重试 / 切换平台模型 CTA）；E22 超时；MISSING_*
        通常说明 SceneBinding 缺失。
      </p>
    </section>
  )
}
