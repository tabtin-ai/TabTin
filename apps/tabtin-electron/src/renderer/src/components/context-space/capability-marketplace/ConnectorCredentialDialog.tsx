import React, { useState } from 'react'
import { ExternalLink, KeyRound, Building2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  StatusNotice,
} from '@components/ui'
import type { RecommendedConnectorCatalogEntry } from './recommendedConnectorCatalog'

export type ConnectorCredentialDialogMode = 'api_key' | 'app_credentials'

export interface ConnectorCredentialDialogProps {
  open: boolean
  mode: ConnectorCredentialDialogMode
  connectorName: string
  credentialUrl?: string
  docsUrl?: string
  saving?: boolean
  onCancel: () => void
  onSubmit: (value: {
    apiKey?: string
    clientId?: string
    clientSecret?: string
  }) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

/**
 * API Key / 企业应用凭证专用表单（不再把用户丢进裸 JSON 编辑器）。
 */
export function ConnectorCredentialDialog({
  open,
  mode,
  connectorName,
  credentialUrl,
  docsUrl,
  saving = false,
  onCancel,
  onSubmit,
  t,
}: ConnectorCredentialDialogProps) {
  const [apiKey, setApiKey] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const isGitHubPat = mode === 'api_key' && connectorName === 'GitHub'

  const resetAndClose = () => {
    setApiKey('')
    setClientId('')
    setClientSecret('')
    setError(null)
    onCancel()
  }

  const handleSubmit = () => {
    if (mode === 'api_key') {
      if (!apiKey.trim()) {
        setError(
          isGitHubPat
            ? t('mcpConnections.marketplace.credentialDialog.githubTokenRequired', {
                defaultValue: '请粘贴 GitHub Token',
              })
            : t('mcpConnections.marketplace.credentialDialog.apiKeyRequired', {
                defaultValue: '请粘贴 API Key',
              }),
        )
        return
      }
      onSubmit({ apiKey: apiKey.trim() })
      return
    }
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(
        t('mcpConnections.marketplace.credentialDialog.appCredentialsRequired', {
          defaultValue: '请填写 Client ID 与 Client Secret',
        }),
      )
      return
    }
    onSubmit({ clientId: clientId.trim(), clientSecret: clientSecret.trim() })
  }

  const title =
    mode === 'api_key'
      ? isGitHubPat
        ? t('mcpConnections.marketplace.credentialDialog.githubTokenTitle', {
            name: connectorName,
            defaultValue: `填写 ${connectorName} Token`,
          })
        : t('mcpConnections.marketplace.credentialDialog.apiKeyTitle', {
            name: connectorName,
            defaultValue: `填写 ${connectorName} API Key`,
          })
      : t('mcpConnections.marketplace.credentialDialog.appCredentialsTitle', {
          name: connectorName,
          defaultValue: `配置 ${connectorName} 企业应用`,
        })

  const description =
    mode === 'api_key'
      ? isGitHubPat
        ? t('mcpConnections.marketplace.credentialDialog.githubTokenDescription', {
            defaultValue:
              '本机未配置 GitHub OAuth App 时，粘贴 Personal Access Token 即可连接。密钥只保存在本机。',
          })
        : t('mcpConnections.marketplace.credentialDialog.apiKeyDescription', {
            defaultValue: '在官方控制台申请密钥后粘贴到下方。保存后会自动探测连接，密钥只保存在本机。',
          })
      : t('mcpConnections.marketplace.credentialDialog.appCredentialsDescription', {
          defaultValue:
            '请先在开放平台创建企业内部应用并开通所需权限，再填写 Client ID / Secret。保存后会自动探测。',
        })

