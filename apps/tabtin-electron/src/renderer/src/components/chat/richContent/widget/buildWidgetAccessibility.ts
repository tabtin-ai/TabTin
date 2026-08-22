export function buildWidgetAccessibility(params: {
  isInterrupted: boolean
  isStreaming: boolean
  finalCode: string
  summary?: string
  title?: string
  widgetTypeLabel: string
  t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string
}): { ariaLabel: string; liveAnnouncement: string } {
  const summaryLabel = params.summary || params.title || params.widgetTypeLabel
  const statePrefix = params.isInterrupted
    ? params.t('richContent.statePrefixInterrupted', { defaultValue: '（已中断）' })
    : params.isStreaming && !params.finalCode
      ? params.t('richContent.statePrefixStreaming', { defaultValue: '（生成中）' })
      : ''
  const ariaLabel = `${params.widgetTypeLabel}${statePrefix}：${summaryLabel}`
  const liveAnnouncement = params.isInterrupted
    ? `${params.t('richContent.widgetInterrupted', { defaultValue: '已中断' })}：${summaryLabel}`
    : params.finalCode
      ? `${params.t('richContent.widgetComplete', { defaultValue: '完成' })}：${summaryLabel}`
      : ''
  return { ariaLabel, liveAnnouncement }
}
