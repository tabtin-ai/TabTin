import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()

vi.mock('../apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
  },
}))

vi.mock('@/config/api', () => ({
  API_ENDPOINTS: {
    AGENT: {
      LIST: '/agents',
    },
  },
}))

import { listOrganizationAgents, organizationAgentSummaryFromAgent } from '../organizationAgentsApi'

describe('organizationAgentsApi', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('优先使用后端已展开的 display_name，避免把 {owner} 暴露到界面', async () => {
    get.mockResolvedValue({
      data: {
        agents: [
          {
            id: 'agent-code',
            name: '{owner}代码版',
            display_name: '小明代码版',
            is_active: true,
          },
        ],
        total: 1,
      },
    })

    await expect(listOrganizationAgents('org-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'agent-code',
        name: '小明代码版',
        display_name: '小明代码版',
      }),
    ])
  })

  it('旧响应缺少 display_name 时保留原名，并过滤已停用分身', async () => {
    get.mockResolvedValue({
      data: {
        agents: [
          { id: 'agent-custom', name: '研究助手', is_active: true },
          { id: 'agent-disabled', name: '已停用', is_active: false },
        ],
        total: 2,
      },
    })

    await expect(listOrganizationAgents('org-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'agent-custom',
        name: '研究助手',
      }),
    ])
  })

  it('organizationAgentSummaryFromAgent 把开号响应压成列表摘要，优先 display_name', () => {
    expect(organizationAgentSummaryFromAgent({
      id: 'agent-t09',
      name: '{owner}访谈',
      display_name: '用户访谈分析员 T09',
      is_active: true,
      is_default: false,
      template_id: '',
      settings: { icon: 'spark' },
    })).toEqual(expect.objectContaining({
      id: 'agent-t09',
      name: '用户访谈分析员 T09',
      display_name: '用户访谈分析员 T09',
      icon: 'spark',
      is_default: false,
    }))
  })
})
