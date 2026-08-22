/**
 * 共享的 Extension 卡片组件。
 * 供 AgentExtensionsPanel 和 ExtensionCatalogSection 共同使用，
 * 通过 props 参数化差异（inherited、按钮文案等）。
 */
import React from 'react'
import {
  Check,
  Link2,
  Loader2,
  Power,
  PowerOff,
  Settings2,
  Trash2,
  Zap,
} from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { ExtensionManifest, ExtensionConnection } from '@/services/extensionApi'
import type { ProbeResultState } from '@/hooks/useProbeConnection'
import { TypeBadge, StatusBadge, ConfigFieldCount } from './ExtensionBadges'
import { ProbeResultBadge } from './ProbeResultBadge'
import { cn } from '@utils/cn'

export interface ExtensionCardProps {
  ext: ExtensionManifest
  conn: ExtensionConnection | undefined
  probingConnId: string | null
  probeResult: ProbeResultState | null
  inherited?: boolean
  inheritedLabel?: string
  canManageOrganization?: boolean
  onInstall?: (ext: ExtensionManifest) => void
  onEditConfig?: (ext: ExtensionManifest, conn: ExtensionConnection) => void
  onProbe?: (connId: string) => void
  onToggle?: (conn: ExtensionConnection) => void
  onRemove?: (connId: string) => void
}

export const ExtensionCard: React.FC<ExtensionCardProps> = ({
  ext,
  conn,
  probingConnId,
  probeResult,
  inherited,
  inheritedLabel,
  canManageOrganization = true,
  onInstall,
  onEditConfig,
  onToggle,
  onRemove,
  onProbe,
}) => {
  const { t } = useTranslation('settings')

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-body shrink-0">{ext.icon || '🧩'}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-caption font-medium truncate">{ext.name}</span>
            <TypeBadge type={ext.type} />
            {conn && <StatusBadge status={conn.status} />}
            <ConfigFieldCount conn={conn} />
          </div>
          <p className="text-caption text-muted-foreground/80 truncate mt-0.5">
            {ext.description}
          </p>
          {inherited && inheritedLabel && (
            <span className="text-caption text-muted-foreground/60 flex items-center gap-1 mt-0.5">
              <Check className="h-3 w-3" />
              {inheritedLabel}
            </span>
          )}
          {conn && <ProbeResultBadge result={probeResult} connId={conn.id} />}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {conn ? (
          <>
            {onEditConfig && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canManageOrganization}
                onClick={() => onEditConfig(ext, conn)}
                title={t('extensions.configure')}
                aria-label={t('extensions.configure')}
              >
                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            )}
            {onProbe && (
              <Button
                variant="ghost"
                size="sm"
                disabled={probingConnId === conn.id}
                onClick={() => onProbe(conn.id)}
                title={t('extensions.testConnection')}
                aria-label={t('extensions.testConnection')}
              >
                {probingConnId === conn.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  : <Zap className={cn(
                    'h-3.5 w-3.5',
                    probeResult?.connId === conn.id
                      ? probeResult.ok ? 'text-success' : 'text-destructive'
                      : 'text-muted-foreground',
                  )} />
                }
              </Button>
            )}
            {onToggle && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canManageOrganization}
                onClick={() => onToggle(conn)}
                title={conn.enabled ? t('extensions.disable') : t('extensions.enable')}
                aria-label={conn.enabled ? t('extensions.disable') : t('extensions.enable')}
              >
                {conn.enabled
                  ? <Power className="h-3.5 w-3.5 text-success" />
                  : <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />
                }
              </Button>
            )}
            {onRemove && !ext.is_builtin && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canManageOrganization}
                onClick={() => onRemove(conn.id)}
                aria-label={t('extensions.remove')}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </Button>
            )}
          </>
        ) : ext.is_builtin ? (
          <span className="text-caption text-muted-foreground px-2 py-1">
            {t('extensions.builtin')}
          </span>
        ) : canManageOrganization && onInstall ? (
          <Button variant="outline" size="sm" onClick={() => onInstall(ext)}>
            <Link2 className="h-3.5 w-3.5 mr-1" />
            {t('extensions.install')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
