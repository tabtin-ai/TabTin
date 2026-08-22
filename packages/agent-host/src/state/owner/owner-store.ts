import { executionOwnerScopeId, type ExecutionOwner } from './owner-types.js'

/**
 * 执行账号权威快照（可读投影）。
 *
 * 写路径仍由 ExecutionOwnerLifecycle 编排；lifecycle 在 replace/clear 后
 * sync 到本 store，供其他子域只读。
 */
export class OwnerStore {
  private current: ExecutionOwner | undefined

  get owner(): ExecutionOwner | undefined {
    return cloneOwner(this.current)
  }

  get scopeId(): string | undefined {
    return this.current ? executionOwnerScopeId(this.current) : undefined
  }

  /** lifecycle / 测试写入 */
  setOwner(owner: ExecutionOwner | undefined): void {
    this.current = cloneOwner(owner)
  }

  clear(): void {
    this.current = undefined
  }
}

function cloneOwner(owner: ExecutionOwner | undefined): ExecutionOwner | undefined {
  if (!owner) return undefined
  return {
    userId: owner.userId,
    organizationId: owner.organizationId,
    agentId: owner.agentId,
  }
}
