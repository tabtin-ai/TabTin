import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchedulePreviewResult } from '@/services/trackerApi'

const listSchedulePreview = vi.hoisted(() => vi.fn())

vi.mock('@/services/trackerApi', async () => {
  const actual = await vi.importActual<typeof import('@/services/trackerApi')>('@/services/trackerApi')
  return {
    ...actual,
    listSchedulePreview,
  }
})

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }
  return { createLogger: () => stub, logger: stub }
})

import { useTrackerSchedulePreview } from './useTrackerSchedulePreview'

const WEEK_FROM = '2026-07-20T00:00:00.000Z'
const WEEK_TO = '2026-07-27T00:00:00.000Z'

describe('useTrackerSchedulePreview', () => {
  beforeEach(() => {
    listSchedulePreview.mockReset()
  })

  it('加载成功后暴露 occurrences，并区分真正空态', async () => {
    listSchedulePreview.mockResolvedValue({
      occurrences: [],
      truncated: false,
    } satisfies SchedulePreviewResult)

    const { result } = renderHook(() =>
      useTrackerSchedulePreview({
        organizationId: 'org-1',
        spaceId: 'space-1',
        from: WEEK_FROM,
        to: WEEK_TO,
      }),
    )

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.occurrences).toEqual([])
    expect(result.current.isEmpty).toBe(true)
    expect(result.current.error).toBe(false)
    expect(listSchedulePreview).toHaveBeenCalledWith('org-1', expect.objectContaining({
      spaceId: 'space-1',
      from: WEEK_FROM,
      to: WEEK_TO,
    }))
  })

  it('错误态可重试', async () => {
    listSchedulePreview
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        occurrences: [{
          tracker_id: 't1',
          name: '晨报',
          space_id: 'space-1',
          space_name: '产品',
          scheduled_at: '2026-07-22T01:00:00.000Z',
          status: 'active',
          trigger_type: 'cron',
          timezone: 'Asia/Shanghai',
        }],
        truncated: false,
      } satisfies SchedulePreviewResult)

    const { result } = renderHook(() =>
      useTrackerSchedulePreview({
        organizationId: 'org-1',
        spaceId: undefined,
        from: WEEK_FROM,
        to: WEEK_TO,
      }),
    )

    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.isEmpty).toBe(false)

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.occurrences).toHaveLength(1))
    expect(result.current.error).toBe(false)
  })

  it('普通错误消息即使包含 abort 也不能被误吞并卡在加载态', async () => {
    const { createLogger } = await import('@/utils/logger')
    const log = createLogger('TrackerSchedulePreview')
    listSchedulePreview.mockRejectedValue(new Error('upstream aborted transaction with 500'))

    const { result } = renderHook(() =>
      useTrackerSchedulePreview({
        organizationId: 'org-1',
        spaceId: 'space-1',
        from: WEEK_FROM,
        to: WEEK_TO,
      }),
    )

    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.isLoading).toBe(false)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('upstream aborted transaction with 500'),
    )
  })

  it('refreshToken 后台刷新保留旧 occurrences，不重新显示 skeleton', async () => {
    const first = {
      occurrences: [{
        tracker_id: 'keep',
        name: '保留',
        space_id: 'space-1',
        space_name: null,
        scheduled_at: '2026-07-22T01:00:00.000Z',
        status: 'active' as const,
        trigger_type: 'cron' as const,
        timezone: 'UTC',
      }],
      truncated: false,
    } satisfies SchedulePreviewResult

    let resolveRefresh: (value: SchedulePreviewResult) => void
    const refreshPromise = new Promise<SchedulePreviewResult>((resolve) => {
      resolveRefresh = resolve
    })

    listSchedulePreview
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => refreshPromise)

    const { result, rerender } = renderHook(
      (props: { refreshToken?: number }) =>
        useTrackerSchedulePreview({
          organizationId: 'org-1',
          spaceId: 'space-1',
          from: WEEK_FROM,
          to: WEEK_TO,
          refreshToken: props.refreshToken,
        }),
      { initialProps: { refreshToken: 0 } },
    )

    await waitFor(() => expect(result.current.occurrences).toHaveLength(1))
    expect(result.current.isLoading).toBe(false)

    rerender({ refreshToken: 1 })
    await waitFor(() => expect(listSchedulePreview).toHaveBeenCalledTimes(2))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isRefreshing).toBe(true)
    expect(result.current.occurrences[0]?.tracker_id).toBe('keep')

    await act(async () => {
      resolveRefresh!({
        occurrences: [{
          ...first.occurrences[0],
          tracker_id: 'newer',
          name: '更新后',
        }],
        truncated: false,
      })
    })
    await waitFor(() => expect(result.current.occurrences[0]?.tracker_id).toBe('newer'))
    expect(result.current.isRefreshing).toBe(false)
  })

  it('查询窗口变化时显示初次 skeleton', async () => {
    listSchedulePreview.mockResolvedValue({
      occurrences: [{
        tracker_id: 'old',
        name: '旧窗',
        space_id: 'space-1',
        space_name: null,
        scheduled_at: '2026-07-22T01:00:00.000Z',
        status: 'active',
        trigger_type: 'cron',
        timezone: 'UTC',
      }],
      truncated: false,
    } satisfies SchedulePreviewResult)

    const { result, rerender } = renderHook(
      (props: { from: string; to: string }) =>
        useTrackerSchedulePreview({
          organizationId: 'org-1',
          spaceId: 'space-1',
          from: props.from,
          to: props.to,
        }),
      {
        initialProps: {
          from: WEEK_FROM,
          to: WEEK_TO,
        },
      },
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let resolveNext: (value: SchedulePreviewResult) => void
    listSchedulePreview.mockImplementationOnce(
      () => new Promise<SchedulePreviewResult>((resolve) => {
        resolveNext = resolve
      }),
    )

    rerender({
      from: '2026-07-27T00:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
    })
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(result.current.isRefreshing).toBe(false)

    await act(async () => {
      resolveNext!({ occurrences: [], truncated: false })
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it('后台刷新失败时保留旧数据并标记错误，不过期响应不覆盖', async () => {
    const kept = {
      occurrences: [{
        tracker_id: 'stable',
        name: '稳定',
        space_id: 'space-1',
        space_name: null,
        scheduled_at: '2026-07-22T01:00:00.000Z',
        status: 'active' as const,
        trigger_type: 'cron' as const,
        timezone: 'UTC',
      }],
      truncated: true,
    } satisfies SchedulePreviewResult

    let rejectRefresh: (err: Error) => void
    const refreshPromise = new Promise<SchedulePreviewResult>((_resolve, reject) => {
      rejectRefresh = reject
    })

    listSchedulePreview
      .mockResolvedValueOnce(kept)
      .mockImplementationOnce(() => refreshPromise)

    const { result, rerender } = renderHook(
      (props: { refreshToken?: number }) =>
        useTrackerSchedulePreview({
          organizationId: 'org-1',
          spaceId: 'space-1',
          from: WEEK_FROM,
          to: WEEK_TO,
          refreshToken: props.refreshToken,
        }),
      { initialProps: { refreshToken: 0 } },
    )

    await waitFor(() => expect(result.current.truncated).toBe(true))
    rerender({ refreshToken: 1 })
    await waitFor(() => expect(result.current.isRefreshing).toBe(true))

    await act(async () => {
      rejectRefresh!(new Error('backend 503 detail'))
    })
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.occurrences[0]?.tracker_id).toBe('stable')
    expect(result.current.truncated).toBe(true)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isEmpty).toBe(false)
  })

  it('竞态：旧请求晚到不覆盖新窗口结果', async () => {
    let resolveSlow: (value: SchedulePreviewResult) => void
    const slow = new Promise<SchedulePreviewResult>((resolve) => {
      resolveSlow = resolve
    })
    listSchedulePreview
      .mockImplementationOnce(() => slow)
      .mockResolvedValueOnce({
        occurrences: [{
          tracker_id: 'new',
          name: '新窗',
          space_id: 'space-1',
          space_name: null,
          scheduled_at: '2026-07-29T01:00:00.000Z',
          status: 'active',
          trigger_type: 'cron',
          timezone: 'UTC',
        }],
        truncated: false,
      })

    const { result, rerender } = renderHook(
      (props: { from: string; to: string }) =>
        useTrackerSchedulePreview({
          organizationId: 'org-1',
          spaceId: 'space-1',
          from: props.from,
          to: props.to,
        }),
      {
        initialProps: {
          from: '2026-07-20T00:00:00.000Z',
          to: '2026-07-27T00:00:00.000Z',
        },
      },
    )

    rerender({
      from: '2026-07-27T00:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
    })
    await waitFor(() => expect(result.current.occurrences[0]?.tracker_id).toBe('new'))

    await act(async () => {
      resolveSlow!({
        occurrences: [{
          tracker_id: 'stale',
          name: '旧窗',
          space_id: 'space-1',
          space_name: null,
          scheduled_at: '2026-07-22T01:00:00.000Z',
          status: 'active',
          trigger_type: 'cron',
          timezone: 'UTC',
        }],
        truncated: false,
      })
    })

    expect(result.current.occurrences[0]?.tracker_id).toBe('new')
  })

  it('refreshToken 变化时重新拉取', async () => {
    listSchedulePreview.mockResolvedValue({ occurrences: [], truncated: false })

    const { result, rerender } = renderHook(
      (props: { refreshToken?: number }) =>
        useTrackerSchedulePreview({
          organizationId: 'org-1',
          spaceId: 'space-1',
          from: WEEK_FROM,
          to: WEEK_TO,
          refreshToken: props.refreshToken,
        }),
      { initialProps: { refreshToken: 0 } },
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(listSchedulePreview).toHaveBeenCalledTimes(1)
    rerender({ refreshToken: 1 })
    await waitFor(() => expect(listSchedulePreview).toHaveBeenCalledTimes(2))
    // 同窗口 refresh：不回到初次 skeleton
    expect(result.current.isLoading).toBe(false)
  })
})
