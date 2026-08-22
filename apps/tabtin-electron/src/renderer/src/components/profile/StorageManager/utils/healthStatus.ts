/**
 * healthStatus — 把"总占用字节"翻译成用户能立即理解的健康档位 + 语气文案。
 *
 * 设计取舍（2026-05 减压重设）：
 *   - 不引入磁盘总容量 / 剩余容量 IPC——避免为一个文案数字改 storage-manager 包结构
 *     （未来真要做"磁盘还剩 X GB"再引入也不晚）。
 *   - 用 4 档纯字节阈值，让用户一眼知道"是否该担心"——对应性能面板的
 *     severity（healthy / attention / heavy），都是"状态先行"的设计。
 *   - 文案走拟人化（"还能用很久" / "该清了"），不写"低 / 中 / 高"这种工程化词。
 *
 * 与性能面板 ResourceMonitor 的呼应：
 *   - severity = 'healthy' | 'attention' | 'heavy' 命名严格对齐
 *   - 颜色 token 复用 success / warning / destructive
 *   - 文案风格："一切从容，安心创作吧" → "还能用很久，专心创作就好"
 */

/** 健康档位——对齐性能面板 severity 命名 */
export type StorageHealthLevel = 'healthy' | 'attention' | 'heavy' | 'critical'

export interface StorageHealthVerdict {
  level: StorageHealthLevel
  /** 一句话状态标签，如 "充裕" / "适度" / "偏多" / "该清了" */
  label: string
  /** 一句拟人化的安抚 / 提示，如 "还能用很久，专心创作吧" */
  tagline: string
}

/**
 * 阈值——单位字节，1024 进制（对齐 formatBytes）。
 *
 * 取值依据：
 *   - 500 MB 是"开始能感知到"的水位线（普通笔记本一两个月用量）
 *   - 5 GB 开始出现"对话+录屏"混合大头
 *   - 20 GB 大概率是录屏 / 项目快照失控
 *
 * 调整时务必同步 i18n 阈值描述文案（避免文案与判定漂移）。
 */
const HEALTHY_CEILING = 500 * 1024 * 1024 // 500 MB
const ATTENTION_CEILING = 5 * 1024 * 1024 * 1024 // 5 GB
const HEAVY_CEILING = 20 * 1024 * 1024 * 1024 // 20 GB

/**
 * 把总字节数翻译成健康档位。
 *
 * 注意 label / tagline 这里返回的是 i18n key 提示而不是字面量——调用方
 * 用 `t(verdict.label)` 渲染。这样测试能脱离 i18n 跑（直接断言 level），
 * 且翻译可以加 zh/en 双语。
 *
 * Key 约定：`storage-manager.json` 下 `health.{level}.label` / `health.{level}.tagline`
 */
export function classifyStorageHealth(totalBytes: number): StorageHealthVerdict {
  let level: StorageHealthLevel
  if (totalBytes < HEALTHY_CEILING) level = 'healthy'
  else if (totalBytes < ATTENTION_CEILING) level = 'attention'
  else if (totalBytes < HEAVY_CEILING) level = 'heavy'
  else level = 'critical'

  return {
    level,
    label: `health.${level}.label`,
    tagline: `health.${level}.tagline`,
  }
}

/**
 * 状态色点的 Tailwind 类——与 ResourceMonitorPanel.severityDotColor 保持视觉
 * 一致（healthy=success, attention=warning, heavy/critical=destructive）。
 */
export const HEALTH_DOT_COLOR: Record<StorageHealthLevel, string> = {
  healthy: 'bg-success',
  attention: 'bg-foreground/60',
  heavy: 'bg-warning',
  critical: 'bg-destructive',
}

/** 状态文字的颜色——critical 用 destructive，其他用 foreground 让视线不被红字带跑 */
export const HEALTH_LABEL_COLOR: Record<StorageHealthLevel, string> = {
  healthy: 'text-success',
  attention: 'text-foreground',
  heavy: 'text-foreground',
  critical: 'text-destructive',
}
