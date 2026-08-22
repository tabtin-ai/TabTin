/**
 * exitGuardListener 单元测试（W2.5 T9）
 *
 * 验证：
 * - 注册 / 卸载 IPC listener 生命周期
 * - 收到 main 请求 → collect dirty + 弹对话框 + 回响应
 * - 用户 cancel → 回 'cancel'
 * - 用户 discard → 回 'continue'
 * - 用户 save-all 全成功 → 回 'continue'
 * - 用户 save-all 部分失败 → 回 'cancel' + toast
 * - 内部异常 → 降级 'continue'
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
  collectAllDirty: () => collectAllDirtyMock(),
}))

const requestMock = vi.fn()
vi.mock('../dirtyExitConfirmStore', () => ({
  requestDirtyExitConfirm: (params: unknown) => requestMock(params),
}))

import { setupExitGuardListener, _disposeExitGuardListener } from '../exitGuardListener'

interface MockBridge {
  onRequest: ReturnType<typeof vi.fn>
  sendResponse: ReturnType<typeof vi.fn>
}

let registeredCallback: ((p: { reason: 'app-quit' | 'window-close'; requestId: string }) => void) | null = null
let bridge: MockBridge

const makeBridge = (): MockBridge => {
  registeredCallback = null
  return {
    onRequest: vi.fn((cb: (p: { reason: 'app-quit' | 'window-close'; requestId: string }) => void) => {
      registeredCallback = cb
      return () => { registeredCallback = null }
    }),
    sendResponse: vi.fn(),
  }
}

beforeEach(() => {
  toastMock.mockReset()
  collectAllDirtyMock.mockReset()
  requestMock.mockReset()
  bridge = makeBridge()
  _disposeExitGuardListener()
})

const dirtyResource = (id = 'doc-1') => ({
  type: 'tabdoc',
  id,
  spaceId: 'sp-1',
  title: `T-${id}`,
})

describe('setupExitGuardListener', () => {
  it('注册 IPC listener 一次', () => {
    setupExitGuardListener({ exitGuardBridge: bridge })
    expect(bridge.onRequest).toHaveBeenCalledTimes(1)
  })

  it('返回的 cleanup 函数能注销 listener', () => {
    const cleanup = setupExitGuardListener({ exitGuardBridge: bridge })
    expect(registeredCallback).not.toBeNull()
    cleanup()
    expect(registeredCallback).toBeNull()
  })

  it('window.tabtin.exitGuard 不存在时返回 noop', () => {
    const cleanup = setupExitGuardListener({ exitGuardBridge: undefined })
    expect(typeof cleanup).toBe('function')
    cleanup()
  })

  it('重复 setup 时先卸载旧 listener', () => {
    setupExitGuardListener({ exitGuardBridge: bridge })
    const oldCallback = registeredCallback

    const newBridge = makeBridge()
    setupExitGuardListener({ exitGuardBridge: newBridge })
    // 旧 listener 应被注销，新 listener 注册
    expect(oldCallback).not.toBe(registeredCallback)
    expect(newBridge.onRequest).toHaveBeenCalledTimes(1)
  })

  describe('收到 request 后的分派', () => {
    beforeEach(() => {
      setupExitGuardListener({ exitGuardBridge: bridge })
    })

    it('用户 cancel → 回 cancel', async () => {
      collectAllDirtyMock.mockReturnValue([dirtyResource()])
      requestMock.mockResolvedValue({ choice: 'cancel' })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'cancel' })
    })

    it('用户 discard → 回 continue', async () => {
      collectAllDirtyMock.mockReturnValue([dirtyResource()])
      requestMock.mockResolvedValue({ choice: 'discard' })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'continue' })
    })

    it('save-all 全成功 → 回 continue', async () => {
      collectAllDirtyMock.mockReturnValue([dirtyResource('a')])
      requestMock.mockResolvedValue({
        choice: 'save-all',
        saveResults: [{ resource: dirtyResource('a'), ok: true }],
      })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'continue' })
      expect(toastMock).not.toHaveBeenCalled()
    })

    it('save-all 部分失败 → 回 cancel + toast', async () => {
      collectAllDirtyMock.mockReturnValue([dirtyResource('a'), dirtyResource('b')])
      requestMock.mockResolvedValue({
        choice: 'save-all',
        saveResults: [
          { resource: dirtyResource('a'), ok: true },
          { resource: dirtyResource('b'), ok: false },
        ],
      })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'cancel' })
      expect(toastMock).toHaveBeenCalledTimes(1)
    })

    it('无 dirty 时 requestDirtyExitConfirm 立即返回 discard → 回 continue', async () => {
      collectAllDirtyMock.mockReturnValue([])
      requestMock.mockResolvedValue({ choice: 'discard' })

      await registeredCallback!({ reason: 'window-close', requestId: 'req-2' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-2', choice: 'continue' })
    })

    it('collectAllDirty 抛错 → 保守回 cancel（P0-3 修复）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      collectAllDirtyMock.mockImplementation(() => { throw new Error('boom') })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'cancel' })
      errSpy.mockRestore()
    })

    it('requestDirtyExitConfirm 抛错 → 保守回 cancel（P0-3 修复）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      collectAllDirtyMock.mockReturnValue([dirtyResource()])
      requestMock.mockRejectedValue(new Error('dialog crashed'))

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'cancel' })
      errSpy.mockRestore()
    })

    it('save-all 全失败 → 回 cancel + toast 标题用 saveFailedToastTitleAll（P1 修复）', async () => {
      collectAllDirtyMock.mockReturnValue([dirtyResource('a'), dirtyResource('b')])
      requestMock.mockResolvedValue({
        choice: 'save-all',
        saveResults: [
          { resource: dirtyResource('a'), ok: false },
          { resource: dirtyResource('b'), ok: false },
        ],
      })

      await registeredCallback!({ reason: 'app-quit', requestId: 'req-1' })
      expect(bridge.sendResponse).toHaveBeenCalledWith({ requestId: 'req-1', choice: 'cancel' })
      expect(toastMock).toHaveBeenCalledTimes(1)
      // 全失败应使用 saveFailedToastTitleAll 而非 saveFailedToastTitle（仅"部分失败"用）
      expect(toastMock.mock.calls[0][0]).toMatchObject({
        title: '文档保存全部失败',
      })
    })

    it('sendResponse 抛错时不向上传播', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      collectAllDirtyMock.mockReturnValue([dirtyResource()])
      requestMock.mockResolvedValue({ choice: 'cancel' })
      bridge.sendResponse.mockImplementation(() => { throw new Error('ipc dead') })

      await expect(
        registeredCallback!({ reason: 'app-quit', requestId: 'req-1' }),
      ).resolves.not.toThrow()
      errSpy.mockRestore()
    })
  })
})
