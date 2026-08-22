/**
 * AgentMemory API 服务（ W3 · 独立领域端点）
 *
 * 封装后端 ``/agent-memory/memories/*``——Agent 从交互蒸馏的记忆（关于你 /
 * 洞察 / 任务摘要 / 工作日记），按 (organization, agent, subject) 强隔离。
 *
 * 与 tabmemoApi 的边界：
 *   - tabmemoApi → ``/tabmemo/*``：只放**用户主动写**的碎片笔记 / 书签。
 *   - agentMemoryApi → ``/agent-memory/*``：Agent 记忆治理（查看 / 纠正 / 忘记 /
 *     重要度反馈 / 导出）。不再经 ``/tabmemo/memos?source=agent`` 猜类型分流。
 *
 * 每个请求必须带 ``organization_id`` + ``agent_id``（scope 三元组的前两键，
 * subject 由后端钉成当前登录用户）。DTO 字段与后端 ``MemoryOut`` schema 对齐
 * （W2a schemas.py：content / memory_type / source_ref / state ...）。
 */

import i18n, { getCurrentLanguage } from '@/i18n'
import { createJsonApiClient } from '@/services/jsonApiClient'

// ── 错误类型（携带 statusCode + 后端 errorCode，供 UI 按 code 取人话） ──

export class AgentMemoryApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'AgentMemoryApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

//  W5：request/getAuthHeaders/envelope 解析收口到共享 createJsonApiClient；
// 保留 AgentMemoryApiError 供调用点 instanceof 判定。requireData=true 保持历史
// 行为（DTO 必然有值，缺失即抛）。
const { request } = createJsonApiClient({
  base: '/agent-memory',
  loggerName: 'AgentMemoryApi',
  requireData: true,
  makeError: (message, statusCode, errorCode) =>
    new AgentMemoryApiError(message, statusCode, errorCode),
})

// ── 类型（与后端 MemoryOut / MemoryPageOut 对齐） ──

export type AgentMemoryType = 'about_you' | 'insight' | 'task_summary' | 'diary'
export type AgentMemoryState = 'active' | 'archived'

export interface AgentMemory {
  id: string
  organization_id: string
  agent_id: string
  subject_user_id: string
  memory_type: AgentMemoryType
  title: string
  content: string
  importance: number | null
  tags: string[]
  state: AgentMemoryState
  source_ref: string
  supersedes_memory_id: string | null
  created_at: string
  updated_at: string
}

export interface AgentMemoryPage {
  items: AgentMemory[]
  next_cursor: string
  has_more: boolean
  limit: number
  /** 记忆总闸是否开启。false 时若 items 非空，说明本次是治理视图放行读取（见 governanceView）。 */
  memory_enabled: boolean
}

/** Organization 级跨 Agent diary 行（``GET /agent-memory/diary-feed/``）。 */
export interface OrgDiaryFeedItem {
  id: string
  agent_id: string
  agent_name: string
  agent_avatar?: string | null
  memory_type: 'diary'
  content: string
  tags: string[]
  importance: number | null
  source_ref?: string
  created_at: string
  updated_at: string
}

export interface OrgDiaryFeedPage {
  items: OrgDiaryFeedItem[]
  next_cursor: string
  has_more: boolean
  limit: number
  memory_enabled: boolean
  /** 旧 TabMemo diary 兼容策略标识；首发为只读 AgentMemory 正典。 */
  legacy_policy?: string
}

export interface AgentMemoryStats {
  total: number
  about_you: number
  insight: number
  task_summary: number
  diary: number
  memory_enabled: boolean
}

export type WorkspaceMemoryModelMode = 'official_default' | 'explicit_model'
export type WorkspaceMemoryProviderScope = 'global' | 'user' | 'organization'

export interface WorkspaceMemoryModel {
  id: string
  display_name: string
  provider_scope: WorkspaceMemoryProviderScope
  provider_display_name: string
}

export interface WorkspaceMemoryUnavailableModel extends WorkspaceMemoryModel {
  reason_code: string
  incompatible_scenes: string[]
}

export interface WorkspaceMemorySettings {
  workspace_scope: 'personal' | 'organization'
  auto_memory_enabled: boolean
  memory_model_mode: WorkspaceMemoryModelMode
  memory_model: WorkspaceMemoryModel | null
  can_update: boolean
}

export interface WorkspaceMemoryModelCatalog {
  workspace_scope: 'personal' | 'organization'
  items: WorkspaceMemoryModel[]
  /** 同 Workspace 内可见但不满足后台 Scene capability 的模型；只用于禁用说明。 */
  unavailable_items?: WorkspaceMemoryUnavailableModel[]
}

export interface WorkspaceMemorySettingsUpdate {
  auto_memory_enabled?: boolean
  memory_model_mode?: WorkspaceMemoryModelMode
  memory_model_id?: string
}

/** scope 三元组前两键——每个调用点必传（subject 由后端钉当前用户）。 */
export interface AgentMemoryScope {
  organizationId: string
  agentId: string
}

