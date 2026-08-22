/**
 * /ai/providers 列表表格（v0.1）
 *
 * 对照宪法 v0.1 §1.2.2 列规格：
 *   display_name / provider_key / 类型 (name) / Domain (badge) / Scope (Badge: global=蓝/organization=橙/user=紫) /
 *   健康 (runtime_status icon) / 模型数 / 优先级（inline 编辑）/ 限速 / 路由 (Switch) / 操作 + BYOK Badge
 *
 * 行内 action（§1.2.2 末列）：编辑 / 探测 / 重置健康 / 探测日志 / 看密钥（展开）/ 删除。
 */

import { useState } from 'react'
import type { ProviderItem, ProviderProbeResult, ProviderScope } from '../../api/providers'
import { ProbeButton } from './ProbeButton'

interface ProviderTableProps {
  providers: ProviderItem[]
  onOpenDetail: (provider: ProviderItem) => void
  onOpenKeys: (provider: ProviderItem) => void
  onEdit: (provider: ProviderItem) => void
  onProbed: (refreshed: ProviderItem, result: ProviderProbeResult) => void
  onProbeError?: (message: string) => void
  onResetHealth: (provider: ProviderItem) => Promise<void> | void
  onDelete: (provider: ProviderItem) => Promise<void> | void
  onToggleRouting: (provider: ProviderItem) => Promise<void> | void
  onPriorityChange: (provider: ProviderItem, nextPriority: number) => Promise<void> | void
  onShowProbeLogs: (provider: ProviderItem) => void
  canResetHealth?: boolean
  canDelete?: boolean
}

const CAPABILITY_LABELS: Record<string, string> = {
  chat: '文本',
  embedding: 'Embedding',
  vision: '视觉',
  asr: '语音',
  tts: '语音',
  image_gen: '图片',
  video_gen: '视频',
  audio_gen: '音频',
}

const SCOPE_BADGE: Record<ProviderScope, { label: string; cls: string }> = {
  global: {
    label: 'global',
    cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  },
  organization: {
    label: 'organization',
    cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  },
  user: {
    label: 'user',
    cls: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
  },
}

const HEALTH_ICON: Record<string, { icon: string; cls: string; label: string }> = {
  healthy: { icon: '✓', cls: 'text-green-600', label: '健康' },
  degraded: { icon: '⚠', cls: 'text-yellow-600', label: '降级' },
  unhealthy: { icon: '✗', cls: 'text-red-500', label: '异常' },
  unknown: { icon: '–', cls: 'text-muted-foreground', label: '未知' },
}

function ScopeBadge({ scope }: { scope: ProviderScope }) {
  const cfg = SCOPE_BADGE[scope]
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-caption font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  )
}

function ByokBadge() {
  return (
    <span
      title="此 Provider scope!=global，作为 BYOK 凭据仅在主对话生命周期内生效（路线 B）"
      className="ml-1 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
    >
      BYOK
    </span>
  )
}

function CapabilityBadges({ domains }: { domains?: string[] }) {
  if (!domains?.length) {
    return <span className="text-caption text-muted-foreground">—</span>
  }
  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {domains.map((domain) => (
        <span
          key={domain}
          title={domain}
          className="inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          {CAPABILITY_LABELS[domain] ?? domain}
        </span>
      ))}
    </div>
  )
}

function HealthCell({ provider }: { provider: ProviderItem }) {
  const cfg = HEALTH_ICON[provider.runtime_status] || HEALTH_ICON.unknown
  const last = provider.health_last_checked_at
    ? new Date(provider.health_last_checked_at).toLocaleString('zh-CN')
    : '—'
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`最近探测：${last}\n最近错误：${provider.health_last_error || '无'}`}
    >
      <span className={`text-body font-medium ${cfg.cls}`}>
        {cfg.icon} {cfg.label}
      </span>
      {provider.health_last_latency_ms != null && (
        <span className="text-[10px] text-muted-foreground">
          {provider.health_last_latency_ms}ms
        </span>
      )}
    </div>
  )
}

interface PriorityInlineProps {
  provider: ProviderItem
  onPriorityChange: (provider: ProviderItem, nextPriority: number) => Promise<void> | void
  busy: boolean
}

