import { describe, expect, it } from 'vitest'

import {
  canUseAsPersonalDefault,
  canUseAsWorkspaceDefault,
  ensureCustomChatJsonCapability,
  isJsonModeEnabled,
  setJsonModeEnabled,
} from './organizationModelCapabilities'


describe('organizationModelCapabilities', () => {
  it('recognizes both canonical flag and json_object mode', () => {
    expect(isJsonModeEnabled({ supports_json_mode: true })).toBe(true)
    expect(isJsonModeEnabled({ json_mode: { modes: ['json_object'] } })).toBe(true)
    expect(isJsonModeEnabled({ supports_streaming: true })).toBe(false)
  })

  it('enables JSON mode without dropping unrelated capability metadata', () => {
    expect(setJsonModeEnabled({ supports_vision: true }, true)).toEqual({
      supports_vision: true,
      supports_json_mode: true,
      json_mode: { modes: ['json_object'] },
    })
  })

  it('disables JSON mode while preserving unrelated metadata', () => {
    expect(setJsonModeEnabled({
      supports_vision: true,
      supports_json_mode: true,
      json_mode: { modes: ['json_object', 'json_schema'] },
    }, false)).toEqual({
      supports_vision: true,
      supports_json_mode: false,
      json_mode: { modes: [] },
    })
  })

  it('uses backend default-model eligibility for BYOK scope decisions', () => {
    const base = {
      provider_routing_enabled: true,
      wave_status: 'ready',
      capability_domain: 'chat',
      is_active: true,
      provider_is_active: true,
    }
    expect(canUseAsWorkspaceDefault({
      ...base,
      provider_scope: 'user',
      can_set_as_default: true,
    })).toBe(true)
    expect(canUseAsWorkspaceDefault({
      ...base,
      provider_scope: 'user',
      can_set_as_default: false,
    })).toBe(false)
  })

  it('keeps personal default eligibility separate from organization default eligibility', () => {
    const base = {
      provider_routing_enabled: true,
      wave_status: 'ready',
      capability_domain: 'chat',
      is_active: true,
      provider_is_active: true,
      provider_scope: 'user' as const,
    }

    expect(canUseAsWorkspaceDefault({
      ...base,
      can_set_as_default: false,
      can_set_as_user_default: true,
    })).toBe(false)
    expect(canUseAsPersonalDefault({
      ...base,
      can_set_as_default: false,
      can_set_as_user_default: true,
    })).toBe(true)
  })

  it('rejects personal defaults when routing or readiness blocks use', () => {
    expect(canUseAsPersonalDefault({
      provider_routing_enabled: false,
      wave_status: 'ready',
      capability_domain: 'chat',
      can_set_as_user_default: true,
    })).toBe(false)
    expect(canUseAsPersonalDefault({
      provider_routing_enabled: true,
      wave_status: 'w2_pending',
      capability_domain: 'chat',
      can_set_as_user_default: true,
    })).toBe(false)
  })

  it('registers JSON mode for every custom chat model without dropping other capabilities', () => {
    expect(ensureCustomChatJsonCapability({
      supports_streaming: true,
      supports_json_mode: false,
    })).toEqual({
      supports_streaming: true,
      supports_json_mode: true,
      json_mode: { modes: ['json_object'] },
    })
  })
})
