import type { HumanInteractionContext } from '@tabtin/agent-runtime/permissions'
import {
  ApprovalMemoRegistry,
  type ApprovalMemoRegistryOptions,
} from '../../interaction/approval-memo-registry.js'
import { HumanInteractionRegistry } from '../../interaction/human-interaction-registry.js'

export type PendingPlatformApproval = {
  context: HumanInteractionContext
  isStrict: boolean
}

/**
 * HITL waiters / approval memo / platform approval 权威容器（ Phase 3）。
 */
export class HitlStore {
  readonly interactions = new HumanInteractionRegistry()
  approvalMemos!: ApprovalMemoRegistry
  private readonly pendingPlatformApprovals = new Map<string, PendingPlatformApproval>()

  configureApprovalMemos(options: ApprovalMemoRegistryOptions): void {
    this.approvalMemos = new ApprovalMemoRegistry(options)
  }

  getPendingPlatformApproval(batchId: string): PendingPlatformApproval | undefined {
    return this.pendingPlatformApprovals.get(batchId)
  }

  setPendingPlatformApproval(batchId: string, pending: PendingPlatformApproval): void {
    this.pendingPlatformApprovals.set(batchId, pending)
  }

  deletePendingPlatformApproval(batchId: string): void {
    this.pendingPlatformApprovals.delete(batchId)
  }

  clear(): void {
    this.approvalMemos?.clear()
    this.interactions.clear()
    this.pendingPlatformApprovals.clear()
  }
}
