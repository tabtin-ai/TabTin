/**
 * Agent 技能携带集 react-query hooks（ W3）。
 *
 * 后端契约（正典 /api/agents）：
 * - GET    /agents/{agent_id}/skills            携带列表
 * - POST   /agents/{agent_id}/skills            挂载（幂等）
 * - DELETE /agents/{agent_id}/skills/{key}      摘除（幂等）
 * - PATCH  /agents/{agent_id}/skills/{key}      更新 enabled / config_json
 *
 * Agent 是用户私有资源（owner 校验，非 owner 403）。前端新代码一律走本
 * 文件的 agent 维度 API——不要再新增按 space 启用（SkillEnablement）的调用，
 * 旧 (user, space) 路径仅双写过渡期保留。
 *
 * HTTP 通道与 hooks/queries/skills.ts 一致：electronFetch → 主进程 IPC 代理，
 * 禁止 renderer 裸 fetch 拼 URL。
 */
import { joinApiPath } from '@tabtin/config'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { electronFetch } from '@/services/electronFetch'
import { createLogger } from '@/utils/logger'
import type { AgentSkillLinkItem, SkillConfig, SkillIndexEntry } from '@/skills/types'
import { invalidateSkillEnablementCache } from '@/services/skillEnablementCacheApi'
import { agentSkillKeys, ensureSkillMaterializedLocally, skillKeys } from './skills'

const log = createLogger('AgentSkills')

export { agentSkillKeys }

function getAuthHeaders(): HeadersInit {
  const token = useAuthStore.getState().accessToken
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function agentSkillApiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, url), {
    headers: getAuthHeaders(),
    ...options,
  })
  if (!resp.ok) {
    let errorMessage: string | undefined
    let errorCode: string | undefined
    try {
      const body = await resp.json()
      errorCode = body?.error?.code ?? body?.code
      errorMessage = body?.error?.message ?? body?.message
    } catch {
      // 非 JSON 响应
    }
    const err = new Error(
      errorMessage || `Agent skills API error: ${resp.status} ${resp.statusText}`,
    ) as Error & { status?: number; code?: string }
    err.status = resp.status
    err.code = errorCode
    throw err
  }
  const json = await resp.json()
  return json?.data ?? json
}

/** 列出 Agent 携带集（含 enabled / config_json + registry 元信息）。 */
export async function fetchAgentSkills(agentId: string): Promise<AgentSkillLinkItem[]> {
  const data = await agentSkillApiRequest<{ skills: AgentSkillLinkItem[]; total: number }>(
    API_ENDPOINTS.AGENT.SKILLS(agentId),
  )
  return data?.skills ?? []
}

export function useAgentSkillsQuery(agentId: string | null | undefined) {
  return useQuery({
    queryKey: agentSkillKeys.list(agentId ?? ''),
    queryFn: () => fetchAgentSkills(agentId!),
    enabled: !!agentId,
    staleTime: 30_000,
  })
}

