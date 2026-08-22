import { createLogger } from '@/utils/logger'

const log = createLogger('ProvisionalSessionHost')

type ProvisionalSessionBridge = {
  registerProvisionalSession?: (sessionId: string) => Promise<{ registered: boolean }>
  beginProvisionalSessionClaim?: (sessionId: string) => Promise<{
    accepted: boolean
    tracked: boolean
    reason?: string
  }>
  completeProvisionalSessionClaim?: (
    sessionId: string,
    accepted: boolean,
  ) => Promise<{ completed: boolean }>
  beginProvisionalSessionDiscard?: (sessionId: string) => Promise<{
    accepted: boolean
    reason?: string
  }>
  completeProvisionalSessionDiscard?: (
    sessionId: string,
    deleted: boolean,
  ) => Promise<{ completed: boolean }>
}

function bridge(): ProvisionalSessionBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.tabtin?.agentEngine
}

export async function registerProvisionalSessionWithHost(sessionId: string): Promise<boolean> {
  const register = bridge()?.registerProvisionalSession
  if (!register) return false
  try {
    return (await register(sessionId)).registered
  } catch (error) {
    log.warn('Host 登记预建会话失败', { sessionId, error })
    return false
  }
}

export async function beginProvisionalSessionClaim(sessionId: string): Promise<boolean> {
  const begin = bridge()?.beginProvisionalSessionClaim
  if (!begin) return false
  try {
    return (await begin(sessionId)).accepted
  } catch (error) {
    log.warn('Host 预建会话发送仲裁失败', { sessionId, error })
    return false
  }
}

export async function completeProvisionalSessionClaim(
  sessionId: string,
  accepted: boolean,
): Promise<void> {
  try {
    await bridge()?.completeProvisionalSessionClaim?.(sessionId, accepted)
  } catch (error) {
    log.warn('Host 预建会话发送结果同步失败', { sessionId, accepted, error })
  }
}

export async function beginProvisionalSessionDiscard(sessionId: string): Promise<boolean> {
  const begin = bridge()?.beginProvisionalSessionDiscard
  if (!begin) return false
  try {
    return (await begin(sessionId)).accepted
  } catch (error) {
    log.warn('Host 预建会话删除仲裁失败', { sessionId, error })
    return false
  }
}

export async function completeProvisionalSessionDiscard(
  sessionId: string,
  deleted: boolean,
): Promise<void> {
  try {
    await bridge()?.completeProvisionalSessionDiscard?.(sessionId, deleted)
  } catch (error) {
    log.warn('Host 预建会话删除结果同步失败', { sessionId, deleted, error })
  }
}
