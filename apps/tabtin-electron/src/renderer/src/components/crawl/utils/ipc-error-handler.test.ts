import { describe, it, expect, vi, beforeEach } from 'vitest'

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: toastMock }))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => {
      const dict: Record<string, string> = {
        'crawl:downloads.actionFailed': '操作失败',
        'crawl:downloads.openFileFailed': '打开文件失败',
      }
      return dict[key] ?? options?.defaultValue ?? key
    },
  },
}))

import { handleIPCError, createIPCErrorHandler } from './ipc-error-handler'

describe('handleIPCError', () => {
  beforeEach(() => {
    toastMock.mockReset()
  })

  it('surfaces the real error message as the toast description ', () => {
    handleIPCError(new Error('文件已被移动或删除'), {
      source: 'DownloadStore',
      action: 'open',
      severity: 'toast',
      titleKey: 'crawl:downloads.openFileFailed',
    })

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '打开文件失败',
        description: '文件已被移动或删除',
        variant: 'destructive',
      }),
    )
  })

  it('never shows the raw internal action name as the title; falls back to a generic label', () => {
    handleIPCError(new Error('boom'), {
      source: 'DownloadStore',
      action: 'open',
      severity: 'toast',
    })

    const call = toastMock.mock.calls[0][0]
    // 回归 ：以前标题会渲染成 "open 失败"（裸方法名），现在应为可读的通用标题
    expect(call.title).toBe('操作失败')
    expect(call.title).not.toContain('open')
    expect(call.description).toBe('boom')
  })

  it('does not toast for silent severity', () => {
    handleIPCError(new Error('quiet'), { source: 'X', action: 'copyUrl' })
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('createIPCErrorHandler forwards the titleKey to the toast', () => {
    const handle = createIPCErrorHandler('DownloadStore')
    handle('open', 'toast', 'crawl:downloads.openFileFailed')(new Error('gone'))

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '打开文件失败', description: 'gone' }),
    )
  })
})
