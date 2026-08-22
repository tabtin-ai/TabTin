import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from '../../context/BrowserContext'
import { getSharedCDPOperationHelper } from '../CDPOperationHelper'
import { runSingleAction } from '../ActionRunner'

type MockExecuteScript = (code: string, frameId?: string) => Promise<unknown>

function context(executeScript: MockExecuteScript): BrowserContext {
  return {
    isAlive: () => true,
    executeScript: executeScript as BrowserContext['executeScript'],
    getCurrentURL: () => 'https://mail.qq.com',
  } as unknown as BrowserContext
}

describe('ActionRunner frame execution', () => {
  afterEach(() => vi.restoreAllMocks())

  it('iframe click 在所属 frame 走 DOM 路径，不使用主 target CDP 点击', async () => {
    const cdpSpy = vi
      .spyOn(getSharedCDPOperationHelper(), 'runAction')
      .mockResolvedValue({ success: true })
    const executeScript = vi.fn<MockExecuteScript>(async () => ({ success: true }))

    const entry = await runSingleAction(
      context(executeScript),
      { type: 'click', selector: '#mobile', frameId: 'frame-20' },
      1000,
    )

    expect(entry.status).toBe('success')
    expect(executeScript).toHaveBeenCalledWith(expect.any(String), 'frame-20')
    expect(cdpSpy).not.toHaveBeenCalled()
  })

  it('iframe selector 失效后的语义重定位和重试始终留在同一 frame', async () => {
    const executeScript = vi
      .fn<MockExecuteScript>()
      .mockResolvedValueOnce({
        success: false,
        code: 'element_not_found',
        error: '未找到元素',
      })
      .mockResolvedValueOnce({
        success: false,
        code: 'element_not_found',
        error: '未找到元素',
      })
      .mockResolvedValueOnce({
        success: true,
        selector: 'a[aria-label="QQ手机版"]',
      })
      .mockResolvedValueOnce({ success: true })

    const entry = await runSingleAction(
      context(executeScript),
      {
        type: 'click',
        ref: 'e2',
        selector: '#stale-mobile',
        frameId: 'frame-20',
        refSemantic: { role: 'link', name: 'QQ手机版', nth: 0 },
      },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      selector: 'a[aria-label="QQ手机版"]',
      selector_source: 'semantic_relocate',
    })
    expect(executeScript).toHaveBeenCalledTimes(4)
    for (const call of executeScript.mock.calls) expect(call[1]).toBe('frame-20')
  })

  it('frame 已失效时明确失败且只尝试一次，不回退主 frame', async () => {
    const executeScript = vi.fn<MockExecuteScript>(async () => {
      throw new Error('目标 frame 已失效，请重新 glance')
    })

    const entry = await runSingleAction(
      context(executeScript),
      { type: 'click', selector: '#mobile', frameId: 'frame-gone' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error: '目标 frame 已失效，请重新 glance',
    })
    expect(executeScript).toHaveBeenCalledOnce()
    expect(executeScript.mock.calls[0]?.[1]).toBe('frame-gone')
  })
})
