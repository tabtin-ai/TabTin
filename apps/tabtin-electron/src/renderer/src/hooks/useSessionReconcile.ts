import { useEffect } from 'react'
import { startSessionReconcileWatcher } from '@/stores/chat/execution/sessionReconcileWatcher'

/**
 * 会话心跳兜底对账的 React 生命周期绑定。
 *
 * 业务逻辑全部下沉到 `stores/chat/execution/sessionReconcileWatcher.ts`；本 hook
 * 只把命令式 watcher 绑到组件的 mount/unmount（React 唯一无法下沉的那一层）。
 */
export function useSessionReconcile(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return
    return startSessionReconcileWatcher(sessionId)
  }, [sessionId])
}
