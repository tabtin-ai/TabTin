import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, LogIn, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, toast } from '@components/ui'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { cn } from '@utils/cn'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import {
  closeLoginRelayWorkbenchTab,
  openLoginRelayWorkbenchTab,
  type LoginRelayWorkbenchHandle,
} from '@/services/loginRelayWorkbench'
import { TEXT } from '../registry/chatDesignTokens'
import type { LoginRelayImportResult } from '@shared/types/login-relay'
import type { AskUserAnswer, AskUserQuestion } from '@tabtin/chat-client'

type LoginRelayStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'submitting'
  | 'cancelling'
  | 'cancel_error'
  | 'error'
  | 'complete'

const RELAY_CLEANUP_RETRY_MS = 1_000
const relayIdsAwaitingCleanup = new Set<string>()

function scheduleRelayCleanup(
  relayId: string,
  workbenchHandle?: LoginRelayWorkbenchHandle | null,
): void {
  if (workbenchHandle) {
    void closeLoginRelayWorkbenchTab(workbenchHandle).catch(() => undefined)
  }
  relayIdsAwaitingCleanup.add(relayId)
  void attemptRelayCleanup(relayId)
}

async function attemptRelayCleanup(relayId: string): Promise<void> {
  if (!relayIdsAwaitingCleanup.has(relayId)) return
  try {
    const result = await window.tabtin.loginRelay.cancel({ relayId })
    if (result.success) {
      relayIdsAwaitingCleanup.delete(relayId)
      return
    }
  } catch {
    // 组件已卸载时没有可交互入口；保留 ID 并在下一轮继续清理。
  }
  setTimeout(() => {
    void attemptRelayCleanup(relayId)
  }, RELAY_CLEANUP_RETRY_MS)
}

interface LoginRelayActionProps {
  spaceId: string
  threadId: string
  domain: string
  tabId?: string
  questions: AskUserQuestion[]
  onRelayComplete: (answers: AskUserAnswer[]) => void
  onSkip?: () => void
}

interface PreparedRelay {
  relayId: string
  workbenchHandle: LoginRelayWorkbenchHandle | null
}

interface PrepareRelayInput {
  spaceId: string
  tabScopeKey: string
  organizationId: string
  domain: string
  startFailedMessage: string
}

async function cancelRelayAndWorkbench(
  relayId: string,
  workbenchHandle: LoginRelayWorkbenchHandle | null,
  cancelFailedMessage: string,
): Promise<void> {
  const result = await window.tabtin.loginRelay.cancel({ relayId })
  if (!result.success) throw new Error(result.error || cancelFailedMessage)
  if (workbenchHandle) await closeLoginRelayWorkbenchTab(workbenchHandle)
}

async function prepareRelay(input: PrepareRelayInput): Promise<PreparedRelay> {
  const result = await window.tabtin.loginRelay.start({
    spaceId: input.spaceId,
    organizationId: input.organizationId,
    domain: input.domain,
  })
  if (!result.success || !result.relayId) {
    throw new Error(result.error || input.startFailedMessage)
  }
  if (!result.partition || !result.loginUrl) {
    scheduleRelayCleanup(result.relayId)
    throw new Error(input.startFailedMessage)
  }

  const opened = await openLoginRelayWorkbenchTab({
    tabScopeKey: input.tabScopeKey,
    relayId: result.relayId,
    organizationId: input.organizationId,
    partition: result.partition,
    loginUrl: result.loginUrl,
    domain: input.domain,
  })
  if (!opened.ok) {
    scheduleRelayCleanup(result.relayId)
    throw new Error(opened.error)
  }
  return {
    relayId: result.relayId,
    workbenchHandle: opened.handle,
  }
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function isInternalRelayErrorCode(value: string | undefined): boolean {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value)
}

function importFailureMessage(
  result: LoginRelayImportResult | undefined,
  fallback: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (result?.success && result.reloaded !== true) {
    return t('askUser.loginRelay.reloadFailed', {
      defaultValue: '执行设备未能刷新登录页面，请重试。',
    })
  }
  switch (result?.error_code) {
    case 'cookie_write_failed':
      return t('askUser.loginRelay.importCookieWriteFailed', {
        defaultValue: '执行设备写入登录信息失败，请稍后重试。',
      })
    case 'partition_unavailable':
      return t('askUser.loginRelay.importPartitionUnavailable', {
        defaultValue: '执行设备的浏览器环境不可用，请确认执行设备在线后重试。',
      })
    case 'consume_failed':
      return t('askUser.loginRelay.importConsumeFailed', {
        defaultValue: '执行设备未能获取登录接力包，请稍后重试。',
      })
    case 'target_tab_unavailable':
    case 'target_tab_mismatch':
    case 'reload_failed':
      return t('askUser.loginRelay.reloadFailed', {
        defaultValue: '执行设备未能刷新登录页面，请重试。',
      })
    default:
      return result?.error && !isInternalRelayErrorCode(result.error)
        ? result.error
        : fallback
  }
}

