import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  handleBrowserAction,
  OBSERVE_NO_HREF_HINT,
  LOGIN_REQUIRED_HINT,
  CAPTCHA_REQUIRED_HINT,
  OBSERVE_RESULT_HINT,
  BrowserActionError,
  type BrowserActionResult,
  type BrowserContextInfo,
  type BrowserContextResponse,
  type BrowserExecHooks,
  type BrowserExecOutcome,
  type BrowserObserveParams,
  type BrowserOrchestratorHostHooks,
  type BrowserResourceStreamHooks,
  type BrowserSnapshotRequestParams,
  type BrowserJobHooks,
} from '../BrowserOrchestrator'
import { wrapEvalCode, isParsableExpression } from '../wrapEvalCode'
import {
  projectCapabilitiesForRuntime,
  type BrowserRuntime,
  type CapabilityProjection,
} from '../../capability-matrix'
import { getSharedRefCache, resetSharedRefCache, BrowserJobManager } from '../../runtime'

/**
 * BR-8 「完成即固化」单测：钉住 Orchestrator 的响应形状 / 状态码 / 迁移缝。
 *  - P1：capabilities / context（喂 mock hostHooks 断言形状稳定、runtime 来源正确）。
 *  - P3c：act / observe（喂 mock exec hooks 断言投影形状、ref 回解、校验、状态闸门、守卫错误）。
 */

/**
 * BR-9 P1：这些既有用例聚焦 switch 逻辑（投影/校验/迁移缝），不测安全闸门——
 * 统一注入「放行」policy 让 write 类动作的 confirm 直通，复刻闸门接入前的行为。
 * 闸门本身（block/confirm/allow 三态）由 `browser-orchestrator-gate.test.ts` 专测。
 */
const ALLOW_POLICY = { resolveConfirmation: async () => true } as const

// ── P1：自描述命令 ─────────────────────────────────────────────────

/** 构造一个可控的 mock hostHooks（context 数据完全由测试给定）。 */
function makeHooks(
  runtime: BrowserRuntime,
  info: BrowserContextInfo,
  opts?: { async?: boolean },
): BrowserOrchestratorHostHooks {
  return {
    runtime,
    getContextInfo: opts?.async ? async () => info : () => info,
    policy: ALLOW_POLICY,
  }
}

const SAMPLE_INFO: BrowserContextInfo = {
  source: 'daemon',
  spaceId: 'space-1',
  crawlspaceId: null,
  workspaceRoot: '/tmp/ws',
  activeTab: { id: 'tab-1', url: 'https://example.com', title: '示例' },
  tabCount: 3,
}

describe('handleBrowserAction —— capabilities', () => {
  it('返回当前运行时的能力投影（与共享投影同源、status=200）', async () => {
    for (const runtime of ['electron', 'daemon'] as BrowserRuntime[]) {
      const hooks = makeHooks(runtime, SAMPLE_INFO)
      const result = await handleBrowserAction('capabilities', {}, hooks)
      expect(result).not.toBeNull()
      expect(result!.ok).toBe(true)
      expect(result!.status).toBe(200)
      // 逐字段等于共享投影——证明 capabilities 数据集中到一处、无二次加工。
      const data = (result as { ok: true; data: unknown }).data
      expect(data).toEqual(projectCapabilitiesForRuntime(runtime))
      expect((data as CapabilityProjection).runtime).toBe(runtime)
    }
  })

  it('投影的 runtime 取自 hostHooks.runtime（两端各拿各列）', async () => {
    const electron = await handleBrowserAction('capabilities', {}, makeHooks('electron', SAMPLE_INFO))
    const daemon = await handleBrowserAction('capabilities', {}, makeHooks('daemon', SAMPLE_INFO))
    expect(((electron as { ok: true; data: CapabilityProjection }).data).runtime).toBe('electron')
    expect(((daemon as { ok: true; data: CapabilityProjection }).data).runtime).toBe('daemon')
  })
})

describe('handleBrowserAction —— context', () => {
  it('响应形状唯一：恰好 7 个字段、顺序固定、status=200', async () => {
    const result = await handleBrowserAction('context', {}, makeHooks('daemon', SAMPLE_INFO))
    expect(result!.ok).toBe(true)
    expect(result!.status).toBe(200)
    const data = (result as { ok: true; data: BrowserContextResponse }).data
    const keys = Object.keys(data)
    // 顺序对齐 browser.go 的 context OutputSchema + 两端现状（逐字节对齐的保证）。
    expect(keys).toEqual([
      'runtime',
      'source',
      'spaceId',
      'crawlspaceId',
      'workspaceRoot',
      'activeTab',
      'tabCount',
    ])
  })

  it('runtime 由 hostHooks.runtime 注入，其余字段透传自 getContextInfo()', async () => {
    const result = await handleBrowserAction('context', {}, makeHooks('electron', SAMPLE_INFO))
    expect((result as { ok: true; data: unknown }).data).toEqual({
      runtime: 'electron',
      source: 'daemon', // 故意与 runtime 不一致：证明 source 来自 info、runtime 来自 hooks
      spaceId: 'space-1',
      crawlspaceId: null,
      workspaceRoot: '/tmp/ws',
      activeTab: { id: 'tab-1', url: 'https://example.com', title: '示例' },
      tabCount: 3,
    })
  })

  it('await 异步 getContextInfo（Daemon 需 await 取页面标题）', async () => {
    const result = await handleBrowserAction('context', {}, makeHooks('daemon', SAMPLE_INFO, { async: true }))
    const data = (result as { ok: true; data: BrowserContextResponse }).data
    expect(data.tabCount).toBe(3)
    expect(data.activeTab).toEqual(SAMPLE_INFO.activeTab)
  })

  it('缺 getContextInfo → context 落 null 迁移缝', async () => {
    const result = await handleBrowserAction('context', {}, { runtime: 'daemon' })
    expect(result).toBeNull()
  })
})

// ── P3c：act / observe ─────────────────────────────────────────────

/** 构造一个可控的 mock exec hooks，记录被调用时收到的参数，便于断言。 */
interface ExecCalls {
  preparedBody?: any
  actTabId?: string
  actResolved?: any[]
  observeTabId?: string
  observeParams?: BrowserObserveParams
}

interface SnapshotCalls {
  snapshotBody?: any
  snapshotParams?: BrowserSnapshotRequestParams
}

function makeExecHooks(
  calls: ExecCalls,
  opts: {
    runtime: BrowserRuntime
    tabId?: string | undefined
    prepareError?: BrowserActionError
    actOutcome?: BrowserExecOutcome
    observeOutcome?: BrowserExecOutcome
    snapshotOutcome?: BrowserExecOutcome
    evalOutcome?: BrowserExecOutcome
    observeLimitDefault?: number
    requireNonEmptyActions?: boolean
    snapshotCalls?: SnapshotCalls
    persistScreenshot?: (base64: string, savePath: string | undefined) => Promise<string>
  },
): BrowserOrchestratorHostHooks {
  const exec: BrowserExecHooks = {
    observeLimitDefault: opts.observeLimitDefault ?? 50,
    requireNonEmptyActions: opts.requireNonEmptyActions,
    async prepareTab(body) {
      calls.preparedBody = body
      if (opts.prepareError) throw opts.prepareError
      return opts.tabId
    },
    async runAct(tabId, resolvedActions) {
      calls.actTabId = tabId
      calls.actResolved = resolvedActions
      return opts.actOutcome ?? { success: true, raw: {} }
    },
    async runObserve(tabId, params) {
      calls.observeTabId = tabId
      calls.observeParams = params
      return opts.observeOutcome ?? { success: true, raw: {} }
    },
    async runSnapshot(body, params) {
      if (opts.snapshotCalls) {
        opts.snapshotCalls.snapshotBody = body
        opts.snapshotCalls.snapshotParams = params
      }
      return opts.snapshotOutcome ?? { success: true, raw: { data: {} } }
    },
    async persistSnapshotScreenshot(base64, savePath) {
      return opts.persistScreenshot
        ? opts.persistScreenshot(base64, savePath)
        : `/tmp/${base64.length}-${savePath ?? 'auto'}.png`
    },
    async runEval(tabId, code) {
      calls.actTabId = tabId
      return opts.evalOutcome ?? { success: true, raw: { value: code } }
    },
  }
  return { runtime: opts.runtime, exec, policy: ALLOW_POLICY }
}

