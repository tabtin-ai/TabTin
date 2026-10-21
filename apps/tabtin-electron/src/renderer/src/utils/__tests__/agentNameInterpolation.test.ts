import { describe, expect, it } from 'vitest'
import {
  expandAgentName,
  localizeKnownAgentDisplayName,
  normalizeKnownAgentDisplayName,
} from '../agentNameInterpolation'

describe('known Agent display names', () => {
  it.each(['小Tin', '万能Tin', '默认 Workspace 执行身份', '默认 Space 执行身份', 'NiiNii'])(
    'displays the known default %s as NiiNii without changing stored data',
    (name) => expect(normalizeKnownAgentDisplayName(name)).toBe('NiiNii'),
  )

  it.each(['日常版', '代码版', '文书版', '数据版', '冲浪版', 'PPT 版', '跑腿版'])(
    'updates the exact factory name for %s',
    (role) => expect(normalizeKnownAgentDisplayName(`小Tin ${role}`)).toBe(`NiiNii ${role}`),
  )

  it('preserves custom names and owner interpolation', () => {
    expect(normalizeKnownAgentDisplayName('小Tin 我的专属代码号')).toBe('小Tin 我的专属代码号')
    expect(normalizeKnownAgentDisplayName('小明代码版')).toBe('小明代码版')
    expect(normalizeKnownAgentDisplayName('toString')).toBe('toString')
    expect(expandAgentName('{owner}代码版', '小Tin')).toBe('小Tin代码版')
    expect(expandAgentName('小Tin 代码版', '小明')).toBe('NiiNii 代码版')
  })

  it('uses NiiNii as the localized default and keeps custom names intact', () => {
    const t = (_key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? '')
    expect(localizeKnownAgentDisplayName('小Tin', t)).toBe('NiiNii')
    expect(localizeKnownAgentDisplayName('我的伙伴', t)).toBe('我的伙伴')
  })
})
