import { describe, expect, it } from 'vitest'

import {
  HOST_TRACKER_MISFIRE_GRACE_MS,
  planHostSchedule,
} from '../host-schedule-plan.js'

describe('planHostSchedule', () => {
  it('arms a future at occurrence', () => {
    const plan = planHostSchedule(
      {
        trackerId: 'tr-1',
        triggerType: 'at',
        triggerConfig: { at: '2026-08-19T03:00:00.000Z' },
      },
      Date.parse('2026-08-19T02:00:00.000Z'),
    )
    expect(plan).toEqual({
      trackerId: 'tr-1',
      dueMs: Date.parse('2026-08-19T03:00:00.000Z'),
      shouldFire: true,
    })
  })

  it('skips a late interval without asking the cloud to persist next', () => {
    const now = Date.parse('2026-08-19T04:00:00.000Z')
    const plan = planHostSchedule(
      {
        trackerId: 'tr-1',
        triggerType: 'interval',
        triggerConfig: { interval_seconds: 3600, catchup_policy: 'skip' },
        lastRunAt: '2026-08-19T01:00:00.000Z',
      },
      now,
    )
    expect(plan?.shouldFire).toBe(true)
    expect(plan?.dueMs).toBe(Date.parse('2026-08-19T05:00:00.000Z'))
    expect(now - Date.parse('2026-08-19T02:00:00.000Z')).toBeGreaterThan(HOST_TRACKER_MISFIRE_GRACE_MS)
  })

  it('fires a slightly late interval under the grace window', () => {
    const now = Date.parse('2026-08-19T03:02:00.000Z')
    const plan = planHostSchedule(
      {
        trackerId: 'tr-1',
        triggerType: 'interval',
        triggerConfig: { interval_seconds: 3600, catchup_policy: 'skip' },
        lastRunAt: '2026-08-19T02:00:00.000Z',
      },
      now,
    )
    expect(plan).toEqual({
      trackerId: 'tr-1',
      dueMs: now,
      shouldFire: true,
    })
  })
})
