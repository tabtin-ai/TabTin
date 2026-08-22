/**
 * SystemSleepGuard — 系统睡眠/唤醒感知层
 *
 * 监听 powerMonitor 的 suspend / resume 事件，在系统睡眠前主动断开
 * WS 连接、暂停服务定时器；唤醒后延迟重连、重启服务，并通过 IPC
 * 通知渲染进程做相应恢复。
 *
 * 这是解决「睡眠一晚后界面卡死」的核心模块。
 */

import { powerMonitor, type BrowserWindow } from 'electron'
import type { ElectronWsGateway } from './ws/ElectronWsGateway'
import type { EventPersistence } from './run-session/EventPersistence'
import { getViewFactory } from './view-factory'
import { createLogger } from './logger'
import { waitForApiReachable } from './network/wait-for-api-reachable'

const log = createLogger('SystemSleepGuard')

const RESUME_DELAY_MS = 3_000

export interface SleepGuardDeps {
  getMainWindow: () => BrowserWindow | null
  wsGateway: ElectronWsGateway
  agentServicePause: () => void
  agentServiceResume: () => void
  eventPersistence: EventPersistence
}

export function installSystemSleepGuard(deps: SleepGuardDeps): () => void {
  let isSuspended = false
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const notifyRenderer = (channel: string) => {
    const win = deps.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel)
    }
  }

  const handleSuspend = () => {
    if (isSuspended || disposed) return
    isSuspended = true
    log.info('系统即将休眠，主动断开连接并暂停服务')

    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }

    deps.wsGateway.suspend()
    deps.agentServicePause()
    deps.eventPersistence.pauseFlush()

    notifyRenderer('system:suspend')
  }

  const handleResume = () => {
    if (!isSuspended || disposed) return
    isSuspended = false
    log.info('系统已唤醒，延迟重连...')
    deps.wsGateway.markResumeRecovering()

    if (resumeTimer) {
      clearTimeout(resumeTimer)
    }

    resumeTimer = setTimeout(async () => {
      resumeTimer = null
      if (isSuspended || disposed) return
      log.info('开始恢复服务...')

      try {
        const probe = await waitForApiReachable()
        if (!probe.ok) {
          log.warn('API health probe did not recover before WS reconnect', probe)
        }
      } catch (err) {
        log.warn('API health probe failed unexpectedly, continuing resume', err)
      }

      if (isSuspended || disposed) return

      try {
        const connected = await deps.wsGateway.reconnectAfterResume()
        if (!connected) {
          deps.wsGateway.clearResumeRecovering()
        }
      } catch (err) {
        log.warn('WS 重连失败:', err)
        deps.wsGateway.clearResumeRecovering()
      }

      if (isSuspended || disposed) return

      try {
        deps.agentServiceResume()
        deps.eventPersistence.resumeFlush()
      } catch (err) {
        log.warn('部分服务恢复失败:', err)
      }

      try {
        const vf = getViewFactory()
        vf.touchAllViews()
        log.info('ViewFactory idle 计时器已重置')
      } catch (err) {
        log.warn('ViewFactory touchAllViews 失败:', err)
      }

      notifyRenderer('system:resume')
      log.info('服务恢复完成')
    }, RESUME_DELAY_MS)
  }

  powerMonitor.on('suspend', handleSuspend)
  powerMonitor.on('resume', handleResume)

  log.info('已安装')

  return () => {
    disposed = true
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    powerMonitor.removeListener('suspend', handleSuspend)
    powerMonitor.removeListener('resume', handleResume)
    log.info('已卸载')
  }
}
