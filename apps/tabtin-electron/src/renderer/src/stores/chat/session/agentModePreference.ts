import { isAgentModeName, type AgentModeName } from '../shared/types'

const STORAGE_PREFIX = 'tabtin:agent-default-mode:'

export function readAgentDefaultMode(agentId: string | null | undefined): AgentModeName | null {
  if (!agentId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${agentId}`)
    return raw && isAgentModeName(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeAgentDefaultMode(agentId: string | null | undefined, mode: AgentModeName): void {
  if (!agentId || typeof window === 'undefined') return
  if (!isAgentModeName(mode)) return
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${agentId}`, mode)
  } catch {
    // 存储失败不阻塞切 mode
  }
}
