/**
 * Host 侧拉取 AgentSkillLink → enabled map（供 prompt / tools 共用）。
 */
import { joinApiPath } from '@tabtin/config'
import { parseAgentSkillEnablementResponse } from '@tabtin/agent-runtime/skills'

export async function fetchSkillEnablementMap(params: {
  apiBaseUrl: string
  agentId: string
  getAccessToken: () => Promise<string | null | undefined>
}): Promise<Record<string, boolean>> {
  const agentId = params.agentId.trim()
  if (!agentId) {
    throw new Error('Agent Skill enablement request failed: missing agentId')
  }

  const token = await params.getAccessToken()
  if (!token) {
    throw new Error('Agent Skill enablement request failed: missing access token')
  }

  const url = joinApiPath(
    params.apiBaseUrl,
    `/agents/${encodeURIComponent(agentId)}/skills`,
  )
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!resp.ok) {
    throw new Error(`Agent Skill enablement request failed: HTTP ${resp.status}`)
  }

  let json: unknown
  try {
    json = await resp.json()
  } catch {
    throw new Error('Agent Skill enablement request failed: invalid JSON')
  }
  return parseAgentSkillEnablementResponse(json)
}
