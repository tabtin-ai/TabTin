import { describe, expect, it } from 'vitest'
import {
  resolveAgentDisplayName,
  resolveCurrentAgentDisplay,
  resolveCurrentAgentId,
} from '../resolveAgentDisplayName'

describe('resolveCurrentAgentId · 草稿斜杠 / 展示名同口径', () => {
  it('session 缺省时回落 selectedAgent', () => {
    expect(resolveCurrentAgentId({
      sessionAgentId: null,
      selectedAgentId: 'agent-selected',
    })).toBe('agent-selected')
  })

  it('sessionId 为空串时回落 selectedAgent', () => {
    expect(resolveCurrentAgentId({
      sessionAgentId: '  ',
      selectedAgentId: 'agent-selected',
    })).toBe('agent-selected')
  })

  it('session.agent_id 优先于 selected', () => {
    expect(resolveCurrentAgentId({
      sessionAgentId: 'agent-session',
      selectedAgentId: 'agent-selected',
    })).toBe('agent-session')
  })

  it('两者皆空 → null', () => {
    expect(resolveCurrentAgentId({
      sessionAgentId: null,
      selectedAgentId: null,
    })).toBeNull()
  })
})

describe('resolveAgentDisplayName', () => {
  it('优先 display_name', () => {
    expect(resolveAgentDisplayName({
      display_name: '小明代码版',
      name: 'xiaoming',
    })).toBe('小明代码版')
  })

  it('display_name 空则用 name', () => {
    expect(resolveAgentDisplayName({ display_name: '  ', name: 'xiaoming' })).toBe('xiaoming')
  })

  it('皆空 → 空串', () => {
    expect(resolveAgentDisplayName(null)).toBe('')
    expect(resolveAgentDisplayName({ display_name: '', name: '' })).toBe('')
  })
})

describe('resolveCurrentAgentDisplay · ', () => {
  it('session 缺省时用 selectedAgent 真名', () => {
    expect(resolveCurrentAgentDisplay({
      sessionAgentId: null,
      selectedAgent: { id: 'agent-test', name: 'test' },
      agentCache: {},
    })).toEqual({ agentId: 'agent-test', displayName: 'test', avatarUrl: null })
  })

  it('cache 未命中且无同 id selected → null（禁止 UUID 占位）', () => {
    expect(resolveCurrentAgentDisplay({
      sessionAgentId: 'agent-missing',
      selectedAgent: { id: 'other', name: 'other' },
      agentCache: {},
    })).toBeNull()
  })

  it('session agent_id 优先于 selected', () => {
    expect(resolveCurrentAgentDisplay({
      sessionAgentId: 'agent-session',
      selectedAgent: { id: 'agent-selected', name: 'Selected' },
      agentCache: { 'agent-session': { name: 'Session' } },
    })).toEqual({ agentId: 'agent-session', displayName: 'Session', avatarUrl: null })
  })

  it('透出 settings.avatar_url', () => {
    expect(resolveCurrentAgentDisplay({
      sessionAgentId: 'agent-1',
      selectedAgent: null,
      agentCache: {
        'agent-1': {
          name: '小鱼',
          settings: { avatar_url: 'https://cdn.example.com/yu.png' },
        },
      },
    })).toEqual({
      agentId: 'agent-1',
      displayName: '小鱼',
      avatarUrl: 'https://cdn.example.com/yu.png',
    })
  })
})
