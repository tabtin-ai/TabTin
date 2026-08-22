import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHomePane } from './DesktopHomePane'

const mockCreateDocument = vi.fn()
const mockCreateTable = vi.fn()
const mockCreateTerminal = vi.fn()
const mockOpenAppHome = vi.fn()
const mockSelectItem = vi.fn()

const visibleDocItem = {
  type: 'tabdoc',
  id: 'doc-1',
  tabKey: 'tabdoc:doc-1',
  title: 'Spec Doc',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('./SpaceContextAreaContext', () => ({
  useSpaceContextActions: () => ({
    createHandlers: {
      tabdoc: mockCreateDocument,
      tabdata: mockCreateTable,
      terminal: mockCreateTerminal,
    },
    onOpenAppHome: mockOpenAppHome,
    onSelectItem: mockSelectItem,
  }),
  useSpaceContextState: () => ({
    visibleItems: [visibleDocItem],
    spaceId: 'space-1',
    creatingAppIds: new Set(),
  }),
}))

vi.mock('@stores/useUnifiedResources', () => ({
  useUnifiedResources: (selector: (state: unknown) => unknown) => selector({
    resourcesBySpaceId: {
      'space-1': [{
        id: 'context-item-1',
        item_type: 'tabdoc',
        resource_id: 'doc-1',
        title: 'Spec Doc',
        space_id: 'space-1',
        last_visited_at: '2026-07-20T10:00:00Z',
      }],
    },
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: unknown) => unknown) => selector({
    spaces: [{ id: 'space-1', organization_id: 'organization-1', is_archived: false }],
  }),
}))

vi.mock('./registry', () => ({
  contextRegistry: {
    getAppEntries: () => [],
    getTabIcon: () => 'icon',
    getTabLabel: (item: { title?: string }) => item.title ?? '',
  },
}))

describe('DesktopHomePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.removeItem('tabtin:desktop-home:intro-dismissed:v1')
    window.localStorage.removeItem('tabtin:desktop-sidebar:pinned-apps:v1')
  })

  it('uses container-aware spacing and card columns for narrow panels', () => {
    render(<DesktopHomePane />)

    const pageContainer = screen.getByRole('heading', { name: '从应用开始工作' }).closest('[class*="px-[clamp(16px,5%,32px)]"]')
    expect(pageContainer?.className).toContain('px-[clamp(16px,5%,32px)]')
    expect(pageContainer?.className).toContain('py-10')
    expect(pageContainer?.className).toContain('w-full')
    expect(pageContainer?.className).not.toContain('max-w-[1020px]')
    expect(pageContainer?.className).not.toContain('max-w-5xl')

    const continueCard = screen.getByText('Spec Doc').closest('button')
    expect(continueCard?.parentElement?.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))]')
    expect(continueCard?.className).toContain('min-h-[96px]')
    expect(continueCard?.querySelector('span')?.className).toContain('h-14')
    expect(continueCard?.querySelector('span')?.className).toContain('[&>span]:h-10')
    expect(continueCard?.querySelector('span')?.className).not.toContain('bg-muted')

    const manageCard = screen.getByText('管理快捷入口').closest('button')
    expect(manageCard?.parentElement?.className).toContain('grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))]')
    expect(manageCard?.className).toContain('min-h-[124px]')
    expect(manageCard?.querySelector('span span')?.className).toContain('h-12')
    expect(screen.queryByText('desktop.home.introTitle')).toBeNull()
  })

  it('任务模式显示工作台入口文案', () => {
    render(<DesktopHomePane variant="task-workbench" />)

    expect(screen.getByRole('heading', { name: '打开应用工作台' })).toBeTruthy()
    expect(screen.getByText('从已有应用或新应用进入工作现场，打开后会成为当前任务的一个标签。')).toBeTruthy()
  })
})
