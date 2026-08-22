import React from 'react'
import { Check, ExternalLink, Loader2, Lock, Shield } from 'lucide-react'
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
import { parseMcpError } from '@shared/types/mcp'

export type ConnectorOAuthDialogStep =
  | 'prompt'
  | 'authorizing'
  | 'failed'
  | 'success'

export interface ConnectorOAuthDialogProps {
  open: boolean
  connectorName: string
  step: ConnectorOAuthDialogStep
  /** 成功态：已配置给几个 Agent（首装时常为 0） */
  assignedAgentCount?: number
  /** 失败态：主进程探测返回的可读错误 */
  errorDetail?: string
  authorizeHostHint?: string
  onCancel: () => void
  onAuthorize: () => void
  onRetry: () => void
  onBack: () => void
  onDone: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

/**
 * 标准 MCP OAuth 引导：说明 → 系统浏览器授权 → 探测工具 → 成功/失败。
 * Token 仍由 mcp-remote / 厂商侧持有，TabTin 只编排体验。
 */
export function ConnectorOAuthAuthorizeDialog({
  open,
  connectorName,
  step,
  assignedAgentCount = 0,
  errorDetail,
  authorizeHostHint = '官方域名',
  onCancel,
  onAuthorize,
  onRetry,
  onBack,
  onDone,
  t,
}: ConnectorOAuthDialogProps) {
  const parsedError = errorDetail ? parseMcpError(errorDetail) : null
  const isProbeTimeout = parsedError?.code === 'PROBE_TIMEOUT'
  const readableErrorDetail = parsedError
    ? t(`mcpConnections.errors.${parsedError.code}`, {
        defaultValue: errorDetail,
        ...parsedError.params,
      })
    : errorDetail
  const title =
    step === 'failed'
      ? isProbeTimeout
        ? t('mcpConnections.marketplace.oauthDialog.timeoutTitle', {
            defaultValue: '连接确认超时',
          })
        : t('mcpConnections.marketplace.oauthDialog.failedTitle', {
            defaultValue: '授权未完成',
          })
      : step === 'success'
        ? t('mcpConnections.marketplace.oauthDialog.successTitle', {
            name: connectorName,
            defaultValue: `${connectorName} 已连接`,
          })
        : step === 'authorizing'
          ? t('mcpConnections.marketplace.oauthDialog.confirmingTitle', {
              defaultValue: '正在确认连接',
            })
          : t('mcpConnections.marketplace.oauthDialog.promptTitle', {
              name: connectorName,
              defaultValue: `完成 ${connectorName} 网页授权`,
            })

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/80 px-5 pb-4 pt-[18px] text-left">
          <DialogTitle className="text-subtitle font-semibold">{title}</DialogTitle>
          {step === 'prompt' ? (
            <DialogDescription className="sr-only">
              {t('mcpConnections.marketplace.oauthDialog.promptDescription', {
                name: connectorName,
                defaultValue: `在授权窗口完成 ${connectorName} 登录后回到这里。`,
              })}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {step === 'prompt' ? (
            <>
              <StatusNotice
                tone="info"
                size="sm"
                description={t('mcpConnections.marketplace.oauthDialog.browserHint', {
                  name: connectorName,
                  defaultValue: `将在系统默认浏览器中打开授权页。若尚未登录 ${connectorName}，会先出现登录页；登录后才会看到「允许 TabTin 访问」确认。`,
                })}
              />
              <ul className="space-y-3 text-body text-muted-foreground">
                <li className="flex items-start gap-2.5">
                  <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-primary-text" aria-hidden />
                  <span>
                    <strong className="font-medium text-foreground">
                      {t('mcpConnections.marketplace.oauthDialog.scopeConnectTitle', {
                        defaultValue: '连接账户',
                      })}
                    </strong>
                    <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground/80">
                      {t('mcpConnections.marketplace.oauthDialog.scopeConnectBody', {
                        defaultValue: '用于读取项目、部署状态与基础团队信息。',
                      })}
                    </span>
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary-text" aria-hidden />
                  <span>
                    <strong className="font-medium text-foreground">
                      {t('mcpConnections.marketplace.oauthDialog.scopeControlTitle', {
                        defaultValue: '仍由你掌控操作',
                      })}
                    </strong>
                    <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground/80">
                      {t('mcpConnections.marketplace.oauthDialog.scopeControlBody', {
                        defaultValue: '授权连接不代表自动执行；外部变更仍需按规则确认。',
                      })}
                    </span>
                  </span>
                </li>
              </ul>
              <p className="flex items-start gap-2 text-caption leading-relaxed text-muted-foreground/60">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  {t('mcpConnections.marketplace.oauthDialog.securityNote', {
                    host: authorizeHostHint,
                    defaultValue: `请确认浏览器地址属于 ${authorizeHostHint}。授权可随时在对方账户中撤销。`,
                  })}
                </span>
              </p>
            </>
          ) : null}

          {step === 'authorizing' ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary-text" aria-hidden />
              <p className="text-body font-medium text-foreground">
                {t('mcpConnections.marketplace.oauthDialog.confirmingBody', {
                  defaultValue: '正在打开授权页…首次可能需要十几秒。打开后请在窗口内完成登录。',
                })}
              </p>
              <p className="text-caption text-muted-foreground/80">
                {t('mcpConnections.marketplace.oauthDialog.confirmingHint', {
                  defaultValue: '若浏览器没有自动打开，请检查系统默认浏览器和网络设置。登录确认后这里会自动继续。',
                })}
              </p>
            </div>
          ) : null}

          {step === 'failed' ? (
            <div className="space-y-3">
              <StatusNotice
                tone="danger"
                size="sm"
                description={isProbeTimeout
                  ? t('mcpConnections.marketplace.oauthDialog.timeoutBody', {
                      name: connectorName,
                      seconds: parsedError?.params?.seconds ?? 180,
                      defaultValue: `${connectorName} 在等待授权完成时超时，无法确认是否已授权。原配置没有变化，你可以重试或返回。`,
                    })
                  : t('mcpConnections.marketplace.oauthDialog.failedBody', {
                      name: connectorName,
                      defaultValue: `${connectorName} 没有完成授权，原配置没有变化。你可以重试或返回。`,
                    })}
              />
              {readableErrorDetail ? (
                <p className="rounded-md bg-muted/60 px-3 py-2 font-mono text-caption leading-relaxed text-muted-foreground break-words">
                  {readableErrorDetail}
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 'success' ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
                <Check className="h-6 w-6" strokeWidth={2.5} aria-hidden />
              </span>
              <p className="text-body font-semibold text-foreground">
                {t('mcpConnections.marketplace.oauthDialog.successBody', {
                  defaultValue: '授权与连接探测均已完成',
                })}
              </p>
              <p className="text-caption text-muted-foreground/80">
                {assignedAgentCount > 0
                  ? t('mcpConnections.marketplace.oauthDialog.successAssigned', {
                      name: connectorName,
                      count: assignedAgentCount,
                      defaultValue: `${connectorName} 已配置给 ${assignedAgentCount} 个 Agent。`,
                    })
                  : t('mcpConnections.marketplace.oauthDialog.successUnassigned', {
                      name: connectorName,
                      defaultValue: `${connectorName} 已接入本机，可在「配置给 Agent」中启用。`,
                    })}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border/80 px-5 py-3.5">
          {step === 'prompt' ? (
            <>
              <Button type="button" variant="outline" onClick={onCancel}>
                {t('mcpConnections.marketplace.oauthDialog.cancel', { defaultValue: '取消' })}
              </Button>
              <Button type="button" onClick={onAuthorize}>
                {t('mcpConnections.marketplace.oauthDialog.goAuthorize', {
                  defaultValue: '前往授权',
                })}
              </Button>
            </>
          ) : null}
          {step === 'failed' ? (
            <>
              <Button type="button" variant="outline" onClick={onBack}>
                {t('mcpConnections.marketplace.oauthDialog.back', { defaultValue: '返回' })}
              </Button>
              <Button type="button" onClick={onRetry}>
                {t('mcpConnections.marketplace.oauthDialog.retry', { defaultValue: '重新授权' })}
              </Button>
            </>
          ) : null}
          {step === 'success' ? (
            <Button type="button" onClick={onDone}>
              {t('mcpConnections.marketplace.oauthDialog.backToConfig', {
                defaultValue: '返回配置',
              })}
            </Button>
          ) : null}
          {step === 'authorizing' ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('mcpConnections.marketplace.oauthDialog.cancel', { defaultValue: '取消' })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 从推荐连接器远程 URL 抽出给用户核验的主机名。 */
export function authorizeHostHintFromCatalogTransport(transport: {
  kind: string
  args?: string[]
  url?: string
}): string {
  const raw =
    transport.kind === 'http'
      ? transport.url
      : transport.args?.find(arg => /^https?:\/\//i.test(arg))
  if (!raw) return '官方域名'
  try {
    return new URL(raw).hostname
  } catch {
    return '官方域名'
  }
}
