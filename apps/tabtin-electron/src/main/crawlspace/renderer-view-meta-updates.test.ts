import { describe, expect, it } from 'vitest'

import { normalizeRendererViewMetaUpdates } from './renderer-view-meta-updates'

describe('normalizeRendererViewMetaUpdates', () => {
  it('只保留 renderer 仍允许主动写回的字段', () => {
    expect(
      normalizeRendererViewMetaUpdates({
        runId: 'run-1',
        isPreview: false,
        title: 'ignored',
        url: 'https://ignored.example',
        favicon: 'ignored.ico',
        themeColor: '#123456',
      }),
    ).toEqual({
      runId: 'run-1',
      isPreview: false,
    })
  })

  it('无受支持字段时返回 null', () => {
    expect(
      normalizeRendererViewMetaUpdates({
        title: 'ignored',
      }),
    ).toBeNull()
    expect(normalizeRendererViewMetaUpdates(null)).toBeNull()
  })
})
