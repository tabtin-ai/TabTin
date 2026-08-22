import { describe, expect, it } from 'vitest'
import {
  formatChatVideoUploadedBody,
  isChatVideoAttachment,
} from './analyzeChatVideoAttachment.js'

describe('isChatVideoAttachment', () => {
  it('识别 video mime 与常见扩展名', () => {
    expect(isChatVideoAttachment('video/mp4', 'a.mp4')).toBe(true)
    expect(isChatVideoAttachment('video/quicktime', 'a.mov')).toBe(true)
    expect(isChatVideoAttachment(undefined, 'clip.webm')).toBe(true)
    expect(isChatVideoAttachment('audio/mpeg', 'a.mp3')).toBe(false)
    expect(isChatVideoAttachment('application/pdf', 'x.pdf')).toBe(false)
  })
})

describe('formatChatVideoUploadedBody', () => {
  it('拼装上传成功确认', () => {
    const text = formatChatVideoUploadedBody('demo.mp4', 758090)
    expect(text).toContain('[视频: demo.mp4]')
    expect(text).toContain('已上传成功')
    expect(text).toContain('KB')
  })
})
