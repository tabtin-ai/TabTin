import { describe, expect, it } from 'vitest'
import {
  analyzeCaptchaFromPageMeta,
  analyzeDetectionResult,
  CAPTCHA_REQUIRED_HINT,
  projectCaptchaRequired,
} from '../CaptchaDetector'

describe('analyzeDetectionResult —— Google sorry / 异常流量墙', () => {
  it('sorry URL + 异常流量正文 → detected + user-intervention', () => {
    const info = analyzeDetectionResult({
      matches: [],
      title: 'https://www.google.com/search?q=agent',
      url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search',
      bodyText: '我们的系统检测到您的计算机网络中存在异常流量。此网页用于确认这些请求是由您而不是自动程序发出的。',
    })
    expect(info.detected).toBe(true)
    expect(info.type).toBe('recaptcha-v2')
    expect(info.suggested_action).toBe('user-intervention')
    expect(info.confidence).toBeGreaterThanOrEqual(0.88)
    expect(info.page_url).toContain('google.com/sorry')
  })

  it('仅正文 unusual traffic 也可命中', () => {
    const info = analyzeDetectionResult({
      matches: [],
      title: 'About this page',
      url: 'https://www.google.com/search?q=x',
      bodyText: 'Our systems have detected unusual traffic from your computer network.',
    })
    expect(info.detected).toBe(true)
    expect(info.suggested_action).toBe('user-intervention')
  })

  it('普通搜索页无墙文案不误报', () => {
    const info = analyzeDetectionResult({
      matches: [],
      title: 'agent产品 - Google 搜索',
      url: 'https://www.google.com/search?q=agent',
      bodyText: '约 1,000,000 条结果',
    })
    expect(info.detected).toBe(false)
  })

  it('analyzeCaptchaFromPageMeta 能从 HTML 抽出异常流量', () => {
    const info = analyzeCaptchaFromPageMeta({
      url: 'https://www.google.com/sorry/index?continue=/search',
      title: 'verification',
      htmlOrText: '<html><body><p>我们的系统检测到您的计算机网络中存在异常流量。</p></body></html>',
    })
    expect(info.detected).toBe(true)
  })
})

describe('analyzeDetectionResult —— 字节/火山验证（36kr 墙-6）', () => {
  it('宿主 #captcha_container + bytedance verifycenter iframe → bytedance + user-intervention', () => {
    const info = analyzeDetectionResult({
      matches: [
        '#captcha_container',
        'iframe[src*="rmc.bytedance.com/verifycenter"]',
      ],
      title: '36氪',
      url: 'https://36kr.com/',
      bodyText: '',
    })
    expect(info.detected).toBe(true)
    expect(info.type).toBe('bytedance')
    expect(info.suggested_action).toBe('user-intervention')
    expect(info.challenge_visible).toBe(true)
    expect(info.confidence).toBeGreaterThanOrEqual(0.9)
    expect(info.page_url).toBe('https://36kr.com/')
  })

  it('仅 verifycenter/captcha iframe 也可命中', () => {
    const info = analyzeDetectionResult({
      matches: ['iframe[src*="verifycenter/captcha"]'],
      title: '36kr.com',
      url: 'https://36kr.com/information/enterpriseservice/',
    })
    expect(info.detected).toBe(true)
    expect(info.type).toBe('bytedance')
    expect(info.suggested_action).toBe('user-intervention')
  })

  it('仅 #captcha_container 也可命中（墙-6 宿主遮罩）', () => {
    const info = analyzeDetectionResult({
      matches: ['#captcha_container'],
      title: '36kr.com',
      url: 'https://36kr.com/',
    })
    expect(info.detected).toBe(true)
    expect(info.type).toBe('bytedance')
    expect(projectCaptchaRequired(info)).toEqual({
      reason: '页面需要完成验证码（bytedance）',
      hint: CAPTCHA_REQUIRED_HINT,
      type: 'bytedance',
    })
  })

  it('普通内容页无 bytedance 信号不误报', () => {
    const info = analyzeDetectionResult({
      matches: [],
      title: '36氪 - 让一部分人先看到未来',
      url: 'https://36kr.com/',
      bodyText: '企业服务 最新文章',
    })
    expect(info.detected).toBe(false)
  })
})

describe('projectCaptchaRequired', () => {
  it('detected 时投影 reason/hint/type', () => {
    expect(
      projectCaptchaRequired({
        detected: true,
        type: 'recaptcha-v2',
        confidence: 0.9,
        challenge_visible: true,
        suggested_action: 'user-intervention',
      }),
    ).toEqual({
      reason: '页面需要完成验证码（recaptcha-v2）',
      hint: CAPTCHA_REQUIRED_HINT,
      type: 'recaptcha-v2',
    })
  })

  it('未 detected 不加字段', () => {
    expect(
      projectCaptchaRequired({
        detected: false,
        confidence: 0,
        challenge_visible: false,
        suggested_action: 'auto-wait',
      }),
    ).toBeUndefined()
  })
})
