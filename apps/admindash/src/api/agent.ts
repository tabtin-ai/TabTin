/**
 * Agent 相关 API
 */

import type { AgentExecution } from '@/types/agent'
import { getApiClient } from './tabtin-client'

export async function getAgentExecutions(): Promise<AgentExecution[]> {
  return getApiClient().raw<AgentExecution[]>('GET', '/agent/executions')
}

export async function getAgentExecution(id: string): Promise<AgentExecution> {
  return getApiClient().raw<AgentExecution>('GET', `/agent/executions/${id}`)
}

export async function createAgentExecution(
  prompt: string,
  context?: Record<string, unknown>
): Promise<AgentExecution> {
  return getApiClient().raw<AgentExecution>('POST', '/agent/executions', {
    body: { prompt, context },
  })
}