describe('handleBrowserAction —— observe 登录墙 surfacing（login_required）', () => {
  beforeEach(() => resetSharedRefCache())

  it('引擎 block 判为 auth_wall 时，observe 投影出 login_required（置首键）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-xhs',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: '#phone', tag: 'input', text: '输入手机号', visible: true, index: 0 }],
          page_url: 'https://www.xiaohongshu.com/explore',
          page_title: '小红书',
          block: { blocked: true, type: 'auth_wall', loginRequired: true, reason: '内容需要登录后才能查看', confidence: 0.9, shouldUpgrade: false },
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(Object.keys(data)[0]).toBe('login_required')
    expect(data.login_required).toEqual({
      reason: '内容需要登录后才能查看',
      hint: LOGIN_REQUIRED_HINT,
      tab_id: 'tab-xhs',
    })
    expect(data.observed_elements).toHaveLength(1)
  })

  it('无 block 时不加 login_required（零行为变更）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      observeOutcome: {
        success: true,
        raw: { observed_elements: [], page_url: 'u', page_title: 't' },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.login_required).toBeUndefined()
  })

  it('反爬类 block（cloudflare）不投影成 login_required', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [],
          page_url: 'u',
          page_title: 't',
          block: { blocked: true, type: 'cloudflare', confidence: 0.8, shouldUpgrade: false },
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.login_required).toBeUndefined()
  })
})

describe('handleBrowserAction —— observe/act 验证码 surfacing（captcha_required）', () => {
  beforeEach(() => resetSharedRefCache())

  it('引擎 captcha.detected 时，observe 投影出 captcha_required', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-google',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: '#recaptcha', tag: 'div', text: '验证', visible: true, index: 0 }],
          page_url: 'https://www.google.com/search?q=agent',
          page_title: '进行人机身份验证',
          captcha: {
            detected: true,
            type: 'recaptcha-v2',
            confidence: 0.9,
            challenge_visible: true,
            suggested_action: 'click-checkbox',
          },
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.captcha_required).toEqual({
      reason: '页面需要完成验证码（recaptcha-v2）',
      hint: CAPTCHA_REQUIRED_HINT,
      type: 'recaptcha-v2',
    })
    expect(Object.keys(data)[0]).toBe('captcha_required')
  })

  it('Electron act 投影保留 captcha_required（不再丢掉）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-google',
      actOutcome: {
        success: true,
        raw: {
          executed_actions: [{ type: 'click', status: 'success' }],
          page_url: 'https://www.google.com/search?q=agent',
          page_title: '进行人机身份验证',
          captcha: {
            detected: true,
            type: 'recaptcha-v2',
            confidence: 0.9,
            challenge_visible: true,
            suggested_action: 'user-intervention',
          },
        },
      },
    })
    const result = await handleBrowserAction(
      'act',
      { actions: [{ type: 'click', selector: '#recaptcha' }] },
      hooks,
    )
    const data = (result as { ok: true; data: any }).data
    expect(data.captcha_required?.type).toBe('recaptcha-v2')
    expect(data.executed_actions).toHaveLength(1)
  })

  it('无 captcha 时不加 captcha_required', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      observeOutcome: {
        success: true,
        raw: { observed_elements: [], page_url: 'u', page_title: 't' },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.captcha_required).toBeUndefined()
  })

  it('glance --screenshot（snapshot compact）保留 captcha_required', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-sorry',
      snapshotOutcome: {
        success: true,
        raw: {
          crawlTabId: 'tab-sorry',
          captcha: {
            detected: true,
            type: 'recaptcha-v2',
            confidence: 0.9,
            challenge_visible: true,
            suggested_action: 'user-intervention',
          },
          data: {
            snapshot: {
              url: 'https://www.google.com/sorry/index',
              title: 'verification',
              accessibility_tree: '- root',
              xpath_map: {},
              screenshot_path: '/tmp/sorry.png',
            },
          },
        },
      },
    })
    const result = await handleBrowserAction(
      'glance',
      { screenshot: true },
      hooks,
    )
    expect(result!.ok).toBe(true)
    const data = (result as { ok: true; data: any }).data
    expect(data.captcha_required?.type).toBe('recaptcha-v2')
    expect(Object.keys(data)[0]).toBe('captcha_required')
    expect(data.screenshot_path).toBe('/tmp/sorry.png')
  })

  it('act 失败但引擎已标 captcha 时，error.detail 带 captcha_required + page_url', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-sorry',
      actOutcome: {
        success: false,
        errorMessage: 'Action timed out',
        raw: {
          executed_actions: [{ type: 'click', status: 'failed' }],
          page_url: 'https://www.google.com/sorry/index',
          captcha: {
            detected: true,
            type: 'recaptcha-v2',
            confidence: 0.9,
            challenge_visible: true,
            suggested_action: 'user-intervention',
            page_url: 'https://www.google.com/sorry/index',
          },
        },
      },
    })
    const result = await handleBrowserAction(
      'act',
      { actions: [{ type: 'click', selector: '#btn' }] },
      hooks,
    )
    expect(result!.ok).toBe(false)
    const err = (result as { ok: false; error: any }).error
    expect(err.detail?.captcha_required?.type).toBe('recaptcha-v2')
    expect(err.detail?.page_url).toBe('https://www.google.com/sorry/index')
  })
})

