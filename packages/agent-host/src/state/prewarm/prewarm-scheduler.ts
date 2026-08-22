/**
 * Space / Agent 激活预热调度（ Phase 4）。
 *
 * 只负责 in-flight 合并与 pending 补发；预热实现由平台 handler 注入。
 */
export class PrewarmScheduler {
  private spaceHandler: SpacePrewarmHandler | null = null
  private agentHandler: AgentEnablementPrewarmHandler | null = null
  private pendingSpaceRequest: { organizationId: string; spaceId: string } | null = null
  private pendingAgentRequest: string | null = null
  private readonly spaceInflight = new Map<string, Promise<void>>()
  private readonly agentInflight = new Map<string, Promise<void>>()

  setSpaceHandler(next: SpacePrewarmHandler | null): void {
    this.spaceHandler = next
    if (!next || !this.pendingSpaceRequest) return
    const { organizationId, spaceId } = this.pendingSpaceRequest
    this.pendingSpaceRequest = null
    this.requestSpace(organizationId, spaceId)
  }

  setAgentHandler(next: AgentEnablementPrewarmHandler | null): void {
    this.agentHandler = next
    if (!next || !this.pendingAgentRequest) return
    const agentId = this.pendingAgentRequest
    this.pendingAgentRequest = null
    this.requestAgentEnablement(agentId)
  }

  requestSpace(
    organizationId: string | null | undefined,
    spaceId: string | null | undefined,
    onError?: (err: unknown, organizationId: string, spaceId: string) => void,
  ): void {
    if (!organizationId || !spaceId) return
    if (!this.spaceHandler) {
      this.pendingSpaceRequest = { organizationId, spaceId }
      return
    }
    const key = `${organizationId}::${spaceId}`
    if (this.spaceInflight.has(key)) return
    const p = this.spaceHandler(organizationId, spaceId)
      .catch((err) => {
        onError?.(err, organizationId, spaceId)
      })
      .finally(() => {
        this.spaceInflight.delete(key)
      })
    this.spaceInflight.set(key, p)
  }

  requestAgentEnablement(
    agentId: string | null | undefined,
    onError?: (err: unknown, agentId: string) => void,
  ): void {
    const id = typeof agentId === 'string' ? agentId.trim() : ''
    if (!id) return
    if (!this.agentHandler) {
      this.pendingAgentRequest = id
      return
    }
    if (this.agentInflight.has(id)) return
    const p = this.agentHandler(id)
      .catch((err) => {
        onError?.(err, id)
      })
      .finally(() => {
        this.agentInflight.delete(id)
      })
    this.agentInflight.set(id, p)
  }

  /**
   * 身份切换时清 pending / in-flight，保留 handler。
   * 与 {@link reset} 不同：reset 用于 host stop（连 handler 一起卸）。
   */
  clearPending(): void {
    this.pendingSpaceRequest = null
    this.pendingAgentRequest = null
    this.spaceInflight.clear()
    this.agentInflight.clear()
  }

  reset(): void {
    this.spaceHandler = null
    this.agentHandler = null
    this.clearPending()
  }
}

export type SpacePrewarmHandler = (
  organizationId: string,
  spaceId: string,
) => Promise<void>

export type AgentEnablementPrewarmHandler = (agentId: string) => Promise<void>
