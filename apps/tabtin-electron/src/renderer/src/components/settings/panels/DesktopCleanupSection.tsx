/**
 * DesktopCleanupSection — 设置页清登录凭证 / 配置缓存；卸程序走对应系统的卸载入口。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, ConfirmDialog, toast } from '@tabtin/smartsheet-ui'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { useAuthStore } from '@stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { resolveCleanupPlatform } from './desktopCleanupPlatform'
import {
  resolveCleanupCatchMessage,
  resolveCleanupFailureMessage,
} from './desktopCleanupErrors'
import { SETTINGS_TEXT_MICRO } from '../settingsUi'
import { cn } from '@utils/cn'

type ConfirmKind = 'credentials' | 'localData' | 'uninstall' | null

export const DesktopCleanupSection: React.FC = () => {
  const { t } = useTranslation('settings')
  const cleanupPlatform = resolveCleanupPlatform(window.tabtin?.getPlatform?.() ?? '')
  const platformCopy = useCallback(
    (name: 'subtitle' | 'uninstallAppDesc' | 'uninstallConfirmDesc' | 'uninstallHint') =>
      t(`desktopCleanup.${name}.${cleanupPlatform}`),
    [cleanupPlatform, t],
  )
  const logout = useAuthStore((s) => s.logout)
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null)
  const [deleteLocalData, setDeleteLocalData] = useState(false)
  const [busy, setBusy] = useState(false)

  const syncRendererLogout = useCallback(async () => {
    try {
      await logout('manual')
    } catch {
      // 磁盘凭证已清；renderer 登出失败不阻断
    }
  }, [logout])

  const handleConfirm = useCallback(async () => {
    if (!window.tabtin?.appCleanup) {
      toast({
        title: t('desktopCleanup.failed', {
          message: t('desktopCleanup.errors.unknown'),
        }),
        variant: 'destructive',
      })
      return
    }

    setBusy(true)
    try {
      if (confirmKind === 'credentials') {
        // 凭证文件和主 auth 都清理成功后，renderer 才进入登出态。
        const result = await window.tabtin.appCleanup.wipeCredentials()
        if (!result.ok && result.failed.length > 0) {
          toast({
            title: t('desktopCleanup.failed', {
              message: resolveCleanupFailureMessage(t, result.failed),
            }),
            variant: 'destructive',
          })
          return
        }
        await syncRendererLogout()
        toast({ title: t('desktopCleanup.successCredentials') })
        return
      }

      if (confirmKind === 'localData') {
        const result = await window.tabtin.appCleanup.wipeLocalData()
        if (result.willRelaunch) {
          // 安装包：主进程即将 exit；凭证由重启后的启动期清理删除
          toast({ title: t('desktopCleanup.relaunchingToWipe') })
          return
        }
        if (result.needsManualDevRestart) {
          // pnpm/electron-vite：不杀进程；已写 pending，等用户自己重启终端里的 pnpm
          toast({
            title: t('desktopCleanup.needsManualDevRestart'),
            variant: 'destructive',
          })
          return
        }
        if (!result.ok && result.failed.length > 0) {
          toast({
            title: t('desktopCleanup.failed', {
              message: resolveCleanupFailureMessage(t, result.failed),
            }),
            variant: 'destructive',
          })
        } else {
          await syncRendererLogout()
          toast({ title: t('desktopCleanup.successLocalData') })
        }
        return
      }

      if (confirmKind === 'uninstall') {
        const result = await window.tabtin.appCleanup.uninstallApp({
          deleteLocalData,
        })
        if (!result.ok) {
          const failures = [
            ...result.credentials.failed,
            ...(result.localData?.failed ?? []),
          ]
          toast({
            title: t('desktopCleanup.failed', {
              message: resolveCleanupFailureMessage(
                t,
                failures,
                platformCopy('uninstallHint'),
              ),
            }),
            variant: 'destructive',
          })
          return
        }
        await syncRendererLogout()
        toast({
          title: deleteLocalData
            ? t('desktopCleanup.successLocalData')
            : t('desktopCleanup.successCredentials'),
          description: platformCopy('uninstallHint'),
        })
      }
    } catch (error) {
      toast({
        title: t('desktopCleanup.failed', {
          message: resolveCleanupCatchMessage(t, error),
        }),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
      setConfirmKind(null)
      setDeleteLocalData(false)
    }
  }, [confirmKind, deleteLocalData, platformCopy, syncRendererLogout, t])

  const handleGuardedConfirm = useCallback(async () => {
    await runWithAgentContextSwitchGuard('logout', handleConfirm)
  }, [handleConfirm])

  const confirmTitle =
    confirmKind === 'credentials'
      ? t('desktopCleanup.wipeCredentialsConfirmTitle')
      : confirmKind === 'localData'
        ? t('desktopCleanup.wipeLocalDataConfirmTitle')
        : t('desktopCleanup.uninstallConfirmTitle')

  const confirmDescription =
    confirmKind === 'credentials'
      ? t('desktopCleanup.wipeCredentialsConfirmDesc')
      : confirmKind === 'localData'
        ? t('desktopCleanup.wipeLocalDataConfirmDesc')
        : platformCopy('uninstallConfirmDesc')

  return (
    <>
      <SettingsSectionCard
        title={t('desktopCleanup.title')}
        subtitle={(
          <>
            <p>{platformCopy('subtitle')}</p>
            <p className="mt-1.5">
              {t('desktopCleanup.wipeCredentials')}
              {'：'}
              {t('desktopCleanup.wipeCredentialsDesc')}
            </p>
            <p className="mt-1.5">
              {t('desktopCleanup.wipeLocalData')}
              {'：'}
              {t('desktopCleanup.wipeLocalDataDesc')}
            </p>
            <p className="mt-1.5">
              {t('desktopCleanup.uninstallApp')}
              {'：'}
              {platformCopy('uninstallAppDesc')}
            </p>
          </>
        )}
        subtitleAsTooltip
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body font-medium text-foreground pr-2">
              {t('desktopCleanup.wipeCredentials')}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmKind('credentials')}
            >
              {t('desktopCleanup.wipeCredentials')}
            </Button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-t border-border/30 pt-4">
            <p className="text-body font-medium text-foreground pr-2">
              {t('desktopCleanup.wipeLocalData')}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmKind('localData')}
            >
              {t('desktopCleanup.wipeLocalData')}
            </Button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-t border-border/30 pt-4">
            <p className="text-body font-medium text-foreground pr-2">
              {t('desktopCleanup.uninstallApp')}
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDeleteLocalData(false)
                setConfirmKind('uninstall')
              }}
            >
              {t('desktopCleanup.uninstallApp')}
            </Button>
          </div>
        </div>
      </SettingsSectionCard>

      <ConfirmDialog
        open={confirmKind != null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmKind(null)
            setDeleteLocalData(false)
          }
        }}
        title={confirmTitle}
        description={confirmDescription}
        variant="destructive"
        confirmText={
          confirmKind === 'uninstall'
            ? t('desktopCleanup.uninstallConfirmAction')
            : undefined
        }
        isLoading={busy}
        onConfirm={handleGuardedConfirm}
      >
        {confirmKind === 'uninstall' ? (
          <label className={cn(SETTINGS_TEXT_MICRO, 'mt-3 flex items-start gap-2 text-foreground')}>
            <Checkbox
              checked={deleteLocalData}
              onCheckedChange={(value) => setDeleteLocalData(value === true)}
              className="mt-0.5"
            />
            <span>{t('desktopCleanup.deleteLocalDataCheckbox')}</span>
          </label>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
