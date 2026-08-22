/**
 * Wave 3 G6 — autofill-service 单测
 *
 * 覆盖：
 *   - verifyLoginSuccess 启发式（URL 变化 + 无密码框）
 *   - onPasswordSubmitted 三模式决策（save / update / new-account / skip）
 *   - 黑名单守门
 *   - pendingSavePasswords 安全设计：密码不暴露给 emitter，从 map 取后立即清
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WebContents } from 'electron'

// 打桩 electron 依赖（避免真装 Electron）
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
  detectLoginForm: vi.fn().mockResolvedValue(null),
  fillLoginForm: vi.fn().mockResolvedValue(true),
  notifyRendererAutofillSuggestion: vi.fn(),
  clearRendererAutofillSuggestion: vi.fn(),
  installPasswordCaptureScript: vi.fn().mockResolvedValue(undefined),
}))

import {
  setCredentialMatchFn,
  setCredentialFetchPlaintextFn,
  setBlacklistCheckFn,
  setSavePromptEmitter,
  __setWebContentsForTest,
  __clearAllWebContentsForTest,
  __clearBlacklistCacheForTest,
  __clearPendingSavePasswordsForTest,
  __clearRecentSubmitsForTest,
  __setInPageNavRecordForTest,
  __setLoginVerifyTimingForTest,
  __setAutofillDetectTimingForTest,
  verifyLoginSuccess,
  onPasswordSubmitted,
  onViewDomReady,
  checkDomainBlacklist,
  type SavePromptPayload,
} from './autofill-service'
import { installPasswordCaptureScript } from './autofill-detector'

// 登录表单检测重试默认会轮询 ~8s（覆盖 SPA 异步渲染）——单测里调成单次无延迟，
// 行为与"只检测一次"一致，避免拖慢/超时。
beforeEach(() => {
  __setAutofillDetectTimingForTest({ attempts: 1, intervalMs: 0 })
})

function makeWebContents(opts: {
  url: string
  isDestroyed?: boolean
  hasPasswordForm?: boolean
  /** 若提供，则挂上 session.cookies.get 返回这些 cookie 名（启用 Cookie 信号） */
  cookieNames?: string[]
}): WebContents {
  const wc: Record<string, unknown> = {
    getURL: () => opts.url,
    isDestroyed: () => opts.isDestroyed ?? false,
    executeJavaScript: vi.fn(async () => Boolean(opts.hasPasswordForm)),
    once: vi.fn(),
    id: 1,
  }
  if (opts.cookieNames) {
    wc.session = {
      cookies: {
        get: vi.fn(async () => opts.cookieNames!.map((name) => ({ name }))),
      },
    }
  }
  return wc as unknown as WebContents
}