describe('handleBrowserAction —— observe（形状收敛 + 默认值 + 状态闸门）', () => {
  beforeEach(() => resetSharedRefCache())

  it('成功响应只投影 3 键（+ 可选 som），丢弃引擎多余字段', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'daemon',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: '#a', tag: 'a', text: 't', visible: true, index: 0 }],
          page_url: 'https://e.com',
          page_title: 'E',
    // 以下字段必须被丢弃（与两端现状的稳定字段形状一致）：
          dom_index: 'x',
          frontend_execution_time_ms: 12,
          success: true,
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    expect(result!.ok).toBe(true)
    expect(result!.status).toBe(200)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    // 该用例元素带 text 无 href → 额外触发首键 hint（无 href 条目的 act --ref 用法）。
    expect(Object.keys(data)).toEqual(['hint', 'observed_elements', 'page_url', 'page_title'])
  })

  it('带 som 截图时才追加 som_screenshot_base64', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      observeOutcome: {
        success: true,
        raw: { observed_elements: [], page_url: 'u', page_title: 't', som_screenshot_base64: 'BASE64' },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(Object.keys(data)).toEqual(['hint', 'observed_elements', 'page_url', 'page_title', 'som_screenshot_base64'])
    expect(data.som_screenshot_base64).toBe('BASE64')
  })

  it('观察结果始终在首键提供通用消费契约，无 href 时追加 ref 点击说明', async () => {
    const makeHooks = (elements: any[]) => makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: { observed_elements: elements, page_url: 'https://e.com', page_title: 'E' },
      },
    })

    const withTextOnly = await handleBrowserAction('observe', {}, makeHooks([
      { selector: 'a.nav', tag: 'a', text: 'VClub', visible: true, index: 1, href: 'https://e.com/vclub' },
      { selector: 'div.nav-label', tag: 'div', text: '创投平台', visible: true, index: 2 },
    ]))
    const dataWith = (withTextOnly as { ok: true; data: any }).data
    expect(dataWith.hint).toContain(OBSERVE_RESULT_HINT)
    expect(dataWith.hint).toContain(OBSERVE_NO_HREF_HINT)
    // hint 必须是首键：大响应落盘后 file_ref preview 只露头部。
    expect(Object.keys(dataWith)[0]).toBe('hint')

    const allHref = await handleBrowserAction('observe', {}, makeHooks([
      { selector: 'a.nav', tag: 'a', text: 'VClub', visible: true, index: 1, href: 'https://e.com/vclub' },
    ]))
    const allHrefData = (allHref as { ok: true; data: any }).data
    expect(allHrefData.hint).toBe(OBSERVE_RESULT_HINT)
    expect(Object.keys(allHrefData)[0]).toBe('hint')
  })

  it('BR-27：每个元素注入 eN ref（与 1 基 index 对齐），index 保留为展示序号', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            { selector: 'p > a', tag: 'a', text: 'More', visible: true, index: 1 },
            { selector: '#submit', tag: 'button', text: 'Go', visible: true, index: 2 },
          ],
          page_url: 'https://e.com',
          page_title: 'E',
        },
      },
    })
    // 全字段投影（含 index/selector）需显式 compact=false；默认已是轻量。
    const result = await handleBrowserAction('observe', { compact: false }, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.observed_elements[0]).toMatchObject({ index: 1, ref: 'e1', selector: 'p > a' })
    expect(data.observed_elements[1]).toMatchObject({ index: 2, ref: 'e2', selector: '#submit' })
  })

  it('默认（未传 compact）走轻量投影：浅路径不带 selector/tag/visible，仍注入 ref', async () => {
    const hooks = makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            { selector: 'p > a', tag: 'a', text: 'More', visible: true, index: 1 },
          ],
          page_url: 'https://e.com',
          page_title: 'E',
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const el = (result as { ok: true; data: any }).data.observed_elements[0]
    expect(el).toMatchObject({ ref: 'e1', text: 'More' })
    expect(el.selector).toBeUndefined()
    expect(el.tag).toBeUndefined()
    expect(el.visible).toBeUndefined()
    expect(el.index).toBeUndefined()
  })

  it('#3283：元素上的 href 原样透传（不被投影裁剪）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            { selector: 'a', tag: 'a', text: '笔记', visible: true, index: 1, href: 'https://x.com/n/1?xsec_token=T' },
          ],
          page_url: 'https://x.com/s',
          page_title: 'S',
        },
      },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    const data = (result as { ok: true; data: any }).data
    expect(data.observed_elements[0]).toMatchObject({ ref: 'e1', href: 'https://x.com/n/1?xsec_token=T' })
  })

  it('#5376：class 在全量与 compact 投影里都保留（无文本控件的判读线索）', async () => {
    const calls: ExecCalls = {}
    const makeHooks = () => makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            { selector: 'div.pagination-next', tag: 'div', text: '', role: 'button', visible: true, class: 'pagination-next' },
          ],
          page_url: 'https://e.com/list',
          page_title: 'L',
        },
      },
    })

    const full = await handleBrowserAction('observe', { compact: false }, makeHooks())
    expect((full as { ok: true; data: any }).data.observed_elements[0]).toMatchObject({
      ref: 'e1',
      class: 'pagination-next',
      selector: 'div.pagination-next',
      tag: 'div',
    })

    const compact = await handleBrowserAction('observe', {}, makeHooks())
    const el = (compact as { ok: true; data: any }).data.observed_elements[0]
    expect(el).toMatchObject({ ref: 'e1', class: 'pagination-next' })
    // 浅 selector：默认轻量不带 selector/tag/visible
    expect(el.selector).toBeUndefined()
    expect(el.tag).toBeUndefined()
  })

  it('compact 保留原生表单的 control_type、option_value 与 checked', async () => {
    const calls: ExecCalls = {}
    const makeHooks = () => makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{
            selector: 'input[name="topping"]', tag: 'input', text: 'Bacon', role: 'checkbox', visible: true,
            control_type: 'checkbox', option_value: 'bacon', checked: true,
          }],
          page_url: 'https://e.com/form',
          page_title: 'Form',
        },
      },
    })

    const compact = await handleBrowserAction('observe', { compact: true }, makeHooks())
    expect((compact as { ok: true; data: any }).data.observed_elements[0]).toMatchObject({
      ref: 'e1', text: 'Bacon', role: 'checkbox', control_type: 'checkbox', option_value: 'bacon', checked: true,
    })
  })

  it('#7282：compact 保留深路径 selector（host >>> inner），浅路径仍省略', async () => {
    const calls: ExecCalls = {}
    const makeHooks = () => makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            {
              selector: 'my-host >>> .inner-btn',
              tag: 'button',
              text: 'Shadow 内按钮',
              visible: true,
              index: 1,
            },
            {
              selector: '#shallow-btn',
              tag: 'button',
              text: '浅层按钮',
              visible: true,
              index: 2,
            },
          ],
          page_url: 'https://e.com/shadow',
          page_title: 'Shadow',
        },
      },
    })

    const compact = await handleBrowserAction('observe', { compact: true }, makeHooks())
    const elements = (compact as { ok: true; data: any }).data.observed_elements
    expect(elements[0]).toMatchObject({
      ref: 'e1',
      selector: 'my-host >>> .inner-btn',
      text: 'Shadow 内按钮',
    })
    expect(elements[0].tag).toBeUndefined()
    expect(elements[1]).toMatchObject({ ref: 'e2', text: '浅层按钮' })
    expect(elements[1].selector).toBeUndefined()
    expect(elements[1].tag).toBeUndefined()
  })

  it('BR-27：observe 把 eN→selector（含裸序号别名）写进共享 RefCache，按 tabId 分桶', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'daemon',
      tabId: 'tab-7',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: 'p > a', tag: 'a', text: 'More', visible: true, index: 1 }],
          page_url: 'u',
          page_title: 't',
        },
      },
    })
    await handleBrowserAction('observe', {}, hooks)
    const cache = getSharedRefCache()
    expect(cache.get('tab-7').get('e1')?.selector).toBe('p > a')
    // 裸序号别名：直接吸收 BR-27 dogfood 里 ref:"1" 的写法。
    expect(cache.get('tab-7').get('1')?.selector).toBe('p > a')
  })

  it('iframe 元素的 frameId 只写入 RefCache，不出现在默认 compact glance', async () => {
    const hooks = makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-frame',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{
            selector: '#mobile',
            tag: 'a',
            text: 'QQ手机版',
            visible: true,
            frameId: 'frame-20',
          }],
          page_url: 'https://mail.qq.com',
          page_title: 'QQ邮箱',
        },
      },
    })

    const result = await handleBrowserAction('glance', {}, hooks)
    const data = (result as { ok: true; data: any }).data

    expect(data.observed_elements[0]).toMatchObject({ ref: 'e1', text: 'QQ手机版' })
    expect(data.observed_elements[0].frameId).toBeUndefined()
    expect(getSharedRefCache().get('tab-frame').get('e1')).toMatchObject({
      selector: '#mobile',
      frameId: 'frame-20',
    })
  })

  it('BW-1：observe 写 RefCache 时按 compact 口径归一化 semantic name', async () => {
    const calls: ExecCalls = {}
    const longName = `  ${'Long observe semantic label '.repeat(4)}  `
    const hooks = makeExecHooks(calls, {
      runtime: 'daemon',
      tabId: 'tab-long',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [
            { selector: '#long', tag: 'button', text: longName, visible: true, index: 1 },
          ],
          page_url: 'u',
          page_title: 't',
        },
      },
    })

    await handleBrowserAction('observe', {}, hooks)
    expect(getSharedRefCache().get('tab-long').get('e1')?.semantic).toEqual({
      role: 'button',
      name: longName.trim().slice(0, 60),
      nth: 0,
    })
  })

  it('limit 缺省无上限（ 无损：不注入截断），显式 limit 仍覆盖', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, { runtime: 'daemon', observeLimitDefault: 100 })
    await handleBrowserAction('observe', {}, hooks)
    // 缺省不再注入 observeLimitDefault → limit 为 undefined，底层收集全部元素（无损）
    expect(calls.observeParams!.limit).toBeUndefined()

    const calls2: ExecCalls = {}
    const hooks2 = makeExecHooks(calls2, { runtime: 'daemon', observeLimitDefault: 100 })
    await handleBrowserAction('observe', { limit: 7 }, hooks2)
    expect(calls2.observeParams!.limit).toBe(7)
  })

  it('include_som 兼容 snake_case 与 camelCase，缺省 false', async () => {
    const calls: ExecCalls = {}
    await handleBrowserAction('observe', {}, makeExecHooks(calls, { runtime: 'daemon' }))
    expect(calls.observeParams!.include_som).toBe(false)

    const callsSnake: ExecCalls = {}
    await handleBrowserAction('observe', { include_som: true }, makeExecHooks(callsSnake, { runtime: 'daemon' }))
    expect(callsSnake.observeParams!.include_som).toBe(true)

    const callsCamel: ExecCalls = {}
    await handleBrowserAction('observe', { includeSom: true }, makeExecHooks(callsCamel, { runtime: 'daemon' }))
    expect(callsCamel.observeParams!.include_som).toBe(true)
  })

  it('outcome.success=false → 500 INTERNAL_ERROR（成功闸门端，如 Electron）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      observeOutcome: { success: false, raw: {}, errorMessage: 'boom' },
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    expect(result!.ok).toBe(false)
    expect(result!.status).toBe(500)
    expect((result as { ok: false; error: { code: string; message: string } }).error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'boom',
    })
  })

  it('prepareTab 抛 BrowserActionError → 转成对应状态码的错误结果（如 503 守卫）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'daemon',
      prepareError: new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: 'browser-core 尚未初始化',
        retryable: true,
      }),
    })
    const result = await handleBrowserAction('observe', {}, hooks)
    expect(result!.ok).toBe(false)
    expect(result!.status).toBe(503)
    expect((result as { ok: false; error: { retryable?: boolean } }).error.retryable).toBe(true)
  })

  it('缺 exec → observe 落 null 迁移缝', async () => {
    // observe 已是 glance 的内部管线（contract 无此 id），过闸需 policy 放行。
    const result = await handleBrowserAction('observe', {}, { runtime: 'daemon', policy: ALLOW_POLICY })
    expect(result).toBeNull()
  })
})

