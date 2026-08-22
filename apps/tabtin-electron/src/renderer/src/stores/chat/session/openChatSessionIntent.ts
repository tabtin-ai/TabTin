/**
 * 显式「打开指定会话」意图。
 *
 * 对齐器只服务「用户只切了 Workspace」。点开某条会话时必须先钉住这个 intent，
 * 否则空桶 / 失效指针会先开草稿、抢走前台。
 *
 * 用 token 区分连续导航：只有仍是这次导航才清 intent，避免 A→B 时旧收尾把 B 抹掉。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('OpenChatSessionIntent')

export interface OpenChatSessionIntent {
  token: number
  spaceId: string
  sessionId: string
}

let nextToken = 0
let currentIntent: OpenChatSessionIntent | null = null

export function beginOpenChatSessionIntent(spaceId: string, sessionId: string): number {
  const token = ++nextToken
  currentIntent = { token, spaceId, sessionId }
  log.info('intent-set', { token, spaceId, sessionId })
  return token
}

export function getOpenChatSessionIntent(): OpenChatSessionIntent | null {
  return currentIntent
}

export function clearOpenChatSessionIntent(token: number): void {
  if (currentIntent?.token !== token) return
  currentIntent = null
}

export function resetOpenChatSessionIntentForTests(): void {
  nextToken = 0
  currentIntent = null
}
