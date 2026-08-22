type Translate = (key: string, options?: Record<string, unknown>) => string

// SYNC: Backend _classify_agent_error() in chat_service.py — keep categories aligned
const ERROR_CODE_MAP: Record<string, string> = {
  device_offline: 'errors.deviceOfflineHint',
  device_busy: 'errors.deviceBusyHint',
  owner_execution_device_unavailable: 'errors.ownerExecutionUnavailableHint',
  review_required: 'messages.reviewRequired',
  safety_terminated: 'messages.safetyTerminated',
  empty_reply: 'messages.emptyReply',
  ask_user: 'messages.askUser',
  queued: 'messages.queued',
  cancelled: 'errors.cancelled',
  context_overflow: 'errors.contextOverflow',
  llm_timeout: 'errors.llmTimeout',
  tool_timeout: 'errors.toolTimeout',
  tool_exec: 'errors.toolExec',
  llm_call: 'errors.llmCall',
  persist_error: 'errors.persistError',
  rate_limited: 'errors.rateLimited',
  auth_error: 'errors.authError',
  process_timeout: 'errors.processTimeout',
  unknown: 'errors.unknown',
}

export function localizeErrorContent(
  content: string,
  t: Translate,
): string {
  const match = content.match(/^\[(\w+)\]\s*(.*)$/s)
  if (!match) return content
  const [, code, fallback] = match
  const i18nKey = ERROR_CODE_MAP[code]
  if (!i18nKey) return fallback || content
  const localized = t(i18nKey, { defaultValue: '' })
  return localized || fallback
}

export function sanitizeErrorContent(
  content: string,
  isError: boolean,
  t: Translate,
): string {
  if (!isError) return content
  if (/API\s*Key/i.test(content)) {
    return t('systemNotice.channelUnavailable', { defaultValue: '当前渠道暂时不可用，请稍后重试' })
  }
  return content
}
