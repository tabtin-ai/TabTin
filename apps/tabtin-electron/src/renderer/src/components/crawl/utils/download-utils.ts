/**
 * 下载模块渲染进程共享工具函数
 */

import React from 'react'
import { Film, FileText, Image, Music, Archive, File, CheckCircle2, XCircle, Pause } from 'lucide-react'
import type { DownloadItem } from '@stores/useDownloadStore'
import { formatFileSize } from '@/constants/upload'
import i18n from '@/i18n'

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function getFileIcon(name: string, mimeType: string, size: 'sm' | 'md' = 'md') {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const mime = mimeType.toLowerCase()
  const cls = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'

  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext))
    return React.createElement(Image, { className: `${cls} text-type-webhook` })
  if (mime.startsWith('video/') || ['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv'].includes(ext))
    return React.createElement(Film, { className: `${cls} text-type-agent` })
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'].includes(ext))
    return React.createElement(Music, { className: `${cls} text-success` })
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg'].includes(ext))
    return React.createElement(Archive, { className: `${cls} text-warning` })
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md'].includes(ext))
    return React.createElement(FileText, { className: `${cls} text-info` })
  return React.createElement(File, { className: `${cls} text-muted-foreground` })
}

export function getStatusIcon(status: DownloadItem['status']): React.ReactNode {
  switch (status) {
    case 'completed':
      return React.createElement(CheckCircle2, { className: 'w-4 h-4 text-success flex-shrink-0' })
    case 'interrupted':
      return React.createElement(XCircle, { className: 'w-4 h-4 text-destructive flex-shrink-0' })
    case 'cancelled':
      return React.createElement(XCircle, { className: 'w-4 h-4 text-muted-foreground flex-shrink-0' })
    case 'paused':
      return React.createElement(Pause, { className: 'w-4 h-4 text-warning flex-shrink-0' })
    default:
      return null
  }
}

export function formatSpeed(bytesPerSecond: number, formatter: (bytes: number) => string = formatFileSize): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const perSec = i18n.t('crawl:downloads.units.perSecond', { defaultValue: '/s' })
  return `${formatter(bytesPerSecond)}${perSec}`
}

export function formatRemainingTimeValue(received: number, total: number, speed: number): string {
  if (speed <= 0 || total <= 0 || total <= received) return ''
  const remainingSeconds = Math.ceil((total - received) / speed)
  const s = i18n.t('crawl:downloads.units.seconds', { defaultValue: 's' })
  const min = i18n.t('crawl:downloads.units.minutes', { defaultValue: 'min' })
  const h = i18n.t('crawl:downloads.units.hours', { defaultValue: 'h' })
  if (remainingSeconds < 60) return `${remainingSeconds}${s}`
  if (remainingSeconds < 3600) return `${Math.ceil(remainingSeconds / 60)}${min}`
  return `${Math.floor(remainingSeconds / 3600)}${h} ${Math.ceil((remainingSeconds % 3600) / 60)}${min}`
}

export function groupByDate(items: DownloadItem[]): { label: string; items: DownloadItem[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000

  const groups: Record<string, DownloadItem[]> = {}

  for (const item of items) {
    let key: string
    if (item.startTime >= today) {
      key = 'today'
    } else if (item.startTime >= yesterday) {
      key = 'yesterday'
    } else {
      const d = new Date(item.startTime)
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  }

  const result: { label: string; items: DownloadItem[] }[] = []
  if (groups.today) result.push({ label: 'today', items: groups.today })
  if (groups.yesterday) result.push({ label: 'yesterday', items: groups.yesterday })

  const otherKeys = Object.keys(groups)
    .filter(k => k !== 'today' && k !== 'yesterday')
    .sort((a, b) => b.localeCompare(a))

  for (const key of otherKeys) {
    result.push({ label: key, items: groups[key] })
  }

  return result
}
