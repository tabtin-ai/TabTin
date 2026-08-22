import { describe, expect, it, vi } from 'vitest'
import { BrowserActionError } from '@tabtin/browser-core'
import {
  buildElectronExecHooks,
  CAPTCHA_ACT_WATCH_INITIAL_DELAY_MS,
  collectNavigationEvidenceInput,
  ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS,
} from '../interaction'
import { resolveTabId } from '../_helpers'

const detectFast = vi.fn(async () => ({
  detected: false,
  confidence: 0,
  challenge_visible: false,
  suggested_action: 'auto-wait' as const,
}))

vi.mock('@tabtin/browser-core', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/browser-core')>('@tabtin/browser-core')
  return {
    ...actual,
    getSharedCaptchaGuard: () => ({ detectFast }),
    projectCaptchaRequired: actual.projectCaptchaRequired,
  }
})

vi.mock('../_helpers', async () => {
  const actual = await vi.importActual<typeof import('../_helpers')>('../_helpers')
  return {
    ...actual,
    resolveTabId: vi.fn(async () => 'tab-1'),
    makeTaskId: vi.fn(() => 'cli-act-test'),
  }
})

vi.mock('../../../../services/ApprovalManager', () => ({
  requestApproval: vi.fn(async () => ({ approved: true })),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    isPackaged: false,
  },
}))

describe('browser interaction route hooks', () => {
  it('#6538：interaction prepareTab 透传 originating thread scope', async () => {
    const executor = vi.fn()
    const hooks = buildElectronExecHooks(executor as any)
    const body = {
      tabId: 'auto',
      space_id: 'space-1',
      crawlspace_id: 'cs-1',
      thread_id: 'session-A',
    }

    await hooks.prepareTab(body)

    expect(resolveTabId).toHaveBeenCalledWith(
      'auto',
      expect.objectContaining({
        spaceId: 'space-1',
        crawlspaceId: 'cs-1',
        _thread_id: 'session-A',
      }),
    )
  })

  it('runAct 在 CLI transport 超时前返回结构化超时错误', async () => {
    vi.useFakeTimers()
    try {
      detectFast.mockResolvedValueOnce({
        detected: false,
        confidence: 0,
        challenge_visible: false,
        suggested_action: 'auto-wait',
      })
      const executor = vi.fn(() => new Promise(() => {}))
      const hooks = buildElectronExecHooks(executor as any)

      const pending = hooks.runAct(
        'tab-1',
        [{ type: 'click', selector: 'a' }],
        { stop_on_error: true },
      )
      const assertion = expect(pending).rejects.toMatchObject({
        status: 504,
        info: {
          code: 'CONNECTION_TIMEOUT',
          retryable: true,
          detail: {
            tabId: 'tab-1',
            timeoutMs: ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS,
            actions: '1:click(a)',
          },
        },
      } satisfies Partial<BrowserActionError>)

      await vi.advanceTimersByTimeAsync(ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS)
      await assertion

      expect(executor).toHaveBeenCalledWith({
        task_id: 'cli-act-test',
        type: 'execute_act',
        params: {
          actions: [{ type: 'click', selector: 'a' }],
          stop_on_error: true,
          crawlTabId: 'tab-1',
        },
        thread_id: '',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('runAct 执行中 detectFast 命中墙则早退（不必等满超时）', async () => {
    vi.useFakeTimers()
    try {
      detectFast.mockResolvedValue({
        detected: true,
        type: 'recaptcha-v2',
        confidence: 0.9,
        challenge_visible: true,
        suggested_action: 'user-intervention',
        page_url: 'https://www.google.com/sorry/index',
      })
      const executor = vi.fn(() => new Promise(() => {}))
      const hooks = buildElectronExecHooks(executor as any)

      const pending = hooks.runAct(
        'tab-1',
        [{ type: 'click', selector: '#btn' }],
        {},
      )
      const assertion = pending.then((outcome) => {
        expect(outcome.success).toBe(false)
        expect(outcome.raw).toMatchObject({
          page_url: 'https://www.google.com/sorry/index',
          captcha: expect.objectContaining({
            type: 'recaptcha-v2',
            suggested_action: 'user-intervention',
          }),
        })
      })

      await vi.advanceTimersByTimeAsync(CAPTCHA_ACT_WATCH_INITIAL_DELAY_MS)
      await assertion
      expect(detectFast).toHaveBeenCalledWith('tab-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('runAct 超时时若仅超时补探测命中墙，detail 带 captcha_required + page_url', async () => {
    vi.useFakeTimers()
    try {
      // 并行 watch 期间不命中，避免早退；超时 enrich 再命中
      detectFast.mockResolvedValue({
        detected: false,
        confidence: 0,
        challenge_visible: false,
        suggested_action: 'auto-wait',
      })
      const executor = vi.fn(() => new Promise(() => {}))
      const hooks = buildElectronExecHooks(executor as any)

      const pending = hooks.runAct(
        'tab-1',
        [{ type: 'click', selector: '#btn' }],
        {},
      )
      const assertion = expect(pending).rejects.toMatchObject({
        status: 504,
        info: {
          code: 'CONNECTION_TIMEOUT',
          detail: {
            page_url: 'https://www.google.com/sorry/index',
            captcha_required: expect.objectContaining({
              type: 'recaptcha-v2',
            }),
          },
        },
      })

      await vi.advanceTimersByTimeAsync(ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS - 1)
      detectFast.mockResolvedValue({
        detected: true,
        type: 'recaptcha-v2',
        confidence: 0.9,
        challenge_visible: true,
        suggested_action: 'user-intervention',
        page_url: 'https://www.google.com/sorry/index',
      })
      await vi.advanceTimersByTimeAsync(1)
      await assertion
      expect(detectFast).toHaveBeenCalledWith('tab-1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('collectNavigationEvidenceInput ', () => {
  it('从 observe 结果提取 page_url + observed_elements[].href', () => {
    const result = {
      ok: true,
      status: 200,
      data: {
        page_url: 'https://www.xiaohongshu.com/search_result?keyword=ai',
        observed_elements: [
          { selector: 'a', tag: 'a', text: '笔记', visible: true, ref: 'e1', href: 'https://www.xiaohongshu.com/search_result/69f?xsec_token=X' },
          { selector: 'button', tag: 'button', text: '搜索', visible: true, ref: 'e2' },
        ],
      },
    } as any
    expect(collectNavigationEvidenceInput(result)).toEqual({
      pageUrl: 'https://www.xiaohongshu.com/search_result?keyword=ai',
      hrefs: ['https://www.xiaohongshu.com/search_result/69f?xsec_token=X'],
    })
  })

  it('observe 无任何 href 时返回 undefined', () => {
    const result = {
      ok: true,
      status: 200,
      data: { page_url: 'https://e.com', observed_elements: [{ selector: 'button', tag: 'button', text: 'x', visible: true }] },
    } as any
    expect(collectNavigationEvidenceInput(result)).toBeUndefined()
  })

  it('错误结果或缺字段返回 undefined', () => {
    expect(collectNavigationEvidenceInput({ ok: false, status: 500, error: { code: 'X', message: 'e' } } as any)).toBeUndefined()
    expect(collectNavigationEvidenceInput({ ok: true, status: 200, data: {} } as any)).toBeUndefined()
  })
})
