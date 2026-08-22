/**
 * 通知中心 / overlay 展示文案：框架文案走 i18n；
 * 后端历史落库的中文模板按 type + 已知正文映射到当前界面语言。
 */
import type { NotificationItem } from '@services/notificationApi'
import { resolveAgentNotificationDisplay } from '@/services/compactNotificationSummary'

type TFunction = (key: string, options?: Record<string, unknown>) => string

export type LocalizedNotificationCopy = {
  title: string
  body: string
}

const TRACKER_COMPLETED_TITLE_RE = /^自动化任务[「『""](.+)[」』""]已完成$/
const TRACKER_FAILED_TITLE_RE = /^自动化任务[「『""](.+)[」』""]执行失败$/

const TRACKER_PERSIST_FAILED_BODIES = new Set([
  '任务已完成，但最终汇报消息未成功持久化；请以已完成的产物和执行记录为准。',
])
const TRACKER_COMPLETED_BODIES = new Set(['任务执行完成'])
const TRACKER_FAILED_BODIES = new Set(['任务执行失败'])

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readTrackerName(notification: NotificationItem, t: TFunction): string {
  const fromMeta = readNonEmptyString(notification.metadata?.tracker_name)
  if (fromMeta) return fromMeta

  const title = (notification.title || '').trim()
  const completed = TRACKER_COMPLETED_TITLE_RE.exec(title)
  if (completed?.[1]) return completed[1]
  const failed = TRACKER_FAILED_TITLE_RE.exec(title)
  if (failed?.[1]) return failed[1]

  return t('notification.tracker.fallbackName')
}

function localizeTrackerBody(body: string, t: TFunction, success: boolean): string {
  const trimmed = body.trim()
  if (!trimmed) {
    return t(success ? 'notification.tracker.completedBody' : 'notification.tracker.failedBody')
  }
  if (TRACKER_PERSIST_FAILED_BODIES.has(trimmed)) {
    return t('notification.tracker.persistFailedBody')
  }
  if (TRACKER_COMPLETED_BODIES.has(trimmed)) {
    return t('notification.tracker.completedBody')
  }
  if (TRACKER_FAILED_BODIES.has(trimmed)) {
    return t('notification.tracker.failedBody')
  }
  return trimmed
}

function localizeTrackerNotification(
  notification: NotificationItem,
  t: TFunction,
): LocalizedNotificationCopy | null {
  const success = notification.type === 'tracker.run.completed'
  const failed = notification.type === 'tracker.run.failed'
  if (!success && !failed) return null

  const name = readTrackerName(notification, t)
  return {
    title: t(
      success ? 'notification.tracker.completedTitle' : 'notification.tracker.failedTitle',
      { name },
    ),
    body: localizeTrackerBody(notification.body || '', t, success),
  }
}

export function resolveLocalizedNotificationCopy(
  notification: NotificationItem,
  t: TFunction,
): LocalizedNotificationCopy {
  const trackerCopy = localizeTrackerNotification(notification, t)
  if (trackerCopy) return trackerCopy

  if (notification.type.startsWith('agent.task.') || notification.type === 'agent.hitl.waiting') {
    const display = resolveAgentNotificationDisplay({
      title: notification.title,
      body: notification.body,
    })
    return { title: display.headline, body: display.subline }
  }

  return {
    title: notification.title,
    body: notification.body,
  }
}
