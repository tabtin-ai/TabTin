export type CommentThreadReloadReason =
  | 'initial'
  | 'realtime_comment'
  | 'realtime_thread'
  | 'realtime_message'
  | 'manual_retry'

export interface CommentThreadReloadBatch {
  reasons: CommentThreadReloadReason[]
  mergedCount: number
  requestSequence: number
}

export type CommentThreadReloadDiagnostic =
  | ({ phase: 'trigger' | 'merged' } & Omit<
      CommentThreadReloadBatch,
      'requestSequence'
    > & { requestSequence: number | null })
  | ({
      phase: 'start' | 'success' | 'error' | 'stale'
    } & CommentThreadReloadBatch & { durationMs?: number; error?: unknown })
  | { phase: 'disposed'; requestSequence: number }

export interface CommentThreadReloadCoordinator {
  request: (reason: CommentThreadReloadReason) => void
  dispose: () => void
}

export interface CreateCommentThreadReloadCoordinatorOptions<T> {
  load: (batch: CommentThreadReloadBatch) => Promise<T>
  onSuccess: (value: T, batch: CommentThreadReloadBatch) => void
  onError: (error: unknown, batch: CommentThreadReloadBatch) => void
  onDiagnostic?: (event: CommentThreadReloadDiagnostic) => void
}

/**
 * 评论列表刷新协调器：同一时刻仅允许一个请求；同一任务内的触发合并，
 * 在途触发最多排队一次后续刷新。dispose 后任何陈旧结果都不会提交。
 */
export function createCommentThreadReloadCoordinator<T>({
  load,
  onSuccess,
  onError,
  onDiagnostic,
}: CreateCommentThreadReloadCoordinatorOptions<T>): CommentThreadReloadCoordinator {
  let disposed = false
  let scheduled = false
  let inFlight = false
  let requestSequence = 0
  let generation = 0
  const pendingReasons = new Set<CommentThreadReloadReason>()
  let pendingTriggerCount = 0

  const snapshotPendingBatch = (): CommentThreadReloadBatch => {
    const reasons = [...pendingReasons]
    const triggerCount = pendingTriggerCount
    pendingReasons.clear()
    pendingTriggerCount = 0
    requestSequence += 1
    return {
      reasons,
      mergedCount: Math.max(0, triggerCount - 1),
      requestSequence,
    }
  }

  const schedule = () => {
    if (disposed || scheduled || inFlight || pendingReasons.size === 0) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed || inFlight || pendingReasons.size === 0) return

      const batch = snapshotPendingBatch()
      const requestGeneration = generation
      const startedAt = Date.now()
      inFlight = true
      onDiagnostic?.({ phase: 'start', ...batch })

      void load(batch)
        .then((value) => {
          const durationMs = Date.now() - startedAt
          if (disposed || requestGeneration !== generation) {
            onDiagnostic?.({ phase: 'stale', ...batch, durationMs })
            return
          }
          onSuccess(value, batch)
          onDiagnostic?.({ phase: 'success', ...batch, durationMs })
        })
        .catch((error: unknown) => {
          const durationMs = Date.now() - startedAt
          if (disposed || requestGeneration !== generation) {
            onDiagnostic?.({ phase: 'stale', ...batch, durationMs, error })
            return
          }
          onError(error, batch)
          onDiagnostic?.({ phase: 'error', ...batch, durationMs, error })
        })
        .finally(() => {
          inFlight = false
          schedule()
        })
    })
  }

  return {
    request(reason) {
      if (disposed) return
      const alreadyPending = pendingReasons.has(reason)
      pendingReasons.add(reason)
      pendingTriggerCount += 1
      onDiagnostic?.({
        phase: alreadyPending || scheduled || inFlight ? 'merged' : 'trigger',
        reasons: [...pendingReasons],
        mergedCount: Math.max(0, pendingTriggerCount - 1),
        requestSequence: inFlight ? requestSequence : null,
      })
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      scheduled = false
      pendingReasons.clear()
      pendingTriggerCount = 0
      onDiagnostic?.({ phase: 'disposed', requestSequence })
    },
  }
}
