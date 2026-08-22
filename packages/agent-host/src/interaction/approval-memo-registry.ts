export interface ApprovalMemoStore {
  maybeRefetch(generation: number): Promise<unknown>
  bootstrap(): Promise<unknown>
}

export interface ApprovalMemoRegistryLogger {
  debug(message: string): void
  warn(message: string): void
}

export interface ApprovalMemoRegistryOptions {
  logger: ApprovalMemoRegistryLogger
  onWorkspaceChanged?(workspaceId: string): void
}

interface ApprovalMemoRegistration {
  workspaceId: string
  store: ApprovalMemoStore
}

/**
 * Owns approval-memo stores for every live host session.
 *
 * Transport adapters only forward the typed update. The registry handles
 * generation fan-out and reconnect/bootstrap recovery consistently for every
 * platform host.
 */
export class ApprovalMemoRegistry {
  private readonly stores = new Map<string, ApprovalMemoRegistration>()

  constructor(private readonly options: ApprovalMemoRegistryOptions) {}

  register(sessionId: string, workspaceId: string, store: ApprovalMemoStore): void {
    if (!sessionId || !workspaceId) {
      throw new Error('sessionId and workspaceId are required')
    }
    this.stores.set(sessionId, { workspaceId, store })
  }

  unregister(sessionId: string): void {
    this.stores.delete(sessionId)
  }

  get(sessionId: string): ApprovalMemoStore | undefined {
    return this.stores.get(sessionId)?.store
  }

  clear(): void {
    this.stores.clear()
  }

  routeUpdate(workspaceId: string, generation: number): number {
    if (!workspaceId || !Number.isFinite(generation) || generation < 0) {
      this.options.logger.warn('[ApprovalMemo] invalid update')
      return 0
    }

    let matched = 0
    for (const [sessionId, entry] of this.stores) {
      if (entry.workspaceId !== workspaceId) continue
      matched += 1
      void entry.store.maybeRefetch(generation).catch((error: unknown) => {
        this.options.logger.warn(
          `[ApprovalMemo] refetch failed session=${shortId(sessionId)}: ${errorMessage(error)}`,
        )
      })
    }
    this.options.onWorkspaceChanged?.(workspaceId)
    this.options.logger.debug(
      `[ApprovalMemo] update workspace=${shortId(workspaceId)} generation=${generation} matched=${matched}`,
    )
    return matched
  }

  async refresh(workspaceId?: string): Promise<void> {
    const tasks: Promise<unknown>[] = []
    for (const [sessionId, entry] of this.stores) {
      if (workspaceId && entry.workspaceId !== workspaceId) continue
      tasks.push(entry.store.bootstrap().catch((error: unknown) => {
        this.options.logger.warn(
          `[ApprovalMemo] bootstrap failed session=${shortId(sessionId)}: ${errorMessage(error)}`,
        )
      }))
    }
    await Promise.all(tasks)
  }
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
