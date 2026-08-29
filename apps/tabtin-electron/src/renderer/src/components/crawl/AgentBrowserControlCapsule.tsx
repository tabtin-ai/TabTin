import { type RefObject, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Monitor, StopCircle } from 'lucide-react'
import { Button, toast } from '@components/ui'
import { useBrowserTabLockStore } from '@stores/useBrowserTabLockStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { isWebviewContainerEnabled } from '@/utils/browserContainerMode'
import { createLogger } from '@/utils/logger'
import {
  injectBrowserControlFacts,
  uniqueSessionIds,
} from './browserControlFacts'
import { useMountedPendingAction } from './useMountedPendingAction'
import { usePortalPaneRect } from './usePortalPaneRect'

export interface AgentBrowserControlCapsuleProps {
  paneRef: RefObject<HTMLElement | null>
  viewId: string
  isActive: boolean
  spaceId: string | null
}

type PendingAction = 'take-over' | 'hand-back' | 'stop'
type ControlAction = Exclude<PendingAction, 'stop'>

const log = createLogger('AgentBrowserControlCapsule')

export function AgentBrowserControlCapsule(props: AgentBrowserControlCapsuleProps) {
  const { paneRef, viewId, isActive } = props
  const { t } = useTranslation('crawl')
  const isLocked = useBrowserTabLockStore((state) => state.isLocked(viewId))
  const isUserControlling = useBrowserTabLockStore(
    (state) => state.isUserControlling(viewId),
  )
  const holderSessionIds = useBrowserTabLockStore(
    (state) => state.getSessionIds(viewId),
  )
  const uniqueHolderSessionIds = uniqueSessionIds(holderSessionIds)
  const holderTitle = useChatStore((state) => {
    for (const sessionId of uniqueHolderSessionIds) {
      const title = state.getSessionById(sessionId)?.title?.trim()
      if (title) return title
    }
    return null
  })
  const { pendingAction, begin, finish } = useMountedPendingAction<PendingAction>()
  const titleId = useId()
  const countId = useId()
  const statusId = useId()
  const shouldRender = isWebviewContainerEnabled()
    && isActive
    && (isLocked || isUserControlling)
  const paneRect = usePortalPaneRect(paneRef, shouldRender)
  const userHasControl = !isLocked && isUserControlling
  const action: ControlAction = userHasControl ? 'hand-back' : 'take-over'

  const showFailureToast = (titleKey: string) => {
    toast({
      title: t(titleKey),
      variant: 'destructive',
    })
  }

  const handleControlAction = async () => {
    if (!begin(action)) return
    try {
      const api = window.tabtin?.crawlView
      if (action === 'take-over') {
        const result = await api?.takeOverBrowser?.(viewId)
        if (!result?.success) {
          log.warn('浏览器控制权切换失败', { action, viewId, outcome: 'rejected' })
          showFailureToast('embedded.controlActionFailed')
          return
        }
        injectBrowserControlFacts({
          action,
          sessionIds: result.sessionIds,
          defaultContent: t('embedded.takeOverFact'),
          inject: useChatStore.getState().injectSystemMessage,
        })
        return
      }
      const result = await api?.handBackBrowser?.(viewId)
      if (!result?.success) {
        log.warn('浏览器控制权切换失败', { action, viewId, outcome: 'rejected' })
        showFailureToast('embedded.controlActionFailed')
        return
      }
      injectBrowserControlFacts({
        action,
        sessionIds: result.sessionIds,
        releasedSessionIds: result.releasedSessionIds,
        defaultContent: t('embedded.handBackFact'),
        releasedContent: t('embedded.handBackResumedFact'),
        inject: useChatStore.getState().injectSystemMessage,
      })
    } catch {
      log.warn('浏览器控制权切换异常', { action, viewId, outcome: 'exception' })
      showFailureToast('embedded.controlActionFailed')
    } finally {
      finish()
    }
  }

  const handleStopTasks = async () => {
    if (uniqueHolderSessionIds.length === 0 || !begin('stop')) return
    try {
      const results = await Promise.allSettled(uniqueHolderSessionIds.map(
        sessionId => useChatStore.getState().abortStreamFromComposer(sessionId),
      ))
      const failedCount = results.filter(result => result.status === 'rejected').length
      if (failedCount > 0) {
        log.warn('终止浏览器 holder 任务存在失败', {
          viewId,
          requestedCount: uniqueHolderSessionIds.length,
          failedCount,
        })
        showFailureToast('embedded.stopTaskFailed')
      }
    } finally {
      finish()
    }
  }

  if (!shouldRender || typeof document === 'undefined') return null

  const statusCopy = t(userHasControl
    ? 'embedded.userControlStatus'
    : 'embedded.agentControlStatus')
  const actionCopy = t(userHasControl ? 'embedded.handBack' : 'embedded.takeOver')
  const holderCount = uniqueHolderSessionIds.length
  const displayTitle = holderCount === 0
    ? t('embedded.taskUnavailable')
    : holderTitle ?? t('embedded.unknownTask')
  const countCopy = holderCount > 1
    ? t('embedded.taskCount', { count: holderCount })
    : null
  const stopCopy = holderCount > 1
    ? t('embedded.stopAllTasks', { count: holderCount })
    : t('embedded.stopTask')

  return createPortal(
    <div
      className="pointer-events-none fixed z-modal flex items-end justify-center pb-6"
      style={paneRect}
      data-testid="agent-browser-control-capsule"
    >
      <div
        className="pointer-events-auto flex max-w-[min(90%,36rem)] items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-caption shadow-sm backdrop-blur-md"
        role="group"
        aria-labelledby={[
          titleId,
          countCopy ? countId : null,
          statusId,
        ].filter(Boolean).join(' ')}
      >
        <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span id={titleId} className="min-w-0 truncate text-foreground">
          {displayTitle}
        </span>
        {countCopy ? (
          <span id={countId} className="shrink-0 text-muted-foreground">
            {countCopy}
          </span>
        ) : null}
        <span
          id={statusId}
          className="shrink-0 text-primary"
          role="status"
          aria-live="polite"
        >
          {statusCopy}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-interactive px-2.5 text-caption"
          disabled={pendingAction !== null}
          aria-busy={pendingAction === action || undefined}
          onClick={() => { void handleControlAction() }}
        >
          {actionCopy}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 gap-1 rounded-interactive px-2.5 text-caption"
          disabled={pendingAction !== null || holderCount === 0}
          aria-busy={pendingAction === 'stop' || undefined}
          onClick={() => { void handleStopTasks() }}
        >
          <StopCircle className="h-3.5 w-3.5" aria-hidden />
          {stopCopy}
        </Button>
      </div>
    </div>,
    document.body,
  )
}
