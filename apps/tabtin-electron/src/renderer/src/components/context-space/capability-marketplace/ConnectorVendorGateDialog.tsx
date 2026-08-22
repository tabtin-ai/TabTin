import React from 'react'
import { Clock3 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusNotice,
} from '@components/ui'
import type {
  RecommendedConnectorCatalogEntry,
  RecommendedConnectorVendorGate,
} from './recommendedConnectorCatalog'

export interface ConnectorVendorGateDialogProps {
  open: boolean
  entry: RecommendedConnectorCatalogEntry | null
  onClose: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

function vendorGateBodyKey(gate: RecommendedConnectorVendorGate | undefined): string {
  if (gate === 'github_app') return 'mcpConnections.marketplace.vendorGate.github'
  if (gate === 'vercel_approval') return 'mcpConnections.marketplace.vendorGate.vercel'
  if (gate === 'canva_callback') return 'mcpConnections.marketplace.vendorGate.canva'
  return 'mcpConnections.marketplace.vendorGate.generic'
}

/**
 * 准入型 OAuth：正式空态说明（不是立刻接入）。
 * 厂商开通后把 catalog 的 oauthGate 改为 ready，即可复用同一套 OAuth 引导流。
 */
export function ConnectorVendorGateDialog({
  open,
  entry,
  onClose,
  t,
}: ConnectorVendorGateDialogProps) {
  const name = entry?.name ?? ''
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/80 px-5 pb-4 pt-[18px] text-left">
          <DialogTitle className="text-subtitle font-semibold">
            {t('mcpConnections.marketplace.vendorGate.dialogTitle', {
              name,
              defaultValue: `${name} 即将开放`,
            })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-body leading-relaxed text-muted-foreground/80">
            {t('mcpConnections.marketplace.vendorGate.dialogDescription', {
              defaultValue: '授权流程已就绪，但尚需完成厂商侧注册或审核后才能对用户开放。',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-start gap-3 rounded-lg border border-border/80 bg-muted/30 px-3 py-3">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary-text" aria-hidden />
            <p className="text-body leading-relaxed text-muted-foreground">
              {t(vendorGateBodyKey(entry?.vendorGate), {
                defaultValue: t('mcpConnections.marketplace.vendorGate.generic', {
                  defaultValue: '该连接器需完成厂商准入后才可授权，请稍后再试。',
                }),
              })}
            </p>
          </div>
          <StatusNotice
            tone="info"
            size="sm"
            description={t('mcpConnections.marketplace.vendorGate.reuseHint', {
              defaultValue: '开通后将复用与 Stripe / Notion 相同的「网页授权 → 探测工具」流程，无需另学一套。',
            })}
          />
        </div>

        <DialogFooter className="border-t border-border/80 px-5 py-3.5">
          <Button type="button" onClick={onClose}>
            {t('mcpConnections.marketplace.vendorGate.gotIt', { defaultValue: '知道了' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
