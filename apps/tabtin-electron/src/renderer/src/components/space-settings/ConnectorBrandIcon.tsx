/**
 * 连接器市场品牌标：经 registry resolver 解析，无命中则 Plug。
 * 新增品牌只改 `@tabtin/connector-brand-icons`，不要在此写死映射。
 */
import React, { useMemo } from 'react'
import { Plug } from 'lucide-react'
import {
  resolveConnectorBrandIconFromRegistry,
  type ConnectorBrandIconQuery,
} from '@tabtin/connector-brand-icons'
import { cn } from '@utils/cn'
import { getBundledConnectorBrandIconUrl } from '@/utils/connector-brand-icon-bundled'

export interface ConnectorBrandIconProps {
  query: ConnectorBrandIconQuery
  className?: string
  /** 外层槽尺寸（默认对齐市场卡 34）。 */
  size?: number
  iconClassName?: string
}

export function ConnectorBrandIcon({
  query,
  className,
  size = 34,
  iconClassName,
}: ConnectorBrandIconProps) {
  const resolved = useMemo(() => resolveConnectorBrandIconFromRegistry(query), [query])
  const url = resolved ? getBundledConnectorBrandIconUrl(resolved.brandKey) : ''

  // 单层芯片：品牌标与 Plug 共用同一圆角底，避免「灰底套白底 / 形状不一致」。
  const glyphPx = Math.max(14, Math.round(size * 0.58))

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[8px] bg-foreground/[0.04] text-primary-text',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {url ? (
        <img
          src={url}
          alt=""
          className={cn('object-contain', iconClassName)}
          style={iconClassName ? undefined : { width: glyphPx, height: glyphPx }}
          draggable={false}
        />
      ) : (
        <Plug
          className={iconClassName}
          style={iconClassName ? undefined : { width: glyphPx, height: glyphPx }}
          strokeWidth={1.6}
        />
      )}
    </span>
  )
}

/** 从推荐货架条目拼 resolver 输入（不把 iconKey 写进 catalog）。 */
export function brandIconQueryFromRecommended(entry: {
  id: string
  name: string
  docsUrl?: string
  credentialUrl?: string
  transport: { kind: string; args?: string[]; url?: string }
}): ConnectorBrandIconQuery {
  const endpointUrl =
    entry.transport.kind === 'http'
      ? entry.transport.url
      : entry.transport.args?.find(arg => /^https?:\/\//i.test(arg))
  return {
    catalogId: entry.id,
    name: entry.name,
    // 不把 docsUrl / credentialUrl 交给图标解析：文档常在 GitHub，会误命中 GitHub 标。
    endpointUrl,
    commandArgs: entry.transport.kind === 'stdio' ? entry.transport.args : undefined,
  }
}

export function brandIconQueryFromConnection(connection: {
  name: string
  url?: string | null
  command?: string | null
  args?: string[] | null
}): ConnectorBrandIconQuery {
  return {
    name: connection.name,
    endpointUrl: connection.url ?? undefined,
    commandArgs: connection.args ?? undefined,
  }
}
