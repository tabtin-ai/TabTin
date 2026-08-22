// Agent 执行日志类型定义
export interface AgentStep {
  id: string
  timestamp: string
  node: string
  type: 'thought' | 'action' | 'observation' | 'decision'
  content: string
  metadata?: Record<string, unknown>
}

export interface AgentExecution {
  id: string
  startTime: string
  endTime?: string
  status: 'running' | 'completed' | 'failed'
  steps: AgentStep[]
  prompt?: string
  response?: string
  context?: Record<string, unknown>
}

export interface PromptDetail {
  system: string
  user: string
  assistant?: string
  context: Record<string, unknown>
}
