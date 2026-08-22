/**
 * 网络栈软自愈——主进程 IPC（ 线上 case 兜底）
 *
 * 背景：Chromium network service 偶发 socket 层坏死——WS 握手永久挂起、
 * 无任何事件回调，只有重启应用能恢复。渲染进程的 collab CONNECTING
 * watchdog 连续触发达到阈值后上报本 channel，主进程对 defaultSession 执行
 * `closeAllConnections()` + `clearHostResolverCache()`，等价于「重启应用」
 * 对网络栈的最小子集，避免用户手动重启。
 *
 * 风险与约束：
 *  - closeAllConnections 会中断该 session 上所有 in-flight 请求
 *    （REST / 上传 / 其他 WS）。各链路自带重连与重试，代价是一次瞬时抖动；
 *    触发前提是协作 WS 已挂起 ≥3 个 watchdog 周期（约 3 分钟），此时网络栈
 *    大概率已整体异常。
 *  - 全局节流：两次自愈至少间隔 RECOVERY_COOLDOWN_MS，多文档同时挂起 /
 *    自愈无效反复上报时不会形成风暴。
 */

import { session } from 'electron'
import { okResponse } from '@tabtin/agent-wire'
import { guardedHandle } from './utils/guarded-handle'
import { createLogger } from './logger'

const log = createLogger('NetworkRecovery')

const CH_RECOVER_STACK = 'network:recover-stack'

/** 两次网络栈自愈的最小间隔（10 分钟） */
export const RECOVERY_COOLDOWN_MS = 10 * 60 * 1000

export interface NetworkRecoveryResult {
  /** 本次是否真正执行了自愈（false = 冷却期内被跳过） */
  performed: boolean
  /** 距下次允许执行的剩余毫秒（performed=true 时为完整冷却期） */
  cooldownRemainingMs: number
}

let lastRecoveryAt = 0

async function recoverNetworkStack(reason: string): Promise<NetworkRecoveryResult> {
  const now = Date.now()
  const sinceLast = now - lastRecoveryAt
  if (lastRecoveryAt > 0 && sinceLast < RECOVERY_COOLDOWN_MS) {
    const cooldownRemainingMs = RECOVERY_COOLDOWN_MS - sinceLast
    log.warn(
      `recover-stack skipped (cooldown): reason=${reason} remainingMs=${cooldownRemainingMs}`,
    )
    return { performed: false, cooldownRemainingMs }
  }
  lastRecoveryAt = now

  log.warn(`recover-stack begin: reason=${reason}`)
  const ses = session.defaultSession
  try {
    await ses.clearHostResolverCache()
  } catch (err) {
    log.error(`clearHostResolverCache failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    await ses.closeAllConnections()
  } catch (err) {
    log.error(`closeAllConnections failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  log.warn('recover-stack done: connections flushed, resolver cache cleared')
  return { performed: true, cooldownRemainingMs: RECOVERY_COOLDOWN_MS }
}

export function registerNetworkRecoveryIpc(): void {
  guardedHandle(CH_RECOVER_STACK, async (_event, payload: unknown) => {
    const reason =
      payload && typeof payload === 'object' && typeof (payload as { reason?: unknown }).reason === 'string'
        ? (payload as { reason: string }).reason
        : 'unspecified'
    return okResponse(await recoverNetworkStack(reason))
  })
  log.info('IPC handlers registered')
}

/** 仅供测试。 */
export const __internal = {
  CH_RECOVER_STACK,
  recoverNetworkStack,
  resetCooldown: () => {
    lastRecoveryAt = 0
  },
}