describe('handleBrowserAction —— act（校验 + ref 回解 + 投影 + 状态闸门）', () => {
  beforeEach(() => resetSharedRefCache())

  it('actions 非数组 → 400 VALIDATION_ERROR', async () => {
    const calls: ExecCalls = {}
    const result = await handleBrowserAction('act', { actions: 'nope' }, makeExecHooks(calls, { runtime: 'electron' }))
    expect(result!.ok).toBe(false)
    expect(result!.status).toBe(400)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('fill 校验先于安全策略，非法请求直接返回 400', async () => {
    const calls: ExecCalls = {}
    const { exec } = makeExecHooks(calls, { runtime: 'electron' })
    const result = await handleBrowserAction('act', { actions: [{ type: 'fill' }] }, { runtime: 'electron', exec })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(calls.actResolved).toBeUndefined()
  })

  it.each([
    [{ type: 'FILL', value: 'A', text: 'B' }],
    [{ type: 'FILL', text: 1 }],
  ])('大小写混用的 fill 非法参数同样在审批前返回 400（%o）', async (action) => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, { runtime: 'electron' })
    const resolveConfirmation = vi.fn(async () => true)
    hooks.policy = { resolveConfirmation }

    const result = await handleBrowserAction('act', { actions: [action] }, hooks)

    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(resolveConfirmation).not.toHaveBeenCalled()
    expect(calls.actResolved).toBeUndefined()
  })

  it('大小写混用的 FILL 在审批前归一 text 别名后交给执行器', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: { success: true, raw: { executed_actions: [] } },
    })
    const resolveConfirmation = vi.fn(async () => true)
    hooks.policy = { resolveConfirmation }

    const result = await handleBrowserAction('act', { actions: [{ type: 'FILL', text: '张三' }] }, hooks)

    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(calls.actResolved).toEqual([{ type: 'fill', value: '张三' }])
    expect(resolveConfirmation).toHaveBeenCalledTimes(1)
  })

  it('空数组：requireNonEmptyActions 端拒绝（400）/ 放行端继续执行', async () => {
    // Daemon 口径：拒绝空数组。
    const callsDaemon: ExecCalls = {}
    const reject = await handleBrowserAction('act', { actions: [] }, makeExecHooks(callsDaemon, {
      runtime: 'daemon', requireNonEmptyActions: true,
    }))
    expect(reject!.ok).toBe(false)
    expect(reject!.status).toBe(400)

    // Electron 口径：放行空数组 → 走到执行。
    const callsElectron: ExecCalls = {}
    const pass = await handleBrowserAction('act', { actions: [] }, makeExecHooks(callsElectron, {
      runtime: 'electron',
      actOutcome: { success: true, raw: { executed_actions: [], page_url: 'u', page_title: 't' } },
    }))
    expect(pass!.ok).toBe(true)
    expect(callsElectron.actResolved).toEqual([])
  })

  it('ref/toRef 经共享 RefCache 回解后才交给 runAct（按 prepareTab 返回的 tabId 分桶）', async () => {
    getSharedRefCache().replace('tab-1', [['e1', { selector: '#btn' }]])
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-1',
      actOutcome: { success: true, raw: { executed_actions: [], page_url: 'u', page_title: 't' } },
    })
    await handleBrowserAction('act', { actions: [{ type: 'click', ref: 'e1' }] }, hooks)
    expect(calls.actTabId).toBe('tab-1')
    expect(calls.actResolved).toEqual([{ type: 'click', ref: 'e1', selector: '#btn' }])
  })

  it('tabId 为空时按 __default 分桶回解', async () => {
    getSharedRefCache().replace('__default', [['e2', { selector: '#x' }]])
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: undefined,
      actOutcome: { success: true, raw: {} },
    })
    await handleBrowserAction('act', { actions: [{ type: 'click', ref: 'e2' }] }, hooks)
    expect(calls.actResolved).toEqual([{ type: 'click', ref: 'e2', selector: '#x' }])
  })

  it('BR-27：observe 后 act --ref eN / --ref "N" 都回解出 selector（dogfood 闭环）', async () => {
    // 先 observe（同一 tab）填共享 RefCache：e1 + 裸序号别名 "1"。
    await handleBrowserAction('observe', {}, makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-1',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: 'p > a', tag: 'a', text: 'More', visible: true, index: 1 }],
          page_url: 'u',
          page_title: 't',
        },
      },
    }))

    // canonical：ref:"e1" → selector + refSemantic（与 snapshot eN 同一套）。
    const c1: ExecCalls = {}
    await handleBrowserAction('act', { actions: [{ type: 'click', ref: 'e1' }] }, makeExecHooks(c1, {
      runtime: 'electron',
      tabId: 'tab-1',
      actOutcome: { success: true, raw: { executed_actions: [], page_url: 'u', page_title: 't' } },
    }))
    expect(c1.actResolved).toEqual([{
      type: 'click',
      ref: 'e1',
      selector: 'p > a',
      refSemantic: { role: 'link', name: 'More', nth: 0 },
    }])

    // 防御性：ref:"1"（dogfood 的原始误写）也回解，不再落 "requires selector or coordinates"。
    const c2: ExecCalls = {}
    await handleBrowserAction('act', { actions: [{ type: 'click', ref: '1' }] }, makeExecHooks(c2, {
      runtime: 'electron',
      tabId: 'tab-1',
      actOutcome: { success: true, raw: {} },
    }))
    expect(c2.actResolved).toEqual([{
      type: 'click',
      ref: '1',
      selector: 'p > a',
      refSemantic: { role: 'link', name: 'More', nth: 0 },
    }])
  })

  it('iframe glance 后 act --ref 把 selector、semantic 和 frameId 一起交给执行器', async () => {
    await handleBrowserAction('glance', {}, makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-iframe',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{
            selector: '#mobile',
            tag: 'a',
            role: 'link',
            text: 'QQ手机版',
            visible: true,
            frameId: 'frame-20',
          }],
          page_url: 'https://mail.qq.com',
          page_title: 'QQ邮箱',
        },
      },
    }))

    const calls: ExecCalls = {}
    await handleBrowserAction(
      'act',
      { actions: [{ type: 'click', ref: 'e1' }] },
      makeExecHooks(calls, {
        runtime: 'electron',
        tabId: 'tab-iframe',
        actOutcome: { success: true, raw: {} },
      }),
    )

    expect(calls.actResolved).toEqual([{
      type: 'click',
      ref: 'e1',
      selector: '#mobile',
      frameId: 'frame-20',
      refSemantic: { role: 'link', name: 'QQ手机版', nth: 0 },
    }])
  })

  it('Electron 投影：内嵌观察字段透传（observed_elements / observe_status / hint / login_required）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: {
        success: true,
        raw: {
          executed_actions: [{ type: 'click', selector: '#next', status: 'success' }],
          page_url: 'https://e.com/page/2',
          page_title: 'Page 2',
          observed_elements: [{ ref: 'e1', role: 'link', text: 'Next', href: 'https://e.com/page/3' }],
          observe_status: 'ok',
          hint: '浏览器观察结果的可交互元素位于 observed_elements',
          login_required: { reason: '需要登录', hint: LOGIN_REQUIRED_HINT },
          // 仍应被丢弃：
          success: true,
          frontend_execution_time_ms: 12,
          block: { blocked: false },
        },
      },
    })
    const result = await handleBrowserAction('act', { actions: [{ type: 'click', ref: 'e1' }] }, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data.executed_actions).toHaveLength(1)
    expect(data.page_url).toBe('https://e.com/page/2')
    expect(data.page_title).toBe('Page 2')
    expect(data.observed_elements).toEqual([
      { ref: 'e1', role: 'link', text: 'Next', href: 'https://e.com/page/3' },
    ])
    expect(data.observe_status).toBe('ok')
    expect(data.hint).toBe('浏览器观察结果的可交互元素位于 observed_elements')
    expect(data.login_required).toEqual({ reason: '需要登录', hint: LOGIN_REQUIRED_HINT })
    expect(data.success).toBeUndefined()
    expect(data.frontend_execution_time_ms).toBeUndefined()
    expect(data.block).toBeUndefined()
  })

  it('Electron 投影：无观察字段时不凭空添加 observe_status', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: {
        success: true,
        raw: {
          executed_actions: [{ type: 'click', selector: '#btn', status: 'success' }],
          page_url: 'https://e.com',
          page_title: 'E',
        },
      },
    })
    const result = await handleBrowserAction('act', { actions: [{ type: 'click', selector: '#btn' }] }, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data.observe_status).toBeUndefined()
    expect(data.observed_elements).toBeUndefined()
    expect(data.hint).toBeUndefined()
    expect(data.login_required).toBeUndefined()
  })

  it('Electron 投影：收窄到 6 键子集（+ loop_warning），丢弃引擎多余字段', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: {
        success: true,
        raw: {
          executed_actions: [{ type: 'click', selector: '#b', status: 'success' }],
          page_url: 'u',
          page_title: 't',
          snapshot: { accessibility_tree: 'a', xpath_map: {} },
          diff: { hasChanges: false },
          loop_warning: 'careful',
          // 必须被丢弃：
          success: true,
          frontend_execution_time_ms: 9,
          block: { blocked: false },
        },
      },
    })
    const result = await handleBrowserAction('act', { actions: [{ type: 'click', selector: '#b' }] }, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(Object.keys(data).sort()).toEqual(
      ['executed_actions', 'page_url', 'page_title', 'snapshot', 'diff', 'loop_warning'].sort(),
    )
  })

  it('Daemon 投影：直透引擎全量结果（现状形状差异，迁移缝忠实复刻）', async () => {
    const calls: ExecCalls = {}
    const raw = {
      success: true,
      executed_actions: [],
      frontend_execution_time_ms: 9,
      page_url: 'u',
      page_title: 't',
      block: { blocked: false },
    }
    const hooks = makeExecHooks(calls, { runtime: 'daemon', actOutcome: { success: true, raw } })
    const result = await handleBrowserAction('act', { actions: [{ type: 'click' }] }, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data).toEqual(raw)
  })

  it.each(['electron', 'daemon'] as BrowserRuntime[])(
    '%s 将 fill.text 归一为 value，并在成功响应携带兼容 warning',
    async (runtime) => {
      const calls: ExecCalls = {}
      const raw = runtime === 'daemon'
        ? { success: true, executed_actions: [], frontend_execution_time_ms: 9, page_url: 'u', page_title: 't' }
        : { executed_actions: [], page_url: 'u', page_title: 't' }
      const result = await handleBrowserAction('act', { actions: [{ type: 'fill', text: '张三' }] }, makeExecHooks(calls, {
        runtime,
        actOutcome: { success: true, raw },
      }))

      expect(calls.actResolved).toEqual([{ type: 'fill', value: '张三' }])
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        data: {
          compatibility_warnings: [{
            action_index: 0,
            code: 'FILL_TEXT_ALIAS',
            message: expect.any(String),
          }],
        },
      })
      if (runtime === 'daemon') {
        expect((result as { ok: true; data: Record<string, unknown> }).data).toMatchObject(raw)
      }
    },
  )

  it.each(['electron', 'daemon'] as BrowserRuntime[])(
    '%s 将 type.text 归一为 value，并携带 TYPE_TEXT_ALIAS warning',
    async (runtime) => {
      const calls: ExecCalls = {}
      const raw = runtime === 'daemon'
        ? { success: true, executed_actions: [], frontend_execution_time_ms: 9, page_url: 'u', page_title: 't' }
        : { executed_actions: [], page_url: 'u', page_title: 't' }
      const result = await handleBrowserAction(
        'act',
        { actions: [{ type: 'type', ref: 'e1', text: '张三' }] },
        makeExecHooks(calls, { runtime, actOutcome: { success: true, raw } }),
      )

      expect(calls.actResolved).toEqual([{ type: 'type', ref: 'e1', value: '张三' }])
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        data: {
          compatibility_warnings: [{
            action_index: 0,
            code: 'TYPE_TEXT_ALIAS',
            message: expect.any(String),
          }],
        },
      })
    },
  )

  it('outcome.success=false → 500（成功闸门端）', async () => {
    const calls: ExecCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: { success: false, raw: {}, errorMessage: 'act failed' },
    })
    const result = await handleBrowserAction('act', { actions: [{ type: 'click' }] }, hooks)
    expect(result!.ok).toBe(false)
    expect(result!.status).toBe(500)
    expect((result as { ok: false; error: { message: string } }).error.message).toBe('act failed')
  })

  it('Electron 失败执行保留可消费的 executed_actions 表单诊断', async () => {
    const calls: ExecCalls = {}
    const executedActions = [{
      type: 'select',
      selector: '#tier',
      status: 'failed',
      error_code: 'invalid_parameter',
      actual_value: '',
      control_value: '',
    }]
    const result = await handleBrowserAction('act', { actions: [{ type: 'select', selector: '#tier', value: 'pro' }] }, makeExecHooks(calls, {
      runtime: 'electron',
      actOutcome: {
        success: false,
        raw: { executed_actions: executedActions, page_url: 'u', page_title: 't' },
        errorMessage: 'Action execution failed',
      },
    }))

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: {
        detail: { executed_actions: executedActions },
      },
    })
  })

  it('缺 exec → act 落 null 迁移缝', async () => {
    const result = await handleBrowserAction('act', { actions: [] }, { runtime: 'daemon', policy: ALLOW_POLICY })
    expect(result).toBeNull()
  })
})

