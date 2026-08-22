/**
 * agentMemoryApi 契约单测（ W3）
 *
 * 守护三件事：
 *   1. 请求构造：list/get/correct/forget/feedback 打对 `/agent-memory/memories/*`，
 *      GET 带 organization_id + agent_id + 过滤参数；POST body 带 scope + 载荷。
 *   2. scope 强制：缺 organization_id / agent_id 直接抛 AgentMemoryApiError（前端护栏，
 *      不发裸请求给后端）。
 *   3. Markdown 导出：按记忆类型分组 + 计数。
 *
 * mock 掉运行时副作用导入（api-adapter-instance / logger），只验证请求形状与纯函数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiRequest = vi.fn()

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  getAuthToken: vi.fn(async () => 'test-token'),
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost/api' },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}))

//  W5：renderAgentMemoriesMarkdown 现按 i18n 本地化文案 / 日期；单测里 mock
// i18n，让 t() 回退到 defaultValue（中文），断言分组/计数结构（与语言无关）。
vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
  getCurrentLanguage: () => 'zh-CN',
}))

import {
  AgentMemoryApi,
  AgentMemoryApiError,
  renderAgentMemoriesMarkdown,
  type AgentMemory,
} from '../agentMemoryApi'

const SCOPE = { organizationId: 'org-1', agentId: 'agent-1' }

function okResponse<T>(data: T) {
  return { data: { success: true, data }, status: 200 }
}

function lastCall() {
  return apiRequest.mock.calls[apiRequest.mock.calls.length - 1][0] as {
    url: string
    method: string
    body?: string
  }
}

const sampleMemory: AgentMemory = {
  id: 'm1',
  organization_id: 'org-1',
  agent_id: 'agent-1',
  subject_user_id: 'u1',
  memory_type: 'insight',
  title: '',
  content: 'x',
  importance: 3,
  tags: [],
  state: 'active',
  source_ref: '',
  supersedes_memory_id: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
}

describe('AgentMemoryApi request 构造', () => {
  beforeEach(() => {
    apiRequest.mockReset()
  })

  it('listMemories 打 /agent-memory/memories/ 且带 scope + 过滤参数', async () => {
    apiRequest.mockResolvedValue(okResponse({ items: [], next_cursor: '', has_more: false, limit: 30 }))
    await AgentMemoryApi.listMemories(SCOPE, { memoryType: 'insight', state: 'active', limit: 30 })
    const call = lastCall()
    expect(call.method).toBe('GET')
    expect(call.url).toContain('/agent-memory/memories/')
    expect(call.url).toContain('organization_id=org-1')
    expect(call.url).toContain('agent_id=agent-1')
    expect(call.url).toContain('memory_type=insight')
    expect(call.url).toContain('state=active')
  })

  it('correctMemory POST body 带 scope + content(+memory_type)', async () => {
    apiRequest.mockResolvedValue(okResponse(sampleMemory))
    await AgentMemoryApi.correctMemory('m1', SCOPE, { content: '改过的事实', memoryType: 'about_you' })
    const call = lastCall()
    expect(call.method).toBe('POST')
    expect(call.url).toContain('/agent-memory/memories/m1/correct/')
    expect(JSON.parse(call.body as string)).toMatchObject({
      organization_id: 'org-1',
      agent_id: 'agent-1',
      content: '改过的事实',
      memory_type: 'about_you',
    })
  })

  it('forgetMemory 打 forget 端点，body 只含 scope', async () => {
    apiRequest.mockResolvedValue(okResponse({ memory_id: 'm1', forgotten: true, changed: true }))
    await AgentMemoryApi.forgetMemory('m1', SCOPE)
    const call = lastCall()
    expect(call.url).toContain('/agent-memory/memories/m1/forget/')
    expect(JSON.parse(call.body as string)).toEqual({ organization_id: 'org-1', agent_id: 'agent-1' })
  })

  it('feedbackMemory 透传 useful / importance', async () => {
    apiRequest.mockResolvedValue(okResponse(sampleMemory))
    await AgentMemoryApi.feedbackMemory('m1', SCOPE, { useful: true })
    expect(JSON.parse(lastCall().body as string)).toMatchObject({ useful: true })

    apiRequest.mockResolvedValue(okResponse(sampleMemory))
    await AgentMemoryApi.feedbackMemory('m1', SCOPE, { importance: 5 })
    expect(JSON.parse(lastCall().body as string)).toMatchObject({ importance: 5 })
  })
})

describe('AgentMemoryApi scope 护栏', () => {
  beforeEach(() => apiRequest.mockReset())

  it('缺 agentId 直接抛错，不发请求', async () => {
    await expect(
      AgentMemoryApi.listMemories({ organizationId: 'org-1', agentId: '' }),
    ).rejects.toBeInstanceOf(AgentMemoryApiError)
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('缺 organizationId 直接抛错，不发请求', async () => {
    await expect(
      AgentMemoryApi.stats({ organizationId: '', agentId: 'agent-1' }),
    ).rejects.toBeInstanceOf(AgentMemoryApiError)
    expect(apiRequest).not.toHaveBeenCalled()
  })
})

describe('renderAgentMemoriesMarkdown', () => {
  it('按类型分组并给出计数', () => {
    const md = renderAgentMemoriesMarkdown(
      [
        { ...sampleMemory, id: 'a', memory_type: 'about_you', content: '你喜欢深色主题' },
        { ...sampleMemory, id: 'b', memory_type: 'insight', content: '你偏好先做能落地的' },
        { ...sampleMemory, id: 'c', memory_type: 'about_you', content: '你常提到读书' },
      ],
      { agentName: 'Tin', organizationName: '我的组织' },
    )
    expect(md).toContain('# Tin 的记忆')
    expect(md).toContain('## 关于你（2）')
    expect(md).toContain('## 洞察（1）')
    expect(md).toContain('你喜欢深色主题')
  })
})