describe('verifyLoginSuccess', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
  })

  it('URL 没变 → false（仍在登录页）', async () => {
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/login',
      hasPasswordForm: true,
    }))
    const ok = await verifyLoginSuccess('tab-1', 'https://example.com/login', 0)
    expect(ok).toBe(false)
  })

  it('URL 变了 + 无密码框 → true', async () => {
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/dashboard',
      hasPasswordForm: false,
    }))
    const ok = await verifyLoginSuccess('tab-1', 'https://example.com/login', 0)
    expect(ok).toBe(true)
  })

  it('URL 变了但仍含密码框 → false（可能在 2FA 页）', async () => {
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/2fa',
      hasPasswordForm: true,
    }))
    const ok = await verifyLoginSuccess('tab-1', 'https://example.com/login', 0)
    expect(ok).toBe(false)
  })

  it('webContents 被销毁 → false（保守不弹）', async () => {
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/dashboard',
      isDestroyed: true,
    }))
    const ok = await verifyLoginSuccess('tab-1', 'https://example.com/login', 0)
    expect(ok).toBe(false)
  })

  it('未注册的 tabId → false（防御）', async () => {
    const ok = await verifyLoginSuccess('not-existed', 'https://example.com/login', 0)
    expect(ok).toBe(false)
  })

  it('executeJavaScript 抛异常 → 当作"已离开登录页"返回 true（页面正在跳转）', async () => {
    const wc = {
      getURL: () => 'https://example.com/post-login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => { throw new Error('page in navigation') }),
      once: vi.fn(),
      id: 1,
    } as unknown as WebContents
    __setWebContentsForTest('tab-1', wc)
    const ok = await verifyLoginSuccess('tab-1', 'https://example.com/login', 0)
    expect(ok).toBe(true)
  })

  it('URL/title/nav 都没变，但会话 Cookie 新增 + 无密码框 → true', async () => {
    const getMock = vi.fn().mockResolvedValue([{ name: 'gclid' }, { name: 'sid' }])
    __setWebContentsForTest('tab-ck', {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 40,
      session: { cookies: { get: getMock } },
    } as unknown as WebContents)
    const ok = await verifyLoginSuccess('tab-ck', 'https://example.com/login', {
      waitMs: 0,
      cookieBaseline: new Set(['gclid']),
    })
    expect(ok).toBe(true)
  })

  it('cookieBaseline 为空集合（读取失败/全新会话）→ cookie 信号不启用', async () => {
    const getMock = vi.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }])
    __setWebContentsForTest('tab-ck2', {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 41,
      session: { cookies: { get: getMock } },
    } as unknown as WebContents)
    const ok = await verifyLoginSuccess('tab-ck2', 'https://example.com/login', {
      waitMs: 0,
      cookieBaseline: new Set(),
    })
    expect(ok).toBe(false)
  })

  it('轮询：首次仍在登录页，随后 URL 跳转 → true（覆盖滑块延迟）', async () => {
    let checks = 0
    __setWebContentsForTest('tab-poll', {
      getURL: () => {
        checks++
        return checks >= 2 ? 'https://example.com/dashboard' : 'https://example.com/login'
      },
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 30,
    } as unknown as WebContents)
    const ok = await verifyLoginSuccess('tab-poll', 'https://example.com/login', {
      waitMs: 0,
      maxWaitMs: 50,
      pollIntervalMs: 5,
    })
    expect(ok).toBe(true)
  })

  it('轮询：超时仍在登录页 → false', async () => {
    __setWebContentsForTest('tab-poll2', makeWebContents({
      url: 'https://example.com/login',
      hasPasswordForm: true,
    }))
    const ok = await verifyLoginSuccess('tab-poll2', 'https://example.com/login', {
      waitMs: 0,
      maxWaitMs: 15,
      pollIntervalMs: 5,
    })
    expect(ok).toBe(false)
  })
})

