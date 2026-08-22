import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Check, Copy, ExternalLink, HelpCircle } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

export interface EntityReference {
  type: string
  id?: string | null
  label?: string | null
  metadata?: Record<string, unknown> | null
}

interface EntityLinkProps extends EntityReference {
  className?: string
  compact?: boolean
  showType?: boolean
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  user: 'User',
  organization: 'Organization',
  space: 'Space',
  resource: 'Resource',
  document: 'Document',
  table: 'Table',
  slide: 'Slide',
  asset: 'Asset',
  billing_event: 'Billing Event',
  credit_ledger: 'Credit Ledger',
  invoice: 'Invoice',
  provider: 'Provider',
  model: 'Model',
  scene: 'Scene',
  trace: 'Trace',
  tool: 'Tool',
  app: 'App',
  connect: 'Connect',
  device: 'Device',
  session: 'Session',
  admin_account: 'Admin Account',
  sensitive_action: 'Sensitive Action',
}

function shortId(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(4, maxLength - 5))}...${value.slice(-4)}`
}

function buildEntityHref(type: string, id: string): string | null {
  const encodedId = encodeURIComponent(id)

  switch (type) {
    case 'user':
    case 'admin_account':
      return `/users?userId=${encodedId}`
    case 'organization':
      return `/organizations/${encodedId}`
    case 'space':
      return `/spaces/${encodedId}`
    case 'document':
      return `/docs/${encodedId}`
    case 'table':
      return `/tables/${encodedId}`
    case 'asset':
    case 'resource':
      return null
    case 'slide':
      return `/slides?keyword=${encodedId}`
    case 'billing_event':
      return `/billing/events?eventId=${encodedId}`
    case 'credit_ledger':
      return `/billing/wallets?transactionId=${encodedId}`
    case 'invoice':
      // 月结账单管理页已下线；保留类型兼容，不再生成跳转。
      return null
    case 'provider':
      return `/ai/providers?keyword=${encodedId}`
    case 'model':
      return `/ai/models?keyword=${encodedId}`
    case 'scene':
      return `/ai/scenes?keyword=${encodedId}`
    case 'trace':
      return `/traces/${encodedId}`
    case 'tool':
      return `/tools/${encodedId}`
    case 'app':
      return `/app-installs?appId=${encodedId}`
    case 'connect':
      return null
    case 'device':
      return `/app-installs?deviceId=${encodedId}`
    case 'session':
      return `/users?sessionId=${encodedId}`
    case 'sensitive_action':
      return `/billing/audit-log?actionId=${encodedId}`
    default:
      return null
  }
}

function stringifyMetadata(value: unknown): string {
  if (value === null || value === undefined) {
    return '-'
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function MetadataPreview({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const entries = Object.entries(metadata ?? {}).filter(([, value]) => value !== undefined)
  if (entries.length === 0) {
    return <div className="text-muted-foreground">暂无补充信息</div>
  }

  return (
    <div className="mt-1 space-y-0.5">
      {entries.slice(0, 5).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <span className="text-muted-foreground">{key}</span>
          <span className="truncate">{stringifyMetadata(value)}</span>
        </div>
      ))}
    </div>
  )
}

export function EntityLink({
  type,
  id,
  label,
  metadata,
  className,
  compact = false,
  showType = true,
}: EntityLinkProps) {
  const [copied, setCopied] = useState(false)
  const normalizedType = type.trim()
  const displayType = ENTITY_TYPE_LABELS[normalizedType] || normalizedType || 'Object'
  const entityId = id?.trim() || ''
  const href = entityId ? buildEntityHref(normalizedType, entityId) : null
  const displayLabel =
    label?.trim() || (entityId ? shortId(entityId, compact ? 12 : 18) : 'unknown')

  const tooltip = useMemo(
    () => (
      <div className="max-w-[360px] text-body">
        <div className="font-medium">{displayType}</div>
        <div className="mt-1 break-all text-muted-foreground">ID: {entityId || 'unknown'}</div>
        <MetadataPreview metadata={metadata} />
      </div>
    ),
    [displayType, entityId, metadata]
  )

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!entityId) {
      return
    }
    try {
      await navigator.clipboard.writeText(entityId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  if (!entityId) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded border border-dashed px-2 py-0.5 text-body text-muted-foreground',
                className
              )}
            >
              <HelpCircle className="h-3.5 w-3.5" />
              {showType ? `${displayType}: ` : null}unknown
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  const content = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {showType ? <span className="text-muted-foreground">{displayType}</span> : null}
      <span className="truncate font-medium">{displayLabel}</span>
      {href ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
    </span>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <span
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-body',
            className
          )}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <TooltipTrigger asChild>
            {href ? (
              <Link className="min-w-0 text-primary hover:underline" to={href}>
                {content}
              </Link>
            ) : (
              <span className="min-w-0">{content}</span>
            )}
          </TooltipTrigger>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            aria-label={`复制 ${displayType} ID`}
            onClick={handleCopy}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </span>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
