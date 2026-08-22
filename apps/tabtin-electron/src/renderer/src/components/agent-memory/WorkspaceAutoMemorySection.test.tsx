import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceAutoMemorySection } from './WorkspaceAutoMemorySection'

const getSettings = vi.fn()
const listModels = vi.fn()
const updateSettings = vi.fn()

vi.mock('@/services/agentMemoryApi', () => ({
  AgentMemoryApi: {
    getWorkspaceMemorySettings: (...args: unknown[]) => getSettings(...args),
    listWorkspaceMemoryModels: (...args: unknown[]) => listModels(...args),
    updateWorkspaceMemorySettings: (...args: unknown[]) => updateSettings(...args),
  },
}))

const personalModel = {
  id: '11111111-1111-4111-8111-111111111111',
  display_name: '个人 Kimi',
  provider_scope: 'user',
  provider_display_name: '我的渠道',
}

const officialModel = {
  id: '00000000-0000-4000-8000-000000000001',
  display_name: 'Doubao Seed 2.0',
  provider_scope: 'global',
  provider_display_name: '火山方舟',
}

const organizationModel = {
  id: '22222222-2222-4222-8222-222222222222',
  display_name: '组织 GPT',
  provider_scope: 'organization',
  provider_display_name: '组织渠道',
}

const explicitPersonalSettings = {
  workspace_scope: 'personal',
  auto_memory_enabled: true,
  memory_model_mode: 'explicit_model',
  memory_model: personalModel,
  can_update: true,
}

const legacyOfficialDefaultSettings = {
  ...explicitPersonalSettings,
  memory_model_mode: 'official_default',
  memory_model: null,
}

