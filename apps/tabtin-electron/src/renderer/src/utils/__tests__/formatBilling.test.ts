import { describe, expect, it } from 'vitest'
import {
  formatUsageQuantity,
  formatYuanAmount,
  formatYuanAmountPlain,
  labelBillingSource,
  labelBizType,
  labelSceneKey,
  parseYuanInput,
  resolveUsageSceneFilter,
  resolveUsageBizTypeFilter,
} from '../formatBilling'

describe('workspace memory billing labels', () => {
  const memoryScenes = [
    'memory_capture',
    'diary_distill',
    'user_portrait_distill',
    'memory_compaction',
  ]

  it.each(memoryScenes)('labels %s as 记忆增强 in usage ledger', sceneKey => {
    expect(labelSceneKey(sceneKey)).toBe('记忆增强')
  })

  it.each(memoryScenes)('labels %s as 记忆增强 in credits ledger', sceneKey => {
    expect(labelBillingSource({ scene_key: sceneKey })).toBe('记忆增强')
  })

  it('does not relabel unrelated or missing transaction metadata', () => {
    expect(labelBillingSource({ scene_key: '_main_chat' })).toBe('')
    expect(labelBillingSource(null)).toBe('')
  })
})

describe('formatYuanAmountPlain / parseYuanInput ( number input)', () => {
  it('formats ≥1000 without thousand separators for type=number inputs', () => {
    expect(formatYuanAmountPlain(1000)).toBe('1000')
    expect(formatYuanAmountPlain('7777')).toBe('7777')
    expect(formatYuanAmountPlain('89898.00')).toBe('89898')
    expect(formatYuanAmountPlain(10.5)).toBe('10.5')
    expect(formatYuanAmountPlain(0)).toBe('0')
  })

  it('keeps display formatter with grouping for read-only copy', () => {
    // zh-CN / en-US 均会带分组符；只断言含逗号且不等于 plain
    const display = formatYuanAmount(1000)
    expect(display).toContain('1')
    expect(display).toContain('000')
    expect(display).not.toBe(formatYuanAmountPlain(1000))
  })

  it('parses plain and thousand-separated yuan strings', () => {
    expect(parseYuanInput('1000')).toBe(1000)
    expect(parseYuanInput('1,000.00')).toBe(1000)
    expect(parseYuanInput('7,777')).toBe(7777)
    expect(parseYuanInput(89898)).toBe(89898)
    expect(Number.isNaN(parseYuanInput(''))).toBe(true)
    expect(Number.isNaN(parseYuanInput('abc'))).toBe(true)
  })
})

describe('resolveUsageBizTypeFilter ( model-call alias)', () => {
  it('expands 模型调用 filter llm_call to include legacy llm', () => {
    expect(resolveUsageBizTypeFilter('llm_call')).toBe('llm_call,llm')
  })

  it('expands legacy llm the same way', () => {
    expect(resolveUsageBizTypeFilter('llm')).toBe('llm_call,llm')
  })

  it('passes through unrelated biz types unchanged', () => {
    expect(resolveUsageBizTypeFilter('llm_chat')).toBe('llm_chat')
    expect(resolveUsageBizTypeFilter('llm_blocked')).toBe('llm_blocked')
  })

  it('returns undefined for empty filter', () => {
    expect(resolveUsageBizTypeFilter('')).toBeUndefined()
    expect(resolveUsageBizTypeFilter('   ')).toBeUndefined()
    expect(resolveUsageBizTypeFilter(null)).toBeUndefined()
  })
})

describe('resolveUsageSceneFilter ( usage scene filter)', () => {
  it('filters LLM 对话 by real billing types and the main-chat scene', () => {
    expect(resolveUsageSceneFilter('_main_chat')).toEqual({
      bizType: 'llm_call,llm',
      sceneKey: '_main_chat',
    })
  })

  it('keeps ordinary billing-type filters unchanged', () => {
    expect(resolveUsageSceneFilter()).toEqual({
      bizType: 'llm_call,llm',
    })
  })

  it.each(['_sub_agent', 'memory_capture', '_compact'])(
    'adds %s as a scene filter within the LLM billing types',
    sceneKey => {
      expect(resolveUsageSceneFilter(sceneKey)).toEqual({
        bizType: 'llm_call,llm',
        sceneKey,
      })
    },
  )

  it.each([undefined, null, '', '   '])('omits sceneKey for empty value %p', value => {
    expect(resolveUsageSceneFilter(value)).toEqual({ bizType: 'llm_call,llm' })
  })
})

describe('labelBizType model-call display', () => {
  it('labels both llm_call and llm as 模型调用', () => {
    expect(labelBizType('llm_call')).toBe('模型调用')
    expect(labelBizType('llm')).toBe('模型调用')
  })
})

describe('formatUsageQuantity ( storage units)', () => {
  it('formats storage.bytes / storage.oss.bytes with binary units', () => {
    expect(formatUsageQuantity('storage.bytes', 1048576)).toMatch(/MB/)
    expect(formatUsageQuantity('storage.oss.bytes', 1024)).toMatch(/KB/)
    expect(formatUsageQuantity('storage.bytes', 0)).toBe('0 B')
  })

  it('keeps sign for negative storage.bytes', () => {
    expect(formatUsageQuantity('storage.bytes', -1048576)).toBe('-1.00 MB')
  })

  it('formats storage.gb_day with GB·天', () => {
    expect(formatUsageQuantity('storage.gb_day', 1.5)).toBe('1.500 GB·天')
  })

  it('keeps llm.tokens compact suffixes', () => {
    expect(formatUsageQuantity('llm.tokens', 500)).toBe('500 tokens')
    expect(formatUsageQuantity('llm.tokens', 1500)).toBe('1.5K tokens')
    expect(formatUsageQuantity('llm.tokens', 2_000_000)).toBe('2.00M tokens')
  })

  it('falls back to quantity + unit for unknown meters; bare number without unit is empty', () => {
    expect(formatUsageQuantity('custom.meter', 12.5, 'unit')).toMatch(/12\.5\s+unit/)
    expect(formatUsageQuantity('custom.meter', 12.5)).toBe('')
  })

  it('treats null / empty / NaN quantity as missing', () => {
    expect(formatUsageQuantity('storage.bytes', null)).toBe('')
    expect(formatUsageQuantity('storage.bytes', undefined)).toBe('')
    expect(formatUsageQuantity('storage.bytes', '')).toBe('')
    expect(formatUsageQuantity('llm.tokens', Number.NaN)).toBe('')
  })
})
