import type {
  ResourceMonitorTabDocRuntimeView,
  ResourceMonitorTrackedItem,
} from './model'
import type {
  ResourceMonitorGovernanceFeedbackItem,
  ResourceMonitorHistoryTrendSummary,
} from './history'
import type { ResourceMonitorSeverityLevel } from './severity'
import i18n from '@/i18n'

// ────────────────────────────────────────────────────────────────────────────
// Byte / number formatters
// ────────────────────────────────────────────────────────────────────────────

export const formatBytes = (value: number): string => {
  const safe = Math.max(0, value)
  if (safe >= 1024 * 1024 * 1024) return `${(safe / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (safe >= 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(0)} MB`
  return `${Math.round(safe / 1024)} KB`
}

export const formatBytesCompact = (value: number): string => {
  const safe = Math.max(0, value)
  if (safe >= 1024 * 1024 * 1024) return `${(safe / (1024 * 1024 * 1024)).toFixed(1)}G`
  if (safe >= 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(0)}M`
  return `${Math.round(safe / 1024)}K`
}

export const formatCpu = (value: number): string => `${Math.round(Math.max(0, value))}%`
export const formatPercent = (value: number): string => `${Math.max(0, value).toFixed(1)}%`
export const formatCount = (value: number): string => Math.max(0, Math.round(value)).toLocaleString(i18n.language)

export const formatLatency = (value: number | null): string => {
  if (value == null) return '待采样'
  return `${Math.round(Math.max(0, value))} ms`
}

export const formatSnapshotTime = (value: number | null): string => {
  if (value == null || value <= 0) return '未采集'
  return new Date(value).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export const formatDuration = (value: number | null): string => {
  if (value == null || value <= 0) return '0s'
  if (value >= 60 * 1000) return `${Math.round(value / (60 * 1000))}m`
  return `${Math.round(value / 1000)}s`
}

// ────────────────────────────────────────────────────────────────────────────
// List / label formatters
// ────────────────────────────────────────────────────────────────────────────

export const formatInlineList = (values: string[], limit = 3): string => {
  const normalized = values.map((v) => v.trim()).filter(Boolean)
  if (normalized.length === 0) return ''
  if (normalized.length <= limit) return normalized.join('、')
  return `${normalized.slice(0, limit).join('、')} 等 ${normalized.length} 项`
}

export const describeBrowserGovernanceReason = (item: ResourceMonitorTrackedItem): string => {
  const parts: string[] = []
  if (item.browserMeta && !item.browserMeta.attachedToMainWindow) parts.push('脱屏')
  if (item.browserMeta?.isPreview) parts.push('预览态')
  if (parts.length === 0) parts.push('空闲')
  return parts.join(' · ')
}

export const formatGovernanceFeedbackList = (
  items: ResourceMonitorGovernanceFeedbackItem[],
  options?: { includeError?: boolean; limit?: number },
): string => {
  const limit = options?.limit ?? 3
  const labels = items.map((item) => {
    const suffix = options?.includeError && item.error
      ? `（${item.reason}，${item.error}）`
      : `（${item.reason}）`
    return `${item.title}${suffix}`
  })
  return formatInlineList(labels, limit)
}

// ────────────────────────────────────────────────────────────────────────────
// Domain-specific label formatters
// ────────────────────────────────────────────────────────────────────────────

export const formatPressureLabel = (value: string): string => {
  switch (value) {
    case 'warning': return '预警'
    case 'critical': return '高压'
    case 'emergency': return '紧急'
    default: return '正常'
  }
}

export const formatMemorySource = (value: string): string => {
  switch (value) {
    case 'measureMemory': return '精确采样'
    case 'performance.memory': return 'Renderer Heap'
    case 'heuristic': return '估算'
    default: return '待采集'
  }
}

export const describeOwnerStrategy = (value: string | null | undefined): string => {
  switch (value) {
    case 'active-pane': return '归属到最近活跃 pane'
    case 'visible-pane': return '归属到当前可见 pane'
    case 'recent-update': return '归属到最近更新 pane'
    case 'none': return '无有效归属（加载中或异常）'
    default: return '未归因'
  }
}

/** @deprecated 用 describeOwnerStrategy 代替 */
export const describeDocOwnerStrategy = describeOwnerStrategy
/** @deprecated 用 describeOwnerStrategy 代替 */
export const describeDataOwnerStrategy = describeOwnerStrategy

export const formatDocSaveState = (value: ResourceMonitorTabDocRuntimeView['saveState']): string => {
  switch (value) {
    case 'dirty': return '待保存'
    case 'saving': return '保存中'
    case 'saved': return '已保存'
    case 'error': return '保存失败'
    default: return '空闲'
  }
}

export const describeTrend = (trend: ResourceMonitorHistoryTrendSummary, kind: 'memory' | 'cpu'): string => {
  if (trend.direction === 'insufficient') return '样本不足'
  if (trend.direction === 'steady') return '平稳'
  const delta = Math.abs(trend.delta ?? 0)
  const deltaLabel = kind === 'memory' ? formatBytes(delta) : formatCpu(delta)
  return `${trend.direction === 'up' ? '上升' : '下降'} ${deltaLabel}`
}

// ────────────────────────────────────────────────────────────────────────────
// Style maps
// ────────────────────────────────────────────────────────────────────────────

export const severityClasses: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'border-success/30 bg-success/10 text-success',
  attention: 'border-warning/30 bg-warning/10 text-warning',
  heavy: 'border-destructive/30 bg-destructive/10 text-destructive',
}

export const severitySurfaceClasses: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'border-success/20 bg-success/5',
  attention: 'border-warning/20 bg-warning/5',
  heavy: 'border-destructive/20 bg-destructive/5',
}

export const severityDotClasses: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'bg-success',
  attention: 'bg-warning',
  heavy: 'bg-destructive',
}

export const severityTextClasses: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'text-success',
  attention: 'text-warning',
  heavy: 'text-destructive',
}

export const itemStatusClasses: Record<ResourceMonitorTrackedItem['status'], string> = {
  active: 'bg-success',
  loading: 'bg-info',
  idle: 'bg-warning',
  closed: 'bg-muted-foreground/60',
}

export const trendClasses: Record<ResourceMonitorHistoryTrendSummary['direction'], string> = {
  up: 'border-warning/30 bg-warning/10 text-warning',
  down: 'border-info/30 bg-info/10 text-info',
  steady: 'border-border/40 bg-muted/10 text-muted-foreground',
  insufficient: 'border-border/40 bg-muted/10 text-muted-foreground',
}
