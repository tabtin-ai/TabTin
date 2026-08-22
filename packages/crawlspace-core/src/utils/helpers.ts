/**
 * 任务相关工具函数
 */

import { getCrawlspaceLocale, t, type CrawlspaceLocale } from '../i18n'

/**
 * 格式化字段名（驼峰转可读名称）
 */
function formatFieldName(field: string): string {
  const mapping: Record<CrawlspaceLocale, Record<string, string>> = {
    'zh-CN': {
      name: t('fieldName.name'),
      title: t('fieldName.title'),
      rating: t('fieldName.rating'),
      description: t('fieldName.description'),
      price: t('fieldName.price'),
      image: t('fieldName.image'),
      url: t('fieldName.url'),
      date: t('fieldName.date'),
      author: t('fieldName.author'),
      category: t('fieldName.category'),
    },
    'en-US': {
      name: t('fieldName.name'),
      title: t('fieldName.title'),
      rating: t('fieldName.rating'),
      description: t('fieldName.description'),
      price: t('fieldName.price'),
      image: t('fieldName.image'),
      url: t('fieldName.url'),
      date: t('fieldName.date'),
      author: t('fieldName.author'),
      category: t('fieldName.category'),
    }
  }

  const locale = getCrawlspaceLocale()
  return mapping[locale]?.[field] || field
}

/**
 * 自动生成字段映射
 */
export function autoMapFields(extractedFields: string[]): Array<{ source: string; target: string }> {
  return extractedFields.map((field) => ({
    source: field,
    target: formatFieldName(field),
  }))
}

/**
 * Get a random item from an array
 */
export function getRandomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)]
}

/**
 * Calculate elapsed time in milliseconds
 */
export function getElapsedTime(startTime: number): number {
  return Date.now() - startTime
}

/**
 * 格式化时长（毫秒 → 可读字符串）
 * @param ms 毫秒数
 * @returns 格式化字符串（如 "1.5秒"、"2分30秒"）
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return t('duration.milliseconds', { value: ms })
  if (ms < 60000) return t('duration.seconds', { value: (ms / 1000).toFixed(1) })
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  if (seconds === 0) return t('duration.minutes', { value: minutes })
  return t('duration.minutesSeconds', { minutes, seconds })
}

/**
 * 格式化执行时间（秒 → 可读字符串）
 * @param seconds 秒数
 * @returns 格式化字符串
 */
export function formatExecutionTime(seconds: number): string {
  if (seconds < 60) return t('duration.seconds', { value: seconds.toFixed(1) })
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (remainingSeconds === 0) return t('duration.minutes', { value: minutes })
  return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds })
}

/**
 * 格式化进度百分比
 * @param progress 进度值（0-100）
 * @returns 格式化字符串（如 "75%"）
 */
export function formatProgress(progress: number): string {
  return `${Math.round(progress)}%`
}

/**
 * 自动补全 URL（添加 https:// 前缀）
 * @param url 原始 URL
 * @returns 补全后的 URL
 */
export function autocompleteUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}`
}

/**
 * 智能导航：判断输入是 URL 还是搜索关键词
 * - 已有协议 → 直接返回
 * - 看起来像域名（包含 . 且无空格）→ 补全 https://
 * - localhost 或 IP:port → 补全 http://
 * - 其他 → 跳转 Google 搜索
 */
export function smartNavigate(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  // 已有协议
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  // 看起来像 URL (包含 . 且没有空格, 或 localhost)
  if (/^[\w\-]+(\.[\w\-]+)+/.test(trimmed) && !trimmed.includes(' ')) {
    return `https://${trimmed}`
  }
  if (trimmed.startsWith('localhost') || /^[\d.]+:\d+/.test(trimmed)) {
    return `http://${trimmed}`
  }

  // 其余当作搜索关键词
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/**
 * 判断 URL 是否为空白页（新标签、about:blank 等）。
 * 全局统一定义，toolbar / EmbeddedCrawlView / 其他消费方共用。
 */
export function isBlankLikeUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase()
  return !normalized || normalized === 'about:blank' || normalized === 'about:newtab'
}

/**
 * 验证 URL 格式
 * @param url URL 字符串
 * @returns 是否有效
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // 允许 about:blank 作为空白新标签
    if (parsed.protocol === 'about:' && parsed.pathname === 'blank') {
      return true
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
