import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SidebarCloudDocsOpenTabsDock } from '../SidebarCloudDocsOpenTabsDock'
import { CLOUD_DOCS_HOME_TAB_KEY } from '../cloudDocsOpenTabs'

const CLOUD_DOCS_SCOPE = 'cloud-docs:organization:org-1:user:user-1'
const setActiveKey = vi.fn()
const closeTab = vi.fn()
const setDockCollapsed = vi.fn()
const invokeCloseContextTab = vi.fn()

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (state: unknown) => unknown) => selector({
    tabOrderBySpace: {
      [CLOUD_DOCS_SCOPE]: [
        CLOUD_DOCS_HOME_TAB_KEY,
        'tabdoc:doc-1',
        'tabweb:view-1',
      ],
    },
    itemsBySpace: {
      [CLOUD_DOCS_SCOPE]: {
        [CLOUD_DOCS_HOME_TAB_KEY]: {
          tabKey: CLOUD_DOCS_HOME_TAB_KEY,
          type: 'apphome',
          id: 'cloud-resources',
          title: '云文档',
          meta: null,
        },
        'tabdoc:doc-1': {
          tabKey: 'tabdoc:doc-1',
          type: 'tabdoc',
          id: 'doc-1',
          title: '未命名文档',
          meta: null,
        },
        'tabweb:view-1': {
          tabKey: 'tabweb:view-1',
          type: 'tabweb',
          id: 'view-1',
          title: 'Demo HTML',
          meta: {
            spaceId: 'space-from-browser',
            crawlspaceId: 'crawlspace-cloud-docs',
          },
        },
      },
    },
    activeKeyBySpace: {
      [CLOUD_DOCS_SCOPE]: 'tabdoc:doc-1',
    },
    setActiveKey,
    closeTab,
  }),
}))

vi.mock('@components/context-space/tools/ContextSpaceToolHandler', () => ({
  invokeCloseContextTab: (...args: unknown[]) => invokeCloseContextTab(...args),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: unknown) => unknown) => selector({
    getPrefs: (_spaceId: string) => ({ cloudDocsOpenTabsDockCollapsed: false }),
    setCloudDocsOpenTabsDockCollapsed: setDockCollapsed,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; title?: string }) =>
      (options?.defaultValue ?? key).replace('{{title}}', options?.title ?? ''),
  }),
}))

vi.mock('@components/layout/sidebarTypeEmoji', () => ({
  TabTypeEmoji: ({ appIdOrType }: { appIdOrType: string }) => (
    <span data-testid={`emoji-${appIdOrType}`} />
  ),
}))

describe('SidebarCloudDocsOpenTabsDock', () => {
  beforeEach(() => {
    setActiveKey.mockReset()
    closeTab.mockReset()
    setDockCollapsed.mockReset()
    invokeCloseContextTab.mockReset()
    invokeCloseContextTab.mockResolvedValue({ success: true })
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders open tabs and switches active tab', () => {
    render(<SidebarCloudDocsOpenTabsDock tabScopeKey={CLOUD_DOCS_SCOPE} />)

    expect(screen.getByText('当前打开')).toBeTruthy()
    expect(screen.getByText('未命名文档')).toBeTruthy()

    fireEvent.click(screen.getByText('云文档'))
    expect(setActiveKey).toHaveBeenCalledWith(CLOUD_DOCS_SCOPE, CLOUD_DOCS_HOME_TAB_KEY)
  })

  it('closes closable tabs with fallback', () => {
    render(<SidebarCloudDocsOpenTabsDock tabScopeKey={CLOUD_DOCS_SCOPE} />)

    fireEvent.click(screen.getByLabelText('关闭 未命名文档'))
    expect(closeTab).toHaveBeenCalledWith(
      CLOUD_DOCS_SCOPE,
      'tabdoc:doc-1',
      CLOUD_DOCS_HOME_TAB_KEY,
    )
  })

  it('closes browser tabs through the canonical resource cleanup path', async () => {
    render(
      <SidebarCloudDocsOpenTabsDock
        tabScopeKey={CLOUD_DOCS_SCOPE}
        resourceHostSpaceId="space-host-fallback"
      />,
    )

    fireEvent.click(screen.getByLabelText('关闭 Demo HTML'))

    expect(invokeCloseContextTab).toHaveBeenCalledWith({
      spaceId: 'space-from-browser',
      tabScopeKey: CLOUD_DOCS_SCOPE,
      crawlspaceId: 'crawlspace-cloud-docs',
      tabKey: 'tabweb:view-1',
    })
    expect(closeTab).not.toHaveBeenCalledWith(
      CLOUD_DOCS_SCOPE,
      'tabweb:view-1',
      expect.anything(),
    )
  })
})
