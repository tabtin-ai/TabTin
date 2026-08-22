/**
 * Wave 5b S3 — SaveBlacklist 管理 UI（PRD 6.4 V1）
 *
 * 让用户撤回"不为此网站保存"屏蔽。Wave 3 G5 在 SavePasswordBar 上提供了
 * 5s 撤销窗口；逾期后此前没有 UI 入口，用户只能等下一次同 domain 提交
 * 才能间接发现"还在屏蔽中"。本组件兑现 PRD Story 2 异常路径
 *
 *   "用户点了'不为此网站保存' → 该 domain 进入 V1 SaveBlacklist
 *    （后端持久化，跨设备生效）……
 *    Wave 5 设置页提供完整黑名单管理 UI"
 *
 * 数据：useSaveBlacklistQuery / useDeleteSaveBlacklistEntryMutation
 *   （Wave 3 后端：`GET / DELETE /credential-vault/save-blacklist[/{domain}]`）
 *
 * 闭环验收：用户在此移除屏蔽 → 下次访问同 domain 登录成功 → SavePasswordBar
 * 重新弹保存条（autofill-service.checkDomainBlacklist 5min 缓存会因 mutation
 * 失效后下次 onPasswordSubmitted 时重新拉，最迟 5min 内生效）。
 */
import React, { useState } from 'react'
import { Globe, Loader2, ShieldOff, Trash2 } from 'lucide-react'
import { Button, ConfirmDialog, cn, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { SettingsSectionCard } from '../../SettingsSectionCard'
import { SETTINGS_HINT, SETTINGS_HOVER_ACTION, SETTINGS_TEXT_MICRO } from '../../settingsUi'
import {
  useDeleteSaveBlacklistEntryMutation,
  useSaveBlacklistQuery,
  type SaveBlacklistEntry,
} from '@/hooks/queries/credentials'

function formatCreatedAt(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // 与系统其他列表（凭据/订单）保持一致：仅用本地化日期
  return d.toLocaleDateString()
}

export const SaveBlacklistSection: React.FC = () => {
  const { t } = useTranslation('settings')
  const { data: entries = [], isLoading, error } = useSaveBlacklistQuery()
  const deleteMutation = useDeleteSaveBlacklistEntryMutation()
  const [confirmTarget, setConfirmTarget] = useState<SaveBlacklistEntry | null>(null)

  React.useEffect(() => {
    if (error) {
      console.error('[SaveBlacklistSection] load failed:', error)
      toast({
        title: t('credentialVault.saveBlacklist.loadFailed'),
        variant: 'destructive',
      })
    }
  }, [error, t])

  const handleConfirmDelete = async () => {
    if (!confirmTarget) return
    try {
      await deleteMutation.mutateAsync(confirmTarget.domain)
      toast({
        title: t('credentialVault.saveBlacklist.removeSuccess', { domain: confirmTarget.domain }),
      })
    } catch (err: any) {
      toast({
        title: t('credentialVault.saveBlacklist.removeFailed'),
        description: err?.message,
        variant: 'destructive',
      })
    } finally {
      setConfirmTarget(null)
    }
  }

  return (
    <SettingsSectionCard
      icon={<ShieldOff className="h-4 w-4" />}
      title={t('credentialVault.saveBlacklist.title')}
      subtitle={t('credentialVault.saveBlacklist.subtitle')}
    >
      {isLoading ? (
        <div className="py-1">
          <ManagementCardListSkeleton count={3} />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex items-center gap-3 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/40">
            <ShieldOff className="h-5 w-5 text-muted-foreground/40" />
          </div>
          <p className={SETTINGS_HINT}>
            {t('credentialVault.saveBlacklist.empty')}
          </p>
        </div>
      ) : (
        <div className="space-y-0.5 max-h-80 overflow-y-auto">
          {entries.map((item) => {
            const isDeleting =
              deleteMutation.isPending && deleteMutation.variables === item.domain
            return (
              <div
                key={item.id}
                className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/20 transition-colors"
                data-testid="save-blacklist-row"
                data-domain={item.domain}
              >
                <Globe className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                <div className="min-w-0 flex-1">
                  {/* Wave 5b 视角 2#5 自修：domain 是行主标识，按设计系统应为 text-body
                      （14px），原 SETTINGS_TEXT_MICRO（12px）违反"SETTINGS_TEXT_MICRO 不得用于操作按钮 /
                      表单 Label / 主标识"规范，且与同设置页 WebsiteCredentialsSection 行视
                      觉不一致。改回 text-body 后扫读体验回到设计系统轨道。 */}
                  <div className="truncate text-body font-medium text-foreground">
                    {item.domain}
                  </div>
                  <div className={SETTINGS_HINT}>
                    {t('credentialVault.saveBlacklist.addedAt', {
                      date: formatCreatedAt(item.created_at),
                    })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => setConfirmTarget(item)}
                    className={cn(
                      SETTINGS_HOVER_ACTION,
                      // 视角 2#5：操作按钮去掉 SETTINGS_TEXT_MICRO，让 ghost variant 用默认 body 字号，
                      // 与"网站登录凭据 / App 登录凭据"区块的同性质操作按钮视觉一致。
                      'h-7 gap-1.5 text-muted-foreground/80 hover:text-destructive',
                    )}
                    data-action="remove"
                  >
                    {isDeleting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    {t('credentialVault.saveBlacklist.removeAction')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null)
        }}
        title={t('credentialVault.saveBlacklist.removeConfirmTitle')}
        description={t('credentialVault.saveBlacklist.removeConfirmDesc', {
          domain: confirmTarget?.domain ?? '',
        })}
        confirmText={t('credentialVault.saveBlacklist.removeAction')}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </SettingsSectionCard>
  )
}