/** 挂载 skill 到 Agent 携带集（幂等：已携带则原地重开 enabled=true）。 */
export function useAttachAgentSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      agentId: string
      skillCanonicalKey: string
      /** SubAgentTemplate 同步锚；My Agents 面板传 skillContextSpaceId */
      spaceId?: string
      /** 显式写入携带集 enabled；工作区 Skill 也通过此入口配置 Agent */
      enabled?: boolean
      /** 分配对话框可直传 org，避免依赖 space→org 映射 */
      organizationId?: string
      /** ：用于添加后本机物化；不传则只改云端携带集 */
      skill?: SkillIndexEntry
      /** 批量配置由调用方在全部请求结束后原子写回缓存，避免逐条刷新 UI。 */
      deferQueryInvalidation?: boolean
    }) => {
      const link = await agentSkillApiRequest<AgentSkillLinkItem>(
        API_ENDPOINTS.AGENT.SKILLS(params.agentId),
        {
          method: 'POST',
          body: JSON.stringify({
            skill_canonical_key: params.skillCanonicalKey,
            ...(params.spaceId ? { space_id: params.spaceId } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
          }),
        },
      )
      // ：添加即启用后须本机可调用；物化失败不回滚携带集，但抛错让 UI 提示。
      const isWorkspaceSkill = params.skill?.source === 'workspace'
        || params.skillCanonicalKey.startsWith('workspace:')
      if (params.skill && params.spaceId && !isWorkspaceSkill) {
        try {
          await ensureSkillMaterializedLocally({
            skill: params.skill,
            spaceId: params.spaceId,
            organizationId: params.organizationId,
          })
        } catch (err) {
          log.warn('local materialize failed after attach', {
            agentId: params.agentId,
            skillKey: params.skillCanonicalKey,
          }, err)
          throw err instanceof Error
            ? err
            : new Error('技能已添加，但本机同步失败，暂时无法调用')
        }
      }
      return link
    },
    onSuccess: (_data, variables) => {
      // ：组织级目录不再缓存 Agent 携带态；失效携带集 + 目录即可。
      if (!variables.deferQueryInvalidation) {
        void queryClient.invalidateQueries({ queryKey: agentSkillKeys.list(variables.agentId) })
        void queryClient.invalidateQueries({ queryKey: skillKeys.all })
      }
      // ：携带集变更后丢掉主进程启用快照
      void invalidateSkillEnablementCache(variables.agentId)
    },
  })
}

/** 从携带集摘除（删行；幂等，未携带返回 found=false）。 */
export function useDetachAgentSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      agentId: string
      skillCanonicalKey: string
      spaceId?: string
      /** 批量配置由调用方在全部请求结束后原子写回缓存，避免逐条刷新 UI。 */
      deferQueryInvalidation?: boolean
    }) => {
      const base = API_ENDPOINTS.AGENT.SKILL(params.agentId, params.skillCanonicalKey)
      const url = params.spaceId
        ? `${base}?space_id=${encodeURIComponent(params.spaceId)}`
        : base
      return agentSkillApiRequest<{ skill_canonical_key: string; found: boolean }>(
        url,
        { method: 'DELETE' },
      )
    },
    onSuccess: (_data, variables) => {
      // ：组织级技能库目录不再按 agent 缓存携带态；只失效 Agent 携带集 + 目录。
      if (!variables.deferQueryInvalidation) {
        void queryClient.invalidateQueries({ queryKey: agentSkillKeys.list(variables.agentId) })
        void queryClient.invalidateQueries({ queryKey: skillKeys.all })
      }
      void invalidateSkillEnablementCache(variables.agentId)
    },
  })
}

/**
 * 更新携带行的 enabled / config_json。
 * 注意后端对 config_json 是按顶层 key **merge**（值为 null 删除该 key）——
 * 调用方只传要改的字段；清空 env/config 时显式传 null。
 */
export function useUpdateAgentSkillLinkMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      agentId: string
      skillCanonicalKey: string
      enabled?: boolean
      configJson?: SkillConfig
      spaceId?: string
      /** ：重新打开 enabled 时补本机物化 */
      skill?: SkillIndexEntry
    }) => {
      const link = await agentSkillApiRequest<AgentSkillLinkItem>(
        API_ENDPOINTS.AGENT.SKILL(params.agentId, params.skillCanonicalKey),
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
            ...(params.configJson !== undefined ? { config_json: params.configJson } : {}),
            ...(params.spaceId ? { space_id: params.spaceId } : {}),
          }),
        },
      )
      if (params.enabled === true && params.skill && params.spaceId) {
        try {
          await ensureSkillMaterializedLocally({
            skill: params.skill,
            spaceId: params.spaceId,
          })
        } catch (err) {
          log.warn('local materialize failed after re-enable', {
            agentId: params.agentId,
            skillKey: params.skillCanonicalKey,
          }, err)
          throw err instanceof Error
            ? err
            : new Error('技能已启用，但本机同步失败，暂时无法调用')
        }
      }
      return link
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: agentSkillKeys.list(variables.agentId) })
      if (variables.enabled !== undefined) {
        void queryClient.invalidateQueries({ queryKey: skillKeys.all })
        void invalidateSkillEnablementCache(variables.agentId)
      }
    },
  })
}
