/**
 * Wave 4 单测 — autofill-service Agent 后台 view 分支。
 *
 * 覆盖：
 *   - T1：``isAgentBackgroundView`` 信号判断（3 信号 × 边界）
 *   - T1：onViewDomReady 路由分流——前台 view emit overlay；Agent 后台 view 走自动 fill+submit
 *   - T2：``revealForAutofillWithoutDialogFn`` 注入路径（不弹 dialog）
 *   - T2：fill 后调用 SUBMIT_FORM_SCRIPT
 *   - T4：fill 成功后**同步 ``recordRecentSubmit``**——后续同密码 capture 被去重
 *   - PD-10：多匹配取 matches[0]（后端已排序）
 *   - 边界：reveal 返回 null（凭据失效）→ 通知 + 不 fill
 *   - 边界：fill 失败 → 通知 + 不 submit
 *   - 安全：密码不进 IPC 消息（emit 路径不带 password 字段）
 *   - 不 regression：前台 view 仍走 Wave 3 overlay 路径
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WebContents } from 'electron'

// 打桩 electron 依赖
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}))

vi.mock('../auth', () => ({ TokenManager: { getAccessToken: vi.fn() } }))
vi.mock('../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))
vi.mock('../config/api', () => ({ API_BASE_URL: 'http://e2e.invalid/api' }))
vi.mock('@tabtin/config', () => ({ joinApiPath: (a: string, b: string) => a + b }))
vi.mock('../window-manager', () => ({ getMainWindow: () => null }))
vi.mock('./autofill-detector', () => ({
  detectLoginForm: vi.fn().mockResolvedValue({ hasPassword: true, hasUsername: true, passwordCount: 1 }),
  fillLoginForm: vi.fn().mockResolvedValue(true),
  notifyRendererAutofillSuggestion: vi.fn(),
  clearRendererAutofillSuggestion: vi.fn(),
  installPasswordCaptureScript: vi.fn().mockResolvedValue(undefined),
  submitLoginForm: vi.fn().mockResolvedValue({ submitted: true, via: 'type=submit' }),
}))

import {
  setCredentialMatchFn,
  setRevealForAutofillWithoutDialogFn,
  setViewClassificationFn,
  __clearAllWebContentsForTest,
  __clearRecentSubmitsForTest,
  __isAgentBackgroundViewForTest,
  onViewDomReady,
  onPasswordSubmitted,
  setSavePromptEmitter,
  setBlacklistCheckFn,
  setCredentialFetchPlaintextFn,
  __clearPendingSavePasswordsForTest,
  __setWebContentsForTest,
  __clearBlacklistCacheForTest,
  __setAutofillDetectTimingForTest,
  type ViewClassification,
  type SavePromptPayload,
} from './autofill-service'
import {
  notifyRendererAutofillSuggestion,
  fillLoginForm,
  submitLoginForm,
} from './autofill-detector'

function makeWc(opts: { url: string; isDestroyed?: boolean; hasPwdForm?: boolean }): WebContents {
  return {
    getURL: () => opts.url,
    isDestroyed: () => opts.isDestroyed ?? false,
    executeJavaScript: vi.fn(async () => Boolean(opts.hasPwdForm)),
    once: vi.fn(),
    on: vi.fn(),
    id: 1,
  } as unknown as WebContents
}

// 登录表单检测重试默认轮询 ~8s（覆盖 SPA 异步渲染）——单测调成单次无延迟。
beforeEach(() => {
  __setAutofillDetectTimingForTest({ attempts: 1, intervalMs: 0 })
})

describe('Wave 4 T1 — isAgentBackgroundView 信号判断', () => {
  it('null classification → false（保守降级到前台路径）', () => {
    expect(__isAgentBackgroundViewForTest(null)).toBe(false)
  })

  it('profile=background-task → true（Agent 后台任务专用 profile）', () => {
    expect(__isAgentBackgroundViewForTest({ profile: 'background-task' })).toBe(true)
  })

  it('displayMode=hidden + runId 存在 → true', () => {
    expect(__isAgentBackgroundViewForTest({
      displayMode: 'hidden',
      runId: 'run-abc',
    })).toBe(true)
  })

  it('displayMode=hidden 但无 runId → false（避免误伤"用户最小化标签"场景）', () => {
    expect(__isAgentBackgroundViewForTest({ displayMode: 'hidden' })).toBe(false)
  })

  it('runId 存在但 displayMode=embedded → false（agent-workspace 用户可见）', () => {
    expect(__isAgentBackgroundViewForTest({
      displayMode: 'embedded',
      runId: 'run-abc',
      profile: 'agent-workspace',
    })).toBe(false)
  })

  it('user-tab profile + showInSidebar=true → false（标准前台用户标签）', () => {
    expect(__isAgentBackgroundViewForTest({
      profile: 'user-tab',
      displayMode: 'embedded',
      showInSidebar: true,
    })).toBe(false)
  })
})

describe('Wave 4 T1 — onViewDomReady 路由分流', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    vi.mocked(notifyRendererAutofillSuggestion).mockClear()
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
    setCredentialMatchFn(async () => [{
      id: 'cred-fg',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'agent-pw-12345678',
    }))
  })

  it('前台用户 view → emit overlay（Wave 3 行为不破坏）', async () => {
    setViewClassificationFn((_tabId) => ({
      profile: 'user-tab',
      displayMode: 'embedded',
      showInSidebar: true,
    }))
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('fg-tab', wc)
    // 短暂等待 runAgentAutofill 不应被调
    await new Promise((r) => setTimeout(r, 10))

    expect(notifyRendererAutofillSuggestion).toHaveBeenCalledTimes(1)
    expect(fillLoginForm).not.toHaveBeenCalled()
    expect(submitLoginForm).not.toHaveBeenCalled()
  })

  it('Agent 后台 view (profile=background-task) → 自动 fill+submit；不 emit overlay', async () => {
    setViewClassificationFn((_tabId) => ({
      profile: 'background-task',
      displayMode: 'hidden',
      runId: 'run-abc',
      showInSidebar: false,
    }))
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('agent-tab', wc)
    // 等 runAgentAutofill 跑完
    await new Promise((r) => setTimeout(r, 50))

    expect(notifyRendererAutofillSuggestion).not.toHaveBeenCalled()
    expect(fillLoginForm).toHaveBeenCalledTimes(1)
    // fillLoginForm 收到的明文不会进入 Vitest mock 调用记录之外的任何路径——
    // 它 closure 在主进程，密码字符串生命周期止于 fillLoginForm 调用结束
    expect(submitLoginForm).toHaveBeenCalledTimes(1)
  })

  it('Agent 后台 view + 0 匹配 → 不操作 + 不弹 overlay (W4-C 场景核心)', async () => {
    setViewClassificationFn(() => ({ profile: 'background-task', displayMode: 'hidden', runId: 'r1' }))
    setCredentialMatchFn(async () => [])
    const wc = makeWc({ url: 'https://nomatch.com/login' })
    await onViewDomReady('agent-no-match-tab', wc)
    await new Promise((r) => setTimeout(r, 30))

    expect(notifyRendererAutofillSuggestion).not.toHaveBeenCalled()
    expect(fillLoginForm).not.toHaveBeenCalled()
    expect(submitLoginForm).not.toHaveBeenCalled()
  })
})

describe('Wave 4 PD-10 — 多匹配取 matches[0]', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
    setViewClassificationFn(() => ({ profile: 'background-task' }))
  })

  it('多匹配 → fill 用 matches[0] 的 credentialId（后端已按 last_used_at DESC 排序）', async () => {
    setCredentialMatchFn(async () => [
      { id: 'cred-recent', url: 'https://example.com', username: 'recent-user', masked_password: '****' },
      { id: 'cred-old', url: 'https://example.com', username: 'old-user', masked_password: '****' },
    ])
    const revealMock = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      username: 'recent-user',
      password: 'recent-pw-12345678',
    })
    setRevealForAutofillWithoutDialogFn(revealMock)
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('multi-match-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    // 关键断言：reveal 用第一个 credential id（recent-user，PD-10）
    expect(revealMock).toHaveBeenCalledWith('cred-recent')
    expect(revealMock).not.toHaveBeenCalledWith('cred-old')
    // fill 用第一个的 username
    expect(fillLoginForm).toHaveBeenCalledWith(
      expect.anything(),
      'recent-user',
      'recent-pw-12345678',
      'https://example.com',
    )
  })
})

describe('Wave 4 T2 — 失败分支处理', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
    setViewClassificationFn(() => ({ profile: 'background-task' }))
    setCredentialMatchFn(async () => [{
      id: 'cred-x',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
  })

  it('reveal 返回 null（凭据过期/失效）→ fill 不被调用 (W4-D 场景)', async () => {
    setRevealForAutofillWithoutDialogFn(async () => null)
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('expired-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(fillLoginForm).not.toHaveBeenCalled()
    expect(submitLoginForm).not.toHaveBeenCalled()
  })

  it('reveal 抛异常 → fill 不被调用（不破坏 Agent 流程）', async () => {
    setRevealForAutofillWithoutDialogFn(async () => {
      throw new Error('network failed')
    })
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('reveal-throw-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(fillLoginForm).not.toHaveBeenCalled()
    expect(submitLoginForm).not.toHaveBeenCalled()
  })

  it('fill 返回 false（域名不匹配）→ submit 不被调用', async () => {
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'pw-1234',
    }))
    vi.mocked(fillLoginForm).mockResolvedValueOnce(false)
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('fill-fail-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(fillLoginForm).toHaveBeenCalledTimes(1)
    expect(submitLoginForm).not.toHaveBeenCalled()
  })
})

describe('Wave 4 真·真 Review 自修验证 — V3#1 / V2#3 / V1#2', () => {
  // V3#1: fill ok + submit fail → 应走失败路径而不是成功 toast
  // V2#3: emitter payload 必须带 spaceId 透传给 renderer
  // V1#2: recordRecentSubmit 应在 fill 之前调用（防 race）

  let failedEmitter: ReturnType<typeof vi.fn>
  let succeededEmitter: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
    setCredentialMatchFn(async () => [{
      id: 'cred-x',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'plaintext-pw-NEVER-IN-IPC-1234',
    }))
    setViewClassificationFn(() => ({
      profile: 'background-task',
      runId: 'run-vfix',
      spaceId: 'space-research-helper',
    }))
    failedEmitter = vi.fn()
    succeededEmitter = vi.fn()
    const mod = await import('./autofill-service')
    mod.setAgentAutofillFailedEmitter(failedEmitter)
    mod.setAgentAutofillSucceededEmitter(succeededEmitter)
  })

  it('V3#1: fill ok + submit fail → emit failed(code=submit-failed) 而不是 succeeded', async () => {
    vi.mocked(submitLoginForm).mockResolvedValueOnce({ submitted: false, reason: 'no-submit-target' })

    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('vfix-submit-fail-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(fillLoginForm).toHaveBeenCalledTimes(1)
    expect(submitLoginForm).toHaveBeenCalledTimes(1)
    // V3#1 关键：不应 emit succeeded，应 emit failed(submit-failed)
    expect(succeededEmitter).not.toHaveBeenCalled()
    expect(failedEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'vfix-submit-fail-tab',
        code: 'submit-failed',
        credentialId: 'cred-x',
        domain: 'example.com',
      }),
    )
  })

  it('V3#1: fill ok + submit ok → emit succeeded（保留原行为）', async () => {
    vi.mocked(submitLoginForm).mockResolvedValueOnce({ submitted: true, via: 'type=submit' })

    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('vfix-submit-ok-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(succeededEmitter).toHaveBeenCalledTimes(1)
    expect(failedEmitter).not.toHaveBeenCalled()
  })

  it('V2#3: succeeded payload 带 spaceId（让 renderer 反查 Agent 名字）', async () => {
    vi.mocked(submitLoginForm).mockResolvedValueOnce({ submitted: true, via: 'type=submit' })

    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('vfix-spaceid-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(succeededEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-research-helper',
        domain: 'example.com',
        // maskedUsername 由 maskUsername 算 — alice 长度 5 → "al***e"
        maskedUsername: 'al***e',
      }),
    )
    // 不应包含明文密码
    const payload = succeededEmitter.mock.calls[0][0]
    expect(JSON.stringify(payload)).not.toContain('plaintext-pw-NEVER-IN-IPC-1234')
  })

  it('V2#3: failed payload 也带 spaceId', async () => {
    vi.mocked(submitLoginForm).mockResolvedValueOnce({ submitted: false, reason: 'no-submit-target' })

    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('vfix-failed-spaceid-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    expect(failedEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-research-helper',
        code: 'submit-failed',
      }),
    )
  })

  it('V1#2: recordRecentSubmit 在 fill 之前调用（防 page 端 race）', async () => {
    // 模拟"fill 期间 page 触发 submit + capture"——在 fillLoginForm 内部
    // 同步调用 onPasswordSubmitted（page race 的最坏情况），如果 record 在
    // fill 之前已经调过，capture 应被 dedup 静默吞掉。
    const savePrompts: SavePromptPayload[] = []
    setSavePromptEmitter((p) => savePrompts.push(p))
    setBlacklistCheckFn(async () => false)
    setCredentialFetchPlaintextFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'plaintext-pw-NEVER-IN-IPC-1234',
    }))

    // 把 fillLoginForm mock 改成"fill 期间 page race 调 onPasswordSubmitted"
    vi.mocked(fillLoginForm).mockImplementationOnce(async (wc, _u, _p, _url) => {
      void _u; void _p; void _url
      // 模拟 page-side capture script 在 fill 执行期间 fire
      __setWebContentsForTest('vfix-race-tab', {
        getURL: () => 'https://example.com/login',
        isDestroyed: () => false,
        getTitle: () => 'Login',
        executeJavaScript: vi.fn(async () => false),
        once: vi.fn(),
        on: vi.fn(),
        id: 99,
      } as any)
      await onPasswordSubmitted('vfix-race-tab', {
        url: 'https://example.com/login',
        username: 'alice',
        password: 'plaintext-pw-NEVER-IN-IPC-1234',
      })
      void wc
      return true
    })

    vi.mocked(submitLoginForm).mockResolvedValueOnce({ submitted: true, via: 'type=submit' })

    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('vfix-race-tab', wc)
    await new Promise((r) => setTimeout(r, 1700)) // 等 verifyLoginSuccess 1.5s

    // V1#2 关键：record 在 fill 之前调过 → capture 上来的同密码应被 dedup
    // 命中 → savePrompts 应为空（不弹保存条/不走 update 路径）
    expect(savePrompts.length).toBe(0)
  }, 5000)
})

describe('Wave 4 T4 — recordRecentSubmit 闭环（防回声）', () => {
  let prompts: SavePromptPayload[]

  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    __clearPendingSavePasswordsForTest()
    __clearBlacklistCacheForTest()
    prompts = []
    setSavePromptEmitter((p) => prompts.push(p))
    setBlacklistCheckFn(async () => false)
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
    setViewClassificationFn(() => ({ profile: 'background-task' }))
    // 默认登录"成功"（URL 变了 + 无密码框）
    __setWebContentsForTest('agent-tab', makeWc({
      url: 'https://example.com/dashboard',
      hasPwdForm: false,
    }))
  })

  it('Agent fill 后 capture 上来同密码 → recentSubmits 命中，onPasswordSubmitted 不弹保存条', async () => {
    // 1. 先模拟 Agent 后台 view 的 onViewDomReady 链路：fill+submit
    //    （webContentsMap 已经被 __setWebContentsForTest 设置）
    setCredentialMatchFn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'shared-pw-fixed-1234',
    }))
    const wcDomReady = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('agent-tab', wcDomReady)
    await new Promise((r) => setTimeout(r, 30))

    expect(fillLoginForm).toHaveBeenCalledTimes(1)
    expect(submitLoginForm).toHaveBeenCalledTimes(1)

    // 2. 模拟 page 内 capture script 监听到 form submit / button click，
    //    上报刚被 Agent 填的密码（注意：webContentsMap.get('agent-tab') 是
    //    步骤 0 中 __setWebContentsForTest 设置的"登录后页"——URL 变了 +
    //    无密码框，verifyLoginSuccess 会判成功）
    setCredentialMatchFn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setCredentialFetchPlaintextFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'shared-pw-fixed-1234', // 与 Agent 填的密码相同
    }))
    await onPasswordSubmitted('agent-tab', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'shared-pw-fixed-1234', // page 自动 capture 上来的同密码
    })

    // T4 关键断言：保存条**不弹**（recordRecentSubmit 命中 → 静默跳过）
    // 不修复时：onPasswordSubmitted 走 update / 同密码 silently 路径，可能
    // 误污染 last_used 字段或健康度判断
    expect(prompts).toHaveLength(0)
  })

  it('Agent fill 后用户在另一 tab 输不同密码 → recentSubmits 不影响（hash 不同）', async () => {
    setCredentialMatchFn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'agent-filled-pw-1',
    }))
    const wcDomReady = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('agent-tab', wcDomReady)
    await new Promise((r) => setTimeout(r, 30))

    // 用户在另一站点输不同密码
    __clearAllWebContentsForTest()
    __setWebContentsForTest('user-tab', makeWc({
      url: 'https://other.com/dashboard',
      hasPwdForm: false,
    }))
    setCredentialMatchFn(async () => [])
    await onPasswordSubmitted('user-tab', {
      url: 'https://other.com/login',
      username: 'bob',
      password: 'user-different-pw-9999',
    })

    // 不同密码 → 走正常 save 路径，弹保存条
    expect(prompts).toHaveLength(1)
    expect(prompts[0].mode).toBe('save')
  })
})

describe('Wave 4 安全约束 — 密码不进 IPC / emit / 任何持久化路径', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearRecentSubmitsForTest()
    vi.mocked(fillLoginForm).mockClear()
    vi.mocked(submitLoginForm).mockClear()
  })

  it('Agent 后台 view fill+submit 全程：notifyRendererAutofillSuggestion 不被调（密码就不会经过 IPC）', async () => {
    setViewClassificationFn(() => ({ profile: 'background-task' }))
    setCredentialMatchFn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setRevealForAutofillWithoutDialogFn(async () => ({
      url: 'https://example.com',
      username: 'alice',
      password: 'super-secret-pw-NEVER-IN-IPC',
    }))
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('sec-tab', wc)
    await new Promise((r) => setTimeout(r, 50))

    // 关键安全断言：notifyRendererAutofillSuggestion 不会被调用 →
    // 任何 IPC 消息都不携带 credentials 列表（更不会带明文）
    expect(notifyRendererAutofillSuggestion).not.toHaveBeenCalled()

    // fill 调用了 fillLoginForm 但密码只在主进程内存，没有任何 IPC 路径
    // 把它发到 renderer
    expect(fillLoginForm).toHaveBeenCalledWith(
      expect.anything(),
      'alice',
      'super-secret-pw-NEVER-IN-IPC',
      'https://example.com',
    )
  })

  it('viewClassificationFn 抛异常 → 保守走前台 overlay 路径（不破坏 Wave 3）', async () => {
    setViewClassificationFn(() => {
      throw new Error('classification failed')
    })
    setCredentialMatchFn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    const wc = makeWc({ url: 'https://example.com/login' })
    await onViewDomReady('classify-throw-tab', wc)
    await new Promise((r) => setTimeout(r, 30))

    // 异常 → 降级前台路径 → emit overlay
    expect(notifyRendererAutofillSuggestion).toHaveBeenCalledTimes(1)
    expect(fillLoginForm).not.toHaveBeenCalled()
  })
})
