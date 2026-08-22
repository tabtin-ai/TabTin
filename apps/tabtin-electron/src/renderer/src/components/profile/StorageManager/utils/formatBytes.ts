export function formatBytes(bytes: number, locale = 'zh-CN'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIdx = 0
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024
    unitIdx += 1
  }
  const formatted = value < 10 && unitIdx > 0 ? value.toFixed(1) : Math.round(value).toString()
  void locale
  return `${formatted} ${units[unitIdx]}`
}
