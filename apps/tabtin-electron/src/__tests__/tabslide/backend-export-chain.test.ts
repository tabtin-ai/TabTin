import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { downloadFromUrl, requestBackendPptxExport } from '@/components/slide/slide-export'

describe('TabSlide backend PPTX export chain', () => {
  const apiRequestMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requests backend pptx export instead of client pptxgenjs export', async () => {
    apiRequestMock.mockResolvedValue({
      download_url: 'https://oss.example.com/deck.pptx',
      filename: 'deck.pptx',
    })

    const result = await requestBackendPptxExport('project-1', apiRequestMock)

    expect(apiRequestMock).toHaveBeenCalledWith({
      method: 'POST',
      url: '/tabslide/projects/project-1/export/',
      data: { format: 'pptx' },
    }, expect.objectContaining({
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    }))
    expect(result).toEqual({
      downloadUrl: 'https://oss.example.com/deck.pptx',
      filename: 'deck.pptx',
    })
  })

  it('rejects backend export response without download_url', async () => {
    apiRequestMock.mockResolvedValue({ filename: 'deck.pptx' })

    await expect(requestBackendPptxExport('project-1', apiRequestMock)).rejects.toThrow('missing download_url')
  })

  it('downloads the backend returned url', () => {
    vi.useFakeTimers()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    downloadFromUrl('https://oss.example.com/deck.pptx', 'deck.pptx')

    const link = document.body.querySelector('a')
    expect(link?.href).toBe('https://oss.example.com/deck.pptx')
    expect(link?.download).toBe('deck.pptx')
    expect(clickSpy).toHaveBeenCalledTimes(1)

    vi.runAllTimers()
    expect(document.body.querySelector('a')).toBeNull()
  })
})
