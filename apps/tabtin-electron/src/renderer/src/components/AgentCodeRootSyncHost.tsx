import { useEffect } from 'react'
import type { SessionCodeRootChangedEvent } from '@shared/session-code-root-events'
import { applySessionCodeRootChange } from './context-space/code-workspace/switchSessionWorktree'
import { createLogger } from '@/utils/logger'
import { mirrorSessionCodeRootBinding } from '@/services/sessionCodeRootBinding'

const log = createLogger('AgentCodeRootSyncHost')

/** 把 main 端已提交的 Agent worktree 切换投影到当前 renderer。 */
export function AgentCodeRootSyncHost(): null {
  useEffect(() => {
    const subscribe = window.tabtin?.agentEngine?.onSessionCodeRootChanged
    if (!subscribe) return
    return subscribe((event: SessionCodeRootChangedEvent) => {
      if (!event.sessionId || !event.rootPath) return
      try {
        mirrorSessionCodeRootBinding(event.sessionId, {
          rootPath: event.rootPath,
          tabKey: event.tabScopeKey || null,
          branch: event.branch,
          title: event.branch,
        })
        applySessionCodeRootChange({
          sessionId: event.sessionId,
          spaceId: event.spaceId,
          tabScopeKey: event.tabScopeKey,
          previousRootPath: event.previousRootPath,
          rootPath: event.rootPath,
        })
      } catch (error) {
        // main 端绑定已提交；renderer 投影失败只能记录，不能伪装成切换回滚。
        log.error('failed to project Agent code-root change', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
      }
    })
  }, [])

  return null
}