function scopeParams(scope: AgentMemoryScope): Record<string, string> {
  return { organization_id: scope.organizationId, agent_id: scope.agentId }
}

function scopeBody(scope: AgentMemoryScope): Record<string, unknown> {
  return { organization_id: scope.organizationId, agent_id: scope.agentId }
}

function requireScope(scope: AgentMemoryScope): void {
  if (!scope.organizationId) {
    throw new AgentMemoryApiError('organizationId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
  }
  if (!scope.agentId) {
    throw new AgentMemoryApiError('agentId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
  }
}

// ── API 方法 ──

export const AgentMemoryApi = {
  async getWorkspaceMemorySettings(organizationId: string): Promise<WorkspaceMemorySettings> {
    if (!organizationId) {
      throw new AgentMemoryApiError('organizationId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
    }
    return request<WorkspaceMemorySettings>({
      path: '/workspace-settings/',
      method: 'GET',
      params: { organization_id: organizationId },
    })
  },

  async updateWorkspaceMemorySettings(
    organizationId: string,
    update: WorkspaceMemorySettingsUpdate,
  ): Promise<WorkspaceMemorySettings> {
    if (!organizationId) {
      throw new AgentMemoryApiError('organizationId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
    }
    return request<WorkspaceMemorySettings>({
      path: '/workspace-settings/',
      method: 'PUT',
      body: { organization_id: organizationId, ...update },
    })
  },

  async listWorkspaceMemoryModels(organizationId: string): Promise<WorkspaceMemoryModelCatalog> {
    if (!organizationId) {
      throw new AgentMemoryApiError('organizationId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
    }
    return request<WorkspaceMemoryModelCatalog>({
      path: '/workspace-settings/models/',
      method: 'GET',
      params: { organization_id: organizationId },
    })
  },

  /**
   * Organization 级跨 Agent diary 聚合。
   * 不需要 agentId；subject 由后端钉当前用户；关记忆后空页。
   */
  async listOrgDiaryFeed(
    organizationId: string,
    opts: {
      search?: string
      state?: AgentMemoryState
      cursor?: string
      limit?: number
    } = {},
  ): Promise<OrgDiaryFeedPage> {
    if (!organizationId) {
      throw new AgentMemoryApiError('organizationId is required', 400, 'AGENT_MEMORY_INVALID_SCOPE')
    }
    return request<OrgDiaryFeedPage>({
      path: '/diary-feed/',
      method: 'GET',
      params: {
        organization_id: organizationId,
        search: opts.search || undefined,
        state: opts.state || undefined,
        cursor: opts.cursor || undefined,
        limit: opts.limit ?? undefined,
      },
    })
  },

  async listMemories(
    scope: AgentMemoryScope,
    opts: {
      memoryType?: AgentMemoryType | ''
      search?: string
      state?: AgentMemoryState
      cursor?: string
      limit?: number
      /**
       * 治理视图（ 治理闭环缺口）：总闸关闭时仍放行读取历史条目，
       * 只为了让用户能找到旧记忆点「忘记」——不代表运行时会重新召回或注入。
       * 只应由治理 UI（Agent 记忆治理面板）传 true；任何召回 / 注入路径都
       * 不应设置本参数。
       */
      governanceView?: boolean
    } = {},
  ): Promise<AgentMemoryPage> {
    requireScope(scope)
    return request<AgentMemoryPage>({
      path: '/memories/',
      method: 'GET',
      params: {
        ...scopeParams(scope),
        memory_type: opts.memoryType || undefined,
        search: opts.search || undefined,
        state: opts.state || undefined,
        cursor: opts.cursor || undefined,
        limit: opts.limit ?? undefined,
        governance_view: opts.governanceView || undefined,
      },
    })
  },

  async stats(scope: AgentMemoryScope, opts: { governanceView?: boolean } = {}): Promise<AgentMemoryStats> {
    requireScope(scope)
    return request<AgentMemoryStats>({
      path: '/memories/stats/',
      method: 'GET',
      params: { ...scopeParams(scope), governance_view: opts.governanceView || undefined },
    })
  },

  async getMemory(memoryId: string, scope: AgentMemoryScope): Promise<AgentMemory> {
    requireScope(scope)
    return request<AgentMemory>({
      path: `/memories/${encodeURIComponent(memoryId)}/`,
      method: 'GET',
      params: scopeParams(scope),
    })
  },

  /** 纠正：归档原记忆并新建替代记忆（保留 supersedes 溯源）。 */
  async correctMemory(
    memoryId: string,
    scope: AgentMemoryScope,
    payload: { content: string; memoryType?: AgentMemoryType },
  ): Promise<AgentMemory> {
    requireScope(scope)
    return request<AgentMemory>({
      path: `/memories/${encodeURIComponent(memoryId)}/correct/`,
      method: 'POST',
      body: {
        ...scopeBody(scope),
        content: payload.content,
        ...(payload.memoryType ? { memory_type: payload.memoryType } : {}),
      },
    })
  },

  /** 忘记：软删除（forgotten_at）——之后所有默认读取都排除该行。 */
  async forgetMemory(
    memoryId: string,
    scope: AgentMemoryScope,
  ): Promise<{ memory_id: string; forgotten: boolean; changed: boolean }> {
    requireScope(scope)
    return request<{ memory_id: string; forgotten: boolean; changed: boolean }>({
      path: `/memories/${encodeURIComponent(memoryId)}/forget/`,
      method: 'POST',
      body: scopeBody(scope),
    })
  },

  /** 重要度 / 「有用」反馈：``importance`` 绝对设定，或 ``useful`` 增减一档。 */
  async feedbackMemory(
    memoryId: string,
    scope: AgentMemoryScope,
    payload: { importance?: number; useful?: boolean },
  ): Promise<AgentMemory> {
    requireScope(scope)
    return request<AgentMemory>({
      path: `/memories/${encodeURIComponent(memoryId)}/feedback/`,
      method: 'POST',
      body: {
        ...scopeBody(scope),
        ...(payload.importance !== undefined ? { importance: payload.importance } : {}),
        ...(payload.useful !== undefined ? { useful: payload.useful } : {}),
      },
    })
  },
}

// ── 导出工具 ──

/**
 * 拉全某 Agent 在当前用户名下的活跃记忆（分页汇总，带上限护栏）。
 * 供「导出」用——不做 UI 渲染，只拿完整数据。
 */
export async function fetchAllAgentMemories(
  scope: AgentMemoryScope,
  opts: { maxItems?: number } = {},
): Promise<AgentMemory[]> {
  const maxItems = opts.maxItems ?? 1000
  const all: AgentMemory[] = []
  let cursor = ''
  // 上限护栏：最多翻 (maxItems / 100) 页，避免异常数据导致无限翻页。
  for (let page = 0; page < Math.ceil(maxItems / 100) + 1; page += 1) {
    const resp = await AgentMemoryApi.listMemories(scope, {
      state: 'active',
      limit: 100,
      cursor: cursor || undefined,
      // 治理动作：导出应能拿到关闸前的历史记忆（与 governanceView 同口径）。
      governanceView: true,
    })
    all.push(...resp.items)
    if (!resp.has_more || !resp.next_cursor || all.length >= maxItems) break
    cursor = resp.next_cursor
  }
  return all.slice(0, maxItems)
}

const MEMORY_TYPE_LABEL_FALLBACK: Record<AgentMemoryType, string> = {
  about_you: '关于你',
  insight: '洞察',
  task_summary: '任务摘要',
  diary: '工作日记',
}

/** 记忆类型标签——导出时按当前 App 语言解析（复用 agentMemory namespace 的 types.*）。 */
function memoryTypeLabel(type: AgentMemoryType): string {
  return i18n.t(`agentMemory:types.${type}`, { defaultValue: MEMORY_TYPE_LABEL_FALLBACK[type] })
}

/**
 * 把一组 Agent 记忆渲染成可读 Markdown（导出用）。
 *  W5：标题 / 元信息 / 类型分组 / 重要度 / 日期全部按当前 App 语言本地化——
 * EN 用户导出得到英文文档、英文日期（此前通篇中文）。
 */
export function renderAgentMemoriesMarkdown(
  memories: AgentMemory[],
  meta: { agentName: string; organizationName?: string },
): string {
  const lang = getCurrentLanguage()
  const lines: string[] = []
  lines.push(`# ${i18n.t('agentMemory:exportDoc.title', { name: meta.agentName, defaultValue: `${meta.agentName} 的记忆` })}`)
  if (meta.organizationName) {
    lines.push(`> ${i18n.t('agentMemory:exportDoc.organization', { name: meta.organizationName, defaultValue: `组织：${meta.organizationName}` })}`)
  }
  lines.push(`> ${i18n.t('agentMemory:exportDoc.exportedAt', { time: new Date().toLocaleString(lang), defaultValue: `导出时间：${new Date().toLocaleString(lang)}` })}`)
  lines.push(`> ${i18n.t('agentMemory:exportDoc.count', { count: memories.length, defaultValue: `共 ${memories.length} 条` })}`)
  lines.push('')

  const importanceLabel = i18n.t('agentMemory:exportDoc.importanceLabel', { defaultValue: '重要度' })
  const groups: AgentMemoryType[] = ['about_you', 'insight', 'task_summary', 'diary']
  for (const type of groups) {
    const rows = memories.filter(m => m.memory_type === type)
    if (rows.length === 0) continue
    lines.push(`## ${memoryTypeLabel(type)}（${rows.length}）`)
    lines.push('')
    for (const m of rows) {
      const stars = m.importance ? ` ｜ ${importanceLabel} ${'★'.repeat(Math.min(5, m.importance))}` : ''
      const when = m.created_at ? new Date(m.created_at).toLocaleDateString(lang) : ''
      lines.push(`- ${m.content.replace(/\n/g, ' ')}${stars}${when ? ` ｜ ${when}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
