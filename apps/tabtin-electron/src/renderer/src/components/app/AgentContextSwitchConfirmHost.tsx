import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingSpinner,
} from '@tabtin/smartsheet-ui'
import {
  cancelAgentContextSwitchConfirm,
  confirmAgentContextSwitch,
  useAgentContextSwitchConfirmStore,
} from './agentContextSwitchConfirm'

export function AgentContextSwitchConfirmHost(): React.ReactElement {
  const { t } = useTranslation(['common', 'settings'])
  const open = useAgentContextSwitchConfirmStore((state) => state.open)
  const kind = useAgentContextSwitchConfirmStore((state) => state.kind)
  const sessions = useAgentContextSwitchConfirmStore((state) => state.sessions)
  const isStopping = useAgentContextSwitchConfirmStore((state) => state.isStopping)
  const error = useAgentContextSwitchConfirmStore((state) => state.error)
  const actionLabel = kind === 'organization'
    ? t('agentContextSwitch.switchOrganization', { defaultValue: '切换组织' })
    : t('agentContextSwitch.logout', { defaultValue: '退出登录' })
  const confirmLabel = kind === 'organization'
    ? t('agentContextSwitch.stopAndSwitch', { defaultValue: '停止并切换' })
    : t('agentContextSwitch.stopAndLogout', { defaultValue: '停止并退出' })

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isStopping) cancelAgentContextSwitchConfirm()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-subtitle font-semibold">
            {t('agentContextSwitch.title', { defaultValue: '正在运行的 Agent 需要先停止' })}
          </DialogTitle>
          <DialogDescription className="text-body text-muted-foreground/80">
            {t('agentContextSwitch.description', {
              defaultValue: `继续${actionLabel}会中断以下任务。停止后才会继续此操作。`,
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 space-y-2 overflow-y-auto rounded-interactive border border-border/60 px-3 py-2" aria-label="正在运行的 Agent 任务">
          {sessions.map((session) => (
            <li key={session.sessionId} className="flex items-center justify-between gap-3 text-body">
              <span className="min-w-0 truncate text-foreground">{session.title}</span>
              <span className="shrink-0 text-caption text-muted-foreground/60">
                {session.queuedCount > 0
                  ? t('agentContextSwitch.queued', { count: session.queuedCount, defaultValue: `排队 ${session.queuedCount}` })
                  : t('agentContextSwitch.running', { defaultValue: '运行中' })}
              </span>
            </li>
          ))}
        </ul>
        {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:space-x-2">
          <Button
            type="button"
            variant="outline"
            className="w-full text-body sm:w-auto"
            disabled={isStopping}
            onClick={cancelAgentContextSwitchConfirm}
          >
            {t('cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full text-body sm:w-auto"
            disabled={isStopping}
            onClick={() => void confirmAgentContextSwitch()}
          >
            {isStopping ? <LoadingSpinner size="sm" /> : null}
            {isStopping
              ? t('agentContextSwitch.stopping', { defaultValue: '正在停止…' })
              : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
