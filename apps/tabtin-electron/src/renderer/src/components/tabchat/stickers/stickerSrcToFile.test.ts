import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickerSrcToFile } from './stickerSrcToFile'

describe('stickerSrcToFile', () => {
  beforeEach(() => {
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 128
      height = 128
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)

    const ctx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(new Blob(['png'], { type: 'image/png' }))
    })
  })

  it('rasterizes a sticker src into a PNG File', async () => {
    const file = await stickerSrcToFile('happy.svg', 'tabtin-happy')
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('tabtin-happy.png')
    expect(file.type).toBe('image/png')
  })
})
