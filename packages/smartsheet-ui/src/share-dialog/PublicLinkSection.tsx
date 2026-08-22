/**
 * PublicLinkSection — ShareDialog 下半部"公开链接"段。
 *
 * canManage=true 时：
 *   - 公开分享开关
 *   - 「链接可见范围」下拉（D6：public / organization）
 *   - 权限下拉（view / comment / edit）
 *   - 密码输入 + 应用
 *   - 链接 + 复制 + 刷新（带 tooltip 警告）
 *   - 访问计数
 *
 * canManage=false 时：所有控件 readonly/disabled，提示 readOnlyHint
 *
 * （TabDoc / TabData 对齐）：
 *   - 首次开启默认 organization
 *   - 扩大到 public（任何人）须 ConfirmDialog + acknowledgePublicExposure
 */

import * as React from 'react'
import { Check, Copy, Globe, Link2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../components/button'
import { Input } from '../components/input'
import { Switch } from '../components/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/tooltip'
import { toast } from '../components/toast/use-toast'
import { ConfirmDialog } from '../components/confirm-dialog'
import { shareTypeToScope, useShareSettings } from './hooks/useShareSettings'
import { buildShareUrl } from './url'
import type {
  ResourceType,
  ShareLinkPermission,
  ShareScope,
} from './types'

const LINK_PERMISSION_OPTIONS_DOC: ShareLinkPermission[] = ['view', 'comment', 'edit']
const LINK_PERMISSION_OPTIONS_TABLE: ShareLinkPermission[] = ['view', 'edit']

interface Props {
  resourceType: ResourceType
  resourceId: string
  organizationId: string
  shareUrlPrefix?: string
  canManage: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}

type PendingPublicAction =
  | { kind: 'enable' }
  | { kind: 'scope'; next: ShareScope }

export const PublicLinkSection: React.FC<Props> = ({
  resourceType,
  resourceId,
  organizationId,
  shareUrlPrefix,
  canManage,
  t,
}) => {
  const { share, enabled, loading, busy, enableShare, disableShare, refreshLink } = useShareSettings(
    resourceType,
    resourceId,
    organizationId,
  )

  const [password, setPassword] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [refreshConfirmOpen, setRefreshConfirmOpen] = React.useState(false)
  const [publicConfirmOpen, setPublicConfirmOpen] = React.useState(false)
  const [pendingPublicAction, setPendingPublicAction] = React.useState<PendingPublicAction | null>(
    null,
  )
  const linkOptions =
    resourceType === 'doc' ? LINK_PERMISSION_OPTIONS_DOC : LINK_PERMISSION_OPTIONS_TABLE

  const currentScope = shareTypeToScope(share?.share_type, resourceType)
  const currentPermission = share?.permission ?? linkOptions[0]
  const isAlreadyPublic = currentScope === 'public'

  const shareUrl = React.useMemo(() => {
    return buildShareUrl(share?.share_id, shareUrlPrefix)
  }, [share, shareUrlPrefix])

  const runEnable = React.useCallback(
    async (options: {
      shareScope: ShareScope
      acknowledgePublicExposure?: boolean
      permission?: string
    }) => {
      await enableShare({
        shareScope: options.shareScope,
        permission: options.permission ?? currentPermission,
        ...(password ? { password } : {}),
        ...(options.acknowledgePublicExposure ? { acknowledgePublicExposure: true } : {}),
      })
    },
    [currentPermission, enableShare, password],
  )

  // Wave 5 §C PATCH 语义：切 scope/permission 不传 password（保留旧 hash）；
  // 只有用户手动按"应用"按钮时才显式传 password（含 "" 表示清空、非空表示设新值）。
  const handleToggle = React.useCallback(
    async (checked: boolean) => {
      try {
        if (checked) {
          // ：首次开启默认组织内（doc / table 一致）
          const nextScope: ShareScope = 'organization'
          await runEnable({ shareScope: nextScope })
          toast({
            title: t('share.dialog.publicLink.enabledToast', { defaultValue: '公开链接已开启' }),
          })
        } else {
          await disableShare()
          toast({
            title: t('share.dialog.publicLink.disabledToast', { defaultValue: '公开链接已关闭' }),
          })
        }
      } catch (err) {
        toast({
          title: t('share.dialog.publicLink.toggleFailed', { defaultValue: '操作失败' }),
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      }
    },
    [disableShare, runEnable, t],
  )

  const handleScopeChange = React.useCallback(
    async (next: ShareScope) => {
      if (next === currentScope) return
      // ：扩到「任何人」须二次确认（doc / table）
      if (next === 'public') {
        setPendingPublicAction({ kind: 'scope', next })
        setPublicConfirmOpen(true)
        return
      }
      try {
        await enableShare({
          shareScope: next,
          permission: currentPermission,
        })
        toast({
          title:
            next === 'organization' && currentScope === 'public'
              ? t('share.dialog.publicLink.scopeNarrowedToast', {
                  defaultValue: '已改为组织内可见，原公开链接已失效',
                })
              : t('share.dialog.publicLink.scopeUpdated', { defaultValue: '链接可见范围已更新' }),
        })
      } catch (err) {
        toast({
          title: t('share.dialog.publicLink.scopeUpdateFailed', { defaultValue: '可见范围更新失败' }),
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      }
    },
    [currentPermission, currentScope, enableShare, t],
  )

  const handlePublicConfirm = React.useCallback(async () => {
    if (!pendingPublicAction) return
    try {
      if (pendingPublicAction.kind === 'enable') {
        await runEnable({ shareScope: 'public', acknowledgePublicExposure: true })
        toast({
          title: t('share.dialog.publicLink.enabledToast', { defaultValue: '公开链接已开启' }),
        })
      } else {
        await enableShare({
          shareScope: 'public',
          permission: currentPermission,
          acknowledgePublicExposure: true,
        })
        toast({
          title: t('share.dialog.publicLink.scopeUpdated', { defaultValue: '链接可见范围已更新' }),
        })
      }
    } catch (err) {
      toast({
        title: t('share.dialog.publicLink.scopeUpdateFailed', { defaultValue: '可见范围更新失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      setPublicConfirmOpen(false)
      setPendingPublicAction(null)
    }
  }, [currentPermission, enableShare, pendingPublicAction, runEnable, t])

  const handlePermissionChange = React.useCallback(
    async (next: string) => {
      if (next === currentPermission) return
      try {
        // 切 permission：不动密码；已是 public 时无需重复确认
        await enableShare({
          shareScope: currentScope,
          permission: next,
          ...(isAlreadyPublic ? { acknowledgePublicExposure: true } : {}),
        })
        toast({ title: t('share.dialog.publicLink.permissionUpdated', { defaultValue: '权限已更新' }) })
      } catch (err) {
        toast({
          title: t('share.dialog.publicLink.permissionUpdateFailed', { defaultValue: '权限更新失败' }),
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      }
    },
    [currentPermission, currentScope, enableShare, isAlreadyPublic, t],
  )

  const handleApplyPassword = React.useCallback(async () => {
    try {
      // 用户主动按"应用"：把输入框当前值发出去（空串 = 显式清除）
      await enableShare({
        shareScope: currentScope,
        permission: currentPermission,
        password,
        ...(isAlreadyPublic ? { acknowledgePublicExposure: true } : {}),
      })
      toast({ title: t('share.dialog.publicLink.passwordUpdated', { defaultValue: '密码已更新' }) })
    } catch (err) {
      toast({
        title: t('share.dialog.publicLink.passwordUpdateFailed', { defaultValue: '密码更新失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }, [currentPermission, currentScope, enableShare, isAlreadyPublic, password, t])

  const handleCopy = React.useCallback(async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast({
        title: t('share.dialog.publicLink.copyFailed', { defaultValue: '复制失败' }),
        variant: 'destructive',
      })
    }
  }, [shareUrl, t])

  const handleRefreshRequest = React.useCallback(() => {
    setRefreshConfirmOpen(true)
  }, [])

  const handleRefreshConfirm = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshLink()
      toast({ title: t('share.dialog.publicLink.refreshedToast', { defaultValue: '链接已重新生成' }) })
    } catch (err) {
      toast({
        title: t('share.dialog.publicLink.refreshFailed', { defaultValue: '刷新失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      setRefreshing(false)
      setRefreshConfirmOpen(false)
    }
  }, [refreshLink, t])

  const disabled = !canManage || busy

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-body font-medium">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t('share.dialog.publicLink.section', { defaultValue: '公开链接' })}
        </h3>
        <div className="flex items-center gap-2">
          {!canManage && (
            <span className="text-caption text-muted-foreground">
              {t('share.dialog.publicLink.disabledForRole', { defaultValue: '仅所有者可管理' })}
            </span>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void handleToggle(v)}
            disabled={disabled || loading}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-3 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : enabled && share ? (
        <div className="space-y-3 rounded-lg bg-muted/20 p-3">
          {/* 链接 + 复制 + 刷新 */}
          <div className="flex items-center gap-2">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-body text-muted-foreground">{shareUrl}</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleCopy()}
                      disabled={!shareUrl}
                      className="rounded p-1 hover:bg-muted"
                      aria-label={t('share.dialog.copy', { defaultValue: '复制链接' })}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('share.dialog.copy', { defaultValue: '复制链接' })}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {canManage && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0">
                      <button
                        type="button"
                        onClick={handleRefreshRequest}
                        disabled={refreshing}
                        className="rounded p-1 hover:bg-muted disabled:opacity-50"
                        aria-label={t('share.dialog.refresh', { defaultValue: '刷新链接' })}
                      >
                        {refreshing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 text-warning" />
                        )}
                      </button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t('share.dialog.refreshWarning', {
                      defaultValue: '刷新后旧链接立即失效，请谨慎操作',
                    })}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* 链接可见范围 + 权限 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t('share.dialog.publicLink.scope', { defaultValue: '链接可见范围' })}
              </label>
              <Select
                value={currentScope}
                onValueChange={(v) => void handleScopeChange(v as ShareScope)}
                disabled={disabled}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="organization">
                    {t('share.dialog.publicLink.scopeOption.organization', { defaultValue: '组织内' })}
                  </SelectItem>
                  <SelectItem value="public">
                    {t('share.dialog.publicLink.scopeOption.public', { defaultValue: '任何人' })}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div className="text-caption text-muted-foreground/80">
                {currentScope === 'organization'
                  ? t('share.dialog.publicLink.scopeHint.organization', {
                      defaultValue: '仅登录的组织成员能通过此链接访问。',
                    })
                  : t('share.dialog.publicLink.scopeHint.public', {
                      defaultValue: '任何拿到链接的人都能访问。',
                    })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t('share.dialog.publicLink.permission', { defaultValue: '权限' })}
              </label>
              <Select
                value={currentPermission}
                onValueChange={(v) => void handlePermissionChange(v)}
                disabled={disabled}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {linkOptions.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`share.dialog.publicLink.permissionOption.${p}`, { defaultValue: p })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <label className="text-caption text-muted-foreground">
              {t('share.dialog.password', { defaultValue: '密码保护（可选）' })}
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  share.has_password
                    ? t('share.dialog.passwordSetPlaceholder', { defaultValue: '已设置（留空则清除）' })
                    : t('share.dialog.passwordPlaceholder', { defaultValue: '可选，留空则无密码' })
                }
                className="h-9 flex-1"
                disabled={disabled}
              />
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleApplyPassword()}
                  disabled={disabled}
                  className="h-9"
                >
                  {t('share.dialog.apply', { defaultValue: '应用' })}
                </Button>
              )}
            </div>
          </div>

          {/* 访问统计 */}
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>{t('share.dialog.visitCount', { defaultValue: '访问次数' })}</span>
            <span>{share.visit_count ?? 0}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-md bg-muted/20 px-3 py-3 text-caption text-muted-foreground">
          {t('share.dialog.publicLink.disabledHint', {
            defaultValue: '开启后默认仅组织内成员可访问；改为「任何人」需二次确认。',
          })}
        </div>
      )}

      <ConfirmDialog
        open={refreshConfirmOpen}
        onOpenChange={setRefreshConfirmOpen}
        title={t('share.dialog.refreshConfirmTitle', { defaultValue: '刷新分享链接' })}
        description={t('share.dialog.refreshConfirm', {
          defaultValue: '刷新会让旧链接立即失效，确定继续吗？',
        })}
        variant="destructive"
        confirmText={t('share.dialog.refresh', { defaultValue: '刷新链接' })}
        cancelText={t('share.dialog.cancel', { defaultValue: '取消' })}
        onConfirm={handleRefreshConfirm}
        isLoading={refreshing}
      />

      <ConfirmDialog
        open={publicConfirmOpen}
        onOpenChange={(open) => {
          setPublicConfirmOpen(open)
          if (!open) setPendingPublicAction(null)
        }}
        title={t('share.dialog.publicLink.publicConfirmTitle', {
          defaultValue: '确认设为任何人可访问？',
        })}
        description={t('share.dialog.publicLink.publicConfirmDescription', {
          defaultValue:
            '这是高危操作：无需加入组织，任何获得链接的人都能访问内容。确认后立即生效。',
        })}
        variant="destructive"
        confirmText={t('share.dialog.publicLink.publicConfirmAction', {
          defaultValue: '确认公开',
        })}
        cancelText={t('share.dialog.cancel', { defaultValue: '取消' })}
        onConfirm={handlePublicConfirm}
        isLoading={busy}
      />
    </div>
  )
}
