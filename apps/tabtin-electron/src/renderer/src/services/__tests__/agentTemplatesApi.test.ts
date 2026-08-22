import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
const post = vi.fn()

vi.mock('../apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}))

vi.mock('@/config/api', () => ({
  API_ENDPOINTS: {
    AGENT: {
      CREATE: '/agents',
      TEMPLATES: '/agents/templates',
    },
  },
}))

import { createBotAgent, listAgentTemplates } from '../agentTemplatesApi'

describe('agentTemplatesApi', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
  })

  it('模板列表透传 avatar_key', async () => {
    get.mockResolvedValue({
      data: {
        templates: [
          {
            id: 'code-engineer',
            name: '代码版',
            avatar_key: 'code-engineer',
          },
        ],
        total: 1,
      },
    })

    await expect(listAgentTemplates()).resolves.toEqual([
      {
        id: 'code-engineer',
        name: '代码版',
        avatar_key: 'code-engineer',
      },
    ])
  })

  it('从空白创建只提交品牌头像标识，不上传图片', async () => {
    post.mockResolvedValue({
      data: {
        id: 'agent-1',
        name: '研究助手',
      },
    })

    await createBotAgent({
      organizationId: 'org-1',
      name: '研究助手',
      avatarKey: 'web-researcher',
    })

    expect(post).toHaveBeenCalledWith('/agents', {
      organization_id: 'org-1',
      name: '研究助手',
      type: 'bot',
      avatar_key: 'web-researcher',
    })
  })
})
