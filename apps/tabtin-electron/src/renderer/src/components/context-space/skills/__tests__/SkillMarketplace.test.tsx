import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockEnableMutateAsync = vi.fn()
type ChildrenProps = { children?: React.ReactNode }

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ScrollArea: ({ children }: ChildrenProps) => <div>{children}</div>,
  toast: vi.fn(),
  TooltipProvider: ({ children }: ChildrenProps) => <>{children}</>,
  Tooltip: ({ children }: ChildrenProps) => <>{children}</>,
  TooltipTrigger: ({ children }: ChildrenProps) => <>{children}</>,
  TooltipContent: ({ children }: ChildrenProps) => <>{children}</>,
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillMarketQuery: () => ({
    data: [
      {
        skill_id: 'available',
        skill_key: 'user:available',
        name: 'Available Skill',
        source: 'user',
        description: 'Can be installed',
      },
      {
        skill_id: 'market-installed',
        skill_key: 'user:market-installed',
        name: 'Market Installed Skill',
        source: 'user',
        installed: true,
      },
      {
        skill_id: 'current-installed',
        skill_key: 'user:current-installed',
        name: 'Current Installed Skill',
        source: 'user',
      },
      {
        skill_id: 'disabled-installed',
        skill_key: 'user:disabled-installed',
        name: 'Disabled Installed Skill',
        source: 'user',
      },
      {
        skill_id: 'office-pack-skill',
        skill_key: 'app:tabtin-office-skills-pack/office-pack-skill',
        name: 'Office Pack Skill',
        source: 'app',
        distribution: 'marketplace',
      },
      {
        skill_id: 'table-operator',
        skill_key: 'app:tabtin-office-skills-pack/table-operator',
        name: 'Tabular Writer',
        source: 'app',
        distribution: 'marketplace',
        description: 'Edit schemas and records',
      },
      {
        skill_id: 'official-okr-planner',
        skill_key: 'app:tabtin-business-analysis-pack/okr-planner',
        slug: 'okr-planner',
        name: 'okr-planner',
        display_name: 'OKR 制定与复盘',
        source: 'app',
        app_id: 'tabtin-business-analysis-pack',
        distribution: 'marketplace',
        description: '中文描述',
      },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useSkillsListQuery: () => ({
    data: [
      {
        skill_id: 'current-installed',
        skill_key: 'user:current-installed',
        name: 'Current Installed Skill',
        source: 'user',
        enabled: true,
      },
      {
        skill_id: 'disabled-installed',
        skill_key: 'user:disabled-installed',
        name: 'Disabled Installed Skill',
        source: 'user',
        enabled: false,
        installed: true,
      },
    ],
  }),
  useEnableSkillMutation: () => ({
    mutateAsync: mockEnableMutateAsync,
    isPending: false,
    variables: null,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
  }),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockEnableMutateAsync.mockResolvedValue({ enabled: true })
})

afterEach(() => {
  cleanup()
})

describe('SkillMarketplace installed visibility', () => {
  it('keeps installed skills visible and marks them as installed', async () => {
    const { SkillMarketplace } = await import('../SkillMarketplace')
    render(<SkillMarketplace spaceId="space-1" />)

    expect(screen.queryByText('Available Skill')).not.toBeNull()
    expect(screen.queryByText('Office Pack Skill')).not.toBeNull()
    expect(screen.queryByText('Tabular Writer')).not.toBeNull()
    expect(screen.queryByText('Market Installed Skill')).not.toBeNull()
    expect(screen.queryByText('Current Installed Skill')).not.toBeNull()
    expect(screen.queryByText('Disabled Installed Skill')).not.toBeNull()

    // 已安装项显示「已安装」文案，未安装项仍有「安装」按钮
    expect(screen.getAllByText('skillMarket.installed').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('skillMarket.install').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps a skill visible after successful install and shows installed state', async () => {
    const { SkillMarketplace } = await import('../SkillMarketplace')
    render(<SkillMarketplace spaceId="space-1" />)

    fireEvent.click(screen.getAllByText('skillMarket.install')[0])

    await waitFor(() => {
      expect(mockEnableMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
        canonicalKey: 'user:available',
        spaceId: 'space-1',
        skill: expect.objectContaining({
          skill_key: 'user:available',
        }),
      }))
    })
    await waitFor(() => {
      expect(screen.queryByText('Available Skill')).not.toBeNull()
      expect(screen.getAllByText('skillMarket.installed').length).toBeGreaterThanOrEqual(4)
    })
  })

  it('matches canonical key fragments like /table-operator', async () => {
    const { SkillMarketplace } = await import('../SkillMarketplace')
    render(<SkillMarketplace spaceId="space-1" />)

    fireEvent.change(screen.getByPlaceholderText('skills.panel.searchPlaceholder'), {
      target: { value: '/table-operator' },
    })

    expect(screen.queryByText('Tabular Writer')).not.toBeNull()
    expect(screen.queryByText('Available Skill')).toBeNull()
    expect(screen.queryByText('Office Pack Skill')).toBeNull()
  })

  it('shows and searches localized English metadata for official recommended skills', async () => {
    const { SkillMarketplace } = await import('../SkillMarketplace')
    render(<SkillMarketplace spaceId="space-1" />)

    expect(screen.queryByText('OKR Planning & Review')).not.toBeNull()
    expect(screen.queryByText('OKR 制定与复盘')).toBeNull()
    expect(screen.queryByText('中文描述')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('skills.panel.searchPlaceholder'), {
      target: { value: 'quarterly goals' },
    })

    expect(screen.queryByText('OKR Planning & Review')).not.toBeNull()
    expect(screen.queryByText('Available Skill')).toBeNull()
  })
})
