import { describe, expect, it, vi } from 'vitest'
import {
  toCrawlspaceViewMetaUpdates,
  toRemoteCrawlspaceViewMetaUpdates,
} from './useCrawlSpaceViewManagerAdapter'

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => {
      if (key === 'context:label.newTab') return 'New Tab'
      if (key === 'context:label.untitledTab') return 'Untitled'
      return key
    },
  },
}))

describe('useCrawlSpaceViewManagerAdapter helpers', () => {
  it('toCrawlspaceViewMetaUpdates 只映射 renderer 可本地覆盖的字段', () => {
    const payload = toCrawlspaceViewMetaUpdates({
      title: 'New title',
      url: 'https://new.example',
      favicon: 'favicon.ico',
      themeColor: '#123456',
      isLoading: true,
      canGoBack: true,
    })

    expect(payload).toEqual({
      title: 'New title',
      url: 'https://new.example',
      favicon: 'favicon.ico',
      themeColor: '#123456',
      isLoading: true,
    })
  })

  it('toRemoteCrawlspaceViewMetaUpdates 只映射仍需 renderer 主动写回的字段', () => {
    const payload = toRemoteCrawlspaceViewMetaUpdates({
      title: 'New title',
      themeColor: undefined,
      favicon: undefined,
      runId: 'run-1',
      isPreview: false,
      isLoading: true,
    })

    expect(payload).toEqual({
      runId: 'run-1',
      isPreview: false,
    })
  })
})