describe('checkDomainBlacklist', () => {
  beforeEach(() => {
    __clearBlacklistCacheForTest()
  })

  it('未配置 blacklistCheckFn → false', async () => {
    setBlacklistCheckFn(undefined as any)
    const blocked = await checkDomainBlacklist('example.com')
    expect(blocked).toBe(false)
  })

  it('5min 内复用缓存：第二次调用不打后端', async () => {
    const fn = vi.fn(async (d: string) => d === 'banned.com')
    setBlacklistCheckFn(fn)
    expect(await checkDomainBlacklist('banned.com')).toBe(true)
    expect(await checkDomainBlacklist('banned.com')).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('查询异常 → 当作未拉黑（保守不阻塞主流程）', async () => {
    setBlacklistCheckFn(async () => { throw new Error('network fail') })
    const blocked = await checkDomainBlacklist('flaky.com')
    expect(blocked).toBe(false)
  })
})

describe('onPasswordSubmitted — 三模式决策 + 安全', () => {
  let prompts: SavePromptPayload[]

  beforeEach(() => {
    __clearAllWebContentsForTest()
    __clearBlacklistCacheForTest()
    __clearPendingSavePasswordsForTest()
    // Wave 3 修正版回归 fix：跨 it 共享 module state 时，recentSubmits 队列
    // 残留的 password hash 会让下一条用例的同密码 capture 命中
    // isRecentlySubmittedDuplicate → 静默跳过 → assert prompt count 失败。
    // 必须每个 it 之前清空。
    __clearRecentSubmitsForTest()
    // 关闭 verify 轮询等待：单测只需检查一次，避免真的等 1.5s / 轮询 12s 超时
    __setLoginVerifyTimingForTest({ waitMs: 0, maxWaitMs: 0 })
    prompts = []
    setSavePromptEmitter((p) => prompts.push(p))
    setBlacklistCheckFn(async () => false)
    // 默认登录成功（URL 变了 + 无密码框）
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/dashboard',
      hasPasswordForm: false,
    }))
  })

  it('全新凭据 → mode=save', async () => {
    setCredentialMatchFn(async () => [])
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'pw-12345',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      mode: 'save',
      domain: 'example.com',
      username: 'alice',
    })
    // 安全：emit payload 不含 password
    expect((prompts[0] as any).password).toBeUndefined()
  })

  it('URL 没变但登录后会话 Cookie 新增 → 靠 cookie 信号弹保存（京东滑块类场景）', async () => {
    const getMock = vi.fn()
      .mockResolvedValueOnce([{ name: 'gclid' }]) // submit 时刻 baseline
      .mockResolvedValueOnce([{ name: 'gclid' }, { name: 'sessionid' }]) // verify 时刻新增登录态
    __clearAllWebContentsForTest()
    __setWebContentsForTest('tab-1', {
      getURL: () => 'https://example.com/login', // URL 不变
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false), // 无密码框
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 1,
      session: { cookies: { get: getMock } },
    } as unknown as WebContents)
    setCredentialMatchFn(async () => [])
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'pw-12345',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ mode: 'save', domain: 'example.com' })
  })

  it('同 username 密码不变 → 静默不弹', async () => {
    setCredentialMatchFn(async () => [{
      id: 'cred-1', url: 'https://example.com', username: 'alice', masked_password: '****',
    }])
    setCredentialFetchPlaintextFn(async () => ({
      url: 'https://example.com', username: 'alice', password: 'pw-12345',
    }))
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'pw-12345',
    })
    expect(prompts).toHaveLength(0)
  })

  it('同 username 密码变了 → mode=update + credentialId 透传', async () => {
    setCredentialMatchFn(async () => [{
      id: 'cred-1', url: 'https://example.com', username: 'alice', masked_password: '****',
    }])
    setCredentialFetchPlaintextFn(async () => ({
      url: 'https://example.com', username: 'alice', password: 'old-pw',
    }))
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'new-pw-12345',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      mode: 'update',
      credentialId: 'cred-1',
      username: 'alice',
    })
  })

  it('同域名不同 username → mode=new-account + existingUsernames', async () => {
    setCredentialMatchFn(async () => [
      { id: 'cred-1', url: 'https://example.com', username: 'alice', masked_password: '****' },
      { id: 'cred-2', url: 'https://example.com', username: 'bob', masked_password: '****' },
    ])
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'charlie',
      password: 'new-pw-12345',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      mode: 'new-account',
      username: 'charlie',
    })
    expect(prompts[0].existingUsernames).toEqual(['alice', 'bob'])
  })

  it('黑名单命中 → 不弹', async () => {
    setBlacklistCheckFn(async (d) => d === 'example.com')
    setCredentialMatchFn(async () => [])
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'pw-12345',
    })
    expect(prompts).toHaveLength(0)
  })

  it('verifyLoginSuccess 失败（仍在登录页）→ 不弹', async () => {
    __clearAllWebContentsForTest()
    __setWebContentsForTest('tab-1', makeWebContents({
      url: 'https://example.com/login', // URL 没变
      hasPasswordForm: true,
    }))
    setCredentialMatchFn(async () => [])
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: 'wrong-pw',
    })
    expect(prompts).toHaveLength(0)
  })

  it('空密码 → 直接 return（防御）', async () => {
    await onPasswordSubmitted('tab-1', {
      url: 'https://example.com/login',
      username: 'alice',
      password: '',
    })
    expect(prompts).toHaveLength(0)
  })

  it('非法 URL → 提取域名失败，return', async () => {
    await onPasswordSubmitted('tab-1', {
      url: 'not-a-url',
      username: 'alice',
      password: 'pw',
    })
    expect(prompts).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════
// Wave 3 修正版 真问题 1：dom-ready 重新注入
//
// 修复前：onViewDomReady 对同一 webContents 第二次 dom-ready 整段短路 →
//   installPasswordCaptureScript 不被调用 → OAuth 回调 / 多跳登录场景捕获脚本
//   随旧 document 销毁后没有重装。
// 修复后：每次 dom-ready 都调 installPasswordCaptureScript（脚本本身有
//   `__tabtinPasswordCaptureInstalled` 幂等保护，旧文档不会重复装；新文档真
//   正安装）。webContentsMap 注册 + detectLoginForm + autofill suggestion 仍
//   只在首次 dom-ready 跑（避免同 tab 二次 dom-ready 时重弹 overlay）。
// ════════════════════════════════════════════════════════════════════
describe('onViewDomReady — 真问题 1：dom-ready 多次都注入捕获脚本', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    setCredentialMatchFn(undefined as any)
    vi.mocked(installPasswordCaptureScript).mockClear()
  })

  it('同一 webContents 多次 dom-ready → installPasswordCaptureScript 被调用多次（OAuth 回调场景）', async () => {
    const wc = {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn(),
      on: vi.fn(),
      id: 1,
    } as unknown as Electron.WebContents

    await onViewDomReady('tab-multi-doc', wc)
    await onViewDomReady('tab-multi-doc', wc)
    await onViewDomReady('tab-multi-doc', wc)

    // 真问题 1 的核心断言：每次 dom-ready 都调一次（修复前是 1 次）
    expect(installPasswordCaptureScript).toHaveBeenCalledTimes(3)
  })

  it('about:blank / chrome:// → 跳过注入（首次注册仍登记 webContentsMap，让后续 sender 校验能命中）', async () => {
    const wc = {
      getURL: () => 'about:blank',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn(),
      on: vi.fn(),
      id: 2,
    } as unknown as Electron.WebContents

    await onViewDomReady('tab-blank', wc)
    expect(installPasswordCaptureScript).toHaveBeenCalledTimes(0)
  })

  it('首次 dom-ready 挂 destroyed + did-navigate-in-page；二次 dom-ready 不重复挂', async () => {
    const onceCalls: string[] = []
    const onCalls: string[] = []
    const wc = {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn((event: string) => onceCalls.push(event)),
      on: vi.fn((event: string) => onCalls.push(event)),
      id: 3,
    } as unknown as Electron.WebContents

    await onViewDomReady('tab-once', wc)
    await onViewDomReady('tab-once', wc)
    await onViewDomReady('tab-once', wc)

    // 同一 webContents 复用：destroyed listener 只挂一次
    expect(onceCalls.filter((e) => e === 'destroyed')).toHaveLength(1)
    // did-navigate-in-page 也只挂一次
    expect(onCalls.filter((e) => e === 'did-navigate-in-page')).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════
// Wave 3 三视角 Review 视角 3 P1 发现 1 自修：
// lastSuggestUrlByTab 用 origin+pathname 去重（query/hash 不同也算同 page）
// ════════════════════════════════════════════════════════════════════
describe('onViewDomReady — autofill suggest 去重 key 用 origin+pathname', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
    vi.mocked(installPasswordCaptureScript).mockClear()
  })

  it('同 tab 同 origin+pathname 但 query string 不同 → suggest 去重命中（不重复弹）', async () => {
    const matchFn = vi.fn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setCredentialMatchFn(matchFn)
    // detectLoginForm mock 返回 hasPassword=true 让 suggest 链路走完
    const detectModule = await import('./autofill-detector')
    vi.mocked(detectModule.detectLoginForm).mockResolvedValueOnce({
      hasPassword: true,
      hasUsername: true,
      passwordCount: 1,
    })
    vi.mocked(detectModule.detectLoginForm).mockResolvedValueOnce({
      hasPassword: true,
      hasUsername: true,
      passwordCount: 1,
    })

    const wc1 = {
      getURL: () => 'https://example.com/login?next=/foo',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn(),
      on: vi.fn(),
      id: 100,
    } as unknown as Electron.WebContents
    await onViewDomReady('tab-dedup', wc1)

    // 第二次：同 tab、同 webContents、相同 origin+pathname 但 query 不同
    const wc2 = {
      ...wc1,
      getURL: () => 'https://example.com/login?next=/bar',
    } as unknown as Electron.WebContents
    Object.assign(wc2, {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn(),
      on: vi.fn(),
      id: 100,
    })
    await onViewDomReady('tab-dedup', wc2)

    // suggest 只触发 1 次（origin+pathname 去重）
    expect(matchFn).toHaveBeenCalledTimes(1)
  })

  it('同 tab 不同 path → suggest 不去重（重新触发）', async () => {
    const matchFn = vi.fn(async () => [{
      id: 'cred-1',
      url: 'https://example.com',
      username: 'alice',
      masked_password: '****',
    }])
    setCredentialMatchFn(matchFn)
    const detectModule = await import('./autofill-detector')
    vi.mocked(detectModule.detectLoginForm).mockResolvedValue({
      hasPassword: true,
      hasUsername: true,
      passwordCount: 1,
    })

    const wc = {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      once: vi.fn(),
      on: vi.fn(),
      id: 200,
    } as unknown as Electron.WebContents
    await onViewDomReady('tab-paths', wc)

    // 同 wc 但 URL 切到不同 path
    Object.defineProperty(wc, 'getURL', { value: () => 'https://example.com/signin', configurable: true })
    await onViewDomReady('tab-paths', wc)

    expect(matchFn).toHaveBeenCalledTimes(2)
  })
})

