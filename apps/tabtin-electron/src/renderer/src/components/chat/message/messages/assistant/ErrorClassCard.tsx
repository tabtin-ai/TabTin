import React, { useCallback, useState } from 'react'
import { cn } from '@utils/cn'
import { Trans, useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { ConfirmDialog } from '@components/ui'
import { isProjectTaskEditAndResendBlocked } from '@/stores/chat/messages/product/delivery/projectTaskSendGate'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { useSpaceStore } from '../../../../../stores/useSpaceStore'
import { useSettingsSpaceStore } from '../../../../../stores/useSettingsSpaceStore'
import { useAgentSettingsSheetStore } from '../../../../../stores/useAgentSettingsSheetStore'
import { useChatStore } from '../../../../../stores/chat/useChatStore'
import { useSessionAccessStore } from '../../../../../stores/chat/session/sessionAccessStore'
import type { ErrorClassInfo } from '@utils/chat/messageErrorClassMap'

// eslint-disable-next-line complexity -- 错误卡是后端错误分类到用户动作的展示矩阵，保持同处便于审计。
export const ErrorClassCard: React.FC<{ info: ErrorClassInfo; sessionId?: string | null }> = React.memo(({ info, sessionId = null }) => {
  const { t } = useTranslation('chat')
  const [reloginConfirmOpen, setReloginConfirmOpen] = useState(false)
  const isWarning = info.severity === 'warning'
  const Icon = isWarning ? AlertTriangle : AlertCircle
  // ：失败 Project Task 会话不展示会话内「重试」，引导任务页「重新运行」。
  const projectTaskResendBlocked = isProjectTaskEditAndResendBlocked(sessionId)
  const openSettingsSheet = useAgentSettingsSheetStore(s => s.open)
  const selectedSpaceId = useSpaceStore(s => s.selectedSpace?.id ?? null)
  const sharedAccess = useSessionAccessStore(s => sessionId ? s.bySessionId[sessionId] : undefined)
  const sharedGranteeCannotSwitchModel = Boolean(
    sharedAccess && sharedAccess.role !== 'owner' && info.suggestedAction === 'switch_model',
  )
  const sessionSpaceId = useChatStore((s) => {
    const sid = sessionId ?? s.currentSessionId
    if (!sid) return null
    const fromSessions = s.sessions.find(item => item.id === sid)?.space_id
    if (typeof fromSessions === 'string' && fromSessions.length > 0) return fromSessions
    for (const [spaceId, list] of Object.entries(s.sessionsBySpaceId ?? {})) {
      if (list?.some(item => item.id === sid)) return spaceId
    }
    return null
  })
  const spaceId = sessionSpaceId ?? selectedSpaceId

  const handleRetry = useCallback(() => {
    if (isProjectTaskEditAndResendBlocked(sessionId)) return
    window.dispatchEvent(new CustomEvent('chat:retry-last-message', {
      detail: { sessionId },
    }))
  }, [sessionId])

  const handleOpenExecutionLimits = useCallback(() => {
    if (!spaceId) return
    openSettingsSheet('execution-limits', spaceId, { sessionId })
  }, [spaceId, openSettingsSheet, sessionId])

  const handleAction = useCallback(() => {
    const action = info.suggestedAction
    if (action === 'check_billing') {
      useSettingsSpaceStore.getState().openSettings({ category: 'organization', section: 'general' })
    } else if (action === 'relogin') {
      setReloginConfirmOpen(true)
    } else if (action === 'shorten_context') {
      const space = useSpaceStore.getState().selectedSpace
      if (space?.id) {
        void useChatStore.getState().createSession(space.id)
      }
    } else if (action === 'switch_model') {
      window.dispatchEvent(new Event('chat:open-model-selector'))
    } else if (action === 'retry_later') {
      handleRetry()
    } else if (action === 'open_execution_limits') {
      handleOpenExecutionLimits()
    }
  }, [info.suggestedAction, handleRetry, handleOpenExecutionLimits])

  const handleReloginConfirm = useCallback(() => {
    import('../../../../../stores/useAuthStore').then(({ useAuthStore }) => {
      void runWithAgentContextSwitchGuard('logout', () => useAuthStore.getState().logout('manual'))
    })
  }, [])

  const ACTION_LABELS: Record<string, string> = {
    check_billing: t('billing.goRecharge', { defaultValue: '去充值' }),
    relogin: t('errorAction.relogin', { defaultValue: '重新登录' }),
    shorten_context: t('errorAction.newSession', { defaultValue: '新任务' }),
    switch_model: t('errorAction.switchModel', { defaultValue: '换模型' }),
    retry_later: t('errorAction.retry', { defaultValue: '重试' }),
    // 执行限制：主交互在 suggestion 内联链接；无 spaceId 时才露出按钮兜底。
    open_execution_limits: t('errorAction.openExecutionLimits', { defaultValue: '去设置' }),
  }
  const hideRetryAction = projectTaskResendBlocked && info.suggestedAction === 'retry_later'
  const useInlineExecutionLimitsLink =
    info.suggestedAction === 'open_execution_limits'
    && !!info.suggestionKey
    && !!spaceId
  const actionLabel = info.suggestedAction
    && !hideRetryAction
    && !useInlineExecutionLimitsLink
    && !sharedGranteeCannotSwitchModel
    ? ACTION_LABELS[info.suggestedAction]
    : undefined
  // open_execution_limits 且无 spaceId：仍可出「去设置」按钮（点击 no-op 前已有 space 校验）
  const showOpenLimitsFallback =
    info.suggestedAction === 'open_execution_limits'
    && !useInlineExecutionLimitsLink
    && !!spaceId
  const showFallbackRetry = info.retryable
    && !actionLabel
    && !showOpenLimitsFallback
    && !projectTaskResendBlocked
    && !sharedGranteeCannotSwitchModel

  const suggestionClassName = cn(
    'mt-1 text-caption',
    isWarning ? 'text-warning/80' : 'text-destructive/80',
  )
  const linkClassName = cn(
    'underline underline-offset-2 font-medium hover:opacity-80',
    isWarning ? 'text-warning' : 'text-destructive',
  )

  return (
    <>
      <div className={cn(
        'mt-1 rounded-lg border px-3 py-2.5',
        isWarning
          ? 'border-warning/30'
          : 'border-destructive/30',
      )}>
        <div className={cn(
          'flex items-center gap-1.5 text-body font-medium',
          isWarning ? 'text-warning' : 'text-destructive',
        )}>
          <Icon className="h-4 w-4 shrink-0" />
          {info.title}
        </div>
        {useInlineExecutionLimitsLink ? (
          <p className={suggestionClassName}>
            <Trans
              ns="chat"
              i18nKey={info.suggestionKey}
              components={{
                settingsLink: (
                  <button
                    type="button"
                    onClick={handleOpenExecutionLimits}
                    className={linkClassName}
                    data-testid="error-class-open-execution-limits"
                  />
                ),
              }}
            />
          </p>
        ) : (
          <p className={suggestionClassName}>
            {sharedGranteeCannotSwitchModel
              ? t('errorAction.sharedModelManagedByOwner', {
                defaultValue: '共享任务的模型由任务所有者管理，请联系对方切换模型后重试。',
              })
              : info.suggestion}
          </p>
        )}
        {(actionLabel || showOpenLimitsFallback) && (
          <button
            type="button"
            onClick={handleAction}
            className={cn(
              'mt-2 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-caption font-medium transition-colors',
              isWarning
                ? 'border border-warning/30 text-warning hover:bg-warning/5'
                : 'border border-destructive/30 text-destructive hover:bg-destructive/5',
            )}
            data-testid={showOpenLimitsFallback ? 'error-class-open-execution-limits' : undefined}
          >
            {actionLabel ?? ACTION_LABELS.open_execution_limits}
          </button>
        )}
        {showFallbackRetry && (
          <button
            type="button"
            onClick={handleRetry}
            className={cn(
              'mt-2 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-caption font-medium transition-colors',
              isWarning
                ? 'border border-warning/30 text-warning hover:bg-warning/5'
                : 'border border-destructive/30 text-destructive hover:bg-destructive/5',
            )}
          >
            {t('errorAction.retry', { defaultValue: '重试' })}
          </button>
        )}
      </div>
      {info.suggestedAction === 'relogin' && (
        <ConfirmDialog
          open={reloginConfirmOpen}
          onOpenChange={setReloginConfirmOpen}
          title={t('errorAction.reloginConfirmTitle', { defaultValue: '确认重新登录' })}
          description={t('errorAction.reloginConfirmDesc', {
            defaultValue: '登录状态已过期，需要重新登录。\n\n退出后当前页面未保存的内容将丢失，确定继续？',
          })}
          onConfirm={handleReloginConfirm}
          variant="destructive"
        />
      )}
    </>
  )
})
ErrorClassCard.displayName = 'ErrorClassCard'
