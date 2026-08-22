/**
 * Provider 品牌标：优先 Electron 内置 SVG，未知 key 再回退 Catalog API。
 */
import React, { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@utils/cn'
import { getProviderIconKey, getProviderIconUrl, buildProviderIconUrlByKey } from '@/utils/provider-registry'
import { getBundledProviderIconUrl } from '@/utils/provider-icon-bundled'
import { API_BASE_URL } from '@/config/api'

function resolveProviderAssetUrl(iconUrl: string): string {
  if (!iconUrl) return ''
  if (/^https?:\/\//i.test(iconUrl) || iconUrl.startsWith('data:')) return iconUrl
  // API_BASE_URL 形如 http://host:6060/api；icon_url 多为 /api/services/llm/...
  const origin = API_BASE_URL.replace(/\/api\/?$/, '')
  return `${origin}${iconUrl.startsWith('/') ? iconUrl : `/${iconUrl}`}`
}

export interface ProviderLogoProps {
  /** Catalog provider id（如 ``moonshot``） */
  provider?: string
  /** 直接指定 icon stem（如 ``kimi``）；优先于 provider */
  iconKey?: string
  className?: string
}

export function ProviderLogo({ provider, iconKey, className }: ProviderLogoProps) {
  const resolvedKey = iconKey?.trim()
    || (provider ? getProviderIconKey(provider) : '')
  const bundledUrl = resolvedKey ? getBundledProviderIconUrl(resolvedKey) : ''
  const remoteUrl = bundledUrl
    ? ''
    : resolveProviderAssetUrl(
      resolvedKey
        ? buildProviderIconUrlByKey(resolvedKey)
        : (provider ? getProviderIconUrl(provider) : ''),
    )
  const [displayUrl, setDisplayUrl] = useState(bundledUrl)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (bundledUrl) {
      setFailed(false)
      setDisplayUrl(bundledUrl)
      return
    }

    let cancelled = false
    let objectUrl = ''

    setFailed(false)
    setDisplayUrl('')

    if (!remoteUrl) {
      setFailed(true)
      return
    }

    if (remoteUrl.startsWith('data:')) {
      setDisplayUrl(remoteUrl)
      return
    }

    ;(async () => {
      try {
        const response = await fetch(remoteUrl)
        if (!response.ok) throw new Error(`icon http ${response.status}`)
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setDisplayUrl(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [bundledUrl, remoteUrl])

  const cls = cn('h-4 w-4 shrink-0 object-contain', className)

  if (failed || !displayUrl) {
    return <Bot className={cn(cls, 'text-muted-foreground')} strokeWidth={1.75} aria-hidden />
  }

  return (
    <img
      src={displayUrl}
      alt=""
      className={cls}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
