import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER,
  isActivityRailDomainId,
  mergeRailDomainOrder,
  resolveRailDomainOrder,
  type ActivityRailDomainId,
} from './activityRailOrder'

const ALL_DOMAINS: ActivityRailDomainId[] = ['tasks', 'messages', 'agents', 'cloud-docs', 'projects']
const PROJECTS_OFF: ActivityRailDomainId[] = ['tasks', 'messages', 'agents', 'cloud-docs']

describe('DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER', () => {
  it('钉住默认顺序：任务 / 消息 / AI 分身 / 云文档 / 项目', () => {
    expect(DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER).toEqual(ALL_DOMAINS)
  })
})

describe('isActivityRailDomainId', () => {
  it('识别合法域 id，拒绝未知值', () => {
    for (const id of ALL_DOMAINS) {
      expect(isActivityRailDomainId(id)).toBe(true)
    }
    expect(isActivityRailDomainId('organization')).toBe(false)
    expect(isActivityRailDomainId('')).toBe(false)
    expect(isActivityRailDomainId(undefined)).toBe(false)
    expect(isActivityRailDomainId(42)).toBe(false)
  })
})

describe('resolveRailDomainOrder', () => {
  it('无存储时按可见集原序返回', () => {
    expect(resolveRailDomainOrder({ visibleIds: ALL_DOMAINS, storedOrder: undefined }))
      .toEqual(ALL_DOMAINS)
    expect(resolveRailDomainOrder({ visibleIds: ALL_DOMAINS, storedOrder: null }))
      .toEqual(ALL_DOMAINS)
    expect(resolveRailDomainOrder({ visibleIds: ALL_DOMAINS, storedOrder: [] }))
      .toEqual(ALL_DOMAINS)
  })

  it('按用户存储顺序排列可见域', () => {
    expect(resolveRailDomainOrder({
      visibleIds: ALL_DOMAINS,
      storedOrder: ['messages', 'tasks', 'cloud-docs', 'agents', 'projects'],
    })).toEqual(['messages', 'tasks', 'cloud-docs', 'agents', 'projects'])
  })

  it('存储缺失的可见域（新上线域）按可见集顺序追加末尾', () => {
    expect(resolveRailDomainOrder({
      visibleIds: ALL_DOMAINS,
      storedOrder: ['messages', 'tasks'],
    })).toEqual(['messages', 'tasks', 'agents', 'cloud-docs', 'projects'])
  })

  it('已下线 / 非法 id 被丢弃，不影响其余顺序', () => {
    expect(resolveRailDomainOrder({
      visibleIds: ALL_DOMAINS,
      storedOrder: ['legacy-dead-domain', 'agents', 'tasks'],
    })).toEqual(['agents', 'tasks', 'messages', 'cloud-docs', 'projects'])
  })

  it('不可见域不参与展示，但其余顺序仍按存储', () => {
    expect(resolveRailDomainOrder({
      visibleIds: PROJECTS_OFF,
      storedOrder: ['projects', 'cloud-docs', 'tasks'],
    })).toEqual(['cloud-docs', 'tasks', 'messages', 'agents'])
  })

  it('重复 id 只保留第一次出现的位置', () => {
    expect(resolveRailDomainOrder({
      visibleIds: ALL_DOMAINS,
      storedOrder: ['messages', 'messages', 'tasks'],
    })).toEqual(['messages', 'tasks', 'agents', 'cloud-docs', 'projects'])
  })
})

describe('mergeRailDomainOrder', () => {
  it('可见子集重排后按槽位归并全量，不可见域原位保留', () => {
    // Projects 开关关闭时 projects 不可见；用户在四个可见域里把 cloud-docs 提到最前
    const merged = mergeRailDomainOrder({
      fullOrder: ['tasks', 'messages', 'agents', 'cloud-docs', 'projects'],
      reorderedVisibleIds: ['cloud-docs', 'tasks', 'messages', 'agents'],
    })
    expect(merged).toEqual(['cloud-docs', 'tasks', 'messages', 'agents', 'projects'])
  })

  it('全量可见时归并结果就是重排本身', () => {
    const reordered: ActivityRailDomainId[] = ['messages', 'tasks', 'agents', 'cloud-docs', 'projects']
    expect(mergeRailDomainOrder({ fullOrder: ALL_DOMAINS, reorderedVisibleIds: reordered }))
      .toEqual(reordered)
  })

  it('不可见域在中间的槽位同样保持稳定', () => {
    // 存储里 projects 被拖到过第二位；开关关闭后可见集不含 projects
    const merged = mergeRailDomainOrder({
      fullOrder: ['tasks', 'projects', 'messages', 'agents', 'cloud-docs'],
      reorderedVisibleIds: ['agents', 'tasks', 'messages', 'cloud-docs'],
    })
    // 可见槽位依次填充 agents/tasks/messages/cloud-docs，projects 槽位不动
    expect(merged).toEqual(['agents', 'projects', 'tasks', 'messages', 'cloud-docs'])
  })
})
