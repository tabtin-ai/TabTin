/**
 * useSystemSleepRecovery — 系统睡眠/唤醒恢复 Hook
 *
 * 监听主进程通过 IPC 发送的 system:suspend / system:resume 事件，
 * 在睡眠前停止心跳、主动关闭连接；唤醒后由主进程 SystemSleepGuard
 * 统一恢复 Agent Gateway，本 hook 通过防抢跑入口恢复 renderer Chat Gateway
 * 并恢复 IM/Centrifugo、重启心跳，避免并发风暴。
 *
 * 与 useConnectionRecovery 协作：renderer Gateway 重连前会避让主进程
 * recovering 状态，重连成功后 WS 状态变为 connected，自动触发 store 恢复逻辑。
 *
 * 挂载位置：useShellRuntimeEffects（全局唯一）
 */

import { useEffect, useRef } from 'react'
import { stopHeartbeat, startHeartbeat, ensureDeviceRegistered, useDeviceStore } from '@/stores/useDeviceStore'
import { tryReconnectGateway } from '@/hooks/useConnectionRecovery'
import { disconnectCentrifugo, reconnectCentrifugo } from '@/hooks/useCentrifugoClient'
import { getChatClientInstance } from '@/services/chatClientSingleton'
import { logger } from '@/utils/logger'

const HEARTBEAT_RESTART_DELAY_MS = 5_000

export function useSystemSleepRecovery(): void {
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const api = window.tabtin?.system
    if (!api) return

    const offSuspend = api.onSuspend(() => {
      logger.log('[SleepRecovery] 系统即将休眠，停止心跳并关闭连接')
      stopHeartbeat()
      try { disconnectCentrifugo() } catch (e) { logger.warn('[SleepRecovery] Centrifugo disconnect failed:', e) }
      try { getChatClientInstance()?.getGateway()?.close() } catch { /* ChatClient 可能未初始化 */ }
    })

    const offResume = api.onResume(() => {
      logger.log('[SleepRecovery] 系统已唤醒，开始恢复连接')
      tryReconnectGateway()
      try { reconnectCentrifugo() } catch (e) { logger.warn('[SleepRecovery] Centrifugo reconnect failed:', e) }

      try {
        getChatClientInstance()?.getStreamManager()?.refreshAllSlotTimers()
        logger.log('[SleepRecovery] StreamManager slot 计时器已重置')
      } catch { /* ChatClient 可能未初始化 */ }

      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current)
      }
      heartbeatTimerRef.current = setTimeout(() => {
        heartbeatTimerRef.current = null
        // /#363：未注册时直接发心跳会 404，先补注册（成功后内部启动心跳）
        if (useDeviceStore.getState().registered) {
          startHeartbeat()
          logger.log('[SleepRecovery] 心跳已重启')
        } else {
          ensureDeviceRegistered()
          logger.log('[SleepRecovery] 设备未注册，触发补注册')
        }
      }, HEARTBEAT_RESTART_DELAY_MS)
    })

    return () => {
      offSuspend()
      offResume()
      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
    }
  }, [])
}
