import { describe, it, expect } from 'vitest'
import {
  selectSmartDownloadTarget,
  classifyMediaResource,
  type SmartDownloadCandidate,
} from '../resources/smart-download-selector'

describe('classifyMediaResource', () => {
  it('从 URL 后缀识别 HLS / DASH 流', () => {
    expect(classifyMediaResource('https://x.com/a.m3u8')).toBe('hls')
    expect(classifyMediaResource('https://x.com/a.m3u8?token=1')).toBe('hls')
    expect(classifyMediaResource('https://x.com/a.mpd')).toBe('dash')
  })

  it('从 mimeType 识别流（即使 URL 无后缀）', () => {
    expect(classifyMediaResource('https://x.com/play', 'application/vnd.apple.mpegurl')).toBe('hls')
    expect(classifyMediaResource('https://x.com/play', 'application/dash+xml')).toBe('dash')
  })

  it('识别视频 / 音频 / 图片', () => {
    expect(classifyMediaResource('https://x.com/v.mp4')).toBe('video')
    expect(classifyMediaResource('https://x.com/a.mp3')).toBe('audio')
    expect(classifyMediaResource('https://x.com/i.png')).toBe('image')
    expect(classifyMediaResource('https://x.com/c', 'video/webm')).toBe('video')
    expect(classifyMediaResource('https://x.com/c', 'audio/mpeg')).toBe('audio')
  })

  it('无法判定时返回 other（不像 Electron 那样兜底成 video）', () => {
    expect(classifyMediaResource('https://x.com/app.js', 'application/javascript')).toBe('other')
    expect(classifyMediaResource(undefined, undefined)).toBe('other')
  })
})

describe('selectSmartDownloadTarget', () => {
  it('页面无媒体时返回 null', () => {
    expect(selectSmartDownloadTarget([])).toBeNull()
    expect(
      selectSmartDownloadTarget([{ category: 'other', url: 'https://x.com/a.js' }]),
    ).toBeNull()
  })

  it('HLS/DASH 流优先于普通视频，且走 stream 策略', () => {
    const candidates: SmartDownloadCandidate[] = [
      { resourceId: 'v1', category: 'video', size: 999, url: 'https://x.com/v.mp4' },
      {
        resourceId: 's1',
        category: 'hls',
        url: 'https://x.com/a.m3u8',
        capabilities: ['streamDownload'],
      },
    ]
    const sel = selectSmartDownloadTarget(candidates)
    expect(sel?.target.resourceId).toBe('s1')
    expect(sel?.strategy).toBe('stream')
  })

  it('无流时挑体积最大的普通视频，走 download 策略', () => {
    const candidates: SmartDownloadCandidate[] = [
      { resourceId: 'small', category: 'video', size: 100 },
      { resourceId: 'big', category: 'video', size: 5000 },
      { resourceId: 'mid', category: 'video', size: 800 },
    ]
    const sel = selectSmartDownloadTarget(candidates)
    expect(sel?.target.resourceId).toBe('big')
    expect(sel?.strategy).toBe('download')
  })

  it('普通视频优先于页面内 blob 视频', () => {
    const candidates: SmartDownloadCandidate[] = [
      { resourceId: 'blob', category: 'video', captureStatus: 'page_bound_blob' },
      { resourceId: 'plain', category: 'video', size: 1 },
    ]
    expect(selectSmartDownloadTarget(candidates)?.target.resourceId).toBe('plain')
  })

  it('只剩 blob 视频时选它并走 capture-then-download 策略', () => {
    const sel = selectSmartDownloadTarget([
      { resourceId: 'blob', category: 'video', captureStatus: 'page_bound_blob' },
    ])
    expect(sel?.target.resourceId).toBe('blob')
    expect(sel?.strategy).toBe('capture-then-download')
  })

  it('音频兜底（无视频 / 流时）', () => {
    const sel = selectSmartDownloadTarget([
      { resourceId: 'au', category: 'audio', url: 'https://x.com/a.mp3' },
    ])
    expect(sel?.target.resourceId).toBe('au')
    expect(sel?.strategy).toBe('download')
  })

  it('整体排除分片（isSegment）', () => {
    const sel = selectSmartDownloadTarget([
      { resourceId: 'seg', category: 'video', size: 9999, isSegment: true },
      { resourceId: 'whole', category: 'video', size: 10 },
    ])
    expect(sel?.target.resourceId).toBe('whole')
  })

  it('category 过滤只在该类别内挑', () => {
    const candidates: SmartDownloadCandidate[] = [
      { resourceId: 's1', category: 'hls', capabilities: ['streamDownload'] },
      { resourceId: 'au', category: 'audio', url: 'https://x.com/a.mp3' },
    ]
    const sel = selectSmartDownloadTarget(candidates, { category: 'audio' })
    expect(sel?.target.resourceId).toBe('au')
  })

  it('capabilities 含 streamDownload 时即使类别非流也走 stream 策略', () => {
    const sel = selectSmartDownloadTarget([
      { resourceId: 'v', category: 'video', capabilities: ['streamDownload'] },
    ])
    expect(sel?.strategy).toBe('stream')
  })
})
