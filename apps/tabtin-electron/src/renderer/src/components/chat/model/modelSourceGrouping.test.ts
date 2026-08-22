import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import {
  groupModelsBySourceAndProvider,
  resolveModelSource,
} from './modelSourceGrouping'

const model = (
  id: string,
  providerScope?: Model['provider_scope'],
): Model => ({
  id,
  name: id,
  display_name: id,
  provider: 'openai',
  provider_display_name: 'OpenAI',
  provider_scope: providerScope,
} as Model)

describe('model source grouping', () => {
  it('separates platform, organization BYOK, and personal BYOK for one provider', () => {
    const groups = groupModelsBySourceAndProvider([
      model('personal', 'user'),
      model('platform', 'global'),
      model('organization', 'organization'),
    ])

    expect(groups.map(group => ({
      key: group.key,
      modelIds: group.models.map(item => item.id),
    }))).toEqual([
      { key: 'platform:openai', modelIds: ['platform'] },
      { key: 'organizationByok:openai', modelIds: ['organization'] },
      { key: 'userByok:openai', modelIds: ['personal'] },
    ])
  })

  it('treats legacy models without provider_scope as platform models', () => {
    expect(resolveModelSource(undefined)).toBe('platform')
  })

  it('accepts settings catalog models without requiring the full chat model shape', () => {
    const groups = groupModelsBySourceAndProvider([
      {
        id: 'official-kimi',
        provider: 'moonshot',
        provider_display_name: 'Moonshot / Kimi',
        provider_scope: 'global' as const,
      },
      {
        id: 'personal-glm',
        provider: 'zhipu',
        provider_display_name: '智谱 GLM',
        provider_scope: 'user' as const,
      },
    ])

    expect(groups.map(group => ({
      source: group.source,
      provider: group.provider,
      modelIds: group.models.map(item => item.id),
    }))).toEqual([
      { source: 'platform', provider: 'moonshot', modelIds: ['official-kimi'] },
      { source: 'userByok', provider: 'zhipu', modelIds: ['personal-glm'] },
    ])
  })
})