describe('WorkspaceAutoMemorySection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSettings.mockResolvedValue(explicitPersonalSettings)
    listModels.mockResolvedValue({
      workspace_scope: 'personal',
      items: [officialModel, personalModel, organizationModel],
      unavailable_items: [],
    })
    updateSettings.mockImplementation(async (_organizationId, patch) => {
      const selectedModel = [officialModel, personalModel, organizationModel]
        .find(model => model.id === patch.memory_model_id)
      return {
        ...explicitPersonalSettings,
        ...patch,
        memory_model: selectedModel ?? explicitPersonalSettings.memory_model,
      }
    })
  })

  it('读取设置并按官方、个人和组织模型分组展示，不提供官方推荐选项', async () => {
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)

    expect((await screen.findByRole('switch', { name: '自动记忆增强' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: '自动记忆增强说明' })).toBeTruthy()
    expect(screen.queryByText('启用自动记忆增强')).toBeNull()
    expect(screen.queryByText('自动整理工作记忆、日记与画像')).toBeNull()
    expect(getSettings).toHaveBeenCalledWith('workspace-a')
    expect(listModels).toHaveBeenCalledWith('workspace-a')
    expect(screen.queryByRole('option', { name: 'TabTin 官方 · 官方推荐' })).toBeNull()
    expect(screen.getByRole('group', { name: 'TabTin 官方' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '我的模型' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '组织模型' })).toBeTruthy()
  })

  it('ON/OFF 只提交 auto_memory_enabled，关闭不清空模型', async () => {
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)
    const toggle = await screen.findByRole('switch', { name: '自动记忆增强' })

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-a', { auto_memory_enabled: false })
    })
  })

  it('关闭状态可直接开启且不会写入当前 Chat Model', async () => {
    getSettings.mockResolvedValue({ ...explicitPersonalSettings, auto_memory_enabled: false })
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)
    const toggle = await screen.findByRole('switch', { name: '自动记忆增强' })

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-a', { auto_memory_enabled: true })
    })
  })

  it('新组织必须先打开开关才能选择模型，首次选择原子开启', async () => {
    getSettings.mockResolvedValue({ ...legacyOfficialDefaultSettings, auto_memory_enabled: false })
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)

    const toggle = await screen.findByRole('switch', { name: '自动记忆增强' }) as HTMLInputElement
    const selector = screen.getByLabelText('记忆模型') as HTMLSelectElement
    expect(toggle.disabled).toBe(false)
    expect(selector.disabled).toBe(true)
    expect(selector.value).toBe('invalid_explicit_model')

    fireEvent.click(toggle)

    expect(selector.disabled).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()

    fireEvent.change(selector, {
      target: { value: officialModel.id },
    })

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-a', {
        auto_memory_enabled: true,
        memory_model_mode: 'explicit_model',
        memory_model_id: officialModel.id,
      })
    })
  })

  it('旧 official_default 已开启时仍允许关闭，但不再展示官方推荐', async () => {
    getSettings.mockResolvedValue(legacyOfficialDefaultSettings)
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)

    const toggle = await screen.findByRole('switch', { name: '自动记忆增强' })
    expect((toggle as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByRole('option', { name: 'TabTin 官方 · 官方推荐' })).toBeNull()
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-a', { auto_memory_enabled: false })
    })
  })

  it('选择个人 BYOK 时只提交 explicit mode 与精确 UUID', async () => {
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)
    const selector = await screen.findByLabelText('记忆模型')

    fireEvent.change(selector, { target: { value: personalModel.id } })

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-a', {
        memory_model_mode: 'explicit_model',
        memory_model_id: personalModel.id,
      })
    })
  })

  it('选择组织 BYOK 时只提交组织模型的精确 UUID', async () => {
    render(<WorkspaceAutoMemorySection organizationId="workspace-org" />)
    const selector = await screen.findByLabelText('记忆模型')

    fireEvent.change(selector, { target: { value: organizationModel.id } })

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith('workspace-org', {
        memory_model_mode: 'explicit_model',
        memory_model_id: organizationModel.id,
      })
    })
  })

  it('能力元数据不完整的 BYOK 只展示产品结果，不暴露技术字段', async () => {
    listModels.mockResolvedValue({
      workspace_scope: 'organization',
      items: [officialModel],
      unavailable_items: [{
        ...organizationModel,
        reason_code: 'MEMORY_MODEL_CAPABILITY_MISMATCH',
        incompatible_scenes: ['memory_capture', 'task_summary'],
      }],
    })

    render(<WorkspaceAutoMemorySection organizationId="workspace-org" />)

    const option = await screen.findByRole('option', {
      name: /组织 GPT.*暂不支持自动记忆/,
    })
    expect((option as HTMLOptionElement).disabled).toBe(true)
    expect(screen.queryByText(/JSON 结构化输出/)).toBeNull()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('普通成员可读但不能修改', async () => {
    getSettings.mockResolvedValue({ ...explicitPersonalSettings, can_update: false })
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)

    expect((await screen.findByRole('switch', { name: '自动记忆增强' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('记忆模型') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/仅组织 Owner 可以修改/)).toBeTruthy()
  })

  it('切换 Workspace 后丢弃旧上下文并重新读取', async () => {
    const { rerender } = render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)
    await screen.findByRole('switch', { name: '自动记忆增强' })

    rerender(<WorkspaceAutoMemorySection organizationId="workspace-b" />)

    await waitFor(() => expect(getSettings).toHaveBeenLastCalledWith('workspace-b'))
    expect(listModels).toHaveBeenLastCalledWith('workspace-b')
  })

  it('精确模型已失效或被后端排除时要求重选且不自动 fallback', async () => {
    getSettings.mockResolvedValue({
      ...explicitPersonalSettings,
      auto_memory_enabled: false,
      memory_model_mode: 'explicit_model',
      memory_model: {
        id: '33333333-3333-4333-8333-333333333333',
        display_name: 'Codex Local',
        provider_scope: 'user',
        provider_display_name: 'Codex',
      },
    })
    listModels.mockResolvedValue({ workspace_scope: 'personal', items: [personalModel], unavailable_items: [] })
    render(<WorkspaceAutoMemorySection organizationId="workspace-a" />)

    expect((await screen.findByRole('alert')).textContent).toContain('记忆模型需要重新选择')
    const toggle = screen.getByRole('switch', { name: '自动记忆增强' }) as HTMLInputElement
    const selector = screen.getByLabelText('记忆模型') as HTMLSelectElement
    expect(toggle.disabled).toBe(false)
    expect(selector.disabled).toBe(true)

    fireEvent.click(toggle)

    expect(selector.disabled).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
