/**
 * TrackerRunBreadcrumb：显示「查看自动化任务」并跳转详情。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TrackerRunMeta } from '@tabtin/chat-client'

const openResourceTab = vi.fn()
const toastError = vi.fn()
let mockSelectedSpace: { id: string } | null = { id: 'space-1' }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
        let v = opts.defaultValue as string
        for (const [k, val] of Object.entries(opts)) {
          if (k !== 'defaultValue') v = v.replace(`{{${k}}}`, String(val))
        }
        return v
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    toast: {
      error: (...args: unknown[]) => toastError(...args),
      success: vi.fn(),
    },
  }
})

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (sel: (s: unknown) => unknown) =>
    sel({ openResourceTab }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: unknown) => unknown) =>
    sel({ selectedSpace: mockSelectedSpace }),
}))

vi.mock('../../subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => `scope:${spaceId}`,
}))

import {
  TrackerRunBreadcrumb,
  resolveTrackerRunSessionTitle,
} from '../TrackerRunBreadcrumb'

const baseMeta: TrackerRunMeta = {
  run_id: 'run-1',
  run_index: 5,
  run_status: 'success',
  tracker_id: 'tracker-1',
  tracker_name: '整理上周 PR',
  tracker_origin: 'user_created',
  trigger_type: 'cron',
  trigger_context: {},
}

describe('TrackerRunBreadcrumb', () => {
  beforeEach(() => {
    openResourceTab.mockClear()
    toastError.mockClear()
    mockSelectedSpace = { id: 'space-1' }
  })

  it('显示「查看自动化任务」', () => {
    render(<TrackerRunBreadcrumb trackerRun={baseMeta} />)
    expect(screen.getByTestId('tracker-run-breadcrumb').textContent).toContain('查看自动化任务')
  })

  it('点击后跳转到自动化详情(必须带 meta.taskId)', () => {
    render(<TrackerRunBreadcrumb trackerRun={baseMeta} />)
    fireEvent.click(screen.getByTestId('tracker-run-breadcrumb'))
    expect(openResourceTab).toHaveBeenCalledWith('scope:space-1', {
      type: 'tabtracker',
      id: 'tracker-1',
      title: '整理上周 PR',
      meta: { spaceId: 'space-1', taskId: 'tracker-1' },
    })
  })

  it('Space 上下文缺失时不跳转 + toast', () => {
    mockSelectedSpace = null
    render(<TrackerRunBreadcrumb trackerRun={baseMeta} />)
    fireEvent.click(screen.getByTestId('tracker-run-breadcrumb'))
    expect(openResourceTab).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})

describe('resolveTrackerRunSessionTitle', () => {
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
      let v = opts.defaultValue as string
      for (const [k, val] of Object.entries(opts)) {
        if (k !== 'defaultValue') v = v.replace(`{{${k}}}`, String(val))
      }
      return v
    }
    return key
  }

  it('拼出自动化第 n 次记录标题', () => {
    expect(resolveTrackerRunSessionTitle(baseMeta, t)).toBe(
      '自动化任务 "整理上周 PR" 的第 5 次记录',
    )
  })

  it('无名任务回退未命名', () => {
    expect(
      resolveTrackerRunSessionTitle({ ...baseMeta, tracker_name: '' }, t),
    ).toBe('自动化任务 "未命名" 的第 5 次记录')
  })
})
