import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
  },
  net: {
    request: vi.fn(),
  },
  Notification: class Notification {
    constructor() {}
    show() {}
    static isSupported() { return false }
  },
}))

vi.mock('../resourceRequestContext', () => ({
  buildNetRequestOptions: vi.fn((url: string, requestSession?: unknown) => (
    requestSession
      ? { url, method: 'GET', redirect: 'follow', session: requestSession }
      : { url, method: 'GET', redirect: 'follow' }
  )),
}))

describe('M3U8Parser', () => {
  it('能解析 master playlist 并生成按带宽排序的变体列表', async () => {
    const { M3U8Parser } = await import('../M3U8Parser')
    const parser = new M3U8Parser()

    const result = parser.parse(`
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high/index.m3u8
    `.trim(), 'https://fixture.local/master.m3u8')

    expect(result.isMasterPlaylist).toBe(true)
    expect(result.variants).toEqual([
      expect.objectContaining({
        bandwidth: 2800000,
        resolution: '1920x1080',
        url: 'https://fixture.local/high/index.m3u8',
      }),
      expect.objectContaining({
        bandwidth: 800000,
        resolution: '640x360',
        url: 'https://fixture.local/low/index.m3u8',
      }),
    ])
    expect(result.segments).toEqual([])
  })

  it('能解析 media playlist 的分片、时长、直播/加密状态', async () => {
    const { M3U8Parser } = await import('../M3U8Parser')
    const parser = new M3U8Parser()

    const result = parser.parse(`
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.key"
#EXTINF:4.0,
seg-007.ts
#EXTINF:5.5,
seg-008.ts
#EXT-X-ENDLIST
    `.trim(), 'https://fixture.local/live/media.m3u8')

    expect(result.isMasterPlaylist).toBe(false)
    expect(result.isLive).toBe(false)
    expect(result.isEncrypted).toBe(true)
    expect(result.mediaSequence).toBe(7)
    expect(result.duration).toBe(9.5)
    expect(result.segments).toEqual([
      {
        url: 'https://fixture.local/live/seg-007.ts',
        duration: 4,
        sequence: 7,
      },
      {
        url: 'https://fixture.local/live/seg-008.ts',
        duration: 5.5,
        sequence: 8,
      },
    ])
  })
})
