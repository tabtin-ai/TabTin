import type { Tool, ToolResult } from '../engine/contracts/tools.js'
import { jsonError } from '../capability/core/_utils.js'
import { joinApiPath } from '../utils/api-url.js'
import { toJsonErrorMetadata, translateBackendError } from './_backend-error-translator.js'

export interface ProjectTaskToolsDeps {
  apiBaseUrl: string
  apiAuthToken?: string
  organizationId?: string
  projectId: string
}

interface ProjectTaskCreateInput {
  tasks: Array<{
    title: string
    description?: string
    priority?: 'low' | 'medium' | 'high' | 'urgent'
    responsible_user_id: string
  }>
}

function headers(deps: ProjectTaskToolsDeps): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.apiAuthToken) result.Authorization = `Bearer ${deps.apiAuthToken}`
  if (deps.organizationId) result['X-TabTin-Organization-Id'] = deps.organizationId
  return result
}

async function request(
  deps: ProjectTaskToolsDeps,
  toolName: string,
  operation: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | ToolResult> {
  try {
    const response = await fetch(joinApiPath(deps.apiBaseUrl, path), {
      ...init,
      headers: { ...headers(deps), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    })
    const raw = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
      const translated = translateBackendError({
        status: response.status,
        body: raw,
        toolName,
        operation,
        fallbackMessage: `Project ${operation} failed.`,
      })
      return jsonError(translated.message, toJsonErrorMetadata(translated, {
        http_status: response.status,
      }))
    }
    return ((raw?.data ?? raw) || {}) as Record<string, unknown>
  } catch (error) {
    const translated = translateBackendError({
      error,
      toolName,
      operation,
      fallbackMessage: `Project ${operation} failed.`,
    })
    return jsonError(translated.message, toJsonErrorMetadata(translated))
  }
}

function isToolResult(value: Record<string, unknown> | ToolResult): value is ToolResult {
  return typeof (value as ToolResult).content === 'string'
}

export function createProjectTaskTools(deps: ProjectTaskToolsDeps): Tool[] {
  const projectPath = `/context/projects/${encodeURIComponent(deps.projectId)}`

  return [
    {
      name: 'project_members_list',
      description: '列出当前 Project 的真人成员及其 user_id，供任务编排选择责任人。只返回生效成员。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: true,
      policyActionKind: 'object_read',
      execute: async (): Promise<ToolResult> => {
        const memberships = await request(
          deps,
          'project_members_list',
          'member listing',
          `/context/spaces/${encodeURIComponent(deps.projectId)}/memberships`,
        )
        if (isToolResult(memberships)) return memberships

        let organizationMembers: Record<string, unknown>[] = []
        if (deps.organizationId) {
          const organizationPayload = await request(
            deps,
            'project_members_list',
            'organization member listing',
            `/context/organizations/${encodeURIComponent(deps.organizationId)}/members?limit=200`,
          )
          if (isToolResult(organizationPayload)) return organizationPayload
          organizationMembers = Array.isArray(organizationPayload.members)
            ? organizationPayload.members as Record<string, unknown>[]
            : []
        }
        const namesByUserId = new Map(organizationMembers.map(member => {
          const user = (member.user ?? {}) as Record<string, unknown>
          const userId = String(member.user_id ?? user.id ?? '')
          const name = user.nickname ?? user.username ?? user.email ?? userId
          return [userId, String(name)]
        }))
        const rows = Array.isArray(memberships.memberships)
          ? memberships.memberships as Record<string, unknown>[]
          : []
        const members = rows
          .filter(row => row.is_active === true && row.user_id)
          .map(row => ({
            user_id: String(row.user_id),
            name: namesByUserId.get(String(row.user_id)) ?? String(row.user_id),
            role: String(row.role ?? ''),
          }))
        return { content: JSON.stringify({ success: true, members, total: members.length }) }
      },
    },
    {
      name: 'project_tasks_list',
      description: '查看当前 Project 的任务看板，用于避免重复建单并基于现状继续编排。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      isReadOnly: true,
      policyActionKind: 'object_read',
      execute: async (): Promise<ToolResult> => {
        const payload = await request(
          deps,
          'project_tasks_list',
          'task listing',
          `${projectPath}/tasks`,
        )
        if (isToolResult(payload)) return payload
        return { content: JSON.stringify({ success: true, ...payload }) }
      },
    },
    {
      name: 'project_tasks_create',
      description:
        '在当前 Project 原子创建一组任务。调用前必须先向用户展示完整任务方案（标题、说明、优先级、责任人）并获得明确确认；'
        + '不要代责任人接单、配置执行现场、启动、取消或验收。任一任务不合法时整批不会创建。',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '清晰、可验收的任务标题。' },
                description: { type: 'string', description: '范围、约束与验收标准。' },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'urgent'],
                  description: '优先级，默认 medium。',
                },
                responsible_user_id: {
                  type: 'string',
                  description: '来自 project_members_list 的真人成员 user_id。',
                },
              },
              required: ['title', 'responsible_user_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      isReadOnly: false,
      riskLevel: 'review',
      policyActionKind: 'object_write',
      execute: async (input: unknown): Promise<ToolResult> => {
        const params = input as ProjectTaskCreateInput
        const payload = await request(
          deps,
          'project_tasks_create',
          'task batch creation',
          `${projectPath}/tasks/batch`,
          {
            method: 'POST',
            body: JSON.stringify({ tasks: params.tasks }),
          },
        )
        if (isToolResult(payload)) return payload
        return { content: JSON.stringify({ success: true, ...payload }) }
      },
    },
  ]
}
