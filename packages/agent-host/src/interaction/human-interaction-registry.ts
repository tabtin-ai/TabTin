import {
  cancelAllPendingHitlRequests,
  type PendingHitlMap,
} from '@tabtin/agent-runtime'

export interface WaitForHumanInteractionInput {
  requestId: string
  conversationId: string
  timeoutMs: number
  unavailableReason?: string
  timeoutValue?: unknown
}

export interface HumanInteractionDecision {
  request_id?: string
  tool_call_id: string
  /** 与 wire LocalRtUserResponseDecision / PermissionResolvedDecision 四档对齐。 */
  outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
  scope?: 'once' | 'thread' | 'always'
  rejection_message?: string
}

export interface ResolveHumanInteractionBatchInput {
  batchId: string
  decisions: HumanInteractionDecision[]
}

/**
 * Shared owner for pending human-in-the-loop requests.
 *
 * `registry` is exposed only for compatibility with runtime policy builders
 * that consume PendingHitlMap directly. New host code should use coordinator
 * operations instead of mutating it.
 */
export class HumanInteractionRegistry {
  readonly registry: PendingHitlMap = new Map()
  private readonly timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()

  waitForInput(input: WaitForHumanInteractionInput): Promise<unknown> {
    if (input.unavailableReason) {
      return Promise.reject(new Error(input.unavailableReason))
    }

    return new Promise((resolve) => {
      const safetyTimer = setTimeout(() => {
        this.registry.delete(input.requestId)
        this.timeoutTimers.delete(input.requestId)
        resolve(input.timeoutValue)
      }, input.timeoutMs)
      this.timeoutTimers.set(input.requestId, safetyTimer)

      this.registry.set(input.requestId, {
        sessionId: input.conversationId,
        resolver: (value: unknown) => {
          clearTimeout(safetyTimer)
          this.timeoutTimers.delete(input.requestId)
          resolve(value)
        },
      })
    })
  }

  resolve(requestId: string, value: unknown): boolean {
    const entry = this.registry.get(requestId)
    if (!entry) return false
    this.registry.delete(requestId)
    entry.resolver(value)
    return true
  }

  resolveBatch(input: ResolveHumanInteractionBatchInput): boolean {
    if (!input.batchId || input.decisions.length === 0) return false
    return this.resolve(input.batchId, {
      batch_id: input.batchId,
      decisions: input.decisions,
    })
  }

  resolveAnswer(requestId: string, response: unknown): boolean {
    if (!requestId) return false
    return this.resolve(requestId, response)
  }

  cancelConversation(conversationId: string, reason: string): void {
    cancelAllPendingHitlRequests({
      hitlMap: this.registry,
      sessionId: conversationId,
      reason,
    })
  }

  entriesForConversation(conversationId: string) {
    return [...this.registry.values()].filter(entry => entry.sessionId === conversationId)
  }

  clear(): void {
    for (const requestId of [...this.registry.keys()]) {
      this.resolve(requestId, { status: 'cancelled', reason: 'host_stopped' })
    }
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer)
    this.timeoutTimers.clear()
  }
}
