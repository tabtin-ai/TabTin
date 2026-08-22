/**
 * tabdoc handler.beforeClose 集成回归测试
 *
 * 验证三选确认对话框的全部分支：
 * - 无 dirty source（编辑器未挂载）→ 直接放行
 * - dirty source 存在但 saveState='idle'+isDirty=false → 直接放行
 * - 有 dirty 改动：
 *   • 用户"取消" → beforeClose 返回 false（关闭被阻止）
 *   • 用户"放弃修改" → beforeClose 返回 true（关闭继续）
 *   • 用户"保存并关闭" + 保存成功 → beforeClose 返回 true，saver 被调用
 *   • 用户"保存并关闭" + 保存失败 → beforeClose 返回 false，toast 被调用
 *
 * 这些 case 配合 cc001-before-close-hook.test.ts 的 useCloseHandlers
 * 通用契约，确保 tabdoc 关闭路径不丢数据。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockGetSnapshot = vi.fn()
const mockSaveTabDoc = vi.fn()
const mockShouldConfirm = vi.fn()
const mockRequestConfirm = vi.fn()
const mockToast = vi.fn()
const mockOpenResourceTab = vi.fn()

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}))

vi.mock('../../../tabdoc/tabdocDirtyRegistry', () => ({
  getTabDocDirtySnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
  saveTabDoc: (...args: unknown[]) => mockSaveTabDoc(...args),
  shouldConfirmTabDocClose: (...args: unknown[]) => mockShouldConfirm(...args),
}))

vi.mock('../../../tabdoc/tabdocCloseConfirm', () => ({
  requestTabDocCloseConfirm: (...args: unknown[]) => mockRequestConfirm(...args),
}))

// 渲染层 dependency mock —— handler 包含 React.lazy(import) 与 store 引用，仅 beforeClose 不依赖
vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: { getState: () => ({ push: vi.fn() }) },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mockOpenResourceTab,
    }),
  },
}))

vi.mock('@components/common/ListSkeletons', () => ({
  PaneLoadingSkeleton: () => null,
}))

import { tabdocHandler } from '../tabdoc'
import type { ContextItem, ContainerContext } from '../../types'

const makeItem = (overrides: Partial<ContextItem> = {}): ContextItem => ({
  type: 'tabdoc',
  id: 'doc-1',
  tabKey: 'tabdoc:doc-1' as ContextItem['tabKey'],
  title: 'My Doc',
  ...overrides,
})

const makeCtx = (): ContainerContext => ({
  spaceId: 'sp-1',
  closeBrowserView: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tabdocHandler.onSelect', () => {
  it('打开对应 Space 内的文档 tab', () => {
    tabdocHandler.onSelect!(makeItem({ title: '设计文档', meta: { spaceId: 'sp-1' } }), makeCtx())

    expect(mockOpenResourceTab).toHaveBeenCalledWith('sp-1', {
      type: 'tabdoc',
      id: 'doc-1',
      title: '设计文档',
      meta: { spaceId: 'sp-1' },
    })
  })
})

describe('tabdocHandler.beforeClose', () => {
  it('shouldConfirmTabDocClose 返回 false 时直接放行（不弹窗）', async () => {
    mockGetSnapshot.mockReturnValue(null)
    mockShouldConfirm.mockReturnValue(false)

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())

    expect(result).toBe(true)
    expect(mockGetSnapshot).toHaveBeenCalledWith('doc-1')
    expect(mockRequestConfirm).not.toHaveBeenCalled()
    expect(mockSaveTabDoc).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('snapshot=null（编辑器未挂载）时直接放行', async () => {
    mockGetSnapshot.mockReturnValue(null)
    mockShouldConfirm.mockReturnValue(false)

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())
    expect(result).toBe(true)
    expect(mockRequestConfirm).not.toHaveBeenCalled()
  })

  it('saveState=idle + isDirty=false 时直接放行', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'idle',
      isDirty: false,
      isCollaborating: false,
      title: 'doc-1',
    })
    mockShouldConfirm.mockReturnValue(false)

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())
    expect(result).toBe(true)
    expect(mockRequestConfirm).not.toHaveBeenCalled()
  })

  it('有 dirty 改动 + 用户选"取消" → 返回 false（关闭被阻止）', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'dirty',
      isDirty: true,
      isCollaborating: false,
      title: '设计稿草稿',
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('cancel')

    const result = await tabdocHandler.beforeClose!(makeItem({ title: 'My Doc' }), makeCtx())

    expect(result).toBe(false)
    expect(mockRequestConfirm).toHaveBeenCalledTimes(1)
    expect(mockRequestConfirm).toHaveBeenCalledWith('设计稿草稿')
    expect(mockSaveTabDoc).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('有 dirty 改动 + 用户选"放弃修改" → 返回 true（正常关闭）', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'dirty',
      isDirty: true,
      isCollaborating: false,
      title: 'doc',
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('discard')

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())

    expect(result).toBe(true)
    expect(mockSaveTabDoc).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('有 dirty 改动 + 用户选"保存并关闭" + 保存成功 → 返回 true（saver 被调用）', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'dirty',
      isDirty: true,
      isCollaborating: false,
      title: 'doc',
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('save')
    mockSaveTabDoc.mockResolvedValue(true)

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())

    expect(result).toBe(true)
    expect(mockSaveTabDoc).toHaveBeenCalledWith('doc-1')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('有 dirty 改动 + 用户选"保存并关闭" + 保存失败 → 返回 false，toast 提示用户', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'error',
      isDirty: true,
      isCollaborating: false,
      title: 'doc',
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('save')
    mockSaveTabDoc.mockResolvedValue(false)

    const result = await tabdocHandler.beforeClose!(makeItem(), makeCtx())

    expect(result).toBe(false)
    expect(mockSaveTabDoc).toHaveBeenCalledWith('doc-1')
    expect(mockToast).toHaveBeenCalledTimes(1)
    const toastArgs = mockToast.mock.calls[0]?.[0]
    expect(toastArgs).toMatchObject({ variant: 'destructive' })
  })

  it('snapshot.title 为空时降级到 item.title 作为对话框显示名', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'dirty',
      isDirty: true,
      isCollaborating: false,
      title: null,
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('cancel')

    await tabdocHandler.beforeClose!(makeItem({ title: 'fallback-title' }), makeCtx())
    expect(mockRequestConfirm).toHaveBeenCalledWith('fallback-title')
  })

  it('snapshot.title 与 item.title 都缺失时传空串（由 Host 降级）', async () => {
    mockGetSnapshot.mockReturnValue({
      saveState: 'dirty',
      isDirty: true,
      isCollaborating: false,
      title: null,
    })
    mockShouldConfirm.mockReturnValue(true)
    mockRequestConfirm.mockResolvedValue('cancel')

    await tabdocHandler.beforeClose!(makeItem({ title: undefined }), makeCtx())
    expect(mockRequestConfirm).toHaveBeenCalledWith('')
  })
})
