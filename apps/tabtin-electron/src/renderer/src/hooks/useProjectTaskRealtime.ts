/**
 * Project Task 实时失效兜底。
 *
 * 主路径：chatApi `agent.user.project_task_invalidated` → store.applyInvalidation。
 * 本 hook 负责：挂载时 track + 首拉；WS 重连 / 窗口焦点恢复时 revalidate。
 */

import { useEffect, useRef } from 'react'
import { getChatClient } from '@/services/chatApi'
import {
  useScopedEventListener,
  useScopedSubscribe,
} from '@/hooks/spaceActivity'
import { useProjectTaskStore } from '@/stores/useProjectTaskStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('ProjectTaskRealtime')

export function useProjectTaskRealtime(projectId: string | null | undefined): void {
  const trackProject = useProjectTaskStore(state => state.trackProject)
  const fetchTasks = useProjectTaskStore(state => state.fetchTasks)
  const fetchInbox = useProjectTaskStore(state => state.fetchInbox)
  const revalidateProject = useProjectTaskStore(state => state.revalidateProject)

  useEffect(() => {
    if (!projectId) return
    trackProject(projectId)
    void fetchTasks(projectId)
    void fetchInbox(projectId)
  }, [projectId, trackProject, fetchTasks, fetchInbox])

  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const revalidateRef = useRef(revalidateProject)
  revalidateRef.current = revalidateProject

  const onFocusOrVisible = () => {
    if (document.visibilityState === 'hidden') return
    const id = projectIdRef.current
    if (!id) return
    void revalidateRef.current(id)
  }

  useScopedEventListener(window, 'focus', onFocusOrVisible, {
    scope: 'hot',
    enabled: Boolean(projectId),
  })
  useScopedEventListener(document, 'visibilitychange', onFocusOrVisible, {
    scope: 'hot',
    enabled: Boolean(projectId),
  })

  useScopedSubscribe(
    () => {
      try {
        const gateway = getChatClient().getGateway()
        const handler = () => {
          const id = projectIdRef.current
          if (!id) return
          void revalidateRef.current(id)
        }
        gateway.onReconnectedEvent(handler)
        return () => {
          try {
            gateway.offReconnectedEvent(handler)
          } catch {
            /* gateway 可能已销毁 */
          }
        }
      } catch (err) {
        log.warn('gateway reconnect attach failed', err)
        return undefined
      }
    },
    [projectId],
    { scope: 'hot', enabled: Boolean(projectId) },
  )
}
