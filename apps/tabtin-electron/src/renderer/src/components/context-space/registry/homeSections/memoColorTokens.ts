/**
 * Memo 颜色 token —— 单一数据源。
 *
 * 便签的颜色语义在两处使用：
 *   - 卡片渐变背景 (HomeGridCard.tsx → `cardGradient`)
 *   - 封面预览色条/色点 (StructuredPreviews.tsx → `dot`)
 *
 * 新增颜色时只需在此文件添加一行。
 */

export type MemoColorKey = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange' | 'red' | 'gray'

export const MEMO_COLOR_TOKENS: Record<MemoColorKey, { dot: string; cardGradient: string }> = {
  yellow: {
    dot:          'bg-yellow-400/40',
    cardGradient: 'from-yellow-400/25 to-yellow-500/10 dark:from-yellow-400/20 dark:to-yellow-500/8',
  },
  green: {
    dot:          'bg-emerald-400/40',
    cardGradient: 'from-emerald-400/25 to-emerald-500/10 dark:from-emerald-400/20 dark:to-emerald-500/8',
  },
  blue: {
    dot:          'bg-blue-400/40',
    cardGradient: 'from-blue-400/25 to-blue-500/10 dark:from-blue-400/20 dark:to-blue-500/8',
  },
  pink: {
    dot:          'bg-pink-400/40',
    cardGradient: 'from-pink-400/25 to-pink-500/10 dark:from-pink-400/20 dark:to-pink-500/8',
  },
  purple: {
    dot:          'bg-purple-400/40',
    cardGradient: 'from-purple-400/25 to-purple-500/10 dark:from-purple-400/20 dark:to-purple-500/8',
  },
  orange: {
    dot:          'bg-orange-400/40',
    cardGradient: 'from-orange-400/25 to-orange-500/10 dark:from-orange-400/20 dark:to-orange-500/8',
  },
  red: {
    dot:          'bg-red-400/40',
    cardGradient: 'from-red-400/25 to-red-500/10 dark:from-red-400/20 dark:to-red-500/8',
  },
  gray: {
    dot:          'bg-slate-400/40',
    cardGradient: 'from-slate-400/25 to-slate-500/10 dark:from-slate-400/20 dark:to-slate-500/8',
  },
}

export function getMemoTokenDot(color: string): string {
  return (MEMO_COLOR_TOKENS as Record<string, { dot: string }>)[color]?.dot ?? 'bg-foreground/20'
}

export function getMemoTokenGradient(color: string, fallback: string): string {
  return (MEMO_COLOR_TOKENS as Record<string, { cardGradient: string }>)[color]?.cardGradient ?? fallback
}
