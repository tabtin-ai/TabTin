import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  writeBuffer: vi.fn(),
  writeImage: vi.fn(),
  createFromBuffer: vi.fn(),
  execFile: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: {
    clear: mocks.clear,
    writeBuffer: mocks.writeBuffer,
    writeImage: mocks.writeImage,
  },
  nativeImage: { createFromBuffer: mocks.createFromBuffer },
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  default: { execFile: mocks.execFile },
}))

describe('clipboard media', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createFromBuffer.mockReturnValue({ isEmpty: () => false })
    mocks.execFile.mockImplementation((_command, _args, callback) => callback(null, '', ''))
  })

  it('writes downloaded image bytes with Electron native clipboard', async () => {
    const { copyImageBufferToClipboard } = await import('../clipboard-media')
    const bytes = new Uint8Array([137, 80, 78, 71])

    copyImageBufferToClipboard(bytes)

    expect(mocks.createFromBuffer).toHaveBeenCalledWith(Buffer.from(bytes))
    expect(mocks.writeImage).toHaveBeenCalledTimes(1)
  })

  it('copies a downloaded file on macOS without shell interpolation', async () => {
    const { copyLocalFileToClipboard } = await import('../clipboard-media')
    const filePath = "/Users/me/Downloads/a file's video.mp4"

    await copyLocalFileToClipboard(filePath, 'darwin')

    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.arrayContaining([filePath]),
      expect.any(Function),
    )
  })

  it('writes a file URI for Linux clipboards', async () => {
    const { copyLocalFileToClipboard } = await import('../clipboard-media')

    await copyLocalFileToClipboard('/tmp/video clip.mp4', 'linux')

    expect(mocks.clear).toHaveBeenCalledTimes(1)
    expect(mocks.writeBuffer).toHaveBeenCalledWith(
      'text/uri-list',
      Buffer.from('file:///tmp/video%20clip.mp4\r\n'),
    )
  })
})
