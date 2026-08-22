/**
 * `CapabilityBadges` — 模型能力快速标识（宪法 07 §1.3.2）。
 *
 * 从 `model.capabilities_config` 读真实开关，依次显示 5 个 badge：
 *
 * | Badge | 来源字段                                           | 含义        |
 * |-------|----------------------------------------------------|-------------|
 * | ⚡    | capabilities_config.tool.enabled                   | 工具调用    |
 * | 👁    | capabilities_config.image.enabled                  | 视觉输入    |
 * | 🎯    | capabilities_config.json_mode.modes (非空)         | 结构化输出  |
 * | 🔄    | capabilities_config.wire.stream_supported          | 流式        |
 * | 📝    | capabilities_config.caching.mode (≠ 'none')        | 提示词缓存  |
 *
 * 设计原则：
 * - 只读 capabilities_config，不读 resolved_capabilities（后者是兼容老代码的派生）
 * - 关闭的 badge 显示为灰色不亮，让运营一眼看出「哪些能力没开」
 * - 统一图标+文本，不只画 emoji（无障碍 + 国际化）
 */

import { cn } from '@/lib/utils'

interface CapabilityBadgesProps {
  capabilitiesConfig: Record<string, unknown>
  /** 紧凑模式仅显示已开启的能力（用于列表行避免列宽爆炸） */
  compact?: boolean
  className?: string
}

interface CapabilityBadgeSpec {
  key: string
  emoji: string
  label: string
  enabled: boolean
}

function readNested(cfg: Record<string, unknown>, path: [string, string]): unknown {
  const top = cfg[path[0]]
  if (top && typeof top === 'object') {
    return (top as Record<string, unknown>)[path[1]]
  }
  return undefined
}

export function deriveCapabilityBadges(
  capabilitiesConfig: Record<string, unknown> | null | undefined
): CapabilityBadgeSpec[] {
  const cfg = capabilitiesConfig || {}

  const toolEnabled = readNested(cfg, ['tool', 'enabled']) === true
  const imageEnabled = readNested(cfg, ['image', 'enabled']) === true
  const jsonModes = readNested(cfg, ['json_mode', 'modes'])
  const jsonEnabled = Array.isArray(jsonModes) && jsonModes.length > 0
  const streamEnabled = readNested(cfg, ['wire', 'stream_supported']) === true
  const cacheMode = readNested(cfg, ['caching', 'mode'])
  const cacheEnabled = typeof cacheMode === 'string' && cacheMode !== 'none' && cacheMode !== ''

  return [
    { key: 'tool', emoji: '⚡', label: '工具', enabled: toolEnabled },
    { key: 'image', emoji: '👁', label: '视觉', enabled: imageEnabled },
    { key: 'json', emoji: '🎯', label: 'JSON', enabled: jsonEnabled },
    { key: 'stream', emoji: '🔄', label: '流式', enabled: streamEnabled },
    { key: 'cache', emoji: '📝', label: '缓存', enabled: cacheEnabled },
  ]
}

export function CapabilityBadges({
  capabilitiesConfig,
  compact = false,
  className,
}: CapabilityBadgesProps) {
  const badges = deriveCapabilityBadges(capabilitiesConfig)
  const visible = compact ? badges.filter((b) => b.enabled) : badges

  if (visible.length === 0) {
    return <span className="text-caption text-muted-foreground/70 italic">未声明</span>
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {visible.map((b) => (
        <span
          key={b.key}
          title={`${b.label}：${b.enabled ? '支持' : '不支持'}`}
          className={cn(
            'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-caption font-medium select-none',
            b.enabled
              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
              : 'bg-muted/50 text-muted-foreground/60'
          )}
        >
          <span aria-hidden>{b.emoji}</span>
          <span className="text-[10px]">{b.label}</span>
        </span>
      ))}
    </div>
  )
}
