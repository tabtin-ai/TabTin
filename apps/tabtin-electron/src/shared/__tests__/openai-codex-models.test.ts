import { describe, expect, it } from 'vitest'
import {
  OPENAI_CODEX_MODELS,
  resolveOpenAICodexModelCapabilities,
} from '../openai-codex-models'

describe('openai-codex-models capabilities', () => {
  it('assigns official per-model context windows (mini differs from flagship)', () => {
    expect(resolveOpenAICodexModelCapabilities('gpt-5.6-sol')).toEqual({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    })
    expect(resolveOpenAICodexModelCapabilities('gpt-5.4-mini')).toEqual({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    })
  })

  it('keeps every preset model on a positive official window', () => {
    for (const model of OPENAI_CODEX_MODELS) {
      expect(model.contextWindowTokens).toBeGreaterThan(128_000)
      expect(model.maxOutputTokens).toBe(128_000)
    }
  })
})
