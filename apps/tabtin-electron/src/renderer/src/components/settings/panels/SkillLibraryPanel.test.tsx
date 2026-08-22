import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook } from '@testing-library/react'

const spaceState = {
  selectedSpace: { id: 'space-org-1', organization_id: 'org-1' } as {
    id: string
    organization_id: string
  } | null,
  selectedAgent: null as { id: string } | null,
  spaces: [
    { id: 'space-org-1', organization_id: 'org-1' },
    { id: 'space-org-2', organization_id: 'org-2' },
  ],
}

const organizationState = {
  selectedOrganization: { id: 'org-1' } as { id: string } | null,
}

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (
    selector: (state: typeof organizationState) => unknown,
  ) => selector(organizationState),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof spaceState) => unknown) => selector(spaceState),
}))

vi.mock('@components/context-space/skills/SkillPanel', () => ({
  SkillPanel: () => null,
}))

vi.mock('../SettingsPanelHeader', () => ({
  useCompositeTabActive: () => false,
  useSettingsPanelHeaderFooter: () => null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('lucide-react', () => ({
  Sparkles: () => null,
}))

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  PaneLoadingSkeleton: () => null,
}))

import { SkillLibraryPanel, useSkillLibraryContextSpaceId } from './SkillLibraryPanel'

afterEach(() => {
  spaceState.selectedSpace = { id: 'space-org-1', organization_id: 'org-1' }
  spaceState.selectedAgent = null
  organizationState.selectedOrganization = { id: 'org-1' }
})

describe('SkillLibraryPanel layout', () => {
  it('一级工作台铺满主画布，设置入口保留最大可读宽度', () => {
    const { container, rerender } = render(<SkillLibraryPanel standalone />)
    expect(container.firstElementChild?.className).not.toContain('max-w-5xl')

    rerender(<SkillLibraryPanel />)
    expect(container.firstElementChild?.className).toContain('max-w-5xl')

    rerender(<SkillLibraryPanel embeddedInWorkbench />)
    expect(container.firstElementChild?.className).not.toContain('max-w-5xl')
  })

  it('#8698 有组织但无 selectedAgent 仍渲染技能库', () => {
    spaceState.selectedAgent = null
    organizationState.selectedOrganization = { id: 'org-1' }
    const { container } = render(<SkillLibraryPanel />)
    expect(container.textContent).not.toContain('请先选择或创建一个组织')
    expect(container.textContent).not.toContain('先创建一个 Agent')
  })

  it('#8698 无组织时展示组织空态', () => {
    organizationState.selectedOrganization = null
    const { container } = render(<SkillLibraryPanel />)
    expect(container.textContent).toContain('请先选择或创建一个组织')
  })
})

describe('useSkillLibraryContextSpaceId', () => {
  it('显式组织只返回该组织的 Space', () => {
    const { result } = renderHook(() => useSkillLibraryContextSpaceId('org-2'))
    expect(result.current).toBe('space-org-2')
  })

  it('显式组织没有 Space 时不回退到其他组织', () => {
    const { result } = renderHook(() => useSkillLibraryContextSpaceId('org-missing'))
    expect(result.current).toBeNull()
  })
})
