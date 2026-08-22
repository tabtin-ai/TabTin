import { describe, expect, it } from 'vitest'
import {
  OPENAI_CODEX_TAB_ID,
  buildByokPlanChannels,
} from '../byok-connect-channels'

describe('buildByokPlanChannels', () => {
  it('includeOpenAICodex=true 时包含 ChatGPT Codex Tab', () => {
    const channels = buildByokPlanChannels(true)
    expect(channels.some((channel) => channel.tabId === OPENAI_CODEX_TAB_ID)).toBe(true)
    expect(
      channels.find((channel) => channel.tabId === OPENAI_CODEX_TAB_ID),
    ).toMatchObject({ kind: 'chatgpt_codex' })
  })

  it('includeOpenAICodex=false 时不包含 ChatGPT Codex Tab（正式包）', () => {
    const channels = buildByokPlanChannels(false)
    expect(channels.some((channel) => channel.tabId === OPENAI_CODEX_TAB_ID)).toBe(false)
    expect(channels.every((channel) => channel.kind === 'plan')).toBe(true)
  })
})
