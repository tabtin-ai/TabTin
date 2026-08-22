import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillSlashCommandOption } from '../../skill/skillSlashCommand'
import { ComposerAddMenu } from '../ComposerAddMenu'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) =>
      options?.defaultValue ?? _key,
  }),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

const mocks = vi.hoisted(() => ({
  selectedAgent: { id: 'agent-1', name: 'Agent One' } as { id: string; name: string } | null,
  openSettings: vi.fn(),
  listConnections: vi.fn(),
}))

vi.mock('@components/ui', () => ({
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
  useOverlayContainer: () => null,
}))

vi.mock('@components/layout/SpaceActivityContext', () => ({
  useSpaceActivity: () => ({ isForeground: true }),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    getSessionById: () => undefined,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    selectedAgent: mocks.selectedAgent,
  }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openSettings: mocks.openSettings,
  }),
}))

const skill: SkillSlashCommandOption = {
  kind: 'skill',
  token: '/research',
  slug: 'research',
  canonicalKey: 'device:research',
  label: '深度研究',
  description: '研究资料',
  skill: { skill_id: 'research', skill_key: 'device:research' } as SkillSlashCommandOption['skill'],
}

function renderMenu(overrides: Partial<React.ComponentProps<typeof ComposerAddMenu>> = {}) {
  const props: React.ComponentProps<typeof ComposerAddMenu> = {
    disabled: false,
    isStreaming: false,
    attachmentLimitReached: false,
    handleFileSelect: vi.fn(),
    slashOptions: [skill],
    input: '分析报告',
    setInput: vi.fn(),
    textareaRef: { current: document.createElement('textarea') },
    sessionId: null,
    slashOpen: false,
    mentionOpen: false,
    presetPickerOpen: false,
    contextRefs: [],
    onAddContextRef: vi.fn(),
    onRemoveContextRef: vi.fn(),
    closeSkillSlash: vi.fn(),
    setMentionOpen: vi.fn(),
    setPresetPickerOpen: vi.fn(),
    ...overrides,
  }
  const rendered = render(<ComposerAddMenu {...props} />)
  return { props, ...rendered }
}

