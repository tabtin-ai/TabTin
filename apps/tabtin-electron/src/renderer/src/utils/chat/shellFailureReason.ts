type Translate = (key: string, options?: Record<string, unknown>) => string

export function getShellFailureReason(t: Translate, exitCode: number | null | undefined): string | null {
  switch (exitCode) {
    case 126:
      return t('card.failure_reason_not_executable', { defaultValue: '命令不可执行' })
    case 127:
      return t('card.failure_reason_not_found', { defaultValue: '找不到命令' })
    case 130:
      return t('card.failure_reason_interrupted', { defaultValue: '命令已中断' })
    case null:
    case undefined:
      return null
    default:
      return t('card.failure_reason_generic', { defaultValue: '命令执行失败' })
  }
}

export function getShellFailureLabel(t: Translate, exitCode: number | null | undefined): string {
  const reason = getShellFailureReason(t, exitCode)
  return reason
    ? t('card.failed_with_reason', { reason, defaultValue: '失败：{{reason}}' })
    : t('card.failed', { defaultValue: '失败' })
}
