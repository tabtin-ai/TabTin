import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  isLocalCodexModelSelection,
  omitServerModelFieldsWhenLocalCodex,
  withPreservedLocalCodexModelSelection,
} from './preserveLocalCodexModelSelection'

describe('preserveLocalCodexModelSelection', () => {
  it('recognizes ChatGPT Codex local model ids', () => {
    expect(isLocalCodexModelSelection('gpt-5.6-sol')).toBe(true)
    expect(isLocalCodexModelSelection('9964a6dd-c8d8-44cf-bb6a-45b12cb03842')).toBe(false)
  })

  it('keeps local Codex model when merging a server session snapshot', () => {
    const local = {
      current_model_id: 'gpt-5.6-sol',
      context_tier_id: null,
      title: 'local',
    }
    const server = {
      current_model_id: '9964a6dd-c8d8-44cf-bb6a-45b12cb03842',
      context_tier_id: 'tier-1',
      title: 'server',
    }

    expect(withPreservedLocalCodexModelSelection(local, server)).toEqual({
      current_model_id: 'gpt-5.6-sol',
      context_tier_id: null,
      title: 'server',
    })
  })

  it('does not rewrite non-Codex local selections', () => {
    const local = {
      current_model_id: '9964a6dd-c8d8-44cf-bb6a-45b12cb03842',
      context_tier_id: 'tier-local',
    }
    const server = {
      current_model_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      context_tier_id: 'tier-server',
    }
    expect(withPreservedLocalCodexModelSelection(local, server)).toEqual(server)
  })

  it('strips model fields from lifecycle patches when local Codex is selected', () => {
    const local = {
      current_model_id: 'gpt-5.6-sol',
      context_tier_id: null,
    } as ChatSession
    const patch = {
      id: 'sess-1',
      title: '打招呼',
      current_model_id: '9964a6dd-c8d8-44cf-bb6a-45b12cb03842',
      context_tier_id: 'tier-1',
      message_count: 2,
    } as Partial<ChatSession>

    expect(omitServerModelFieldsWhenLocalCodex(local, patch)).toEqual({
      id: 'sess-1',
      title: '打招呼',
      message_count: 2,
    })
  })
})