describe('ComposerAddMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectedAgent = { id: 'agent-1', name: 'Agent One' }
    mocks.listConnections.mockResolvedValue([])
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        localMcp: {
          listConnections: mocks.listConnections,
        },
      },
    })
  })

  it('打开统一菜单且不创建 blocking dialog', () => {
    renderMenu()

    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))

    expect(screen.getByText('添加附件')).toBeTruthy()
    expect(screen.getByText('Skill')).toBeTruthy()
    expect(screen.getByText('MCP')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('menu').getAttribute('data-state')).toBeNull()
    expect(screen.getByRole('menu').getAttribute('data-native-view-overlay')).toBeNull()
  })

  it('首次打开时菜单首帧就定位到 Plus 按钮上方', () => {
    renderMenu()
    const trigger = screen.getByLabelText('添加附件、Skill 或 MCP')
    trigger.getBoundingClientRect = () => new DOMRect(400, 600, 24, 24)

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('144px')
    expect(menu.style.bottom).toBe('176px')
  })

  it('附件达到上限时仍允许选择文件以显示超限提示', () => {
    const handleFileSelect = vi.fn()
    renderMenu({ attachmentLimitReached: true, handleFileSelect })
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))

    const attachmentAction = screen.getByRole('menuitem', { name: /添加附件/ }) as HTMLButtonElement
    expect(attachmentAction.disabled).toBe(false)
    expect((screen.getByRole('menuitem', { name: /^Skill$/ }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(attachmentAction)
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
  })

  it('选择 Skill 时写入 leading token 并保留正文', () => {
    const setInput = vi.fn()
    renderMenu({ setInput })
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Skill$/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /深度研究/ }))

    expect(setInput).toHaveBeenCalledWith('/research 分析报告')
  })

  it('hover Skill 行时在右侧并列展开二级列表，hover 附件行收回', () => {
    renderMenu()
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /^Skill$/ }))
    // 不点击也展开；一级菜单保持可见（并列而非切换）
    expect(screen.getByRole('menuitem', { name: /深度研究/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /添加附件/ })).toBeTruthy()

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /添加附件/ }))
    expect(screen.queryByRole('menuitem', { name: /深度研究/ })).toBeNull()
  })

  it('只列当前 Agent 已启用的 MCP，并添加 focus ref', async () => {
    mocks.listConnections.mockResolvedValue([
      {
        id: 'conn-1',
        name: 'github',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'conn-2',
        name: 'other-agent',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-2'],
        requiresAgentSelection: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ])
    const onAddContextRef = vi.fn()
    renderMenu({ onAddContextRef })
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^MCP$/ }))

    await waitFor(() => screen.getByText('github'))
    expect(screen.queryByText('other-agent')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /github/ }))

    expect(onAddContextRef).toHaveBeenCalledWith(
      'mcp_server',
      'conn-1',
      'github',
      expect.objectContaining({
        meta: expect.objectContaining({ serverName: 'github' }),
      }),
    )
  })

  it('MCP 读取失败显示错误与重试，不伪装成空列表', async () => {
    mocks.listConnections.mockRejectedValueOnce(new Error('ipc failed'))
    renderMenu()
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^MCP$/ }))

    await waitFor(() => expect(screen.getByText('MCP 连接读取失败')).toBeTruthy())
    expect(screen.queryByText('当前 Agent 暂无已启用的 MCP')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mocks.listConnections).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('当前 Agent 暂无已启用的 MCP')).toBeTruthy())
  })

  it('切换 Agent 时移除上一 Agent 的 MCP focus', () => {
    const onRemoveContextRef = vi.fn()
    const { props, rerender } = renderMenu({
      contextRefs: [{
        id: 'mcp_server:conn-1',
        type: 'mcp_server',
        resourceId: 'conn-1',
        label: 'github',
      }],
      onRemoveContextRef,
    })
    expect(onRemoveContextRef).not.toHaveBeenCalled()

    mocks.selectedAgent = { id: 'agent-2', name: 'Agent Two' }
    rerender(<ComposerAddMenu {...props} />)

    expect(onRemoveContextRef).toHaveBeenCalledWith('mcp_server:conn-1')
  })

  it('子列表按 Escape 先返回一级，再关闭菜单', () => {
    renderMenu()
    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Skill$/ }))
    expect(screen.getByText('选择 Skill')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('选择 Skill')).toBeNull()
    expect(screen.getByText('添加附件')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('打开时关闭斜杠、@引用与预设菜单', () => {
    const closeSkillSlash = vi.fn()
    const setMentionOpen = vi.fn()
    const setPresetPickerOpen = vi.fn()
    renderMenu({ closeSkillSlash, setMentionOpen, setPresetPickerOpen })

    fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))

    expect(closeSkillSlash).toHaveBeenCalled()
    expect(setMentionOpen).toHaveBeenCalledWith(false)
    expect(setPresetPickerOpen).toHaveBeenCalledWith(false)
  })

  describe('二级浮层关闭策略', () => {
    it('mouseleave 不收回 Skill 浮层（含搜索滤空）', () => {
      renderMenu()
      fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /^Skill$/ }))
      const flyout = screen.getByLabelText('选择 Skill')
      fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'zzzz-no-match' } })

      fireEvent.mouseLeave(flyout)

      expect(screen.getByLabelText('选择 Skill')).toBeTruthy()
      expect(screen.getByText('没有匹配的 Skill')).toBeTruthy()
    })

    it('选中其它一级菜单项时收回二级浮层', () => {
      renderMenu()
      fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /^Skill$/ }))
      expect(screen.getByLabelText('选择 Skill')).toBeTruthy()

      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /添加附件/ }))
      expect(screen.queryByLabelText('选择 Skill')).toBeNull()
      expect(screen.getByText('添加附件')).toBeTruthy()
    })

    it('click away 关闭整个添加菜单', () => {
      renderMenu()
      fireEvent.click(screen.getByLabelText('添加附件、Skill 或 MCP'))
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /^Skill$/ }))
      expect(screen.getByLabelText('选择 Skill')).toBeTruthy()

      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
