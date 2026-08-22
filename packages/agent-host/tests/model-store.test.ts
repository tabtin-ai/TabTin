import { describe, expect, it } from 'vitest'
import { ModelPrefsStore } from '../src/state/index.js'
import type { ModelCatalogEntry } from '@tabtin/agent-runtime/engine'

const entry = (id: string): ModelCatalogEntry => ({
  id,
  capabilities: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    maxInputTokens: 128_000,
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsPromptCaching: false,
    cacheType: 'none',
  },
})

describe('ModelPrefsStore', () => {
  it('stores mutable model catalog snapshot in StateRoot model domain', () => {
    const store = new ModelPrefsStore()
    store.catalogFallbackWarned.add('user-a:org-a:old-miss')

    store.replaceCatalogSnapshot('user-a:org-a', [entry('model-a')])

    expect(store.getCatalogSnapshot('user-a:org-a')).toEqual([entry('model-a')])
    expect(store.catalogFallbackWarned.size).toBe(0)
  })

  it('returns catalog snapshots by copy', () => {
    const store = new ModelPrefsStore()
    store.replaceCatalogSnapshot('user-a:org-a', [entry('model-a')])

    const snapshot = store.getCatalogSnapshot('user-a:org-a')
    snapshot.push(entry('model-b'))

    expect(store.getCatalogSnapshot('user-a:org-a').map(model => model.id)).toEqual(['model-a'])
  })

  it('replaces stale catalog snapshot with the latest available model list', () => {
    const store = new ModelPrefsStore()
    store.replaceCatalogSnapshot('user-a:org-a', [entry('model-a'), entry('model-b')])

    store.replaceCatalogSnapshot('user-a:org-a', [entry('model-b'), entry('model-c')])

    expect(store.getCatalogSnapshot('user-a:org-a').map(model => model.id)).toEqual(['model-b', 'model-c'])
  })

  it('隔离不同用户与组织的 BYOK 模型目录', () => {
    const store = new ModelPrefsStore()
    store.replaceCatalogSnapshot('user-a:org-a', [entry('org-a-model')])
    store.replaceCatalogSnapshot('user-b:org-a', [entry('user-b-byok')])
    store.replaceCatalogSnapshot('user-a:org-b', [entry('org-b-model')])

    expect(store.getCatalogSnapshot('user-a:org-a').map(model => model.id)).toEqual(['org-a-model'])
    expect(store.getCatalogSnapshot('user-b:org-a').map(model => model.id)).toEqual(['user-b-byok'])
    expect(store.getCatalogSnapshot('user-a:org-b').map(model => model.id)).toEqual(['org-b-model'])
  })
})
