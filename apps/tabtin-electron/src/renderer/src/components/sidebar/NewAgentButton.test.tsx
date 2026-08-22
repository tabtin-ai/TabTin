import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionBotAgent } from '@/services/agentProvision'
import { listAgentTemplates } from '@/services/agentTemplatesApi'
import { NewAgentDialog } from './NewAgentButton'

vi.mock('@/services/agentProvision', () => ({
  provisionBotAgent: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/services/agentTemplatesApi', () => ({
  listAgentTemplates: vi.fn(async () => [
    {
      id: 'general-assistant',
      name: '日常版',
      avatar_key: 'general-assistant',
    },
    { id: 'code-engineer', name: '代码版', avatar_key: 'code-engineer' },
    { id: 'doc-writer', name: '文书版', avatar_key: 'doc-writer' },
    { id: 'data-analyst', name: '数据版', avatar_key: 'data-analyst' },
    { id: 'web-researcher', name: '冲浪版', avatar_key: 'web-researcher' },
    { id: 'slide-designer', name: 'PPT 版', avatar_key: 'slide-designer' },
    { id: 'office-secretary', name: '跑腿版', avatar_key: 'office-secretary' },
  ]),
}))

describe('NewAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('空白创建展示完整预设，默认仍是旧版日常头像', async () => {
    render(<NewAgentDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(listAgentTemplates).toHaveBeenCalledTimes(1)
      expect(screen.getAllByRole('radio')).toHaveLength(14)
    })

    expect(
      (screen.getByRole('radio', { name: /agentAvatarPresets\.general-assistant$/ }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(provisionBotAgent).not.toHaveBeenCalled()
  })

  it('模板接口未返回时也提交旧版日常默认头像', async () => {
    vi.mocked(listAgentTemplates).mockImplementationOnce(() => new Promise(() => {}))

    render(<NewAgentDialog open onOpenChange={vi.fn()} />)

    expect(listAgentTemplates).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole('radio', { name: /agentAvatarPresets\.general-assistant$/ }) as HTMLInputElement).checked,
    ).toBe(true)

    fireEvent.change(screen.getByLabelText(/agentCreate\.nameLabel/), {
      target: { value: '快速创建' },
    })
    fireEvent.click(screen.getByRole('button', { name: /agentCreate\.create/ }))

    await waitFor(() => {
      expect(provisionBotAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '快速创建',
          avatarKey: 'general-assistant',
        }),
      )
    })
  })

  it('用户主动选择后才提交功能简笔 avatar_key', async () => {
    render(<NewAgentDialog open onOpenChange={vi.fn()} />)

    const functionAvatar = await screen.findByRole('radio', {
      name: /function-code-engineer/,
    })
    fireEvent.click(functionAvatar)
    fireEvent.change(screen.getByLabelText(/agentCreate\.nameLabel/), {
      target: { value: '新代码搭档' },
    })
    fireEvent.click(screen.getByRole('button', { name: /agentCreate\.create/ }))

    await waitFor(() => {
      expect(provisionBotAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '新代码搭档',
          avatarKey: 'function-code-engineer',
        }),
      )
    })
  })
})
