import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '../types/space.js'
import {
  buildHostAgentTurnPush,
  resetHostTurnPush,
  setHostTurnOrganizationAllowMemberYolo,
} from './host-turn-push.js'

describe('buildHostAgentTurnPush', () => {
  afterEach(() => resetHostTurnPush())

  it('组织安全状态已知时携带完整 Agent Detail', () => {
    const agent = {
      id: 'agent-1',
      organization_id: 'org-1',
      name: '小汀',
      type: 'bot',
      is_active: true,
      goal: '帮助用户完成任务',
      suggested_prompts: ['开始'],
      agent_config: { schema_version: 3 },
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:00Z',
    } satisfies Agent
    setHostTurnOrganizationAllowMemberYolo(true)

    const payload = buildHostAgentTurnPush(agent)

    expect(payload.detail).toMatchObject({
      id: 'agent-1',
      organization_id: 'org-1',
      goal: '帮助用户完成任务',
      suggested_prompts: ['开始'],
      organization_allow_member_yolo: true,
    })
  })
})
