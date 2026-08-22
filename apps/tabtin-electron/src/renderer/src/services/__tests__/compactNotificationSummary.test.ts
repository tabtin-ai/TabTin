import { describe, expect, it } from 'vitest'
import {
  compactNotificationSummary,
  resolveAgentNotificationDisplay,
} from '../compactNotificationSummary'

describe('compactNotificationSummary', () => {
  it('取首句并去掉 markdown 加粗', () => {
    const input =
      '我可以帮你从网上下载视频。不过需要你先提供一下：**视频的网页地址 (URL)** 和保存位置。'
    expect(compactNotificationSummary(input)).toBe('我可以帮你从网上下载视频。')
  })

  it('无句号时截断过长首行', () => {
    const input = 'a'.repeat(100)
    const out = compactNotificationSummary(input, 80)
    expect(out.length).toBe(80)
    expect(out.endsWith('…')).toBe(true)
  })

  it('空文本返回空串', () => {
    expect(compactNotificationSummary('')).toBe('')
    expect(compactNotificationSummary(null)).toBe('')
  })
})

describe('resolveAgentNotificationDisplay', () => {
  it('历史「Agent 任务完成」+ 长 body → 升格首句作主标题', () => {
    const { headline, subline } = resolveAgentNotificationDisplay({
      title: 'Agent 任务完成',
      body: '你好！你提到了王旭明，不过没有说明具体需要我帮你做什么。我可以帮你：1. 查资料',
    })
    expect(headline).toBe('你好！')
    expect(subline).toBe('')
  })

  it('新格式 title=摘要、body=会话名 → 原样展示', () => {
    const { headline, subline } = resolveAgentNotificationDisplay({
      title: '我可以帮你从网上下载视频。',
      body: '下载视频助手',
    })
    expect(headline).toBe('我可以帮你从网上下载视频。')
    expect(subline).toBe('下载视频助手')
  })
})