describe('handleBrowserAction —— snapshot（默认值 + compact + RefCache）', () => {
  const MINI_TREE = [
    'RootWebArea "T"',
    '  link "Go"',
  ].join('\n')

  beforeEach(() => resetSharedRefCache())

  it('compact=false 时 include_dom 默认 true', async () => {
    const snapCalls: SnapshotCalls = {}
    const hooks = makeExecHooks({}, {
      runtime: 'electron',
      snapshotCalls: snapCalls,
      snapshotOutcome: {
        success: true,
        raw: {
          data: {
            snapshot: {
              url: 'https://e.com',
              title: 'E',
              accessibility_tree: MINI_TREE,
              xpath_map: {},
            },
          },
          crawlTabId: 'tab-1',
        },
      },
    })
    await handleBrowserAction('snapshot', {}, hooks)
    expect(snapCalls.snapshotParams!.include_dom).toBe(true)
    expect(snapCalls.snapshotParams!.include_accessibility_tree).toBe(true)
  })

  it('接受 CLI 暴露的 raw/clean HTML flag 别名', async () => {
    const snapCalls: SnapshotCalls = {}
    const hooks = makeExecHooks({}, {
      runtime: 'electron',
      snapshotCalls: snapCalls,
      snapshotOutcome: {
        success: true,
        raw: {
          data: {
            snapshot: {
              url: 'https://e.com',
              title: 'E',
              accessibility_tree: MINI_TREE,
              xpath_map: {},
            },
          },
          crawlTabId: 'tab-1',
        },
      },
    })
    await handleBrowserAction('snapshot', { rawHtml: true, clean_html: true }, hooks)
    expect(snapCalls.snapshotParams!.include_raw_html).toBe(true)
    expect(snapCalls.snapshotParams!.include_clean_html).toBe(true)
  })

  it('compact=true 时 include_dom 默认 false，并回 {compact, elementCount} + 填 RefCache', async () => {
    const snapCalls: SnapshotCalls = {}
    const hooks = makeExecHooks({}, {
      runtime: 'daemon',
      snapshotCalls: snapCalls,
      snapshotOutcome: {
        success: true,
        raw: {
          data: {
            snapshot: {
              url: 'https://d.com',
              title: 'D',
              accessibility_tree: MINI_TREE,
              xpath_map: {},
            },
          },
          crawlTabId: 'tab-9',
        },
      },
    })
    const result = await handleBrowserAction('snapshot', { compact: true }, hooks)
    expect(snapCalls.snapshotParams!.include_dom).toBe(false)
    expect(result!.ok).toBe(true)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data.compact).toBeTypeOf('string')
    expect(data.elementCount).toBeGreaterThan(0)
    expect(getSharedRefCache().get('tab-9').size).toBeGreaterThan(0)
  })

  it('compact=false（全量/回退）也把 {bN} 句柄登记进 RefCache，act --ref bN 可解析（page model 一套寻址）', async () => {
    const calls: ExecCalls = {}
    const TREE = [
      '[RootWebArea] News {b1}',
      '[link] Hacker News {b10}',
      '[button] Submit {b12}',
    ].join('\n')
    const MAP = { '1': '/html[1]', '10': '/html[1]/body[1]/a[1]', '12': '/html[1]/body[1]/button[1]' }
    const hooks = makeExecHooks(calls, {
      runtime: 'electron',
      tabId: 'tab-b',
      snapshotOutcome: {
        success: true,
        raw: {
          data: { snapshot: { url: 'u', title: 't', accessibility_tree: TREE, xpath_map: MAP } },
          crawlTabId: 'tab-b',
        },
      },
    })

    const snapResult = await handleBrowserAction('snapshot', { compact: false }, hooks)
    expect(snapResult!.ok).toBe(true)
    // 全量响应契约不变（仍返回 snapshot 子键），但 RefCache 已按 bN 登记
    const cache = getSharedRefCache().get('tab-b')
    expect(cache.get('b10')?.selector).toBe('xpath=/html[1]/body[1]/a[1]')
    expect(cache.get('b12')?.selector).toBe('xpath=/html[1]/body[1]/button[1]')

    // Agent 从 a11y 树照抄 {b10} → act --ref b10 回解为精确 xpath selector（此前必报 requires selector）
    await handleBrowserAction('act', { actions: [{ type: 'click', ref: 'b10' }] }, hooks)
    expect(calls.actResolved?.[0]?.selector).toBe('xpath=/html[1]/body[1]/a[1]')
  })

  it('Daemon 降级路径直透 data、不经 compact', async () => {
    const hooks = makeExecHooks({}, {
      runtime: 'daemon',
      snapshotOutcome: {
        success: true,
        raw: { degraded: true, data: { url: 'u', title: 't', text: 'x' } },
      },
    })
    const result = await handleBrowserAction('snapshot', { compact: true }, hooks)
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data).toEqual({ url: 'u', title: 't', text: 'x' })
  })

  it('缺 runSnapshot → null 迁移缝', async () => {
    // snapshot 已是 glance 的内部管线（contract 无此 id），过闸需 policy 放行。
    const result = await handleBrowserAction('snapshot', {}, { runtime: 'daemon', policy: ALLOW_POLICY })
    expect(result).toBeNull()
  })
})

