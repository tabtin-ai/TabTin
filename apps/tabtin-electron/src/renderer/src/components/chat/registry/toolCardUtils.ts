/**
 * toolCardUtils — 工具卡片注册表的共享辅助函数
 */

export { basename } from '../utils/path'

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

export function getNestedArgs(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  return (obj.kwargs as Record<string, unknown>) ?? obj
}

export function unwrapData(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object') return {}
  const obj = output as Record<string, unknown>
  const inner = obj.data
  return (inner && typeof inner === 'object' ? inner : obj) as Record<string, unknown>
}

export function unwrapStringOrData(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const d = (output as Record<string, unknown>).data
    if (typeof d === 'string') return d
  }
  return null
}