function PriorityInline({ provider, onPriorityChange, busy }: PriorityInlineProps) {
  const [draft, setDraft] = useState<string>(String(provider.priority))
  const handleCommit = async () => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next === provider.priority) {
      setDraft(String(provider.priority))
      return
    }
    await onPriorityChange(provider, next)
  }
  return (
    <input
      type="number"
      value={draft}
      disabled={busy}
      className="w-16 rounded border px-1 py-0.5 text-center text-caption bg-background"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export function ProviderTable({
  providers,
  onOpenDetail,
  onOpenKeys,
  onEdit,
  onProbed,
  onProbeError,
  onResetHealth,
  onDelete,
  onToggleRouting,
  onPriorityChange,
  onShowProbeLogs,
  canResetHealth = true,
  canDelete = true,
}: ProviderTableProps) {
  const [actionBusyId, setActionBusyId] = useState<string | null>(null)

  const wrap = async (id: string, fn: () => Promise<void> | void) => {
    setActionBusyId(id)
    try {
      await fn()
    } finally {
      setActionBusyId(null)
    }
  }

  if (providers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-8 text-center text-muted-foreground text-body">
        暂无匹配 Provider
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-3 py-3 text-left font-medium">Provider</th>
            <th className="px-3 py-3 text-left font-medium">状态</th>
            <th className="px-3 py-3 text-left font-medium">支持能力</th>
            <th className="px-3 py-3 text-center font-medium">模型数</th>
            <th className="px-3 py-3 text-left font-medium">Key 状态</th>
            <th className="px-3 py-3 text-center font-medium">最近健康检查</th>
            <th className="px-3 py-3 text-left font-medium">更新时间</th>
            <th className="px-3 py-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => {
            const busy = actionBusyId === p.id
            return (
              <tr key={p.id} className="border-b hover:bg-muted/20 transition-colors">
                <td className="px-3 py-3">
                  <div className="flex items-center">
                    <button
                      type="button"
                      className="text-left font-medium hover:text-primary"
                      onClick={() => onOpenDetail(p)}
                    >
                      {p.display_name}
                    </button>
                    {p.scope !== 'global' && <ByokBadge />}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                      {p.provider_key}
                    </code>
                    <ScopeBadge scope={p.scope} />
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <HealthCell provider={p} />
                    <label className="inline-flex cursor-pointer items-center" title="是否参与路由">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={p.routing_enabled}
                        onChange={() => wrap(p.id, () => onToggleRouting(p))}
                        disabled={busy}
                      />
                      <span className="relative block h-4 w-8 rounded-full bg-slate-300 transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-50">
                        <span className="absolute left-0.5 top-0.5 block h-3 w-3 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                      </span>
                    </label>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <CapabilityBadges domains={p.capability_domains} />
                </td>
                <td className="px-3 py-3 text-center tabular-nums">{p.model_count}</td>
                <td className="px-3 py-3">
                  <div className="text-caption">
                    {p.api_key_masked ? (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {p.api_key_masked}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">未配置</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3 text-center text-caption text-muted-foreground">
                  {p.health_last_checked_at
                    ? new Date(p.health_last_checked_at).toLocaleString('zh-CN')
                    : '—'}
                </td>
                <td className="px-3 py-3 text-caption text-muted-foreground">
                  {new Date(p.updated_at).toLocaleString('zh-CN')}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
                      onClick={() => onOpenDetail(p)}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-violet-700 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors"
                      onClick={() => onOpenKeys(p)}
                    >
                      Key
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
                      onClick={() => onEdit(p)}
                      disabled={busy}
                    >
                      编辑
                    </button>
                    <ProbeButton
                      provider={p}
                      onProbed={(refreshed, result) => onProbed(refreshed, result)}
                      onError={(msg) => onProbeError?.(msg)}
                    />
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-cyan-700 hover:bg-cyan-100 dark:hover:bg-cyan-900/40 transition-colors"
                      onClick={() => onShowProbeLogs(p)}
                      disabled={busy}
                    >
                      日志
                    </button>
                    {canResetHealth ? (
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
                        onClick={() => wrap(p.id, () => onResetHealth(p))}
                        disabled={busy}
                      >
                        重置
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-red-600 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                        onClick={() => wrap(p.id, () => onDelete(p))}
                        disabled={busy}
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-1 flex justify-end">
                    <PriorityInline provider={p} onPriorityChange={onPriorityChange} busy={busy} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
