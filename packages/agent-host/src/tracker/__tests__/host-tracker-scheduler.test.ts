import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_TRACKER_FIRE_RETRY_MS,
  HOST_TRACKER_TIMER_MAX_DELAY_MS,
  HOST_TRACKER_WORK_POLL_MS,
  HostTrackerScheduler,
} from '../host-tracker-scheduler.js'
import type { HostScheduleItem } from '../host-schedule-plan.js'

function atItem(trackerId: string, at: string): HostScheduleItem {
  return {
    trackerId,
    triggerType: 'at',
    triggerConfig: { at },
  }
}

describe('HostTrackerScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconciles lifecycle before arming the schedule', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const reconcile = vi.fn().mockResolvedValue(undefined)
    const fire = vi.fn().mockResolvedValue(undefined)
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      reconcile,
      fetchSchedule: async () => [
        atItem('tr-1', '2026-08-19T02:00:05.000Z'),
      ],
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcile).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('fires when next_run_at is reached', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const fire = vi.fn().mockResolvedValue(undefined)
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [
        atItem('tr-1', '2026-08-19T02:00:05.000Z'),
      ],
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(fire).toHaveBeenCalledWith('tr-1')
    scheduler.stop()
  })

  it('disarms a tracker that leaves the schedule', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const fire = vi.fn().mockResolvedValue(undefined)
    let items = [atItem('tr-1', '2026-08-19T02:00:10.000Z')]
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => items,
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    items = []
    await scheduler.sync()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fire).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('re-syncs instead of firing when delay exceeds the timer cap', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const fire = vi.fn().mockResolvedValue(undefined)
    const fetchSchedule = vi.fn().mockResolvedValue([
      atItem('tr-1', '2026-08-20T02:00:00.000Z'),
    ])
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule,
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSchedule).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOST_TRACKER_TIMER_MAX_DELAY_MS)
    expect(fire).not.toHaveBeenCalled()
    expect(fetchSchedule.mock.calls.length).toBeGreaterThan(1)
    scheduler.stop()
  })

  it('does not immediately re-fire an overdue tracker after fire fails', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const fire = vi.fn().mockRejectedValue(new Error('HTTP 400'))
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [
        atItem('tr-1', '2026-08-19T01:00:00.000Z'),
      ],
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fire).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOST_TRACKER_FIRE_RETRY_MS)
    expect(fire).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('drains persisted host work after arming the schedule', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const executeWork = vi.fn().mockResolvedValue(undefined)
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [],
      fire: async () => undefined,
      fetchWork: async () => [{ runId: 'run-1' }],
      executeWork,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeWork).toHaveBeenCalledWith('run-1')
    scheduler.stop()
  })

  it('polls host work again after the work interval', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    const executeWork = vi.fn().mockResolvedValue(undefined)
    const fetchWork = vi.fn()
      .mockResolvedValueOnce([{ runId: 'run-1' }])
      .mockResolvedValue([{ runId: 'run-2' }])
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [],
      fire: async () => undefined,
      fetchWork,
      executeWork,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeWork).toHaveBeenCalledWith('run-1')
    await vi.advanceTimersByTimeAsync(HOST_TRACKER_WORK_POLL_MS)
    expect(executeWork).toHaveBeenCalledWith('run-2')
    scheduler.stop()
  })

  it('does not fire a late interval when catchup is skip', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T04:00:00.000Z')
    vi.setSystemTime(now)
    const fire = vi.fn().mockResolvedValue(undefined)
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [
        {
          trackerId: 'tr-1',
          triggerType: 'interval',
          triggerConfig: { interval_seconds: 3600, catchup_policy: 'skip' },
          lastRunAt: '2026-08-19T01:00:00.000Z',
        },
      ],
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('does not re-fire while the previous fire is still in flight', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-19T02:00:00.000Z')
    vi.setSystemTime(now)
    let releaseFire: (() => void) | undefined
    const fire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFire = resolve
        }),
    )
    const scheduler = new HostTrackerScheduler({
      now: () => Date.now(),
      fetchSchedule: async () => [
        atItem('tr-1', '2026-08-19T01:00:00.000Z'),
      ],
      fire,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fire).toHaveBeenCalledTimes(1)
    releaseFire?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
})
