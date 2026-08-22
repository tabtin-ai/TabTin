/**
 * Organization 详情 · 模型配置 BYOK（organization scope）
 *
 * 对齐 Electron `OrganizationModelSettings`：
 * - 渠道：添加 / 编辑 / 测试连接 / 启停路由 / 删除
 * - 密钥：添加 / 启用停用 / 删除（复用 ProviderKeysSection）
 * - 自定义模型：添加 / 设默认 / 编辑 / 删除
 *
 * 只展示 organization scope；不展示 user-scope BYOK。
 * 写操作走 llm-admin staff API（providersApi / modelsApi / llmAdminApi）。
 */

import { modelsApi } from '@/ai-admin/api/models'
import { type ProviderItem, providersApi } from '@/ai-admin/api/providers'
import { ModelCreateDialog } from '@/ai-admin/components/models/ModelCreateDialog'
import { ModelEditDialog } from '@/ai-admin/components/models/ModelEditDialog'
import { ProbeButton } from '@/ai-admin/components/providers/ProbeButton'
import { ProviderCreateDialog } from '@/ai-admin/components/providers/ProviderCreateDialog'
import { ProviderEditDialog } from '@/ai-admin/components/providers/ProviderEditDialog'
import { ProviderKeysSection } from '@/ai-admin/components/providers/ProviderKeysSection'
import { llmAdminApi } from '@/api/llm-admin'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import type { LlmAdminModel } from '@/types/llm-admin'
import { KeyRound, Loader2, Plus, Power, RefreshCw, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'

export interface OrganizationLlmParitySectionProps {
  organizationId: string
  /** 渠道/模型变更后通知父页刷新可用模型目录与默认模型 */
  onChanged?: () => void
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isOrgByokProvider(provider: ProviderItem, organizationId: string): boolean {
  return provider.scope === 'organization' && provider.organization_id === organizationId
}

function isOrgCustomModel(model: LlmAdminModel, organizationId: string): boolean {
  return (
    model.provider_scope === 'organization' && model.provider_organization_id === organizationId
  )
}

export function OrganizationLlmParitySection({
  organizationId,
  onChanged,
}: OrganizationLlmParitySectionProps) {
  const { adminPermissions } = useAuthStore()
  const canDeleteProvider = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.PROVIDER_DELETE)

  const [providers, setProviders] = useState<ProviderItem[]>([])
  const [models, setModels] = useState<LlmAdminModel[]>([])
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null)
  const [busyModelId, setBusyModelId] = useState<string | null>(null)

  const [createProviderOpen, setCreateProviderOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<ProviderItem | null>(null)
  const [keysProviderId, setKeysProviderId] = useState<string | null>(null)
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<ProviderItem | null>(null)
  const [sensitiveLoading, setSensitiveLoading] = useState(false)

  const [createModelOpen, setCreateModelOpen] = useState(false)
  const [editModel, setEditModel] = useState<LlmAdminModel | null>(null)
  const [deleteModelTarget, setDeleteModelTarget] = useState<LlmAdminModel | null>(null)

  const notifyChanged = useCallback(() => {
    onChanged?.()
  }, [onChanged])

  const load = useCallback(async () => {
    if (!organizationId.trim()) return
    setLoading(true)
    setError(null)
    try {
      const [providerData, modelData, availableData] = await Promise.all([
        providersApi.list({
          scope: 'organization',
          organizationId,
          includeGlobalForOrganization: false,
          includeInactive: true,
        }),
        modelsApi.listModels({
          providerScope: 'organization',
          organizationId,
          includeGlobalForOrganization: false,
          includeInactive: true,
          limit: 200,
        }),
        llmAdminApi.listOrganizationAvailableModels(organizationId, true).catch(() => null),
      ])
      setProviders(
        (providerData.providers || []).filter((item) => isOrgByokProvider(item, organizationId))
      )
      setModels((modelData.models || []).filter((item) => isOrgCustomModel(item, organizationId)))
      setDefaultModelId(availableData?.default_model_id ?? null)
    } catch (err) {
      setProviders([])
      setModels([])
      setDefaultModelId(null)
      setError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  const flash = (message: string) => {
    setStatusMessage(message)
    window.setTimeout(() => setStatusMessage(null), 3000)
  }

  const handleToggleRouting = async (provider: ProviderItem) => {
    setError(null)
    setBusyProviderId(provider.id)
    try {
      await providersApi.updateRuntime(provider.id, {
        routing_enabled: !provider.routing_enabled,
      })
      flash(`渠道「${provider.display_name}」已${provider.routing_enabled ? '暂停' : '启用'}路由`)
      await load()
      notifyChanged()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusyProviderId(null)
    }
  }

  const handleDeleteProvider = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteProviderTarget) return
    setSensitiveLoading(true)
    setError(null)
    try {
      await providersApi.remove(deleteProviderTarget.id, {
        force: deleteProviderTarget.model_count > 0,
        ...payload,
      })
      flash(`已删除渠道「${deleteProviderTarget.display_name}」`)
      if (keysProviderId === deleteProviderTarget.id) setKeysProviderId(null)
      setDeleteProviderTarget(null)
      await load()
      notifyChanged()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSensitiveLoading(false)
    }
  }

  const handleSetDefaultModel = async (model: LlmAdminModel) => {
    setError(null)
    setBusyModelId(model.id)
    try {
      await llmAdminApi.setOrganizationDefaultModel(organizationId, model.id)
      flash(`已将「${model.display_name || model.model_name}」设为组织默认模型`)
      await load()
      notifyChanged()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusyModelId(null)
    }
  }

  const handleDeleteModel = async () => {
    if (!deleteModelTarget) return
    setSensitiveLoading(true)
    setError(null)
    try {
      await modelsApi.deleteModel(deleteModelTarget.id)
      flash(`已删除模型「${deleteModelTarget.display_name || deleteModelTarget.model_name}」`)
      setDeleteModelTarget(null)
      await load()
      notifyChanged()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSensitiveLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-subtitle">
              <KeyRound className="h-4 w-4" />
              BYOK / 自定义渠道
            </CardTitle>
            <CardDescription>
              管理本组织自建渠道、密钥与自定义模型（仅 organization scope；不含 user-scope）。
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setCreateProviderOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              添加渠道
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateModelOpen(true)}
              disabled={providers.length === 0}
              title={providers.length === 0 ? '请先添加组织渠道' : undefined}
            >
              <Plus className="mr-2 h-4 w-4" />
              添加模型
            </Button>
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-body text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
            {statusMessage}
          </div>
        ) : null}

        <div className="rounded-md border border-border/80 bg-muted/20 px-3 py-2 text-caption text-muted-foreground">
          运维代操作：写操作进 llm-admin 审计；删除渠道/模型需填写原因。user 级个人 BYOK
          不在此展示。
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body font-medium">自建渠道（scope=organization）</h3>
            <Badge variant="outline">{providers.length} 个</Badge>
          </div>
          {loading && providers.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-caption text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载渠道…
            </div>
          ) : providers.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-caption text-muted-foreground">
              该组织暂无 BYOK 自建渠道。点击「添加渠道」创建。
            </p>
          ) : (
            <div className="overflow-auto rounded-md border bg-background">
              <table className="min-w-full text-body">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">渠道</th>
                    <th className="px-3 py-2 text-left font-medium">类型 / Key</th>
                    <th className="px-3 py-2 text-left font-medium">健康</th>
                    <th className="px-3 py-2 text-left font-medium">路由</th>
                    <th className="px-3 py-2 text-left font-medium">模型数</th>
                    <th className="px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => {
                    const keysOpen = keysProviderId === provider.id
                    const routingOn = provider.routing_enabled !== false
                    return (
                      <Fragment key={provider.id}>
                        <tr className="border-t">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span>{provider.display_name || provider.name}</span>
                              <Badge
                                variant="outline"
                                className="border-orange-300 text-orange-700 dark:border-orange-700 dark:text-orange-300"
                              >
                                BYOK
                              </Badge>
                            </div>
                            <div className="text-caption text-muted-foreground">{provider.id}</div>
                          </td>
                          <td className="px-3 py-2">
                            <div>{provider.name || provider.provider_key || '—'}</div>
                            <div className="text-caption text-muted-foreground">
                              {provider.api_key_masked || '—'}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline">{provider.runtime_status || 'unknown'}</Badge>
                            <div className="text-caption text-muted-foreground">
                              {formatDateTime(provider.updated_at)}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {routingOn ? (
                              <Badge variant="success">启用</Badge>
                            ) : (
                              <Badge variant="outline">暂停</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{provider.model_count ?? 0}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditProvider(provider)}
                              >
                                编辑
                              </Button>
                              <ProbeButton
                                provider={provider}
                                onProbed={() => {
                                  flash(`渠道「${provider.display_name}」探测完成`)
                                  void load()
                                }}
                                onError={(message) => setError(message)}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyProviderId === provider.id}
                                onClick={() => void handleToggleRouting(provider)}
                              >
                                <Power className="mr-1 h-3 w-3" />
                                {routingOn ? '暂停路由' : '启用路由'}
                              </Button>
                              <Button
                                size="sm"
                                variant={keysOpen ? 'secondary' : 'outline'}
                                onClick={() => setKeysProviderId(keysOpen ? null : provider.id)}
                              >
                                密钥
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canDeleteProvider}
                                onClick={() => setDeleteProviderTarget(provider)}
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {keysOpen ? (
                          <tr className="border-t bg-muted/10">
                            <td colSpan={6} className="px-3 py-3">
                              <ProviderKeysSection providerId={provider.id} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body font-medium">自定义模型（挂在组织 BYOK 渠道）</h3>
            <Badge variant="outline">{models.length} 个</Badge>
          </div>
          {loading && models.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-caption text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载模型…
            </div>
          ) : models.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-caption text-muted-foreground">
              该组织暂无自定义模型。先有渠道后可「添加模型」。
            </p>
          ) : (
            <div className="overflow-auto rounded-md border bg-background">
              <table className="min-w-full text-body">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">模型</th>
                    <th className="px-3 py-2 text-left font-medium">渠道</th>
                    <th className="px-3 py-2 text-left font-medium">能力域</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const isDefault = model.id === defaultModelId
                    return (
                      <tr key={model.id} className="border-t">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span>{model.display_name || model.model_name || model.id}</span>
                            {isDefault ? <Badge variant="success">默认</Badge> : null}
                          </div>
                          <div className="text-caption text-muted-foreground">
                            {model.model_name || model.id}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div>{model.provider_display_name || model.provider_name || '—'}</div>
                          <div className="text-caption text-muted-foreground">
                            {model.provider_id}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline">{model.capability_domain || '—'}</Badge>
                        </td>
                        <td className="px-3 py-2">
                          {model.is_active === false ? (
                            <Badge variant="outline">停用</Badge>
                          ) : (
                            <Badge variant="success">可用</Badge>
                          )}
                          <div className="text-caption text-muted-foreground">
                            {formatDateTime(model.updated_at)}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyModelId === model.id || isDefault}
                              onClick={() => void handleSetDefaultModel(model)}
                            >
                              设为默认
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditModel(model)}>
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setDeleteModelTarget(model)}
                            >
                              <Trash2 className="mr-1 h-3 w-3" />
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>

      <ProviderCreateDialog
        open={createProviderOpen}
        initialDomain="chat"
        lockedScope="organization"
        lockedOrganizationId={organizationId}
        onClose={() => setCreateProviderOpen(false)}
        onCreated={() => {
          flash('组织渠道已创建')
          void load()
          notifyChanged()
        }}
      />

      <ProviderEditDialog
        provider={editProvider}
        open={Boolean(editProvider)}
        onClose={() => setEditProvider(null)}
        onSaved={() => {
          flash('渠道已更新')
          setEditProvider(null)
          void load()
          notifyChanged()
        }}
      />

      <ModelCreateDialog
        open={createModelOpen}
        initialDomain="chat"
        providerListFilter={{ scope: 'organization', organizationId }}
        onClose={() => setCreateModelOpen(false)}
        onCreated={() => {
          flash('自定义模型已创建')
          void load()
          notifyChanged()
        }}
      />

      <ModelEditDialog
        open={Boolean(editModel)}
        model={editModel}
        onClose={() => setEditModel(null)}
        onUpdated={() => {
          flash('模型已更新')
          setEditModel(null)
          void load()
          notifyChanged()
        }}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(deleteProviderTarget)}
        title="删除组织 BYOK 渠道"
        targetLabel={
          deleteProviderTarget
            ? `${deleteProviderTarget.display_name}（${deleteProviderTarget.id}）`
            : ''
        }
        impact={
          deleteProviderTarget && deleteProviderTarget.model_count > 0
            ? `该渠道下仍有 ${deleteProviderTarget.model_count} 个模型，将强制删除渠道及其关联配置。`
            : '删除后该组织将无法再通过此渠道调用模型。'
        }
        confirmText={deleteProviderTarget?.display_name}
        loading={sensitiveLoading}
        onCancel={() => setDeleteProviderTarget(null)}
        onConfirm={handleDeleteProvider}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(deleteModelTarget)}
        title="删除组织自定义模型"
        targetLabel={
          deleteModelTarget
            ? `${deleteModelTarget.display_name || deleteModelTarget.model_name}（${deleteModelTarget.id}）`
            : ''
        }
        impact="删除后组织成员将无法再选择该模型；若其为组织默认模型，需另行设置默认。"
        confirmText={deleteModelTarget?.display_name || deleteModelTarget?.model_name}
        loading={sensitiveLoading}
        onCancel={() => setDeleteModelTarget(null)}
        onConfirm={() => {
          void handleDeleteModel()
        }}
      />
    </Card>
  )
}
