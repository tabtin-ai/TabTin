/**
 * spaceDeleteGuard 单元测试（W2.5 T9）
 *
 * 验证：
 * - 无 dirty 时直接 true（不弹对话框）
 * - 有 dirty 时弹对话框；按用户选择映射 true / false
 * - save 部分失败时返回 false 并 toast 警告
 * - collectAllDirty 抛错时保守 true（不阻塞用户操作）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const toastMock = vi.fn()
vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key },
}))

const collectAllDirtyMock = vi.fn()
vi.mock('../../dirtyRegistry', () => ({
  collectAllDirty: (spaceId?: string) => collectAllDirtyMock(spaceId),
}))

const requestMock = vi.fn()
vi.mock('../dirtyExitConfirmStore', () => ({
  requestDirtyExitConfirm: (params: unknown) => requestMock(params),
}))

import { confirmDirtyBeforeSpaceDelete } from '../spaceDeleteGuard'

beforeEach(() => {
  toastMock.mockReset()
  collectAllDirtyMock.mockReset()
  requestMock.mockReset()
})

const dirtyResource = (id = 'doc-1') => ({
  type: 'tabdoc',
  id,
  spaceId: 'sp-1',
  title: `T-${id}`,
})

describe('confirmDirtyBeforeSpaceDelete', () => {
  it('无 dirty → 直接 true，不弹对话框', async () => {
    collectAllDirtyMock.mockReturnValue([])
    const ok = await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })
    expect(ok).toBe(true)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('用户选 cancel → false', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource()])
    requestMock.mockResolvedValue({ choice: 'cancel' })
    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1', spaceName: 'My Space' })).toBe(false)
    expect(requestMock).toHaveBeenCalledWith({
      resources: [dirtyResource()],
      reason: 'space-delete',
      spaceName: 'My Space',
    })
  })

  it('用户选 discard → true', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource()])
    requestMock.mockResolvedValue({ choice: 'discard' })
    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })).toBe(true)
  })

  it('save-all 全成功 → true', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource('a'), dirtyResource('b')])
    requestMock.mockResolvedValue({
      choice: 'save-all',
      saveResults: [
        { resource: dirtyResource('a'), ok: true },
        { resource: dirtyResource('b'), ok: true },
      ],
    })
    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })).toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('save-all 部分失败 → false + toast 警告', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource('a'), dirtyResource('b')])
    requestMock.mockResolvedValue({
      choice: 'save-all',
      saveResults: [
        { resource: dirtyResource('a'), ok: true },
        { resource: dirtyResource('b'), ok: false },
      ],
    })

    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })).toBe(false)
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock.mock.calls[0][0]).toMatchObject({ variant: 'destructive' })
  })

  it('save-all 全失败 → false + toast', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource('a')])
    requestMock.mockResolvedValue({
      choice: 'save-all',
      saveResults: [{ resource: dirtyResource('a'), ok: false }],
    })

    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })).toBe(false)
    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  it('collectAllDirty 抛错 → 保守 false + toast（P0-2 修复，数据安全优先）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    collectAllDirtyMock.mockImplementation(() => { throw new Error('boom') })
    expect(await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock.mock.calls[0][0]).toMatchObject({ variant: 'destructive' })
    errSpy.mockRestore()
  })

  it('spaceName 为 undefined 时透传 null', async () => {
    collectAllDirtyMock.mockReturnValue([dirtyResource()])
    requestMock.mockResolvedValue({ choice: 'cancel' })
    await confirmDirtyBeforeSpaceDelete({ spaceId: 'sp-1' })
    expect(requestMock).toHaveBeenCalledWith({
      resources: [dirtyResource()],
      reason: 'space-delete',
      spaceName: null,
    })
  })
})