function buildRelayCompletionAnswers(questions: AskUserQuestion[]): AskUserAnswer[] {
  return questions.map(question => ({
    question_id: question.id,
    selected_options: ['__other__'],
    free_text: '登录态已同步至执行设备，原页面已刷新，请继续原任务。',
  }))
}

// 登录接力的生命周期状态集中在此组件，业务副作用已拆到上方 helper。
/* eslint-disable complexity */
export const LoginRelayAction: React.FC<LoginRelayActionProps> = ({
  spaceId,
  threadId,
  domain,
  tabId,
  questions,
  onRelayComplete,
  onSkip,
}) => {
  const { t } = useTranslation('chat')
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id ?? null)
  const [status, setStatus] = useState<LoginRelayStatus>('idle')
  const [relayId, setRelayId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const relayIdRef = useRef<string | null>(null)
  const workbenchHandleRef = useRef<LoginRelayWorkbenchHandle | null>(null)
  const isMountedRef = useRef(true)

  const clearRelay = useCallback(() => {
    relayIdRef.current = null
    workbenchHandleRef.current = null
    setRelayId(null)
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    clearRelay()
    setError(null)
  }, [clearRelay])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      const activeRelayId = relayIdRef.current
      if (activeRelayId) {
        const workbenchHandle = workbenchHandleRef.current
        relayIdRef.current = null
        workbenchHandleRef.current = null
        scheduleRelayCleanup(activeRelayId, workbenchHandle)
      }
    }
  }, [])

  const handleStart = useCallback(async () => {
    if (!organizationId) {
      setError(t('askUser.loginRelay.organizationMissing', { defaultValue: '当前组织不可用，请稍后重试。' }))
      setStatus('error')
      return
    }

    setStatus('starting')
    setError(null)
    try {
      const prepared = await prepareRelay({
        spaceId,
        tabScopeKey: resolveForegroundTabScopeKey(spaceId) || spaceId,
        organizationId,
        domain,
        startFailedMessage: t('askUser.loginRelay.startFailed', {
          defaultValue: '无法准备登录接力，请稍后重试。',
        }),
      })

      if (!isMountedRef.current) {
        scheduleRelayCleanup(prepared.relayId, prepared.workbenchHandle)
        return
      }
      relayIdRef.current = prepared.relayId
      workbenchHandleRef.current = prepared.workbenchHandle
      setRelayId(prepared.relayId)
      setStatus('ready')
    } catch (cause) {
      if (!isMountedRef.current) return
      setError(messageFrom(cause, t('askUser.loginRelay.startFailed', {
        defaultValue: '无法准备登录接力，请稍后重试。',
      })))
      setStatus('error')
    }
  }, [domain, organizationId, spaceId, t])

  const handleComplete = useCallback(async () => {
    if (!relayId) return
    setStatus('submitting')
    setError(null)
    try {
      const result = await window.tabtin.loginRelay.complete({ relayId, threadId, ...(tabId ? { tabId } : {}) })
      if (
        !result.success
        || result.importResult?.success !== true
        || (tabId && result.importResult.reloaded !== true)
      ) {
        const fallback = t('askUser.loginRelay.completeFailed', {
          defaultValue: '登录态发送失败，请重试。',
        })
        const errorMessage = result.importResult
          ? importFailureMessage(result.importResult, fallback, t)
          : result.error && !isInternalRelayErrorCode(result.error)
            ? result.error
            : fallback
        throw new Error(errorMessage)
      }
      const activeWorkbenchHandle = workbenchHandleRef.current
      if (activeWorkbenchHandle) {
        await closeLoginRelayWorkbenchTab(activeWorkbenchHandle)
      }
      const importedCount = result.importResult?.imported_count ?? 0
      clearRelay()
      if (tabId) {
        toast({
          title: t('askUser.loginRelay.completeAndReloadSuccess', {
            defaultValue: '登录态已同步，执行设备页面已刷新。',
          }),
        })
        onRelayComplete(buildRelayCompletionAnswers(questions))
        return
      }
      toast({
        title: t('askUser.loginRelay.completeSuccess', {
          count: importedCount,
          defaultValue: '登录态已发送，导入 {{count}} 条；请在下方卡片选择继续。',
        }),
      })
      setStatus('complete')
    } catch (cause) {
      const completeError = messageFrom(cause, t('askUser.loginRelay.completeFailed', {
        defaultValue: '登录态发送失败，请重试。',
      }))
      try {
        await cancelRelayAndWorkbench(
          relayId,
          workbenchHandleRef.current,
          t('askUser.loginRelay.cancelFailed', { defaultValue: '取消登录接力失败，请重试。' }),
        )
        clearRelay()
        setError(completeError)
        setStatus('error')
      } catch (cancelCause) {
        setError(messageFrom(cancelCause, t('askUser.loginRelay.cancelFailed', {
          defaultValue: '取消登录接力失败，请重试。',
        })))
        setStatus('cancel_error')
      }
    }
  }, [clearRelay, onRelayComplete, questions, relayId, t, tabId, threadId])

  const handleCancel = useCallback(async () => {
    if (!relayId) {
      reset()
      return
    }
    setStatus('cancelling')
    setError(null)
    try {
      await cancelRelayAndWorkbench(
        relayId,
        workbenchHandleRef.current,
        t('askUser.loginRelay.cancelFailed', { defaultValue: '取消登录接力失败，请重试。' }),
      )
      reset()
    } catch (cause) {
      setError(messageFrom(cause, t('askUser.loginRelay.cancelFailed', {
        defaultValue: '取消登录接力失败，请重试。',
      })))
      setStatus('cancel_error')
    }
  }, [relayId, reset, t])

  const isReady = status === 'ready'
  const isStarting = status === 'starting'

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5" data-testid="login-relay-action">
      {isReady || status === 'submitting' || status === 'cancelling' ? (
        <div className="space-y-2">
          <p className={cn(TEXT.body, 'text-foreground')} role="status">
            {t('askUser.loginRelay.loginReadyHint', {
              domain,
              defaultValue: '已在右侧工作台打开 {{domain}}；确认已登录后再发送。',
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void handleComplete()} disabled={!isReady}>
              {status === 'submitting'
                ? t('askUser.loginRelay.submitting', { defaultValue: '正在同步并刷新执行页面…' })
                : t('askUser.loginRelay.complete', { defaultValue: '我已登录，发送给执行设备' })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCancel()} disabled={!isReady}>
              {status === 'cancelling'
                ? t('askUser.loginRelay.cancelling', { defaultValue: '正在取消…' })
                : t('askUser.loginRelay.cancel', { defaultValue: '取消' })}
            </Button>
          </div>
        </div>
      ) : status === 'cancel_error' ? (
        <Button type="button" size="sm" onClick={() => void handleCancel()}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t('askUser.loginRelay.retryCancel', { defaultValue: '再次取消' })}
        </Button>
      ) : status === 'complete' ? (
        <p className={cn(TEXT.body, 'text-foreground')} role="status">
          {t('askUser.loginRelay.sent', { defaultValue: '登录态已发送。请在下方卡片选择继续。' })}
        </p>
      ) : (
        <div className="space-y-2">
          <p className={cn(TEXT.body, 'text-foreground')} role="status">
            {t('askUser.loginRelay.remoteLoginRequiredHint', {
              defaultValue: '远程页面需要登录后才能继续。你可以在本机完成登录，再将登录状态接力到执行设备。',
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void handleStart()} disabled={isStarting}>
              {isStarting ? (
                <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />{t('askUser.loginRelay.starting', { defaultValue: '正在准备登录接力…' })}</>
              ) : (
                <><LogIn className="mr-1 h-3.5 w-3.5" aria-hidden />{t('askUser.loginRelay.start', { defaultValue: '在本机登录并接力' })}</>
              )}
            </Button>
            {status === 'error' && (
              <Button type="button" size="sm" variant="ghost" onClick={() => void handleStart()}>
                <X className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t('askUser.loginRelay.retry', { defaultValue: '重试' })}
              </Button>
            )}
            {onSkip ? (
              <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
                {t('askUser.loginRelay.skip', { defaultValue: '暂不登录' })}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className={cn(TEXT.meta, 'mt-2 text-destructive')} role="alert">{error}</p> : null}
    </div>
  )
}
/* eslint-enable complexity */
