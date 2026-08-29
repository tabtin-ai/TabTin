import { describe, expect, it } from 'vitest'
import { collectChannelSearchHints, modelMatchesChannel } from '../byok-channel-model-search'

describe('collectChannelSearchHints', () => {
  it('百炼按地址收窄到 dashscope，而不是全局 OpenAI', () => {
    expect(collectChannelSearchHints({
      name: 'dashscope',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })).toEqual(['dashscope', 'qwen'])
  })

  it('OpenRouter 按地址收窄，不跟官方 OpenAI 混在一起', () => {
    expect(collectChannelSearchHints({
      name: 'openai',
      base_url: 'https://openrouter.ai/api/v1',
    })).toEqual(['openrouter'])
  })
})

describe('modelMatchesChannel', () => {
  const bailian = {
    name: 'dashscope',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  }

  it('当前渠道下只保留该厂商模型', () => {
    expect(modelMatchesChannel({ name: 'qwen-max', provider: 'dashscope' }, bailian)).toBe(true)
    expect(modelMatchesChannel({ name: 'dashscope/qwen-plus', provider: 'dashscope' }, bailian)).toBe(true)
    expect(modelMatchesChannel({ name: 'gpt-4o', provider: 'openai' }, bailian)).toBe(false)
  })
})
