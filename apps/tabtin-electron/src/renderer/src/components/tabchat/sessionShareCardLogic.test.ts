import { describe, expect, it } from 'vitest'
import {
  buildSessionShareCardView,
  normalizeSessionShareStatus,
  resolveSessionShareCardCapabilities,
  resolveSessionShareCardStatus,
  resolveSessionShareRole,
} from './sessionShareCardLogic'

describe('resolveSessionShareCardCapabilities', () => {
  it('每张卡展示自己的权限快照，不受其他分享卡影响', () => {
    const currentDetail = { canFork: true, canChat: false }

    expect(resolveSessionShareCardCapabilities(
      currentDetail.canFork,
      currentDetail.canChat,
      false,
      false,
    )).toEqual({ canFork: false, canChat: false })
    expect(resolveSessionShareCardCapabilities(
      currentDetail.canFork,
      currentDetail.canChat,
      true,
      false,
    )).toEqual({ canFork: true, canChat: false })
  })

  it('旧消息没有权限快照时，回退到当前共享详情', () => {
    expect(resolveSessionShareCardCapabilities(true, true, undefined, undefined)).toEqual({
      canFork: true,
      canChat: true,
    })
  })
})

describe('resolveSessionShareRole', () => {
  it('当前用户是 owner', () => {
    expect(resolveSessionShareRole('u-owner', 'u-owner', 'u-grantee')).toBe('owner')
  })

  it('当前用户是 grantee', () => {
    expect(resolveSessionShareRole('u-grantee', 'u-owner', 'u-grantee')).toBe('grantee')
  })

  it('都不是 → observer', () => {
    expect(resolveSessionShareRole('u-other', 'u-owner', 'u-grantee')).toBe('observer')
  })

  it('未登录 / 缺 id → observer', () => {
    expect(resolveSessionShareRole(null, 'u-owner', 'u-grantee')).toBe('observer')
    expect(resolveSessionShareRole('u-owner', null, null)).toBe('observer')
  })
})

describe('normalizeSessionShareStatus', () => {
  it('pending 原样保留，不能提前开放共享能力', () => {
    expect(normalizeSessionShareStatus('pending')).toBe('pending')
  })

  it('revoked 原样保留', () => {
    expect(normalizeSessionShareStatus('revoked')).toBe('revoked')
  })

  it('active / 未知 / 缺失 → active（详情加载前按共享中渲染骨架）', () => {
    expect(normalizeSessionShareStatus('active')).toBe('active')
    expect(normalizeSessionShareStatus('something-else')).toBe('active')
    expect(normalizeSessionShareStatus(null)).toBe('active')
    expect(normalizeSessionShareStatus(undefined)).toBe('active')
  })
})

describe('resolveSessionShareCardStatus', () => {
  it('仅详情 → 用详情', () => {
    expect(resolveSessionShareCardStatus('revoked', undefined)).toBe('revoked')
    expect(resolveSessionShareCardStatus('active', null)).toBe('active')
  })

  it('仅快照 → 用快照', () => {
    expect(resolveSessionShareCardStatus(undefined, 'revoked')).toBe('revoked')
    expect(resolveSessionShareCardStatus(undefined, 'pending')).toBe('pending')
  })

  it('两边一致 → 该状态', () => {
    expect(resolveSessionShareCardStatus('active', 'active')).toBe('active')
    expect(resolveSessionShareCardStatus('revoked', 'revoked')).toBe('revoked')
  })

  it('详情已到时以服务端为准（ 审阅：漏掉 WS 时旧快照不得盖住 revoked）', () => {
    expect(resolveSessionShareCardStatus('revoked', 'active')).toBe('revoked')
    expect(resolveSessionShareCardStatus('active', 'revoked')).toBe('active')
  })

  it('都缺 → active 骨架', () => {
    expect(resolveSessionShareCardStatus(null, undefined)).toBe('active')
  })
})

describe('buildSessionShareCardView', () => {
  it('pending 卡片可见但没有打开、停止、恢复能力', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-grantee',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'pending',
      canFork: true,
      canChat: true,
    })
    expect(view.status).toBe('pending')
    expect(view.showOpen).toBe(false)
    expect(view.showRevoke).toBe(false)
    expect(view.showResume).toBe(false)
    expect(view.showRevokedNote).toBe(false)
  })

  it('grantee + active → 显示「打开任务」', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-grantee',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'active',
      canFork: true,
    })
    expect(view.role).toBe('grantee')
    expect(view.showOpen).toBe(true)
    expect(view.showRevoke).toBe(false)
    expect(view.showRevokedNote).toBe(false)
    expect(view.badges.forkable).toBe(true)
  })

  it('owner + active → 同时显示「打开任务」和「停止共享」', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-owner',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'active',
    })
    expect(view.role).toBe('owner')
    expect(view.showOpen).toBe(true)
    expect(view.showRevoke).toBe(true)
    expect(view.badges.forkable).toBe(false)
  })

  it('owner + revoked → 显示「恢复共享」', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-owner',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'revoked',
    })
    expect(view.role).toBe('owner')
    expect(view.showResume).toBe(true)
    expect(view.showRevokedNote).toBe(false)
    expect(view.showRevoke).toBe(false)
  })

  it('revoked → grantee 只看到置灰「共享已停止」', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-grantee',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'revoked',
      canFork: true,
    })
    expect(view.status).toBe('revoked')
    expect(view.showOpen).toBe(false)
    expect(view.showRevoke).toBe(false)
    expect(view.showResume).toBe(false)
    expect(view.showRevokedNote).toBe(true)
  })

  it('revoked owner 不显示 revoked note', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-owner',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'revoked',
    })
    expect(view.showRevokedNote).toBe(false)
    expect(view.showResume).toBe(true)
  })

  it('observer（非双方）没有任何动作按钮', () => {
    const view = buildSessionShareCardView({
      currentUserId: 'u-other',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'active',
    })
    expect(view.showOpen).toBe(false)
    expect(view.showRevoke).toBe(false)
    expect(view.showResume).toBe(false)
    expect(view.showRevokedNote).toBe(false)
  })

  it('可查看徽标恒有', () => {
    const view = buildSessionShareCardView({ currentUserId: null, status: null })
    expect(view.badges.viewable).toBe(true)
  })

  it('canChat →「可控制」徽标（历史 can_chat 份额仍可展示）', () => {
    const withChat = buildSessionShareCardView({
      currentUserId: 'u-grantee',
      ownerUserId: 'u-owner',
      granteeUserId: 'u-grantee',
      status: 'active',
      canFork: true,
      canChat: true,
    })
    expect(withChat.badges.chattable).toBe(true)
    const withoutChat = buildSessionShareCardView({ currentUserId: null, status: null })
    expect(withoutChat.badges.chattable).toBe(false)
  })
})