  const steps =
    mode === 'api_key'
      ? isGitHubPat
        ? t('mcpConnections.marketplace.credentialDialog.githubTokenSteps', {
            defaultValue: '创建 Token → 粘贴 → 安全保存 → 自动探测',
          })
        : t('mcpConnections.marketplace.credentialDialog.apiKeySteps', {
            defaultValue: '获取 API Key → 粘贴密钥 → 安全保存 → 自动探测',
          })
      : t('mcpConnections.marketplace.credentialDialog.appCredentialsSteps', {
          defaultValue: '创建企业应用 → 填写 Client ID/Secret → 安全保存 → 自动探测',
        })

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) resetAndClose()
      }}
    >
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/80 px-5 pb-4 pt-[18px] text-left">
          <DialogTitle className="text-subtitle font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-body leading-relaxed text-muted-foreground/80">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          <StatusNotice
            tone="info"
            size="sm"
            description={steps}
          />

          {mode === 'api_key' ? (
            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-body font-medium text-foreground">
                <KeyRound className="h-3.5 w-3.5" aria-hidden />
                {isGitHubPat
                  ? t('mcpConnections.marketplace.credentialDialog.githubTokenLabel', {
                      defaultValue: 'Personal Access Token',
                    })
                  : t('mcpConnections.marketplace.credentialDialog.apiKeyLabel', {
                      defaultValue: 'API Key',
                    })}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={event => {
                  setApiKey(event.target.value)
                  setError(null)
                }}
                placeholder={
                  isGitHubPat
                    ? t('mcpConnections.marketplace.credentialDialog.githubTokenPlaceholder', {
                        defaultValue: 'ghp_… 或 github_pat_…',
                      })
                    : t('mcpConnections.marketplace.credentialDialog.apiKeyPlaceholder', {
                        defaultValue: '粘贴密钥',
                      })
                }
                className="font-mono text-body"
              />
            </label>
          ) : (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="flex items-center gap-1.5 text-body font-medium text-foreground">
                  <Building2 className="h-3.5 w-3.5" aria-hidden />
                  {t('mcpConnections.marketplace.credentialDialog.clientIdLabel', {
                    defaultValue: 'Client ID',
                  })}
                </span>
                <Input
                  autoComplete="off"
                  value={clientId}
                  onChange={event => {
                    setClientId(event.target.value)
                    setError(null)
                  }}
                  placeholder="DINGTALK_Client_ID"
                  className="font-mono text-body"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-body font-medium text-foreground">
                  {t('mcpConnections.marketplace.credentialDialog.clientSecretLabel', {
                    defaultValue: 'Client Secret',
                  })}
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={event => {
                    setClientSecret(event.target.value)
                    setError(null)
                  }}
                  placeholder="DINGTALK_Client_Secret"
                  className="font-mono text-body"
                />
              </label>
            </div>
          )}

          {credentialUrl ? (
            <a
              href={credentialUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-caption font-medium text-primary-text hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('mcpConnections.marketplace.credentialDialog.openCredentialPage', {
                defaultValue: '打开官方申请页面',
              })}
            </a>
          ) : docsUrl ? (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-caption font-medium text-primary-text hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('mcpConnections.marketplace.credentialDialog.openDocs', {
                defaultValue: '查看官方文档',
              })}
            </a>
          ) : null}

          {error ? (
            <StatusNotice tone="danger" size="sm" description={error} />
          ) : null}
        </div>

        <DialogFooter className="border-t border-border/80 px-5 py-3.5">
          <Button type="button" variant="outline" disabled={saving} onClick={resetAndClose}>
            {t('mcpConnections.marketplace.credentialDialog.cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" disabled={saving} onClick={handleSubmit}>
            {saving
              ? t('mcpConnections.marketplace.credentialDialog.saving', {
                  defaultValue: '保存并探测中…',
                })
              : t('mcpConnections.marketplace.credentialDialog.saveAndProbe', {
                  defaultValue: '保存并探测',
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function credentialDialogModeForEntry(
  entry: Pick<RecommendedConnectorCatalogEntry, 'authKind'>,
): ConnectorCredentialDialogMode | null {
  if (entry.authKind === 'api_key') return 'api_key'
  if (entry.authKind === 'app_credentials') return 'app_credentials'
  return null
}
