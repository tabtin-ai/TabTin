import { describe, expect, it } from 'vitest'
import {
  isInboxExcludedNotificationType,
  isNotificationCenterExcludedType,
  isPersonalGlobalNotificationType,
} from '../inboxNotificationPolicy'

describe('isInboxExcludedNotificationType', () => {
  it('排除 IM 相关通知类型', () => {
    expect(isInboxExcludedNotificationType('im.message')).toBe(true)
    expect(isInboxExcludedNotificationType('im.mention')).toBe(true)
    expect(isInboxExcludedNotificationType('im.agent_task_update')).toBe(true)
  })

  it('保留平台通知类型', () => {
    expect(isInboxExcludedNotificationType('agent.task.completed')).toBe(false)
    expect(isInboxExcludedNotificationType('organization.invitation')).toBe(false)
    expect(isInboxExcludedNotificationType('')).toBe(false)
    expect(isInboxExcludedNotificationType(null)).toBe(false)
  })

  it('Agent 通知不进入通知中心，但仍保留平台通知投递', () => {
    expect(isNotificationCenterExcludedType('agent.task.completed')).toBe(true)
    expect(isNotificationCenterExcludedType('agent.hitl.waiting')).toBe(true)
    expect(isInboxExcludedNotificationType('agent.task.completed')).toBe(false)
  })
})

describe('isPersonalGlobalNotificationType', () => {
  it('组织邀请和成员生命周期通知属于个人全局消息', () => {
    expect(isPersonalGlobalNotificationType('organization.invitation')).toBe(true)
    expect(isPersonalGlobalNotificationType('organization.invitation.sync')).toBe(true)
    expect(isPersonalGlobalNotificationType('organization.invitation.cancelled')).toBe(true)
    expect(isPersonalGlobalNotificationType('organization.invitation.responded')).toBe(true)
    expect(isPersonalGlobalNotificationType('member_added')).toBe(true)
    expect(isPersonalGlobalNotificationType('member_removed')).toBe(true)
  })

  it('普通组织业务通知仍按当前组织隔离', () => {
    expect(isPersonalGlobalNotificationType('agent.task.completed')).toBe(false)
    expect(isPersonalGlobalNotificationType('balance_low')).toBe(false)
  })
})
