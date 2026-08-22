import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'
import { getHumanInteractionContext } from '@tabtin/agent-runtime'
import {
  BROWSER_CLI_APPROVAL_TIMEOUT_MS,
  evaluateElectronBrowserCLIPolicy,
  runWithBrowserApprovalContext,
  runWithBrowserPolicyPreapproval,
} from '../browser-policy-middleware'
import { electronPolicyHooks } from '../routes/browser/_helpers'
import {
  clearRuntimeInteractionMode,
  setRuntimeInteractionMode,
} from '../../agent/policy/interaction-mode-context'

const mocks = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  contexts: [] as Array<string | undefined>,
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/Users/testuser'),
    isPackaged: false,
  },
}))

vi.mock('../../services/ApprovalManager', () => ({
  requestApproval: mocks.requestApproval,
}))

const EVAL_CONFIRM_DECISION = {
  action: 'confirm' as const,
  actionType: 'eval',
  detail: 'actionId=eval risk=high-risk-write',
  reason: '该操作会修改浏览器状态或页面内容，需确认',
}

describe('Electron browser CLI policy middleware', () => {
  beforeEach(() => {
    mocks.requestApproval.mockReset()
    mocks.contexts.length = 0
    mocks.requestApproval.mockImplementation(async () => {
      mocks.contexts.push(getHumanInteractionContext()?.threadId)
      return { approved: true }
    })
  })

  it('浏览器审批等待窗口与 Electron 普通审批一致，给移动端留出同步时间', () => {
    expect(BROWSER_CLI_APPROVAL_TIMEOUT_MS).toBe(PERMISSION_TIMEOUTS.FINAL_MS)
  })

  it('middleware 预授权后 Orchestrator hook 不二次弹审批，且上下文不串到后续请求', async () => {
    const policy = await evaluateElectronBrowserCLIPolicy('/browser/eval', {
      _thread_id: 'chat-session-eval',
      expression: 'document.title',
    })

    expect(policy.action).toBe('allow')
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1)
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )

    await runWithBrowserPolicyPreapproval(
      policy.action === 'allow' ? policy.preapprovedActionIds : [],
      async () => {
        await expect(
          electronPolicyHooks.resolveConfirmation?.(EVAL_CONFIRM_DECISION),
        ).resolves.toBe(true)
      },
    )
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1)

    mocks.requestApproval.mockResolvedValueOnce({ approved: false })
    await expect(
      electronPolicyHooks.resolveConfirmation?.(EVAL_CONFIRM_DECISION),
    ).resolves.toBe(false)
    expect(mocks.requestApproval).toHaveBeenCalledTimes(2)
    expect(mocks.requestApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )
  })

  it('batch 审批 detail 展示子动作，预授权范围与展示内容一致', async () => {
    const policy = await evaluateElectronBrowserCLIPolicy('/browser/batch', {
      _thread_id: 'chat-session-batch',
      actions: [
        { type: 'act', actions: [{ type: 'click', selector: '#x' }] },
        { type: 'cookies', action: 'clear' },
      ],
    })

    expect(policy).toEqual({
      action: 'allow',
      preapprovedActionIds: ['batch', 'act', 'cookies.clear'],
    })
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'browser.batch',
        detail: expect.stringContaining('childActions=[act, cookies.clear]'),
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )
  })

  it('act 审批拒绝时返回明确 APPROVAL_DENIED，不进入后续执行', async () => {
    mocks.requestApproval.mockResolvedValueOnce({ approved: false })

    const policy = await evaluateElectronBrowserCLIPolicy('/browser/act', {
      _thread_id: 'chat-session-act',
      actions: [{ type: 'click', selector: 'a' }],
    })

    expect(policy).toEqual({
      action: 'deny',
      status: 403,
      code: 'APPROVAL_DENIED',
      message: '用户拒绝或未确认该浏览器操作',
      detail: { actionType: 'act', reason: '页面写操作（act），需确认' },
    })
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'browser.act',
        detail: 'act: click',
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )
  })

  it('通过 hook context 给两层审批入口注入 threadId，业务请求不携带 threadId', async () => {
    const policy = await evaluateElectronBrowserCLIPolicy('/browser/act', {
      _thread_id: 'chat-session-browser-ctx',
      actions: [{ type: 'click', selector: '#submit' }],
    })

    expect(policy.action).toBe('allow')
    expect(mocks.requestApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionType: 'browser.act',
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )
    expect(mocks.requestApproval.mock.calls.at(-1)?.[0]).not.toHaveProperty('threadId')
    expect(mocks.contexts.at(-1)).toBe('chat-session-browser-ctx')

    mocks.requestApproval.mockClear()
    await runWithBrowserApprovalContext(
      { context: { threadId: 'chat-session-nested-ctx' } },
      async () => {
        await expect(
          electronPolicyHooks.resolveConfirmation?.(EVAL_CONFIRM_DECISION),
        ).resolves.toBe(true)
      },
    )

    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: `browser.${EVAL_CONFIRM_DECISION.actionType}`,
        timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
      }),
    )
    expect(mocks.requestApproval.mock.calls.at(-1)?.[0]).not.toHaveProperty('threadId')
    expect(mocks.contexts.at(-1)).toBe('chat-session-nested-ctx')
  })

  it('scheduled thread 下 browser.act 直接预批准，不弹旧审批框', async () => {
    setRuntimeInteractionMode('chat-session-scheduled', 'scheduled')
    try {
      const policy = await evaluateElectronBrowserCLIPolicy('/browser/act', {
        _thread_id: 'chat-session-scheduled',
        actions: [{ type: 'scroll' }],
      })

      expect(policy).toEqual({
        action: 'allow',
        preapprovedActionIds: ['act'],
      })
      expect(mocks.requestApproval).not.toHaveBeenCalled()
    } finally {
      clearRuntimeInteractionMode('chat-session-scheduled')
    }
  })

  it('scheduled thread 下 Orchestrator 二级确认也直接放行', async () => {
    setRuntimeInteractionMode('chat-session-hook-scheduled', 'scheduled')
    mocks.requestApproval.mockResolvedValueOnce({ approved: false })
    try {
      await runWithBrowserApprovalContext(
        { _thread_id: 'chat-session-hook-scheduled' },
        async () => {
          await expect(
            electronPolicyHooks.resolveConfirmation?.(EVAL_CONFIRM_DECISION),
          ).resolves.toBe(true)
        },
      )

      expect(mocks.requestApproval).not.toHaveBeenCalled()
    } finally {
      clearRuntimeInteractionMode('chat-session-hook-scheduled')
    }
  })

  it('非 scheduled thread 下 Orchestrator 二级确认仍走人工审批', async () => {
    setRuntimeInteractionMode('chat-session-hook-solo', 'solo')
    mocks.requestApproval.mockResolvedValueOnce({ approved: false })
    try {
      await runWithBrowserApprovalContext(
        { _thread_id: 'chat-session-hook-solo' },
        async () => {
          await expect(
            electronPolicyHooks.resolveConfirmation?.(EVAL_CONFIRM_DECISION),
          ).resolves.toBe(false)
        },
      )

      expect(mocks.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: `browser.${EVAL_CONFIRM_DECISION.actionType}`,
          timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
        }),
      )
      expect(mocks.requestApproval.mock.calls.at(-1)?.[0]).not.toHaveProperty('threadId')
    } finally {
      clearRuntimeInteractionMode('chat-session-hook-solo')
    }
  })
})
