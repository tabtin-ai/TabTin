export type ProvisionalSessionState =
  | 'provisional'
  | 'claiming'
  | 'discarding'
  | 'claimed'
  | 'discarded'

export type ProvisionalSessionClaimDecision =
  | { accepted: false; reason: 'discarding' | 'discarded' }
  | { accepted: true; tracked: false }
  | { accepted: true; tracked: true }

export type ProvisionalSessionDiscardDecision =
  | { accepted: false; reason: 'unknown' | 'claiming' | 'claimed' | 'discarding' | 'discarded' }
  | { accepted: true }

/**
 * Agent Host 内的预建会话所有权状态机。
 *
 * `beginClaim` 与 `beginDiscard` 都是同步提交点；JavaScript 单线程保证同一 Host
 * 上二者只能有一个先成功。发送拒绝或删除失败时恢复 provisional。
 */
export class ProvisionalSessionStore {
  private readonly stateBySessionId = new Map<string, ProvisionalSessionState>()

  register(sessionId: string): boolean {
    if (!sessionId) return false
    const state = this.stateBySessionId.get(sessionId)
    if (
      state === 'claiming'
      || state === 'claimed'
      || state === 'discarding'
      || state === 'discarded'
    ) return false
    this.stateBySessionId.set(sessionId, 'provisional')
    return true
  }

  beginClaim(sessionId: string): ProvisionalSessionClaimDecision {
    const state = this.stateBySessionId.get(sessionId)
    if (state === 'discarding' || state === 'discarded') {
      return { accepted: false, reason: state }
    }
    if (state !== 'provisional') {
      return { accepted: true, tracked: false }
    }
    this.stateBySessionId.set(sessionId, 'claiming')
    return { accepted: true, tracked: true }
  }

  completeClaim(sessionId: string, accepted: boolean): void {
    if (this.stateBySessionId.get(sessionId) !== 'claiming') return
    this.stateBySessionId.set(sessionId, accepted ? 'claimed' : 'provisional')
  }

  beginDiscard(sessionId: string): ProvisionalSessionDiscardDecision {
    const state = this.stateBySessionId.get(sessionId)
    if (state !== 'provisional') {
      return {
        accepted: false,
        reason: state ?? 'unknown',
      }
    }
    this.stateBySessionId.set(sessionId, 'discarding')
    return { accepted: true }
  }

  completeDiscard(sessionId: string, deleted: boolean): void {
    if (this.stateBySessionId.get(sessionId) !== 'discarding') return
    this.stateBySessionId.set(sessionId, deleted ? 'discarded' : 'provisional')
  }

  getState(sessionId: string): ProvisionalSessionState | undefined {
    return this.stateBySessionId.get(sessionId)
  }

  clear(): void {
    this.stateBySessionId.clear()
  }
}
