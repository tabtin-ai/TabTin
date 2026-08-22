import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui'
import { startIMProvider, stopIMProvider } from '@/services/tabchatApi'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'

type BlockReason = 'session_kicked' | 'recovery_failed'

export function IMSessionKickedHost() {
  const { t } = useTranslation('auth')
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<BlockReason>('session_kicked')
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState(false)
  const handled = useRef(false)

  useEffect(() => {
    const showBlockingDialog = (nextReason: BlockReason) => {
      if (handled.current) return
      handled.current = true
      setReason(nextReason)
      setError(false)
      setOpen(true)
    }
    const onKicked = () => showBlockingDialog('session_kicked')
    const onRecoveryFailed = () => showBlockingDialog('recovery_failed')
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 账号踢出是 App 级安全事件，不受当前 Space 活跃态影响。
    window.addEventListener('im:session-kicked', onKicked)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- IM 恢复失败是 App 级阻断事件，不受当前 Space 活跃态影响。
    window.addEventListener('im:connection-recovery-failed', onRecoveryFailed)
    return () => {
      window.removeEventListener('im:session-kicked', onKicked)
      window.removeEventListener('im:connection-recovery-failed', onRecoveryFailed)
    }
  }, [])

  const closeDialog = () => {
    setOpen(false)
    handled.current = false
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true)
      return
    }
    closeDialog()
    void useAuthStore.getState().logout(reason === 'session_kicked' ? 'session_revoked' : 'manual')
  }

  const reconnect = async () => {
    const userId = useAuthStore.getState().user?.id
    const organizationId = useOrganizationStore.getState().selectedOrganization?.id
    if (!userId || !organizationId) {
      setError(true)
      return
    }

    setReconnecting(true)
    setError(false)
    try {
      await stopIMProvider()
      await startIMProvider({ organizationId, userId })
      useIMStore.getState().setConnectionStatus('connected')
      closeDialog()
    } catch {
      setError(true)
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" closeLabel={t('sessionKicked.dismiss', { defaultValue: '关闭提示' })}>
        <DialogHeader>
          <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-warning/10 text-warning">
            <RefreshCw className="h-5 w-5" aria-hidden />
          </div>
          <DialogTitle className="text-subtitle font-semibold">
            {reason === 'session_kicked'
              ? t('sessionKicked.title', { defaultValue: '已在其他设备登录对话' })
              : t('connectionRecoveryFailed.title', { defaultValue: '消息服务连接失败' })}
          </DialogTitle>
          <DialogDescription className="text-body text-muted-foreground/80">
            {reason === 'session_kicked'
              ? t('sessionKicked.description', {
                  defaultValue: '可尝试重新连接。重新连接会使其他设备下线。',
                })
              : t('connectionRecoveryFailed.description', {
                  defaultValue: '网络连接持续异常，消息服务无法恢复。请检查网络后重新连接。',
                })}
          </DialogDescription>
          {error && (
            <p role="alert" className="text-caption text-destructive">
              {t('sessionKicked.reconnectFailed', { defaultValue: '重新连接失败，请稍后再试。' })}
            </p>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="link" autoFocus disabled={reconnecting} onClick={() => void reconnect()}>
            {reconnecting
              ? t('sessionKicked.reconnecting', { defaultValue: '正在重新连接…' })
              : t('sessionKicked.reconnect', { defaultValue: '重新连接' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
