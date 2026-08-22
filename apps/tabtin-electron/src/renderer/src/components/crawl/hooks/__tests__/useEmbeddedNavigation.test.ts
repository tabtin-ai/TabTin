/**
 * createNavigationActions.handleNavigate 单测（ 地址栏/页面脱钩回归）
 *
 * 乐观更新 + 回滚语义：地址栏先展示目标 URL，但导航失败或被主进程跳过
 * （task-lock）时必须回退到原 URL——否则出现「地址栏是搜索结果、页面还停在
 * 旧站」的脱钩现场。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createNavigationActions } from '../useEmbeddedNavigation'

vi.mock('../../../../crawlspace/utils/reportCrawlViewError', () => ({
  reportCrawlViewError: (payload: { message: string }) => new Error(payload.message),
}))

const PREV_URL = 'https://www.zhihu.com/'
const NEW_URL = 'https://www.google.com/search?q=taobao'

function makeContainer(): HTMLDivElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}

function makeActions(showResult: { success: boolean; error?: string; skipped?: string }) {
  const updateLocation = vi.fn()
  const setAddressBarStatus = vi.fn()
  const setAddressBarMessage = vi.fn()
  const setToolbarMessage = vi.fn()
  const show = vi.fn(async () => showResult)

  const actions = createNavigationActions({
    tabId: 'tab-1',
    tabUrl: PREV_URL,
    hostView: { show } as any,
    containerRef: { current: makeContainer() },
    updateViewBoundsRef: { current: vi.fn() },
    overlayCount: 0,
    t: ((key: string) => key) as any,
    resolveWorkspaceContext: () => ({
      crawlspaceId: 'cs-1',
      profile: 'user-tab',
      partition: 'persist:tabtin:env:default',
      runId: undefined,
    }),
    buildViewOptions: () => ({ kind: 'workspace-view' }) as any,
    updateLocation,
    stateSetter: {
      setAddressBarStatus,
      setAddressBarMessage,
      setToolbarMessage,
      navigationState: { isLoading: false },
    },
  })

  return { actions, updateLocation, setAddressBarStatus, setToolbarMessage, show }
}

describe('handleNavigate 乐观更新与回滚', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number)
  })

  it('导航成功：地址栏保持目标 URL，不回滚', async () => {
    const { actions, updateLocation, setAddressBarStatus } = makeActions({ success: true })

    await actions.handleNavigate(NEW_URL)

    expect(updateLocation).toHaveBeenCalledTimes(1)
    expect(updateLocation).toHaveBeenCalledWith({ url: NEW_URL, themeColor: null })
    expect(setAddressBarStatus).toHaveBeenLastCalledWith('idle')
  })

  it('导航失败：地址栏回滚到原 URL 并展示错误', async () => {
    const { actions, updateLocation, setAddressBarStatus, setToolbarMessage } = makeActions({
      success: false,
      error: 'view not found: tab-1',
    })

    await actions.handleNavigate(NEW_URL)

    expect(updateLocation).toHaveBeenNthCalledWith(1, { url: NEW_URL, themeColor: null })
    expect(updateLocation).toHaveBeenNthCalledWith(2, { url: PREV_URL })
    expect(setAddressBarStatus).toHaveBeenLastCalledWith('error')
    expect(setToolbarMessage).toHaveBeenLastCalledWith('view not found: tab-1')
  })

  it('导航被 task-lock 跳过：页面没动 → 回滚 URL 并说明原因', async () => {
    const { actions, updateLocation, setAddressBarStatus, setToolbarMessage } = makeActions({
      success: true,
      skipped: 'task-lock',
    })

    await actions.handleNavigate(NEW_URL)

    expect(updateLocation).toHaveBeenNthCalledWith(2, { url: PREV_URL })
    expect(setAddressBarStatus).toHaveBeenLastCalledWith('idle')
    expect(setToolbarMessage).toHaveBeenLastCalledWith('embedded.errors.navigationDeferredByAgent')
  })

  it('same-url 跳过：URL 本就一致，不产生回滚调用', async () => {
    const { actions, updateLocation } = makeActions({ success: true, skipped: 'same-url' })

    await actions.handleNavigate(NEW_URL)

    expect(updateLocation).toHaveBeenCalledTimes(1)
  })

  it('show 抛异常：回滚 URL 并进入错误态', async () => {
    const { actions, updateLocation, setAddressBarStatus, show } = makeActions({ success: true })
    show.mockRejectedValueOnce(new Error('IPC broken'))

    await actions.handleNavigate(NEW_URL)

    expect(updateLocation).toHaveBeenNthCalledWith(2, { url: PREV_URL })
    expect(setAddressBarStatus).toHaveBeenLastCalledWith('error')
  })
})