describe('handleBrowserAction —— glance（observe/snapshot 统一入口的 flag 翻译）', () => {
  beforeEach(() => resetSharedRefCache())

  const MINI_TREE = [
    'RootWebArea "T"',
    '  link "Go"',
  ].join('\n')

  it('默认（无 flag）→ 走 observe 管线，回轻量元素清单', async () => {
    const calls: ObserveCalls = {}
    const hooks = makeExecHooks(calls, {
      runtime: 'daemon',
      observeOutcome: {
        success: true,
        raw: {
          observed_elements: [{ selector: '#a', tag: 'a', role: 'link', text: 'A', visible: true, index: 1 }],
          page_url: 'u',
          page_title: 't',
        },
      },
    })
    const result = await handleBrowserAction('glance', {}, hooks)
    expect(result!.ok).toBe(true)
    const data = (result as { ok: true; data: any }).data
    expect(Array.isArray(data.observed_elements)).toBe(true)
    expect(data.observed_elements[0]).toMatchObject({ ref: 'e1', role: 'link', text: 'A' })
    expect(data.observed_elements[0].selector).toBeUndefined()
    expect(data.observed_elements[0].tag).toBeUndefined()
  })

  it('--tree → 走 snapshot 管线（compact=false、include_dom=true、不吐 HTML）', async () => {
    const snapCalls: SnapshotCalls = {}
    const hooks = makeExecHooks({}, {
      runtime: 'daemon',
      snapshotCalls: snapCalls,
      snapshotOutcome: {
        success: true,
        raw: {
          data: {
            snapshot: { url: 'https://d.com', title: 'D', accessibility_tree: MINI_TREE, xpath_map: {} },
          },
          crawlTabId: 'tab-2',
        },
      },
    })
    const result = await handleBrowserAction('glance', { tree: true }, hooks)
    expect(result!.ok).toBe(true)
    expect(snapCalls.snapshotParams!.include_dom).toBe(true)
    expect(snapCalls.snapshotParams!.include_raw_html).toBe(false)
    expect(snapCalls.snapshotParams!.include_clean_html).toBe(false)
    // compact=false → 全量数据（含 accessibility_tree），不是 {compact,...} 紧凑响应
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect((data as any).snapshot?.accessibility_tree ?? (data as any).accessibility_tree).toBeDefined()
  })

  it('--screenshot → 走 snapshot 紧凑管线并带 include_screenshot；--save 映射为 save_path', async () => {
    const snapCalls: SnapshotCalls = {}
    const hooks = makeExecHooks({}, {
      runtime: 'daemon',
      snapshotCalls: snapCalls,
      snapshotOutcome: {
        success: true,
        raw: {
          data: {
            snapshot: { url: 'https://d.com', title: 'D', accessibility_tree: MINI_TREE, xpath_map: {} },
          },
          crawlTabId: 'tab-3',
        },
      },
    })
    const result = await handleBrowserAction('glance', { screenshot: true, save: '/tmp/g.png' }, hooks)
    expect(result!.ok).toBe(true)
    expect(snapCalls.snapshotBody!.include_screenshot).toBe(true)
    expect(snapCalls.snapshotBody!.save_path).toBe('/tmp/g.png')
    // 纯截图模式默认轻量（compact 管线），不倒灌全量树
    expect(snapCalls.snapshotParams!.include_dom).toBe(false)
  })
})

describe('handleBrowserAction —— eval（校验 + 两端差异）', () => {
  it('缺 expression：Electron / Daemon 各用各的校验文案', async () => {
    const e = await handleBrowserAction('eval', {}, makeExecHooks({}, { runtime: 'electron' }))
    expect((e as { ok: false; error: { message: string } }).error.message).toBe('缺少 expression 参数')

    const d = await handleBrowserAction('eval', {}, makeExecHooks({}, { runtime: 'daemon' }))
    expect((d as { ok: false; error: { message: string } }).error.message).toBe('缺少 expression 或 code 参数')
  })

  it('Electron → electron-executor 桥（dataOverride）', async () => {
    const hooks = makeExecHooks({}, {
      runtime: 'electron',
      tabId: 'tab-e',
      evalOutcome: { success: true, raw: { success: true, data: { x: 1 }, noise: true } },
    })
    const result = await handleBrowserAction('eval', { expression: '1+1' }, hooks)
    expect(result).toMatchObject({
      kind: 'electron-executor',
      dataOverride: { x: 1 },
    })
  })

  it('Daemon 恒 200 直透 raw', async () => {
    const raw = { result: 'ok', logs: [] }
    const hooks = makeExecHooks({}, {
      runtime: 'daemon',
      evalOutcome: { success: true, raw },
    })
    const result = await handleBrowserAction('eval', { code: '1' }, hooks)
    expect(result!.ok).toBe(true)
    expect((result as { ok: true; data: unknown }).data).toEqual(raw)
  })

  it('缺 runEval → null 迁移缝', async () => {
    const exec: BrowserExecHooks = {
      observeLimitDefault: 50,
      async prepareTab() {
        return undefined
      },
      async runAct() {
        return { success: true, raw: {} }
      },
      async runObserve() {
        return { success: true, raw: {} }
      },
    }
    const result = await handleBrowserAction('eval', { code: '1' }, { runtime: 'daemon', exec, policy: ALLOW_POLICY })
    expect(result).toBeNull()
  })
})

// ── P3c 收尾：record / replay / run（session hooks）─────────────────

describe('handleBrowserAction —— record/replay/run（session hooks 分发 + 状态码决策）', () => {
  const SESSION_CASES: Array<[string, keyof NonNullable<BrowserOrchestratorHostHooks['session']>]> = [
    ['record.start', 'recordStart'],
    ['record.stop', 'recordStop'],
    ['record.status', 'recordStatus'],
    ['replay.run', 'replayRun'],
    ['replay.list', 'replayList'],
    ['run.start', 'runStart'],
    ['run.end', 'runEnd'],
    ['run.status', 'runStatus'],
    ['run.list', 'runList'],
  ]

  it('成功：hook 返回的响应体原样下发（不投影形状）、status=200', async () => {
    for (const [actionId, method] of SESSION_CASES) {
      // 两端形状不同：这里给一个 daemon 风格的响应体，断言被原样透传。
      const payload = { runId: 'r1', actionCount: 3, foo: { nested: true } }
      const hooks: BrowserOrchestratorHostHooks = {
        runtime: 'daemon',
        session: { [method]: async () => payload },
        policy: ALLOW_POLICY,
      }
      const result = await handleBrowserAction(actionId, { runId: 'r1' }, hooks)
      expect(result, actionId).not.toBeNull()
      expect(result!.ok, actionId).toBe(true)
      expect(result!.status, actionId).toBe(200)
      expect((result as { ok: true; data: unknown }).data, actionId).toEqual(payload)
    }
  })

  it('缺对应 hook → 落 null 迁移缝（如 Daemon 无 run.* → 维持现状 404 由 route 兜底）', async () => {
    // session 为空对象：每个 action 都缺自己的 hook。
    for (const [actionId] of SESSION_CASES) {
      const result = await handleBrowserAction(actionId, {}, { runtime: 'daemon', session: {}, policy: ALLOW_POLICY })
      expect(result, actionId).toBeNull()
    }
    // 完全无 session：同样落 null。
    for (const [actionId] of SESSION_CASES) {
      const result = await handleBrowserAction(actionId, {}, { runtime: 'electron', policy: ALLOW_POLICY })
      expect(result, actionId).toBeNull()
    }
  })

  it('hook 抛 BrowserActionError → 转成对应状态码的错误结果（缺 runId 400 / 未找到 404 / 冲突 409）', async () => {
    const cases: Array<[number, string]> = [
      [400, 'VALIDATION_ERROR'],
      [404, 'NOT_FOUND'],
      [409, 'VALIDATION_ERROR'],
      [503, 'INTERNAL_ERROR'],
    ]
    for (const [status, code] of cases) {
      const hooks: BrowserOrchestratorHostHooks = {
        runtime: 'daemon',
        session: {
          replayRun: async () => {
            throw new BrowserActionError(status, { code, message: `boom-${status}`, retryable: status === 503 })
          },
        },
        policy: ALLOW_POLICY,
      }
      const result = await handleBrowserAction('replay.run', {}, hooks)
      expect(result!.ok).toBe(false)
      expect(result!.status).toBe(status)
      const err = (result as { ok: false; error: { code: string; message: string } }).error
      expect(err.code).toBe(code)
      expect(err.message).toBe(`boom-${status}`)
    }
  })

  it('hook 抛非结构化异常 → 透传（保留 Electron run.* 由 route handleRouteError 兜底的现状）', async () => {
    const hooks: BrowserOrchestratorHostHooks = {
      runtime: 'electron',
      session: {
        runStart: async () => {
          throw new Error('quota exceeded')
        },
      },
      policy: ALLOW_POLICY,
    }
    await expect(handleBrowserAction('run.start', {}, hooks)).rejects.toThrow('quota exceeded')
  })
})

