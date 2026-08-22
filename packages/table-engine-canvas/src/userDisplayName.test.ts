import { describe, expect, it } from 'vitest'

import { resolveUserDisplay, resolveUserDisplayName } from './userDisplayName'


describe('resolveUserDisplay 归属态', () => {
  it('在职成员：跟随目录现名，可借用目录头像', () => {
    expect(resolveUserDisplay('member-user', {
      currentMemberName: '林小满',
      resolvedNameById: new Map([['member-user', '林小满']]),
      isCurrentMember: true,
    })).toEqual({ displayName: '林小满', kind: 'member', canUseDirectoryAvatar: true })
  })

  it('离组成员：命中的姓名来自快照，不许借目录头像', () => {
    // resolvedNameById 把在职成员和离组快照混在一张表里，只有 isCurrentMember 能分开两者
    expect(resolveUserDisplay('departed-user', {
      resolvedNameById: new Map([['departed-user', '周叙']]),
      isCurrentMember: false,
    })).toEqual({ displayName: '周叙', kind: 'departed', canUseDirectoryAvatar: false })
  })

  it('跨组织成员：两个目录都不认识，用值内嵌姓名且不借头像', () => {
    expect(resolveUserDisplay('external-user', {
      embeddedName: '外部-赵珂',
      isCurrentMember: false,
    })).toEqual({ displayName: '外部-赵珂', kind: 'external', canUseDirectoryAvatar: false })
  })

  it('脏数据：四层全 miss 时不返回任何姓名，更不回落成 ID', () => {
    const resolution = resolveUserDisplay('c05d8e27-4a16-4f93-b8c2-9d7e1f3a6b45', {})
    expect(resolution).toEqual({ displayName: '', kind: 'unknown', canUseDirectoryAvatar: false })
    expect(resolution.displayName).not.toContain('c05d8e27')
  })

  it('目录现名压过值内嵌的旧名，且仍算在职成员', () => {
    expect(resolveUserDisplay('member-user', {
      embeddedName: '林小满-导入时旧名',
      currentMemberName: '林小满',
      resolvedNameById: new Map([['member-user', '林小满']]),
      isCurrentMember: true,
    })).toEqual({ displayName: '林小满', kind: 'member', canUseDirectoryAvatar: true })
  })

  it('未显式传 isCurrentMember 时按有无当前成员姓名推断', () => {
    expect(resolveUserDisplay('user', {
      resolvedNameById: new Map([['user', '有名字']]),
      currentMemberName: '有名字',
    }).kind).toBe('member')

    expect(resolveUserDisplay('user', {
      resolvedNameById: new Map([['user', '有名字']]),
    }).kind).toBe('departed')
  })

  it('历史快照兜底也算离组态', () => {
    expect(resolveUserDisplay('departed-user', {
      historicalNameById: new Map([['departed-user', '离开时姓名']]),
    })).toEqual({ displayName: '离开时姓名', kind: 'departed', canUseDirectoryAvatar: false })
  })
})

describe('resolveUserDisplayName', () => {
  it('纯 ID 在成员离开后使用离开时姓名快照', () => {
    expect(resolveUserDisplayName('departed-user', {
      historicalNameById: new Map([['departed-user', '离开时姓名']]),
    })).toBe('离开时姓名')
  })

  it('当前成员姓名优先于同一用户的旧离开快照', () => {
    expect(resolveUserDisplayName('rejoined-user', {
      currentMemberName: '重新加入后的姓名',
      historicalNameById: new Map([['rejoined-user', '上次离开时姓名']]),
    })).toBe('重新加入后的姓名')
  })

  it('导入对象自带的姓名不被本组织成员资料覆盖', () => {
    expect(resolveUserDisplayName('external-user', {
      embeddedName: '飞书来源姓名',
      currentMemberName: '本组织同 ID 姓名',
    })).toBe('飞书来源姓名')
  })

  it('已识别为组织成员时，最新显示名覆盖记录里的旧姓名快照', () => {
    expect(resolveUserDisplayName('member-user', {
      embeddedName: '旧名字',
      currentMemberName: '旧成员目录',
      resolvedNameById: new Map([['member-user', '新名字']]),
    })).toBe('新名字')
  })
})