// ════════════════════════════════════════════════════════════════════
// Wave 3 修正版 真问题 2：SPA 登录被误判失败
//
// 三类成功信号：URL 变化 / in-page navigation（pushState）/ title 变化。
// 任意一个 + 无密码框 = 成功。
// ════════════════════════════════════════════════════════════════════
describe('verifyLoginSuccess — 真问题 2：SPA 多信号识别', () => {
  beforeEach(() => {
    __clearAllWebContentsForTest()
  })

  it('SPA pushState 改 URL（main-frame URL 变了）+ 无密码框 → true', async () => {
    // 这是"传统跳转"和"SPA pushState 真改了 wc.getURL()"共用的强信号
    __setWebContentsForTest('tab-spa-1', {
      getURL: () => 'https://example.com/dashboard',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Dashboard',
      once: vi.fn(),
      id: 10,
    } as unknown as Electron.WebContents)
    const ok = await verifyLoginSuccess('tab-spa-1', 'https://example.com/login', {
      waitMs: 0,
      originalTitle: 'Login',
    })
    expect(ok).toBe(true)
  })

  it('SPA 只动 history（wc.getURL 字符串没变）→ in-page-nav 信号兜底', async () => {
    // accounts.google.com / Linear / Notion 一类：登录成功后用 pushState 切到
    // dashboard 视图，但 wc.getURL() 字符串可能仍是初始 URL（同源 pushState 不
    // 改 main-frame URL 的极端实现）。in-page-nav 信号必须能兜住。
    __setWebContentsForTest('tab-spa-2', {
      getURL: () => 'https://example.com/login', // 字符串没变
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 11,
    } as unknown as Electron.WebContents)
    const submitTs = 1_700_000_000_000
    // submit 之后发生过 in-page nav → 算成功
    __setInPageNavRecordForTest('tab-spa-2', submitTs + 100)

    const ok = await verifyLoginSuccess('tab-spa-2', 'https://example.com/login', {
      waitMs: 0,
      submitTimestamp: submitTs,
    })
    expect(ok).toBe(true)
  })

  it('SPA 极简（连 history 都不动）+ title 变了 → title 信号兜底', async () => {
    // 一些 SPA 用 DOM diff 切视图，连 history.pushState 都不调，但 document
    // .title 通常会改（比如从 "Sign in - Foo" 变成 "Foo Dashboard"）。
    __setWebContentsForTest('tab-spa-3', {
      getURL: () => 'https://example.com/app', // 没变
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'My Dashboard',
      once: vi.fn(),
      id: 12,
    } as unknown as Electron.WebContents)

    const ok = await verifyLoginSuccess('tab-spa-3', 'https://example.com/app', {
      waitMs: 0,
      originalTitle: 'Sign in',
    })
    expect(ok).toBe(true)
  })

  it('SPA pushState 但仍含密码框 → false（保守不弹，可能在 2FA 步骤）', async () => {
    __setWebContentsForTest('tab-spa-4', {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true), // 仍有密码框
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 13,
    } as unknown as Electron.WebContents)
    const submitTs = 1_700_000_000_000
    __setInPageNavRecordForTest('tab-spa-4', submitTs + 100)

    const ok = await verifyLoginSuccess('tab-spa-4', 'https://example.com/login', {
      waitMs: 0,
      submitTimestamp: submitTs,
    })
    expect(ok).toBe(false)
  })

  it('in-page nav 发生在 submit 之前 → 不算成功信号（防止把登录前的页面跳转误判）', async () => {
    __setWebContentsForTest('tab-spa-5', {
      getURL: () => 'https://example.com/login',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getTitle: () => 'Login',
      once: vi.fn(),
      id: 14,
    } as unknown as Electron.WebContents)
    const submitTs = 1_700_000_000_000
    // in-page nav 发生在 submit 之前 100ms
    __setInPageNavRecordForTest('tab-spa-5', submitTs - 100)

    const ok = await verifyLoginSuccess('tab-spa-5', 'https://example.com/login', {
      waitMs: 0,
      originalTitle: 'Login',
      submitTimestamp: submitTs,
    })
    expect(ok).toBe(false)
  })
})
