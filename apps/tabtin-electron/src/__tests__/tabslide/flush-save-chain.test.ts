import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/tabslide', () => ({
  useSlideStore: { getState: vi.fn(() => ({})) },
}))

vi.mock('@tabtin/tabslide/exports', () => ({
  convertPagesToBackend: vi.fn(() => [{ id: 'page-1', elements: [] }]),
}))

vi.mock('@/services/api', () => ({
  apiService: {
    request: vi.fn(),
  },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: vi.fn(() => ({ selectedOrganization: null })) },
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: { getState: vi.fn(() => ({ selectedSpace: null })) },
}))

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: vi.fn(() => ({ resources: [] })),
    setState: vi.fn(),
  },
}))

vi.mock('@/components/slide/autosave-utils', () => ({
  unwrapEnvelope: vi.fn((envelope: Record<string, unknown> | null | undefined) => {
    if (envelope && typeof envelope === 'object' && 'data' in envelope && envelope.data && typeof envelope.data === 'object') {
      return envelope.data
    }
    return envelope || {}
  }),
  diffIncrementalSave: vi.fn(() => ({
    hasAnyPageChange: true,
    themeChanged: false,
    hasPagePayload: true,
    changedPageIds: ['page-1'],
    deletedPageIds: [],
    pageOrderChanged: false,
    nextBaseline: {},
  })),
  ensureProjectId: vi.fn(),
}))

vi.mock('@/components/slide/slide-font-utils', () => ({
  hasFontEmbeddingMeta: vi.fn(() => false),
  buildFontMetaRequestPayload: vi.fn(() => ({})),
}))

import { apiService } from '@/services/api'
import { fireAndForgetSave, saveToServer } from '@/components/slide/slide-save'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const makePresentation = (): SlidePresentation => ({
  name: 'Test',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  theme: {} as any,
  pages: [{
    id: 'page-1',
    elements: [{
      id: 'el-1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: 'hello',
    } as any],
    background: { type: 'solid', color: '#fff' },
  }],
})

describe('HOST-01: fireAndForgetSave 返回 Promise', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应返回 Promise 而非 void', () => {
    ;(apiService.request as any).mockResolvedValue({})
    const result = fireAndForgetSave(makePresentation(), 'proj-1')
    expect(result).toBeInstanceOf(Promise)
  })

  it('无变更时应返回已 resolve 的 Promise', async () => {
    const { diffIncrementalSave } = await import('@/components/slide/autosave-utils')
    ;(diffIncrementalSave as any).mockReturnValueOnce({
      hasAnyPageChange: false,
      themeChanged: false,
    })
    const result = fireAndForgetSave(
      makePresentation(),
      'proj-1',
      { pageOrder: ['page-1'], pageFingerprints: {}, themeFingerprint: '' },
    )
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBeUndefined()
  })

  it('API 请求成功时 Promise 应 resolve', async () => {
    ;(apiService.request as any).mockResolvedValue({})
    const result = fireAndForgetSave(makePresentation(), 'proj-1')
    await expect(result).resolves.toBeUndefined()
    expect(apiService.request).toHaveBeenCalledTimes(1)
  })

  it('API 请求失败时 Promise 仍应 resolve（不抛异常）', async () => {
    ;(apiService.request as any).mockRejectedValue(new Error('network'))
    const result = fireAndForgetSave(makePresentation(), 'proj-1')
    await expect(result).resolves.toBeUndefined()
  })
})

describe('HOST-02: 导出前保存必须写入页面数据', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('baseline 为空时应调用 save-pages 写入 SlidePage', async () => {
    const { diffIncrementalSave, ensureProjectId } = await import('@/components/slide/autosave-utils')
    const presentation = makePresentation()
    vi.mocked(ensureProjectId).mockResolvedValue('proj-1')
    vi.mocked(apiService.request).mockResolvedValue({ version: 2 })

    const result = await saveToServer(
      presentation,
      { current: null },
      { current: null },
      { current: null },
      { current: 1 },
      { current: { embeddedFonts: [], themeFonts: {} } },
      { current: false },
      { current: null },
      { current: null },
      1,
    )

    expect(result).toEqual({ projectId: 'proj-1', version: 2 })
    expect(diffIncrementalSave).toHaveBeenCalledWith(presentation, null)
    expect(apiService.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: '/tabslide/projects/proj-1/save-pages/',
    }), expect.any(Object))
  })
})