describe('wrapEvalCode', () => {
  it('单表达式不改动', () => {
    expect(wrapEvalCode('document.title')).toBe('document.title')
  })

  it('多语句末行补 return', () => {
    expect(wrapEvalCode('const x = 1\nx + 2')).toContain('return x + 2')
  })

  // ：async IIFE / Promise 链是表达式，内部的 `;`/`return` 不该触发
  // 「多语句已有 return」误判——必须原样透传给 evalTool 按表达式补 return。
  it('async IIFE（内部含 ; 与 return）按表达式原样透传', () => {
    const code = "(async () => { const r = []; r.push(1); return JSON.stringify(r); })()"
    expect(wrapEvalCode(code)).toBe(code)
  })

  it('Promise 链（回调体含 ; 与 return）按表达式原样透传', () => {
    const code = "fetch('/api').then(r => r.json()).then(d => { window.__x = d; return d.len; })"
    expect(wrapEvalCode(code)).toBe(code)
  })

  it('多语句末行为函数调用时补 return（嵌套 return 不再豁免）', () => {
    const wrapped = wrapEvalCode('const f = () => { return 1; }\nf()')
    expect(wrapped).toContain('return f()')
  })

  it('末行补 return 后语法不合法则保持原样（末行是语句中段）', () => {
    const code = 'const x = foo(\n  1\n)'
    expect(wrapEvalCode(code)).toBe(code)
  })
})

describe('isParsableExpression', () => {
  it.each([
    'document.title',
    '(async () => { const a = 1; return a; })()',
    "fetch('/x').then(r => r.json())",
    '{ a: 1 }',
  ])('表达式：%s', (code) => {
    expect(isParsableExpression(code)).toBe(true)
  })

  it.each([
    'const x = 1; x + 2',
    'const x = 1\nx + 2',
    'if (a) { b() }',
    'return 1',
  ])('非表达式：%s', (code) => {
    expect(isParsableExpression(code)).toBe(false)
  })

  it('行尾注释不吞收尾括号', () => {
    expect(isParsableExpression('1 + 1 // comment')).toBe(true)
  })
})

// ── P3c③：resource / stream ────────────────────────────────────────

