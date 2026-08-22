import { getNestedArgs } from '../registry/toolCardUtils'

function describeToolStep(input: unknown): string | undefined {
  const args = getNestedArgs(input)
  const description = args?.description
  return typeof description === 'string' && description.trim()
    ? description.trim()
    : undefined
}

/** `finalized` 的中断兜底态仍可能只含不完整参数，不能用于生成用户可见摘要。 */
export function isCompleteToolInput(finalized: boolean, partial: boolean): boolean {
  return finalized && !partial
}

/**
 * 参数还在流式生成时，partial JSON 的解析结果可能在对象和原始字符串之间切换。
 * 折叠行只显示稳定的工具名；参数封口后才一次性升级为完整的可读摘要。
 */
export function getCollapsedToolLabel({
  input,
  inputFinalized,
  compactSummary,
  intent,
  fallbackLabel,
}: {
  input: unknown
  inputFinalized: boolean
  compactSummary: string | null
  intent?: string | null
  fallbackLabel: string
}): string {
  if (!inputFinalized) return intent ?? fallbackLabel
  const description = describeToolStep(input)
  if (description && intent) return intent
  return description ?? compactSummary ?? intent ?? fallbackLabel
}
