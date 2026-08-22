/**
 * apphome handler 渲染 HomeSection 的回归测试
 *
 * 覆盖两个核心契约：
 *
 * 1. onCreateResource 注入 —— 默认走 HomeSectionPaneContent 分支时，
 *    apphomeHandler 必须从 useSpaceContextActions 读取真实的 createHandlers，
 *    并以 (appId) => createHandlers[appId]?.() 注入给 Section。
 *    历史问题：之前写死 onCreateResource={() => {}}，导致 TabPhoneSection
 *    在独立 apphome 标签页里点击设备 / 点击「+ 添加设备」全部无响应。
 *
 * 2. renderInsideContextHome 路由 —— Section 显式声明该字段时，apphome
 *    应包裹完整的 ContextHome 容器（替代之前 apphome.tsx 内硬编码的
 *    RESOURCE_TYPE_APPS 白名单），保证新增资源型 App 不会再次踩坑。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { render, fireEvent, act } from '@testing-library/react'

const mockUseSpaceContextActions = vi.fn()

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useSpaceContextActions: () => mockUseSpaceContextActions(),
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('../../homeRegistry', () => ({}))

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next')
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const SectionSpy = vi.fn()
const ContextHomeSpy = vi.fn()

// ContextHome 是 React.lazy(import) 加载的；mock 模块本体，等 Suspense 解析后即可被消费。
vi.mock('@components/context-space/ContextHome', () => ({
  ContextHome: (props: Record<string, unknown>) => {
    ContextHomeSpy(props)
    return <div data-testid="context-home">CONTEXT_HOME</div>
  },
}))

let mockSectionRenderInsideContextHome: boolean | undefined

vi.mock('../../resolveUtils', () => ({
  resolveAppHomeTabModel: (appId: string) => ({
    appId,
    title: 'TestApp',
    labelKey: 'home.assetBrowser.devices',
    displayLabel: 'TestApp',
    displayEmoji: '📱',
    section: {
      appId,
      labelKey: 'home.assetBrowser.devices',
      renderInsideContextHome: mockSectionRenderInsideContextHome,
      Component: (props: {
        spaceId: string
        onCreateResource: (id: string, options?: { collectionId?: string | null }) => void
      }) => {
        SectionSpy(props)
        return (
          <div>
            <button onClick={() => props.onCreateResource('tabdoc')}>add-device</button>
            <button onClick={() => props.onCreateResource('tabdoc')}>open-device</button>
            <button onClick={() => props.onCreateResource('tabdoc', { collectionId: 'collection-1' })}>
              add-doc-in-folder
            </button>
          </div>
        )
      },
    },
    sidebarPanel: null,
  }),
}))

import { apphomeHandler } from '../apphome'
import type { ContextItem } from '../../types'

function makeItem(appId = 'tabdoc'): ContextItem {
  return {
    type: 'apphome',
    id: appId,
    tabKey: `apphome:${appId}` as ContextItem['tabKey'],
    title: 'TestApp',
    meta: { appId },
  }
}

async function renderPane(spaceId = 'sp-1') {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    const node = apphomeHandler.renderPane?.(makeItem(), { spaceId })
    utils = render(<>{node}</>)
  })
  // 让 React.lazy + Suspense 完成解析（ContextHome 走 lazy 加载）
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return utils
}

describe('apphomeHandler.renderPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSectionRenderInsideContextHome = undefined
  })

  describe('默认分支 → HomeSectionPaneContent', () => {
    it('应通过 useSpaceContextActions 注入真实的 onCreateResource', async () => {
      const tabdocCreate = vi.fn()
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: { tabdoc: tabdocCreate },
        onSearchNavigate: undefined,
      })

      const utils = await renderPane()

      expect(SectionSpy).toHaveBeenCalled()
      const props = SectionSpy.mock.calls[0][0]
      expect(props.spaceId).toBe('sp-1')
      expect(typeof props.onCreateResource).toBe('function')

      fireEvent.click(utils.getByText('add-device'))
      expect(tabdocCreate).toHaveBeenCalledTimes(1)

      fireEvent.click(utils.getByText('open-device'))
      expect(tabdocCreate).toHaveBeenCalledTimes(2)
    })

    it('createHandlers 未注册对应 appId 时不应抛错（noop 兜底）', async () => {
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: {},
        onSearchNavigate: undefined,
      })

      const utils = await renderPane()
      expect(() => fireEvent.click(utils.getByText('add-device'))).not.toThrow()
    })

    it('应同时把 onSearchNavigate 透传给 Section', async () => {
      const onSearchNavigate = vi.fn()
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: { tabdoc: vi.fn() },
        onSearchNavigate,
      })

      await renderPane()
      const props = SectionSpy.mock.calls[0][0]
      expect(props.onSearchNavigate).toBe(onSearchNavigate)
    })

    it('应把 onCreateResource options 透传给真实 create handler', async () => {
      const tabdocCreate = vi.fn()
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: { tabdoc: tabdocCreate },
        onSearchNavigate: undefined,
      })

      const utils = await renderPane()

      fireEvent.click(utils.getByText('add-doc-in-folder'))
      expect(tabdocCreate).toHaveBeenCalledWith({ collectionId: 'collection-1' })
    })
  })

  describe('renderInsideContextHome=true 分支 → ContextHome', () => {
    it('Section 显式声明 renderInsideContextHome 时应渲染完整 ContextHome', async () => {
      mockSectionRenderInsideContextHome = true
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: {},
        onSearchNavigate: undefined,
      })

      const utils = await renderPane()

      // ContextHome 是 React.lazy 加载，等 Suspense 解析后断言 DOM
      const node = await utils.findByTestId('context-home')
      expect(node).not.toBeNull()
      expect(SectionSpy).not.toHaveBeenCalled()

      const props = ContextHomeSpy.mock.calls[0][0]
      expect(props.forcedAssetTab).toBe('tabdoc')
      expect(props.hideAssetSwitcher).toBe(true)
      expect(props.hideToolbar).toBe(true)
    })

    it('未声明 renderInsideContextHome 时不应走 ContextHome（防止默认行为漂移）', async () => {
      mockSectionRenderInsideContextHome = undefined
      mockUseSpaceContextActions.mockReturnValue({
        createHandlers: { tabdoc: vi.fn() },
        onSearchNavigate: undefined,
      })

      await renderPane()

      expect(ContextHomeSpy).not.toHaveBeenCalled()
      expect(SectionSpy).toHaveBeenCalled()
    })
  })
})
