import { describe, expect, it } from 'vitest'

import {
  buildRealtimeUserDisplayNameById,
  buildUserDisplayNameById,
  mergeUserDisplayNamesIntoMembers,
} from './userDisplayNameMap'


describe('buildUserDisplayNameById', () => {
  it('保留离职成员快照，同时让当前成员姓名优先', () => {
    const result = buildUserDisplayNameById(
      [
        { id: 'active-user', name: '当前成员' },
        { id: 'rejoined-user', name: '重新加入后的姓名' },
      ],
      [
        { user_id: 'departed-user', display_name: '离开时姓名' },
        { user_id: 'rejoined-user', display_name: '上次离开时姓名' },
      ],
    )

    expect(result.get('departed-user')).toBe('离开时姓名')
    expect(result.get('active-user')).toBe('当前成员')
    expect(result.get('rejoined-user')).toBe('重新加入后的姓名')
  })

  it('实时用户资料覆盖已加载的旧成员姓名', () => {
    const result = buildUserDisplayNameById(
      [{ id: 'active-user', name: '旧名字' }],
      [],
      new Map([['active-user', '新名字']]),
    )

    expect(result.get('active-user')).toBe('新名字')
  })

  it('仅让带服务端递增版本的实时资料覆盖成员目录', () => {
    const result = buildRealtimeUserDisplayNameById(
      {
        'stale-login-user': { nickname: '安全存储旧名', revision: 0 },
        'realtime-user': { nickname: '实时新名', revision: 2 },
      },
      new Set(['stale-login-user', 'realtime-user']),
    )

    expect(result.has('stale-login-user')).toBe(false)
    expect(result.get('realtime-user')).toBe('实时新名')
  })

  it('把权威新昵称合并进成员编辑器候选，使中文搜索命中新名字', () => {
    const candidates = mergeUserDisplayNamesIntoMembers(
      [{ id: 'renamed-member', name: '旧名字', email: 'member@example.com', avatarUrl: 'avatar.png' }],
      new Map([['renamed-member', '沈庾涛']]),
    )

    expect(candidates).toEqual([
      { id: 'renamed-member', name: '沈庾涛', email: 'member@example.com', avatarUrl: 'avatar.png' },
    ])
    expect(candidates.filter(member => member.name.toLowerCase().includes('沈'))).toHaveLength(1)
  })
})
