import { resolveGroupValuePresentation } from './groupValueCodec'

describe('resolveGroupValuePresentation', () => {
  it('匹配组织成员时按成员 id 归桶并展示姓名', () => {
    const memberId = '634e1f02-0f40-426e-84cd-655335b5d247'
    const members = new Map([[memberId, '张三']])

    expect(
      resolveGroupValuePresentation(
        [{ id: memberId, name: '张三' }],
        'user',
        '未分组',
        members,
      ),
    ).toEqual({
      key: `user:["${memberId}"]`,
      label: '张三',
    })

    expect(
      resolveGroupValuePresentation([memberId], 'user', '未分组', members),
    ).toEqual({
      key: `user:["${memberId}"]`,
      label: '张三',
    })
  })

  it('未匹配组织成员的导入同名按 name:展示名归桶，与成员拆成两组', () => {
    const memberId = '634e1f02-0f40-426e-84cd-655335b5d247'
    const members = new Map([[memberId, '张三']])

    const memberGroup = resolveGroupValuePresentation(
      [{ id: memberId, name: '张三' }],
      'user',
      '未分组',
      members,
    )
    const importedGroup = resolveGroupValuePresentation(
      [{ id: 'ou_feishu_xxx', name: '张三' }],
      'user',
      '未分组',
      members,
    )

    expect(memberGroup).toEqual({
      key: `user:["${memberId}"]`,
      label: '张三',
    })
    expect(importedGroup).toEqual({
      key: 'user:["name:张三"]',
      label: '张三',
    })
    expect(memberGroup.key).not.toBe(importedGroup.key)
  })

  it('无成员表时导入人员一律按展示名归桶', () => {
    expect(
      resolveGroupValuePresentation(
        [{ id: 'ou_1', name: 'Alice', avatar: 'a.png' }],
        'user',
        '未分组',
      ),
    ).toEqual({
      key: 'user:["name:Alice"]',
      label: 'Alice',
    })

    expect(
      resolveGroupValuePresentation(
        [{ user_id: 'ou_1', display_name: 'Alice' }],
        'user',
        '未分组',
      ),
    ).toEqual({
      key: 'user:["name:Alice"]',
      label: 'Alice',
    })
  })

  it('把多用户值规范化为与成员输入顺序无关的集合', () => {
    const members = new Map([
      ['u-alice', 'Alice'],
      ['u-bob', 'Bob'],
    ])
    const alice = { id: 'u-alice', name: 'Alice' }
    const bob = { id: 'u-bob', name: 'Bob' }

    expect(resolveGroupValuePresentation([alice, bob], 'user', '未分组', members)).toEqual({
      key: 'user:["u-alice","u-bob"]',
      label: 'Alice, Bob',
    })
    expect(resolveGroupValuePresentation([bob, alice], 'user', '未分组', members)).toEqual({
      key: 'user:["u-alice","u-bob"]',
      label: 'Alice, Bob',
    })
  })

  it('把空用户列表归入未分组', () => {
    expect(resolveGroupValuePresentation([], 'user', '未分组')).toEqual({
      key: '__empty__',
      label: '未分组',
    })
  })
})
