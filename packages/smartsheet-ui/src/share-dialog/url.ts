export function buildShareUrl(shareId?: string, shareUrlPrefix?: string): string {
  if (!shareId || !shareUrlPrefix) return ''
  return `${shareUrlPrefix}${shareId}`
}
