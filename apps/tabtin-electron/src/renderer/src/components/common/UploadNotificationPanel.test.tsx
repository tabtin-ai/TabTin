import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadNotificationPanel } from './UploadNotificationPanel'
import { useUploadQueueStore, type UploadTaskStatus } from '@/stores/useUploadQueueStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { defaultValue?: string },
    ) =>
      typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string'
          ? options.defaultValue
          : key,
  }),
}))

const addTask = (
  id: string,
  status: UploadTaskStatus,
  extra?: { error?: string; progress?: number },
) => {
  const store = useUploadQueueStore.getState()
  store.addTask({
    id,
    fileName: `${id}.png`,
    fileSize: 1024,
    mimeType: 'image/png',
    module: 'test',
    folder: 'test',
  })
  store.updateTask(id, {
    status,
    progress: extra?.progress ?? (status === 'completed' ? 1 : 0),
    error: extra?.error,
    completedAt: status === 'completed' ? Date.now() : undefined,
  })
}

describe('UploadNotificationPanel', () => {
  beforeEach(() => {
    useUploadQueueStore.getState().clearAll()
    useUploadQueueStore.getState().setPanel(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('只有成功任务时静默，不显示“上传完成”通知', () => {
    addTask('done', 'completed')

    const { container } = render(<UploadNotificationPanel />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('上传完成')).toBeNull()
    expect(screen.queryByText('done.png')).toBeNull()
  })

  it('只展示进行中和失败任务，不展示已完成任务', () => {
    addTask('running', 'uploading', { progress: 0.4 })
    addTask('done', 'completed')

    render(<UploadNotificationPanel />)

    expect(screen.getByText('1 个文件上传中')).toBeTruthy()
    expect(screen.getByText('running.png')).toBeTruthy()
    expect(screen.queryByText('done.png')).toBeNull()
  })

  it('失败任务显示错误信息和重试按钮', () => {
    const retry = vi.fn()
    addTask('failed', 'failed', { error: 'network down' })
    useUploadQueueStore.getState().registerRetryCallback('failed', retry)

    render(<UploadNotificationPanel />)

    expect(screen.getByText('1 个文件上传失败')).toBeTruthy()
    expect(screen.getByText('failed.png')).toBeTruthy()
    expect(screen.getByText('network down')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('完成任务会在后台自动清理', () => {
    vi.useFakeTimers()
    addTask('done', 'completed')

    render(<UploadNotificationPanel />)

    expect(useUploadQueueStore.getState().tasks).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(useUploadQueueStore.getState().tasks).toHaveLength(0)
  })
})
