/**
 * agent-engine 模块 — 2 个 PlatformSurface。
 *
 * 将原 `ElectronAgentHost.ts` 中的两个 handler 迁移：
 *   - agent-engine:abort     — AbortController.abort() + 清 runningSessions
 *   - agent-engine:get-state — 查询 session 存在性 + 运行状态
 *
 * 这两个都是纯本地操作（不调 Django），通过 AgentHost 的内部
 * sessions / runningSessions / abortController 完成。
 *
 * 设计：工厂模式 `createAgentEngineSurfaces(deps)`，把 abort 和
 * getState 逻辑抽成回调接口。宿主传入绑定了 ElectronAgentHost
 * 实例方法的回调。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'

// ─── 依赖接口 ─────────────────────────────────────────────────────

export interface AgentEngineAbortOutput {
  success: boolean
}

/**
 * 本机运行中的对话摘要。仅在全局 `get-state` 查询时返回，供离开当前上下文前的
 * 安全确认使用；旧客户端可忽略这个加性字段。
 */
export interface AgentEngineBusySession {
  /** 优先为 ChatSession 业务 ID；pre-stream 窗口可回退为 runtime task key。 */
  sessionId: string
  /** pre-stream 窗口可能尚未创建 HostState，故仅在已知时返回。 */
  organizationId?: string
  workspaceId?: string
  queuedRunIds: string[]
}

export interface AgentEngineGetStateOutput {
  sessionId: string | null
  /**
   * ：session 是否忙 = `ConversationRunQueue.isBusy`（running 或有排队；HITL
   * 挂起期 run 未 settle，天然算 busy）。renderer 对账「这条会话还在不在跑」
   * 应看本字段，而非 `running`。
   */
  busy: boolean
  /** 正在执行中（不含排队）。与 busy 的差 = 纯排队等待。 */
  running: boolean
  /** 该 session 排队中（尚未开始执行）的 runId（= clientMessageId）列表。 */
  queuedRunIds: string[]
  activeSessions?: number
  /** 仅全局查询返回的本机 busy 会话。 */
  busySessions?: AgentEngineBusySession[]
}

export interface AgentEngineCompactHistoryItem {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

export interface AgentEngineCompactSessionOutput {
  success: boolean
  error?: string
  summary?: string
  stats?: {
    messages_before: number
    messages_after: number
    tokens_before: number
    tokens_after: number
    tokens_freed: number
    summary_length: number
  }
}

/**
 * agent-engine 模块的外部依赖。
 *
 * 两个回调分别对应 ElectronAgentHost 的 handleAbort / handleGetState
 * 私有方法。宿主在工厂调用时绑定实例引用。
 */
export interface AgentEngineDeps {
  /** 中止指定 session（或全部），返回操作是否成功 */
  abort(sessionId?: string): AgentEngineAbortOutput
  /** 查询引擎状态：指定 session 的存在性 + 运行状态，或全局概览 */
  getState(sessionId?: string): AgentEngineGetStateOutput
  /** 手动压缩指定 session 的历史上下文 */
  compactSession(input: AgentEngineCompactSessionInput): Promise<AgentEngineCompactSessionOutput>
}

// ─── 输入类型 ──────────────────────────────────────────────────────

export interface AgentEngineAbortInput {
  sessionId?: string
}

export interface AgentEngineGetStateInput {
  sessionId?: string
}

export interface AgentEngineCompactSessionInput {
  threadId: string
  workspaceId: string
  history: AgentEngineCompactHistoryItem[]
  summaryFocus?: string
  keepLastN?: number
  modelId?: string
  agentId?: string
  agentMode?: string
  spaceId?: string
  organizationId?: string
  modelContextWindow?: number
  modelMaxOutput?: number
  modelSupportsVision?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  isByokMode?: boolean
}

// ─── 工厂 ─────────────────────────────────────────────────────────

/**
 * 创建 agent-engine 模块的 2 个 PlatformSurface。
 *
 * 调用时机：ElectronAgentHost.start() 或 Daemon 启动链路。
 * deps.abort / deps.getState 应绑定到 host 实例方法。
 */
export function createAgentEngineSurfaces(deps: AgentEngineDeps) {
  const agentEngineAbort = definePlatformSurface({
    module: 'agent-engine',
    verb: 'abort',
    kind: 'local',
    errorCodes: [] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: AgentEngineAbortInput): Promise<AgentEngineAbortOutput> => {
      return deps.abort(input?.sessionId)
    },
  })

  const agentEngineGetState = definePlatformSurface({
    module: 'agent-engine',
    verb: 'get-state',
    kind: 'local',
    errorCodes: [] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: AgentEngineGetStateInput): Promise<AgentEngineGetStateOutput> => {
      return deps.getState(input?.sessionId)
    },
  })

  const agentEngineCompactSession = definePlatformSurface({
    module: 'agent-engine',
    verb: 'compact-session',
    kind: 'local',
    errorCodes: [] as const,
    bindings: { ipc: true, http: true },

    handler: async (input: AgentEngineCompactSessionInput): Promise<AgentEngineCompactSessionOutput> => {
      return deps.compactSession(input)
    },
  })

  return { agentEngineAbort, agentEngineGetState, agentEngineCompactSession }
}
