import { describe, expect, it, vi } from 'vitest'
import {
  CAPTCHA_DETECT_FAST_TIMEOUT_MS,
  CaptchaGuard,
  captchaNeedsUserIntervention,
} from '../CaptchaGuard'
import type { BrowserContext } from '../../context/BrowserContext'

describe('CaptchaGuard.detectFast', () => {
  it('命中人工验证码且不进入 turnstile 长等待', async () => {
    const guard = new CaptchaGuard()
    const executeScript = vi.fn(async () => ({
      matches: ['div.g-recaptcha'],
      title: '验证',
      url: 'https://www.google.com/sorry/index',
      bodyText: '我们的系统检测到您的计算机网络中存在异常流量。',
    }))
    guard.setContextFactory(() =>
      ({
        isAlive: () => true,
        executeScript,
      }) as unknown as BrowserContext,
    )

    const result = await guard.detectFast('tab-1')
    expect(result.detected).toBe(true)
    expect(captchaNeedsUserIntervention(result)).toBe(true)
    expect(executeScript).toHaveBeenCalledTimes(1)
  })

  it(`超过 ${CAPTCHA_DETECT_FAST_TIMEOUT_MS}ms 则返回未检出`, async () => {
    vi.useFakeTimers()
    try {
      const guard = new CaptchaGuard()
      guard.setContextFactory(() =>
        ({
          isAlive: () => true,
          executeScript: () => new Promise(() => {}),
        }) as unknown as BrowserContext,
      )

      const pending = guard.detectFast('tab-slow', 50)
      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toMatchObject({ detected: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
