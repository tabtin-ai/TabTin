import { describe, expect, it } from 'vitest'
import type { ConversationMember } from '@/services/tabchatApi'
import { resolveMentionsFromText, textHasMentionAll, textHasNamedMention } from './resolveMentionsFromText'

function buildMember(partial: Partial<ConversationMember> & Pick<ConversationMember, 'user_id'>): ConversationMember {
  return {
    member_type: 'user',
    agent_id: null,
    nickname: '',
    username: '',
    avatar: '',
    role: 0,
    is_muted: false,
    pinned: false,
    joined_at: null,
    ...partial,
  }
}

describe('resolveMentionsFromText', () => {
  const members: ConversationMember[] = [
    buildMember({
      user_id: 'user-a',
      nickname: '王五',
    }),
    buildMember({
      user_id: null,
      member_type: 'agent',
      agent_id: 'agent-pig',
      nickname: '快乐猪窝',
    }),
  ]

  it('从 markdown 链接按 id 解析，不看展示名', () => {
    const result = resolveMentionsFromText(
      '请 [@改名了](mention:agent/agent-pig) 处理',
      members,
    )
    expect(result.mentioned_agent_ids).toEqual(['agent-pig'])
    expect(result.mentioned_user_ids).toEqual([])
  })

  it('从正文解析 @AI Agent', () => {
    const result = resolveMentionsFromText('@快乐猪窝 你看看群里有啥?', members)
    expect(result.mentioned_agent_ids).toEqual(['agent-pig'])
    expect(result.mentioned_user_ids).toEqual([])
    expect(result.mention_all).toBe(false)
  })

  it('从正文解析 @用户', () => {
    const result = resolveMentionsFromText('@王五 你好', members)
    expect(result.mentioned_user_ids).toEqual(['user-a'])
    expect(result.mentioned_agent_ids).toEqual([])
    expect(result.mention_all).toBe(false)
  })

  it('无 @ 时不返回 mention', () => {
    const result = resolveMentionsFromText('上海天气咋样?', members)
    expect(result.mentioned_user_ids).toEqual([])
    expect(result.mentioned_agent_ids).toEqual([])
    expect(result.mention_all).toBe(false)
  })

  it('不把长昵称的前缀当成 mention', () => {
    const result = resolveMentionsFromText('@快乐猪窝Plus 你看看', members)
    expect(result.mentioned_agent_ids).toEqual([])
  })

  it('同名时 markdown 链接仍能按 id 命中', () => {
    const result = resolveMentionsFromText('请 [@快乐猪窝](mention:agent/agent-pig) 看', [
      ...members,
      buildMember({ user_id: 'user-pig', nickname: '快乐猪窝' }),
    ])
    expect(result.mentioned_agent_ids).toEqual(['agent-pig'])
    expect(result.mentioned_user_ids).toEqual([])
  })

  it('手输同名成员时不猜测身份', () => {
    const result = resolveMentionsFromText('@快乐猪窝 你看看', [
      ...members,
      buildMember({ user_id: 'user-pig', nickname: '快乐猪窝' }),
    ])
    expect(result.mentioned_agent_ids).toEqual([])
    expect(result.mentioned_user_ids).toEqual([])
  })

  const legacyDefault = buildMember({
    user_id: null,
    member_type: 'agent',
    agent_id: 'agent-legacy',
    nickname: '小Tin',
  })

  it('识别旧默认 Agent 的 NiiNii 展示别名，也保留旧名称', () => {
    for (const name of ['NiiNii', '小Tin']) {
      const result = resolveMentionsFromText(`@${name} 继续处理`, [legacyDefault])
      expect(result.mentioned_agent_ids).toEqual(['agent-legacy'])
      expect(result.mentioned_user_ids).toEqual([])
    }
  })

  it('规范名与原名相同的 Agent 不会把自己的别名算成冲突', () => {
    const result = resolveMentionsFromText('@NiiNii 继续处理', [
      { ...legacyDefault, nickname: 'NiiNii' },
    ])
    expect(result.mentioned_agent_ids).toEqual(['agent-legacy'])
  })

  it('NiiNii 与人类重名时不猜测，但唯一旧别名仍可定位 Agent', () => {
    const sameNameMembers = [legacyDefault, buildMember({ user_id: 'user-niinii', nickname: 'NiiNii' })]
    const ambiguous = resolveMentionsFromText('@NiiNii 继续处理', sameNameMembers)
    expect(ambiguous.mentioned_agent_ids).toEqual([])
    expect(ambiguous.mentioned_user_ids).toEqual([])
    expect(resolveMentionsFromText('@小Tin 继续处理', sameNameMembers).mentioned_agent_ids).toEqual(['agent-legacy'])
  })

  it('其他 Agent 同名或共享规范别名时不误 tag，markdown 唯一 ID 仍有效', () => {
    for (const nickname of ['NiiNii', '万能Tin']) {
      const sameNameMembers = [legacyDefault, { ...legacyDefault, agent_id: 'agent-other', nickname }]
      const ambiguous = resolveMentionsFromText('@NiiNii 继续处理', sameNameMembers)
      expect(ambiguous.mentioned_agent_ids).toEqual([])
      expect(ambiguous.mentioned_user_ids).toEqual([])
      expect(resolveMentionsFromText('[@NiiNii](mention:agent/agent-legacy) 继续处理', sameNameMembers).mentioned_agent_ids).toEqual(['agent-legacy'])
    }
  })

  it('人类用户的旧昵称不产生 Agent 规范别名', () => {
    const result = resolveMentionsFromText('@NiiNii 继续处理', [
      buildMember({ user_id: 'user-tin', nickname: '小Tin' }),
    ])
    expect(result.mentioned_user_ids).toEqual([])
    expect(result.mentioned_agent_ids).toEqual([])
  })

  it('识别中文 @所有人', () => {
    const result = resolveMentionsFromText('@所有人 今晚开会', members)
    expect(result.mention_all).toBe(true)
    expect(result.mentioned_user_ids).toEqual([])
  })

  it('识别英文 @Everyone', () => {
    const result = resolveMentionsFromText('@Everyone standup at 10', members)
    expect(result.mention_all).toBe(true)
  })

  it('可同时解析 @所有人 与具体成员', () => {
    const result = resolveMentionsFromText('@所有人 请 @王五 准备材料', members)
    expect(result.mention_all).toBe(true)
    expect(result.mentioned_user_ids).toEqual(['user-a'])
  })
})

describe('textHasMentionAll', () => {
  it('空文本为 false', () => {
    expect(textHasMentionAll('')).toBe(false)
  })

  it('仅成员 @ 不为 mention_all', () => {
    expect(textHasMentionAll('@王五 hi')).toBe(false)
  })

  it('前缀扩展名不误命中', () => {
    expect(textHasMentionAll('@EveryoneElse hello')).toBe(false)
  })

  it('句末标点后仍识别', () => {
    expect(textHasMentionAll('@所有人，今晚开会')).toBe(true)
  })
})

describe('textHasNamedMention', () => {
  it('要求昵称后有 mention 边界', () => {
    expect(textHasNamedMention('@AI 处理', 'AI')).toBe(true)
    expect(textHasNamedMention('@AI助手 处理', 'AI')).toBe(false)
  })
})
