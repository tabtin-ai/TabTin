import { describe, expect, it } from 'vitest'

import type { NotificationItem } from '@services/notificationApi'
import { resolveLocalizedNotificationCopy } from '../resolveLocalizedNotificationCopy'

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notification-1',
    type: 'system',
    title: '通知',
    body: '',
    metadata: {},
    organization_id: 'organization-1',
    is_read: false,
    read_at: null,
    created_at: '2026-08-21T08:00:00.000Z',
    ...overrides,
  }
}

const t = (key: string, options?: Record<string, unknown>) => {
  if (key === 'notification.tracker.completedTitle') return `Automation task “${options?.name}” completed`
  if (key === 'notification.tracker.failedTitle') return `Automation task “${options?.name}” failed`
  if (key === 'notification.tracker.fallbackName') return 'Automation'
  if (key === 'notification.tracker.completedBody') return 'The task completed successfully.'
  if (key === 'notification.tracker.failedBody') return 'The task failed.'
  if (key === 'notification.tracker.persistFailedBody') {
    return 'The task completed, but the final report was not saved.'
  }
  return key
}

describe('resolveLocalizedNotificationCopy', () => {
  it('把历史中文自动化完成通知翻成当前语言', () => {
    const copy = resolveLocalizedNotificationCopy(makeNotification({
      type: 'tracker.run.completed',
      title: '自动化任务「喝水提醒」已完成',
      body: '任务已完成，但最终汇报消息未成功持久化；请以已完成的产物和执行记录为准。',
    }), t)

    expect(copy.title).toBe('Automation task “喝水提醒” completed')
    expect(copy.body).toBe('The task completed, but the final report was not saved.')
  })

  it('优先使用 metadata.tracker_name，失败态走失败模板', () => {
    const copy = resolveLocalizedNotificationCopy(makeNotification({
      type: 'tracker.run.failed',
      title: '自动化任务「旧名」执行失败',
      body: '任务执行失败',
      metadata: { tracker_name: '日报' },
    }), t)

    expect(copy.title).toBe('Automation task “日报” failed')
    expect(copy.body).toBe('The task failed.')
  })

  it('非模板正文（Agent 汇报）保持原文', () => {
    const copy = resolveLocalizedNotificationCopy(makeNotification({
      type: 'tracker.run.completed',
      title: '自动化任务「喝水提醒」已完成',
      body: '今天已经喝了 8 杯水。',
    }), t)

    expect(copy.title).toBe('Automation task “喝水提醒” completed')
    expect(copy.body).toBe('今天已经喝了 8 杯水。')
  })

  it('其它类型不改写标题正文', () => {
    const notification = makeNotification({
      type: 'account.storage_warning',
      title: '存储空间即将用尽',
      body: '请前往设置查看。',
    })
    expect(resolveLocalizedNotificationCopy(notification, t)).toEqual({
      title: '存储空间即将用尽',
      body: '请前往设置查看。',
    })
  })
})