describe('handleBrowserAction —— resource/stream（分发 + 迁移缝 + 守卫错误归一）', () => {
  const RESOURCE_STREAM_CASES: Array<[string, keyof BrowserResourceStreamHooks]> = [
    ['resource.list', 'runResourceList'],
    ['resource.probe', 'runResourceProbe'],
    ['resource.inspect', 'runResourceInspect'],
    ['resource.capture', 'runResourceCapture'],
    ['resource.download', 'runResourceDownload'],
    ['resource.smart-download', 'runResourceSmartDownload'],
    ['stream.parse', 'runStreamParse'],
    ['stream.info', 'runStreamInfo'],
    ['stream.download', 'runStreamDownload'],
  ]

  function makeResourceHooks(
    runtime: BrowserRuntime,
    impl: Partial<Record<keyof BrowserResourceStreamHooks, (body: any) => Promise<BrowserActionResult>>>,
  ): BrowserOrchestratorHostHooks {
    return { runtime, resourceStream: impl as BrowserResourceStreamHooks }
  }

  it('每个 action 分发到对应 hook、原样返回其 BrowserActionResult，body 透传', async () => {
    for (const [actionId, hookName] of RESOURCE_STREAM_CASES) {
      let received: unknown
      const expected: BrowserActionResult = { ok: true, status: 200, data: { from: actionId } }
      const hooks = makeResourceHooks('daemon', {
        [hookName]: async (body: any) => { received = body; return expected },
      })
      const result = await handleBrowserAction(actionId, { marker: actionId }, hooks)
      expect(result, actionId).toEqual(expected)
      expect(received, actionId).toEqual({ marker: actionId })
    }
  })

  it('缺对应 hook → 落 null 迁移缝（仅命中的那个 action 被接管）', async () => {
    for (const [actionId] of RESOURCE_STREAM_CASES) {
      // 完全没有 resourceStream → null
      expect(await handleBrowserAction(actionId, {}, { runtime: 'daemon' }), actionId).toBeNull()
      // 只提供 runResourceList → 除 resource.list 外其余仍 null
      const partial = makeResourceHooks('daemon', {
        runResourceList: async () => ({ ok: true, status: 200, data: {} }),
      })
      const r2 = await handleBrowserAction(actionId, {}, partial)
      if (actionId === 'resource.list') {
        expect(r2!.ok).toBe(true)
      } else {
        expect(r2, actionId).toBeNull()
      }
    }
  })

  it('hook 抛 BrowserActionError → 归一成对应状态码的错误结果（如 404 资源不存在）', async () => {
    const hooks = makeResourceHooks('daemon', {
      runStreamDownload: async () => {
        throw new BrowserActionError(404, { code: 'NOT_FOUND', message: '资源 r-1 不存在或无 URL' })
      },
    })
    const result = await handleBrowserAction('stream.download', { resourceId: 'r-1' }, hooks)
    expect(result!.ok).toBe(false)
    expect(result!.status).toBe(404)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('hook 抛非 BrowserActionError → 透传（不被守卫归一吞掉）', async () => {
    const hooks = makeResourceHooks('daemon', {
      runResourceProbe: async () => { throw new Error('engine boom') },
    })
    await expect(handleBrowserAction('resource.probe', {}, hooks)).rejects.toThrow('engine boom')
  })

  it('resourceStream 与 exec(act/observe) 解耦：只提供 resourceStream 也能分发，act 仍落 null', async () => {
    const hooks: BrowserOrchestratorHostHooks = {
      runtime: 'electron',
      resourceStream: {
        runResourceList: async () => ({
          kind: 'electron-executor',
          executorResult: { success: true, data: { resources: [] } },
        }),
      },
      policy: ALLOW_POLICY,
    }
    // resource.list 经独立注入点分发，透出 electron-executor 桥变体
    expect(await handleBrowserAction('resource.list', {}, hooks)).toEqual({
      kind: 'electron-executor',
      executorResult: { success: true, data: { resources: [] } },
    })
    // 未提供 exec → act 落 null（证明两注入点独立、互不牵连）
    expect(await handleBrowserAction('act', { actions: [] }, hooks)).toBeNull()
  })

  it('hook 返回的 ok/error 结果（含 detail/suggestions）原样透出，Orchestrator 不加工', async () => {
    const errResult: BrowserActionResult = {
      ok: false,
      status: 404,
      error: { code: 'NO_MEDIA_FOUND', message: '页面上未发现可下载的媒体资源', detail: { candidateCount: 0, probed: true }, suggestions: ['确保页面上有视频/音频内容'] },
    }
    const hooks = makeResourceHooks('daemon', { runResourceSmartDownload: async () => errResult })
    const result = await handleBrowserAction('resource.smart-download', {}, hooks)
    expect(result).toEqual(errResult)
  })
})

// ── P2：job 异步执行 + 取消（BR-10）─────────────────────────────────

describe('handleBrowserAction —— job 异步 + 取消（BR-10 P2）', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))

  function makeJobHooks(
    runtime: BrowserRuntime,
    opts: {
      manager?: BrowserJobManager
      execute?: BrowserJobHooks['execute']
      resourceStream?: BrowserResourceStreamHooks
    } = {},
  ): { hooks: BrowserOrchestratorHostHooks; manager: BrowserJobManager } {
    const manager = opts.manager ?? new BrowserJobManager()
    const execute = opts.execute ?? (async () => ({ default: true }))
    return {
      manager,
      hooks: { runtime, resourceStream: opts.resourceStream, jobs: { manager, execute }, policy: ALLOW_POLICY },
    }
  }

  it('默认（不传 async）走同步 hook、不起 job（零行为变更）', async () => {
    const executeSpy = vi.fn(async () => ({ path: '/should-not-run' }))
    let syncCalled = false
    const { hooks, manager } = makeJobHooks('daemon', {
      execute: executeSpy,
      resourceStream: {
        runStreamDownload: async () => {
          syncCalled = true
          return { ok: true, status: 200, data: { path: '/sync.ts' } }
        },
      },
    })
    const result = await handleBrowserAction('stream.download', { url: 'https://e.com/s.m3u8' }, hooks)
    expect(result!.ok).toBe(true)
    expect(result!.status).toBe(200)
    expect((result as { ok: true; data: unknown }).data).toEqual({ path: '/sync.ts' })
    expect(syncCalled).toBe(true)
    expect(executeSpy).not.toHaveBeenCalled()
    expect(manager.list()).toHaveLength(0)
  })

  it('async=true → 202 + jobId + poll；后台 execute 完成后 job=completed 带 result', async () => {
    let syncCalled = false
    const { hooks, manager } = makeJobHooks('daemon', {
      execute: async () => ({ path: '/done.ts', success: true }),
      resourceStream: {
        runStreamDownload: async () => {
          syncCalled = true
          return { ok: true, status: 200, data: {} }
        },
      },
    })
    const result = await handleBrowserAction('stream.download', { url: 'https://e.com/s.m3u8', async: true }, hooks)
    expect(result!.ok).toBe(true)
    expect(result!.status).toBe(202)
    const data = (result as {
      ok: true
      data: { jobId: string; poll: string; pollBody: { jobId: string } }
    }).data
    expect(typeof data.jobId).toBe('string')
    expect(data.poll).toBe('/browser/job/status')
    expect(data.pollBody).toEqual({ jobId: data.jobId })
    expect(syncCalled, '异步路径不该走同步 hook').toBe(false)

    await flush()
    const rec = manager.get(data.jobId)!
    expect(rec.status).toBe('completed')
    expect(rec.result).toEqual({ path: '/done.ts', success: true })
    expect(rec.progress.percent).toBe(100)
  })

  it('wait=false 等价 async=true（同样 202，覆盖 resource.smart-download）', async () => {
    const { hooks } = makeJobHooks('daemon', { execute: async () => ({}) })
    const result = await handleBrowserAction('resource.smart-download', { url: 'x', wait: false }, hooks)
    expect(result!.status).toBe(202)
  })

  it('缺 jobs 钩子 → 即使 async=true 也回落同步（零行为变更）', async () => {
    const hooks: BrowserOrchestratorHostHooks = {
      runtime: 'daemon',
      resourceStream: { runStreamDownload: async () => ({ ok: true, status: 200, data: { path: '/sync.ts' } }) },
    }
    const result = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    expect(result!.status).toBe(200)
    expect((result as { ok: true; data: unknown }).data).toEqual({ path: '/sync.ts' })
  })

  it('replay.run 默认走同步 session hook，不起 job（兼容现有回放脚本）', async () => {
    const executeSpy = vi.fn(async () => ({ shouldNotRun: true }))
    const replayRun = vi.fn(async () => ({ success: true, eventsReplayed: 2 }))
    const { hooks, manager } = makeJobHooks('electron', { execute: executeSpy })
    hooks.session = { replayRun }

    const result = await handleBrowserAction('replay.run', { runId: 'rec-1' }, hooks)
    expect(result!.ok).toBe(true)
    expect(result!.status).toBe(200)
    expect((result as { ok: true; data: unknown }).data).toEqual({ success: true, eventsReplayed: 2 })
    expect(replayRun).toHaveBeenCalledTimes(1)
    expect(executeSpy).not.toHaveBeenCalled()
    expect(manager.list()).toHaveLength(0)
  })

  it('replay.run async=true → 返回 job，并由 jobs.execute 后台执行', async () => {
    const executeSpy = vi.fn(async (actionId: string) => {
      expect(actionId).toBe('replay.run')
      return { success: true, eventsReplayed: 3 }
    })
    const replayRun = vi.fn(async () => ({ shouldNotCall: true }))
    const { hooks, manager } = makeJobHooks('electron', { execute: executeSpy })
    hooks.session = { replayRun }

    const result = await handleBrowserAction('replay.run', { runId: 'rec-1', async: true }, hooks)
    expect(result!.status).toBe(202)
    const { jobId } = (result as { ok: true; data: { jobId: string } }).data
    expect(replayRun).not.toHaveBeenCalled()

    await flush()
    const rec = manager.get(jobId)!
    expect(rec.status).toBe('completed')
    expect(rec.result).toEqual({ success: true, eventsReplayed: 3 })
  })

  it('execute 抛错 → job=failed 记录结构化 error（终态守卫不被覆盖）', async () => {
    const { hooks, manager } = makeJobHooks('daemon', {
      execute: async () => {
        throw new BrowserActionError(500, { code: 'NETWORK_ERROR', message: '下载失败' })
      },
    })
    const result = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    const { jobId } = (result as { ok: true; data: { jobId: string } }).data
    await flush()
    const rec = manager.get(jobId)!
    expect(rec.status).toBe('failed')
    expect(rec.error?.code).toBe('NETWORK_ERROR')
  })

  it('cancel 真把 signal.aborted 传到 execute；引擎随后 resolve 也不覆盖 cancelled', async () => {
    let captured: AbortSignal | undefined
    let resolveExec: (() => void) | undefined
    const { hooks, manager } = makeJobHooks('daemon', {
      execute: (_actionId, _body, ctx) =>
        new Promise((resolve) => {
          captured = ctx.signal
          resolveExec = () => resolve({})
        }),
    })
    const started = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    const { jobId } = (started as { ok: true; data: { jobId: string } }).data
    expect(captured!.aborted).toBe(false)

    const cancel = await handleBrowserAction('job.cancel', { jobId }, hooks)
    expect(cancel!.ok).toBe(true)
    expect((cancel as { ok: true; data: unknown }).data).toMatchObject({ jobId, cancelled: true, status: 'cancelled' })
    expect(captured!.aborted, 'cancel 应触发引擎收到的 signal.aborted').toBe(true)

    resolveExec?.()
    await flush()
    expect(manager.get(jobId)!.status).toBe('cancelled')
  })

  it('job.status：找到返回记录 / 未找到 404 / 缺 jobId 400 / 缺 jobs 钩子 null', async () => {
    const { hooks } = makeJobHooks('daemon', { execute: async () => ({ path: '/x' }) })
    const started = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    const { jobId } = (started as { ok: true; data: { jobId: string } }).data

    const found = await handleBrowserAction('job.status', { jobId }, hooks)
    expect(found!.ok).toBe(true)
    expect(found!.status).toBe(200)
    expect((found as { ok: true; data: { id: string } }).data.id).toBe(jobId)

    const missing = await handleBrowserAction('job.status', { jobId: 'nope' }, hooks)
    expect(missing!.ok).toBe(false)
    expect(missing!.status).toBe(404)

    const noId = await handleBrowserAction('job.status', {}, hooks)
    expect(noId!.ok).toBe(false)
    expect(noId!.status).toBe(400)

    expect(await handleBrowserAction('job.status', { jobId }, { runtime: 'daemon' })).toBeNull()
  })

  it('job.cancel：未找到 404 / 缺 jobs 钩子 null / 取消已终态 job → cancelled=false', async () => {
    const { hooks, manager } = makeJobHooks('daemon', { execute: async () => ({ done: true }) })

    const missing = await handleBrowserAction('job.cancel', { jobId: 'nope' }, hooks)
    expect(missing!.status).toBe(404)

    expect(await handleBrowserAction('job.cancel', { jobId: 'x' }, { runtime: 'daemon' })).toBeNull()

    const started = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    const { jobId } = (started as { ok: true; data: { jobId: string } }).data
    await flush()
    expect(manager.get(jobId)!.status).toBe('completed')
    const cancel = await handleBrowserAction('job.cancel', { jobId }, hooks)
    expect((cancel as { ok: true; data: unknown }).data).toMatchObject({ jobId, cancelled: false, status: 'completed' })
  })

  it('jobId 兼容 snake_case（job_id）键（CLI buildRequestBody 同时下发 camel/snake）', async () => {
    const { hooks } = makeJobHooks('daemon', { execute: async () => ({}) })
    const started = await handleBrowserAction('stream.download', { url: 'x', async: true }, hooks)
    const { jobId } = (started as { ok: true; data: { jobId: string } }).data
    const found = await handleBrowserAction('job.status', { job_id: jobId }, hooks)
    expect(found!.ok).toBe(true)
    expect((found as { ok: true; data: { id: string } }).data.id).toBe(jobId)
  })
})

describe('handleBrowserAction —— 迁移缝', () => {
  it('未被 Orchestrator 接管的 action 返回 null（落回各端旧逻辑）', async () => {
    for (const id of ['open', 'tab.list', 'unknown-action']) {
      const result = await handleBrowserAction(id, {}, makeHooks('daemon', SAMPLE_INFO))
      expect(result, `${id} 不该被 Orchestrator 接管`).toBeNull()
    }
  })

  it('snapshot/eval 缺 exec 子 hook 时落 null', async () => {
    const partial: BrowserExecHooks = {
      observeLimitDefault: 50,
      async prepareTab() {
        return undefined
      },
      async runAct() {
        return { success: true, raw: {} }
      },
      async runObserve() {
        return { success: true, raw: {} }
      },
    }
    expect(await handleBrowserAction('snapshot', {}, { runtime: 'daemon', exec: partial, policy: ALLOW_POLICY })).toBeNull()
    expect(await handleBrowserAction('eval', { code: '1' }, { runtime: 'daemon', exec: partial, policy: ALLOW_POLICY })).toBeNull()
  })
})
