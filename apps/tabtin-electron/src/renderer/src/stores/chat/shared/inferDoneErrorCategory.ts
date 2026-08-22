const DONE_BILLING_ERROR_CLASSES = new Set(['LLM_BILLING_ERROR', 'MAX_CREDITS_EXCEEDED'])

/** 从 DONE metadata 推断计费 / 预算错误类目（供 stream finalizer / 测试）。 */
export function inferDoneErrorCategory(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  const explicitCategory = (
    metadata.error_category
    ?? metadata.errorCategory
    ?? (metadata.error_metadata as Record<string, unknown> | undefined)?.errorCategory
    ?? (metadata.error_metadata as Record<string, unknown> | undefined)?.error_category
  )
  if (typeof explicitCategory === 'string' && explicitCategory.trim()) return explicitCategory

  const errorClass = typeof metadata.error_class === 'string' ? metadata.error_class : ''
  if (!DONE_BILLING_ERROR_CLASSES.has(errorClass)) return undefined

  const message = String(metadata.error_message ?? metadata.errorMessage ?? '')
  if (/organization_insufficient_credits|组织钱包余额不足|组织钱包不足|点券(?:已用完|不足)|wallet_insufficient/i.test(message)) {
    return 'organization_insufficient_credits'
  }
  if (/budget|预算/i.test(message)) {
    return 'budget_exceeded'
  }
  if (errorClass === 'MAX_CREDITS_EXCEEDED') {
    return 'budget_exceeded'
  }
  return 'billing'
}
