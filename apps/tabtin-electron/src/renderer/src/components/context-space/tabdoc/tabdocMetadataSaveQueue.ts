export interface TabDocMetadataSaveContext<Update, Result> {
  suspendContent?: () => void
  resumeContent?: () => void
  flushContent: () => Promise<void>
  refreshAfterVersionConflict?: (error: unknown) => Promise<void> | void
  getBaseVersion: () => number | null
  getBaseUpdatedAt: () => string | null
  saveMetadata: (input: {
    updates: Update
    baseVersion: number | null
    baseUpdatedAt: string | null
  }) => Promise<Result>
  applyResult: (result: Result) => void
  /** 版本冲突刷新后最多再试几次（默认 2，合计最多 3 次 save） */
  maxConflictRetries?: number
}

export interface TabDocMetadataSaveQueue<Update, Result> {
  enqueue: (updates: Update) => Promise<Result>
}

function isVersionConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    if (typeof error === 'string') {
      return /版本冲突|version conflict/i.test(error)
    }
    return false
  }
  const candidate = error as {
    status?: number
    statusCode?: number
    code?: string
    errorCode?: string
    message?: string
  }
  const status = candidate.status ?? candidate.statusCode
  const code = candidate.code ?? candidate.errorCode ?? ''
  if (status === 409 || code === 'VERSION_CONFLICT' || code === 'version_conflict') {
    return true
  }
  const message = candidate.message
    ?? (error instanceof Error ? error.message : '')
  return /版本冲突|version conflict/i.test(message)
}

/**
 * Serializes TabDoc metadata writes so title/icon/cover saves always read the
 * latest version after any preceding content flush or metadata PATCH.
 */
export function createTabDocMetadataSaveQueue<Update, Result>(
  context: TabDocMetadataSaveContext<Update, Result>,
): TabDocMetadataSaveQueue<Update, Result> {
  let tail: Promise<void> = Promise.resolve()
  const maxConflictRetries = Math.max(0, context.maxConflictRetries ?? 2)

  const enqueue = (updates: Update): Promise<Result> => {
    const run = async () => {
      context.suspendContent?.()
      try {
        await context.flushContent()
        const save = () => context.saveMetadata({
          updates,
          baseVersion: context.getBaseVersion(),
          baseUpdatedAt: context.getBaseUpdatedAt(),
        })
        let result: Result
        let attempt = 0
        for (;;) {
          try {
            result = await save()
            break
          } catch (error) {
            if (
              !isVersionConflictError(error)
              || !context.refreshAfterVersionConflict
              || attempt >= maxConflictRetries
            ) {
              throw error
            }
            attempt += 1
            await context.refreshAfterVersionConflict(error)
          }
        }
        context.applyResult(result)
        return result
      } finally {
        context.resumeContent?.()
      }
    }

    const resultPromise = tail.then(run, run)
    tail = resultPromise.then(
      () => undefined,
      () => undefined,
    )
    return resultPromise
  }

  return { enqueue }
}
