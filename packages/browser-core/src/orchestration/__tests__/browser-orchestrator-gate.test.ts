/**
 * BR-9 P1：Orchestrator 统一安全闸门单测。
 *
 * 验证 `handleBrowserAction` 入口闸门（switch 之前）的三态处置：
 *  - block：受限脚本 / 命令硬红线 → 403 POLICY_BLOCKED，**不进执行**。
 *  - confirm：write 动作 → 经 host 的 resolveConfirmation 决断；
 *      true → 放行进入执行；false/undefined（含未注入 policy 的 fail-closed）→ 403 APPROVAL_DENIED，**不进执行**。
 *  - allow：read 动作直通，**不触发** confirm。
 *
 * 用最小 exec hook 作执行探针（vi.fn），断言「闸门挡住时引擎一定没被调」。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  handleBrowserAction,
  type BrowserExecHooks,
  type BrowserExecOutcome,
  type BrowserOrchestratorHostHooks,
} from '../BrowserOrchestrator'

function makeExecHooks(overrides?: Partial<BrowserExecHooks>): BrowserExecHooks {
  return {
    observeLimitDefault: 50,
    async prepareTab() {
      return 'tab-1'
    },
    async runAct(): Promise<BrowserExecOutcome> {
      return { success: true, raw: { executed_actions: [] } }
    },
    async runObserve(): Promise<BrowserExecOutcome> {
      return { success: true, raw: { observed_elements: [], page_url: 'u', page_title: 't' } }
    },
    async runEval(): Promise<BrowserExecOutcome> {
      return { success: true, raw: { result: 'ok' } }
    },
    ...overrides,
  }
}

describe('BR-9 P1 Orchestrator 闸门 — block', () => {
  it('受限脚本（document.cookie）→ 403 POLICY_BLOCKED，引擎不被调', async () => {
    const runEval = vi.fn(async (): Promise<BrowserExecOutcome> => ({ success: true, raw: {} }))
    const resolveConfirmation = vi.fn(async () => true)
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runEval }),
      policy: { resolveConfirmation },
    }
    const result = await handleBrowserAction('eval', { expression: 'return document.cookie' }, hostHooks)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(result && 'ok' in result && !result.ok && result.error.code).toBe('POLICY_BLOCKED')
    expect(runEval).not.toHaveBeenCalled()
    // block 早于 confirm：连 resolveConfirmation 都不该被问。
    expect(resolveConfirmation).not.toHaveBeenCalled()
  })

  it('命令硬红线（rm -rf /）→ 403，即使 policy 放行也拦', async () => {
    const runEval = vi.fn(async (): Promise<BrowserExecOutcome> => ({ success: true, raw: {} }))
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runEval }),
      policy: { resolveConfirmation: async () => true },
    }
    const result = await handleBrowserAction('eval', { code: 'rm -rf /' }, hostHooks)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(result && 'ok' in result && !result.ok && result.error.code).toBe('POLICY_BLOCKED')
    expect(runEval).not.toHaveBeenCalled()
  })
})

describe('BR-9 P1 Orchestrator 闸门 — confirm', () => {
  it('resolveConfirmation=true → 放行进入执行（act 200）', async () => {
    const runAct = vi.fn(
      async (): Promise<BrowserExecOutcome> => ({ success: true, raw: { executed_actions: ['click'] } }),
    )
    const resolveConfirmation = vi.fn(async () => true)
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runAct }),
      policy: { resolveConfirmation },
    }
    const result = await handleBrowserAction(
      'act',
      { actions: [{ type: 'click', selector: '#x' }] },
      hostHooks,
    )
    expect(resolveConfirmation).toHaveBeenCalledTimes(1)
    expect(runAct).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, status: 200 })
  })

  it('resolveConfirmation=false → 403 APPROVAL_DENIED，引擎不被调', async () => {
    const runAct = vi.fn(async (): Promise<BrowserExecOutcome> => ({ success: true, raw: {} }))
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'electron',
      exec: makeExecHooks({ runAct }),
      policy: { resolveConfirmation: async () => false },
    }
    const result = await handleBrowserAction('act', { actions: [{ type: 'click', selector: '#x' }] }, hostHooks)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(result && 'ok' in result && !result.ok && result.error.code).toBe('APPROVAL_DENIED')
    expect(runAct).not.toHaveBeenCalled()
  })

  it('未注入 policy → fail-closed 403 APPROVAL_DENIED', async () => {
    const runAct = vi.fn(async (): Promise<BrowserExecOutcome> => ({ success: true, raw: {} }))
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'electron',
      exec: makeExecHooks({ runAct }),
      // 故意不给 policy
    }
    const result = await handleBrowserAction('act', { actions: [{ type: 'click', selector: '#x' }] }, hostHooks)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(result && 'ok' in result && !result.ok && result.error.code).toBe('APPROVAL_DENIED')
    expect(runAct).not.toHaveBeenCalled()
  })

  it('daemon 默认放行语义：confirm 动作经 always-true policy 不回归（eval 200 直透）', async () => {
    const runEval = vi.fn(async (): Promise<BrowserExecOutcome> => ({ success: true, raw: { result: 42 } }))
    // 复刻 daemonHostHooks.policy 的默认放行
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runEval }),
      policy: { resolveConfirmation: async () => true },
    }
    const result = await handleBrowserAction('eval', { expression: 'document.title' }, hostHooks)
    expect(result).toMatchObject({ ok: true, status: 200, data: { result: 42 } })
    expect(runEval).toHaveBeenCalledTimes(1)
  })
})

describe('BR-9 P1 Orchestrator 闸门 — allow', () => {
  it('read 动作（glance 默认清单）→ 直通执行，不触发 confirm', async () => {
    const resolveConfirmation = vi.fn(async () => true)
    const runObserve = vi.fn(
      async (): Promise<BrowserExecOutcome> => ({
        success: true,
        raw: { observed_elements: [], page_url: 'u', page_title: 't' },
      }),
    )
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runObserve }),
      policy: { resolveConfirmation },
    }
    const result = await handleBrowserAction('glance', { selector: '#x' }, hostHooks)
    expect(resolveConfirmation).not.toHaveBeenCalled()
    expect(runObserve).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, status: 200 })
  })

  it('read 动作（glance）即使未注入 policy 也直通（read 不经 confirm）', async () => {
    const runObserve = vi.fn(
      async (): Promise<BrowserExecOutcome> => ({
        success: true,
        raw: { observed_elements: [], page_url: 'u', page_title: 't' },
      }),
    )
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      exec: makeExecHooks({ runObserve }),
    }
    const result = await handleBrowserAction('glance', { selector: '#x' }, hostHooks)
    expect(runObserve).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, status: 200 })
  })
})
