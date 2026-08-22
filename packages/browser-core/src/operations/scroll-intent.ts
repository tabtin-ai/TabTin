/**
 * scroll 动作意图归一：把 Agent / CLI 常见字段收成内部 ScrollIntent。
 * 页面执行与位移验收见 page-scripts/scroll-runtime.ts。
 */

export type ScrollIntent =
  | { kind: 'to_end' }
  | { kind: 'to_start' }
  | { kind: 'by'; deltaY: number }

export interface ScrollIntentInput {
  value?: string | number
  direction?: string
  amount?: number
}

const DEFAULT_BY_AMOUNT = 500

function parseAmount(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10)
    if (!Number.isNaN(n)) return n
  }
  return undefined
}

function normalizeDirection(direction: unknown): 'up' | 'down' | 'top' | 'bottom' | undefined {
  if (typeof direction !== 'string') return undefined
  const d = direction.trim().toLowerCase()
  if (d === 'up' || d === 'down' || d === 'top' || d === 'bottom') return d
  return undefined
}

/**
 * 归一规则（通用，无站点语义）：
 * - value 为 bottom/max/空且无方向距离 → to_end
 * - value 为 top → to_start
 * - value 为数字 → by(该值)；若带 direction=up/down 则取符号
 * - 仅有 direction(+amount) → by(±amount|默认 500)；direction=bottom 且无 amount → to_end
 */
export function normalizeScrollIntent(input: ScrollIntentInput = {}): ScrollIntent {
  const dir = normalizeDirection(input.direction)
  const amountFromField = parseAmount(input.amount)
  const value = input.value

  const valueIsEmpty =
    value === undefined || value === null || value === '' || value === 'bottom' || value === 'max'

  if (value === 'top') {
    return { kind: 'to_start' }
  }

  if (!valueIsEmpty) {
    const parsed = parseAmount(value)
    if (parsed !== undefined) {
      if (dir === 'up' || dir === 'top') return { kind: 'by', deltaY: -Math.abs(parsed) }
      if (dir === 'down' || dir === 'bottom') return { kind: 'by', deltaY: Math.abs(parsed) }
      return { kind: 'by', deltaY: parsed }
    }
  }

  if (dir === 'up' || dir === 'top') {
    if (dir === 'top' && amountFromField === undefined) return { kind: 'to_start' }
    const amt = Math.abs(amountFromField ?? DEFAULT_BY_AMOUNT)
    return { kind: 'by', deltaY: -amt }
  }

  if (dir === 'down' || dir === 'bottom') {
    if (dir === 'bottom' && amountFromField === undefined) return { kind: 'to_end' }
    const amt = Math.abs(amountFromField ?? DEFAULT_BY_AMOUNT)
    return { kind: 'by', deltaY: amt }
  }

  if (amountFromField !== undefined) {
    return { kind: 'by', deltaY: amountFromField }
  }

  return { kind: 'to_end' }
}
