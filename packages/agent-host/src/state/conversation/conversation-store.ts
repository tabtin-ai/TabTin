import type { ConversationExecutionState } from '../../conversation/conversation-supervisor.js'
import {
  ConversationSupervisor,
  type ConversationSupervisorAdapter,
  type ConversationSupervisorHooks,
} from '../../conversation/conversation-supervisor.js'
import type { ConversationRunState } from '../../conversation/conversation-run-coordinator.js'
import type { HumanInteractionRegistry } from '../../interaction/human-interaction-registry.js'

/**
 * 会话队列 / busy / run_sync 权威容器（ Phase 2）。
 */
export class ConversationStore<
  Request = unknown,
  Result = unknown,
  SessionState = unknown,
> {
  private supervisorInstance?: ConversationSupervisor<Request, Result, SessionState>

  /**
   * 绑定或创建 supervisor。AgentHost 启动时注入 adapter / interactions / hooks。
   */
  ensureSupervisor(
    adapter: ConversationSupervisorAdapter<Request, Result> | undefined,
    interactions: HumanInteractionRegistry,
    hooks?: ConversationSupervisorHooks,
  ): ConversationSupervisor<Request, Result, SessionState> {
    if (!this.supervisorInstance) {
      this.supervisorInstance = new ConversationSupervisor(adapter, interactions, hooks)
      return this.supervisorInstance
    }
    if (adapter) {
      this.supervisorInstance.bindAdapter(adapter)
    }
    return this.supervisorInstance
  }

  get supervisor(): ConversationSupervisor<Request, Result, SessionState> {
    if (!this.supervisorInstance) {
      throw new Error('ConversationSupervisor not initialized; call ensureSupervisor first')
    }
    return this.supervisorInstance
  }

  getState(conversationId: string): ConversationExecutionState {
    return this.supervisor.getState(conversationId)
  }

  isBusy(conversationId: string): boolean {
    return this.supervisor.getRunState(conversationId).busy
  }

  getRunState(conversationId: string): ConversationRunState {
    return this.supervisor.getRunState(conversationId)
  }

  syncCurrentRunState(conversationId: string): boolean {
    return this.supervisor.syncCurrentRunState(conversationId)
  }

  getBusyConversationIds(): string[] {
    return this.supervisor.getBusyConversationIds()
  }
}
