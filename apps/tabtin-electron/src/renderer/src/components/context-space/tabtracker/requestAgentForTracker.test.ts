import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestAppCollaborationMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/requestAppCollaboration', () => ({
  requestAppCollaboration: requestAppCollaborationMock,
}))

import {
  buildTrackerCreateViaAgentPrompt,
  requestAgentForTracker,
} from './requestAgentForTracker'

describe('requestAgentForTracker', () => {
  beforeEach(() => {
    requestAppCollaborationMock.mockReset()
  })

  it('通过正式协作确认发起自动化任务', async () => {
    await expect(requestAgentForTracker('space-1', '  每天九点同步项目进度  ')).resolves.toBe(true)

    expect(requestAppCollaborationMock).toHaveBeenCalledWith({
      sourceLabel: '自动化',
      spaceId: 'space-1',
      prompt: '每天九点同步项目进度',
    })
  })

  it('缺少 Space 或任务内容时不打开确认框', async () => {
    await expect(requestAgentForTracker('', '创建任务')).resolves.toBe(false)
    await expect(requestAgentForTracker('space-1', '   ')).resolves.toBe(false)

    expect(requestAppCollaborationMock).not.toHaveBeenCalled()
  })

  it('创建 Agent 任务时只保留创建意图和用户需求', () => {
    const prompt = buildTrackerCreateViaAgentPrompt('明天十点提醒我复盘')
    expect(prompt).toBe(
      '帮我创建一个自动化任务。\n\n我的需求：\n明天十点提醒我复盘',
    )
    expect(prompt).not.toContain('tabtin tracker new')
    expect(prompt).not.toContain('--once-at')
    expect(prompt).not.toContain('Agent')
    expect(prompt).not.toContain('Skill')
  })
})
