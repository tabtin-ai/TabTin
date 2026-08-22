/**
 * 资源预览工具函数 — 从 metadata 中提取缩略图/文本预览
 *
 * 供 ContextHome、CollectionsView 等多处共享使用。
 */

import type { TFunction } from 'i18next'

import { metaStr, metaNum, metaBool, metaStrArr, metaNumOr } from './metaFieldUtils'

export function extractThumbnail(
  metadata: Record<string, unknown> | null | undefined,
  itemType: string,
): string | null {
  if (!metadata) return null
  const thumbnail = metaStr(metadata, 'thumbnail')
  if (thumbnail) return thumbnail
  const thumbnailUrl = metaStr(metadata, 'thumbnail_url')
  if (thumbnailUrl) return thumbnailUrl
  const coverImage = metaStr(metadata, 'cover_image')
  if (coverImage) return coverImage
  if (itemType === 'tabdata' && metadata.icon) return null
  return null
}

export function synthesizePreview(
  metadata: Record<string, unknown> | null | undefined,
  itemType: string,
  t: TFunction,
): string | null {
  if (!metadata) return null
  switch (itemType) {
    case 'tabdata': {
      const names = metaStrArr(metadata, 'field_names')
      if (names?.length) return names.join(' | ')
      const rows = metaNumOr(metadata, 'record_count', 0)
      const fields = metaNumOr(metadata, 'field_count', 0)
      return t('context:preview.tabdata', { rows, fields })
    }
    case 'tabsite': {
      const parts: string[] = []
      const fw = metaStr(metadata, 'framework')
      if (fw === 'react') parts.push('React')
      else if (fw === 'vanilla') parts.push('HTML/JS')
      const url = metaStr(metadata, 'published_url')
      if (url) parts.push(url.replace(/^https?:\/\//, ''))
      const views = metaNum(metadata, 'total_views')
      if (views) parts.push(t('context:preview.siteViews', { count: views }))
      return parts.length > 0 ? parts.join(' · ') : null
    }
    case 'tabcode': {
      const git = metaStr(metadata, 'gitRemoteUrl')
      if (git) {
        let repo = git.replace(/\/$/, '').split('/').pop() || ''
        if (repo.endsWith('.git')) repo = repo.slice(0, -4)
        if (repo) return repo
      }
      const local = metaStr(metadata, 'localPath')
      if (local) return local.replace(/\/$/, '').split('/').pop() || null
      return null
    }
    case 'tabfolder': {
      const p = metaStr(metadata, 'path')
      return p ? p.replace(/\/$/, '').split('/').pop() || null : null
    }
    case 'tabtracker': {
      const parts: string[] = []
      const s = metaStr(metadata, 'status')
      if (s) {
        const key = `context:preview.goalStatus.${s}`
        const label = t(key)
        if (label !== key) parts.push(label)
      }
      const tt = metaStr(metadata, 'trigger_type')
      if (tt) {
        const triggerKey = `tabtracker:trigger.${tt}`
        const triggerLabel = t(triggerKey)
        parts.push(triggerLabel !== triggerKey ? triggerLabel : tt)
      }
      return parts.length > 0 ? parts.join(' · ') : null
    }
    case 'tins': {
      if (metaBool(metadata, 'is_enabled') === false) return t('context:preview.tinsDisabled')
      return t('context:preview.tinsPlugin')
    }
    default:
      return null
  }
}
