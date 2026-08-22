import { describe, expect, it } from 'vitest'
import {
  findComposerMentionTrigger,
  formatMentionDisplayText,
  formatMentionMarkdown,
  isMentionHref,
  parseMentionMarkdown,
  splitMentionMarkdownSegments,
  stripMentionMarkdown,
  textHasMentionTarget,
} from './mentionMarkdown'

describe('mentionMarkdown', () => {
  it('formats user, agent, and all mentions as markdown links', () => {
    expect(formatMentionMarkdown({
      member_type: 'user',
      display_name: '王五',
      user_id: 'user-a',
      agent_id: null,
    })).toBe('[@王五](mention:user/user-a)')
    expect(formatMentionMarkdown({
      member_type: 'agent',
      display_name: '快乐猪窝',
      user_id: null,
      agent_id: 'agent-pig',
    })).toBe('[@快乐猪窝](mention:agent/agent-pig)')
    expect(formatMentionMarkdown({
      member_type: 'all',
      display_name: '所有人',
      user_id: null,
      agent_id: null,
    })).toBe('[@所有人](mention:all)')
  })

  it('parses mention ids from markdown links and ignores display names', () => {
    const result = parseMentionMarkdown(
      '请 [@改名了](mention:user/user-a) 和 [@旧名](mention:agent/agent-pig) 看 [@所有人](mention:all)',
    )
    expect(result.mentioned_user_ids).toEqual(['user-a'])
    expect(result.mentioned_agent_ids).toEqual(['agent-pig'])
    expect(result.mention_all).toBe(true)
  })

  it('strips mention markdown before leftover name matching', () => {
    expect(stripMentionMarkdown('hi [@王五](mention:user/user-a) 在吗')).toBe('hi   在吗')
  })

  it('formats mention markdown as display names for sidebar previews', () => {
    expect(formatMentionDisplayText(
      'user_0941: [@小Tin](mention:agent/d16b77ff-aaaa-bbbb-cccc-ddddeeeeffff) 看下',
    )).toBe('user_0941: @小Tin 看下')
    expect(formatMentionDisplayText('[@小Tin](mention:agent/d16b77ff-aaaa)')).not.toContain('mention:')
  })

  it('detects a specific mention target by href id', () => {
    const text = '[@快乐猪窝](mention:agent/agent-pig) 看下'
    expect(textHasMentionTarget(text, {
      member_type: 'agent',
      display_name: '别的名字',
      user_id: null,
      agent_id: 'agent-pig',
    })).toBe(true)
    expect(textHasMentionTarget(text, {
      member_type: 'agent',
      display_name: '快乐猪窝',
      user_id: null,
      agent_id: 'agent-other',
    })).toBe(false)
  })

  it('recognizes mention hrefs', () => {
    expect(isMentionHref('mention:user/user-a')).toBe(true)
    expect(isMentionHref('mention:agent/agent-pig')).toBe(true)
    expect(isMentionHref('mention:all')).toBe(true)
    expect(isMentionHref('https://example.com')).toBe(false)
  })

  it('splits mention markdown into text and mention segments', () => {
    expect(splitMentionMarkdownSegments('请 [@王五](mention:user/user-a) 看')).toEqual([
      { type: 'text', value: '请 ' },
      {
        type: 'mention',
        markdown: '[@王五](mention:user/user-a)',
        label: '@王五',
        href: 'mention:user/user-a',
      },
      { type: 'text', value: ' 看' },
    ])
  })

  it('does not treat the @ inside a completed mention as a composer trigger', () => {
    const text = '[@快乐猪窝](mention:agent/agent-pig) '
    expect(findComposerMentionTrigger(text, text.length)).toBeNull()
    expect(findComposerMentionTrigger('hello @快', 8)).toEqual({
      query: '快',
      startIndex: 6,
    })
  })
})
