import { describe, expect, it, vi } from 'vitest'
import { archiveSessionWithRestoreToast } from '../useInlineArchiveConfirm'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  restoreSession: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ToastAction: () => null,
}))

vi.mock('@components/ui', () => ({
  toast: mocks.toast,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({ restoreSession: mocks.restoreSession }),
  },
}))

describe('archiveSessionWithRestoreToast', () => {
  it('opens the share dialog for a share-archive 409 and does not toast success', async () => {
    const onShareConflict = vi.fn()
    const onDeleteSession = vi.fn().mockRejectedValue({
      statusCode: 409,
      message: '请先停止共享任务再归档',
    })

    archiveSessionWithRestoreToast({
      spaceId: 'space-1',
      sessionId: 's1',
      sessionTitle: '任务',
      onDeleteSession,
      onShareConflict,
      t: (_key, options) => String(options.defaultValue),
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(onShareConflict).toHaveBeenCalledWith('s1')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not treat a non-share 409 as a share conflict', async () => {
    const onShareConflict = vi.fn()
    const onDeleteSession = vi.fn().mockRejectedValue({
      statusCode: 409,
      message: '已确定执行设备的会话不能切换为 observer',
    })

    archiveSessionWithRestoreToast({
      spaceId: 'space-1',
      sessionId: 's1',
      sessionTitle: '任务',
      onDeleteSession,
      onShareConflict,
      t: (_key, options) => String(options.defaultValue),
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(onShareConflict).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalled()
  })
})
