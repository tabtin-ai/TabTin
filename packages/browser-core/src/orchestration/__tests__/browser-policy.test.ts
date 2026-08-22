import { describe, it, expect } from 'vitest'
import {
  collectBrowserActionIdsForPolicy,
  evaluateBrowserActionPolicy,
  evaluateBrowserRoutePolicy,
  getBrowserCommandRisk,
  resolveBrowserActionIdForPolicy,
  type BrowserPolicyDecision,
} from '../browser-policy'

// 测试用工作区根：用不存在的绝对前缀，normalize realpath 退化为字面量，判定结果与机器无关。
const WS_ROOT = '/nonexistent-tabtin-test/workspace'

describe('getBrowserCommandRisk（读 generated contract）', () => {
  it('read 档命令（open/glance/print/tab.list）', () => {
    expect(getBrowserCommandRisk('open')).toBe('read')
    expect(getBrowserCommandRisk('glance')).toBe('read')
    expect(getBrowserCommandRisk('print')).toBe('read')
    expect(getBrowserCommandRisk('tab.list')).toBe('read')
  })

  it('导航类命令的 policyRisk 覆盖为 read（open/nav/tab.switch）', () => {
    expect(getBrowserCommandRisk('open')).toBe('read')
    expect(getBrowserCommandRisk('nav')).toBe('read')
    expect(getBrowserCommandRisk('tab.switch')).toBe('read')
    expect(getBrowserCommandRisk('cookies.set')).toBe('write')
  })

  it('policyRisk 高风险档命令（act/eval/batch）', () => {
    expect(getBrowserCommandRisk('act')).toBe('high-risk-write')
    expect(getBrowserCommandRisk('eval')).toBe('high-risk-write')
    expect(getBrowserCommandRisk('batch')).toBe('high-risk-write')
  })

  it('未注册 actionId → fail-safe 当 write', () => {
    expect(getBrowserCommandRisk('does-not-exist')).toBe('write')
  })
})

describe('evaluateBrowserActionPolicy — risk 兜底', () => {
  it('read → allow（含  browser open）', () => {
    expect(evaluateBrowserActionPolicy('open', { url: 'https://example.com' })).toEqual({
      action: 'allow',
    })
    expect(evaluateBrowserActionPolicy('glance', {})).toEqual({ action: 'allow' })
    expect(evaluateBrowserActionPolicy('print', { save: '/tmp/x.md' })).toEqual({
      action: 'allow',
    })
  })

  it('导航类命令自动放行', () => {
    expect(evaluateBrowserActionPolicy('open', { url: 'https://example.com' })).toEqual({ action: 'allow' })
    expect(evaluateBrowserActionPolicy('nav', { direction: 'back' })).toEqual({ action: 'allow' })
    expect(evaluateBrowserActionPolicy('tab.switch', { tab_id: 'tab-1' })).toEqual({ action: 'allow' })
  })

  it('high-risk-write → confirm（不改变默认确认行为，只提高可读风险档）', () => {
    const d = evaluateBrowserActionPolicy('eval', { expression: 'document.title' })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('eval')
    expect(c.detail).toContain('risk=high-risk-write')
  })

  it('cookies.set（write）→ confirm', () => {
    const d = evaluateBrowserActionPolicy('cookies.set', { action: 'set', name: 'a', value: 'b' })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('cookies.set')
    expect(c.detail).toContain('risk=write')
  })
})

describe('browser route policy helpers', () => {
  it('按 route + fixedFields 解析 cookies 子命令', () => {
    expect(resolveBrowserActionIdForPolicy('/browser/cookies', { action: 'set' })).toBe('cookies.set')
    expect(resolveBrowserActionIdForPolicy('/browser/cookies', { action: 'clear' })).toBe('cookies.clear')
    expect(resolveBrowserActionIdForPolicy('/browser/cookies', { action: 'get' })).toBe('cookies.get')
  })

  it('batch 收集外层和子 action，供 Electron middleware 预授权去重', () => {
    expect(collectBrowserActionIdsForPolicy('/browser/batch', {
      actions: [
        { type: 'act', actions: [{ type: 'click', selector: '#x' }] },
        { type: 'cookies', action: 'clear' },
      ],
    })).toEqual(['batch', 'act', 'cookies.clear'])
  })

  it('batch 子动作命中 block 时，外层 route policy 直接阻断', () => {
    const d = evaluateBrowserRoutePolicy('/browser/batch', {
      actions: [
        { type: 'eval', expression: 'document.cookie' },
        { type: 'act', actions: [{ type: 'click', selector: '#x' }] },
      ],
    })
    expect(d?.action).toBe('block')
    expect((d as Extract<BrowserPolicyDecision, { action: 'block' }>).ruleName).toBe('blocked-script')
  })

  it('batch confirm detail 展示将被预授权的子动作清单', () => {
    const d = evaluateBrowserRoutePolicy('/browser/batch', {
      actions: [
        { type: 'act', actions: [{ type: 'click', selector: '#x' }] },
        { type: 'cookies', action: 'clear' },
      ],
    })

    expect(d?.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('batch')
    expect(c.detail).toContain('childActions=[act, cookies.clear]')
  })
})

describe('evaluateBrowserActionPolicy — eval 脚本拦截', () => {
  it('blockedScript（document.cookie）→ block', () => {
    const d = evaluateBrowserActionPolicy('eval', { expression: 'return document.cookie' })
    expect(d.action).toBe('block')
    const b = d as Extract<BrowserPolicyDecision, { action: 'block' }>
    expect(b.code).toBe('POLICY_BLOCKED')
    expect(b.ruleName).toBe('blocked-script')
  })

  it('blockedScript（localStorage）→ block，从 opts.expression 读', () => {
    const d = evaluateBrowserActionPolicy(
      'eval',
      {},
      { expression: 'localStorage.getItem("token")' },
    )
    expect(d.action).toBe('block')
  })

  it('hardline command（rm -rf /）→ block，携规则名', () => {
    const d = evaluateBrowserActionPolicy('eval', { code: 'rm -rf /' })
    expect(d.action).toBe('block')
    const b = d as Extract<BrowserPolicyDecision, { action: 'block' }>
    expect(b.code).toBe('POLICY_BLOCKED')
    expect(b.ruleName).toBeTruthy()
    expect(b.ruleName).not.toBe('blocked-script')
  })

  it('普通 eval 脚本（无红线）→ 回落 risk=write → confirm', () => {
    const d = evaluateBrowserActionPolicy('eval', { expression: 'document.title' })
    expect(d.action).toBe('confirm')
    expect((d as { actionType: string }).actionType).toBe('eval')
  })
})

describe('evaluateBrowserActionPolicy — act 子操作解析', () => {
  it('含 upload/submit → confirm，detail 标注敏感子动作', () => {
    const d = evaluateBrowserActionPolicy('act', {
      actions: [
        { type: 'click', selector: '#open' },
        { type: 'upload', selector: '#file', files: ['/tmp/a.png'] },
        { type: 'submit', selector: 'form' },
      ],
    })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('act')
    expect(c.reason).toContain('upload')
    expect(c.reason).toContain('submit')
    expect(c.detail).toContain('upload')
  })

  it('含 fill → confirm（敏感输入）', () => {
    const d = evaluateBrowserActionPolicy('act', {
      actions: [{ type: 'fill', selector: '#q', value: 'secret' }],
    })
    expect(d.action).toBe('confirm')
    expect((d as { reason: string }).reason).toContain('fill')
  })

  it('纯 click（无敏感子动作）→ 按 risk=write 仍 confirm', () => {
    const d = evaluateBrowserActionPolicy('act', {
      actions: [{ type: 'click', selector: '#btn' }],
    })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('act')
    expect(c.detail).toContain('click')
  })

  it('空 actions → 仍 confirm（act 本体 write）', () => {
    const d = evaluateBrowserActionPolicy('act', { actions: [] })
    expect(d.action).toBe('confirm')
  })
})

describe('evaluateBrowserActionPolicy — 输出路径边界', () => {
  it('落盘到工作区外 → block', () => {
    const d = evaluateBrowserActionPolicy(
      'resource.download',
      { output: '/nonexistent-tabtin-test/other/secret.bin' },
      { workspaceRoots: [WS_ROOT] },
    )
    expect(d.action).toBe('block')
    const b = d as Extract<BrowserPolicyDecision, { action: 'block' }>
    expect(b.code).toBe('POLICY_BLOCKED')
    expect(b.ruleName).toBe('path-out-of-workspace')
  })

  it('落盘在工作区内 → 不被边界拦（read 命令回落 allow）', () => {
    const d = evaluateBrowserActionPolicy(
      'resource.download',
      { output: `${WS_ROOT}/out/result.json` },
      { workspaceRoots: [WS_ROOT] },
    )
    expect(d.action).toBe('allow')
  })

  it('未提供 workspaceRoots → 跳过边界判定（不误拦）', () => {
    const d = evaluateBrowserActionPolicy('resource.download', {
      output: '/nonexistent-tabtin-test/other/secret.bin',
    })
    expect(d.action).toBe('allow')
  })

  it('block 优先级高于 risk：read 命令落盘越界也 block', () => {
    // resource.download 契约 risk=read，但越界落盘仍须先 block（block 早于 risk allow）。
    expect(getBrowserCommandRisk('resource.download')).toBe('read')
    const d = evaluateBrowserActionPolicy(
      'resource.download',
      { save_path: '/nonexistent-tabtin-test/elsewhere/x.mp4' },
      { workspaceRoots: [WS_ROOT] },
    )
    expect(d.action).toBe('block')
  })
})

describe('evaluateBrowserActionPolicy — BW-5 域名白名单', () => {
  it('open/nav 目标域名不在 allowedDomains 内 → block，confirm 不能绕过', () => {
    const d = evaluateBrowserActionPolicy(
      'open',
      { url: 'https://evil.example/login' },
      { allowedDomains: ['trusted.example'] },
    )

    expect(d.action).toBe('block')
    const b = d as Extract<BrowserPolicyDecision, { action: 'block' }>
    expect(b.code).toBe('POLICY_BLOCKED')
    expect(b.ruleName).toBe('domain-allowlist')
  })

  it('allowedDomains 允许同域与子域后，open 自动放行', () => {
    const d = evaluateBrowserActionPolicy(
      'open',
      { url: 'https://app.trusted.example/dashboard' },
      { allowedDomains: ['trusted.example'] },
    )

    expect(d).toEqual({ action: 'allow' })
  })

  it('batch 子动作的导航白名单 block 会阻断整个 batch', () => {
    const d = evaluateBrowserRoutePolicy(
      '/browser/batch',
      {
        actions: [
          { type: 'open', url: 'https://tracker.third-party.test/pixel' },
          { type: 'act', actions: [{ type: 'click', selector: '#ok' }] },
        ],
      },
      { allowedDomains: ['trusted.example'] },
    )

    expect(d?.action).toBe('block')
    expect((d as Extract<BrowserPolicyDecision, { action: 'block' }>).ruleName).toBe(
      'domain-allowlist',
    )
  })

  it('下载 URL 不在白名单内 → block；白名单通过后仍保留媒体下载护栏', () => {
    const blocked = evaluateBrowserActionPolicy(
      'resource.download',
      { url: 'https://cdn.evil.example/v.mp4' },
      { allowedDomains: ['media.example'] },
    )
    expect(blocked.action).toBe('block')

    const guarded = evaluateBrowserActionPolicy(
      'resource.download',
      { url: 'https://media.example/private.mp4?jwt=abc' },
      { allowedDomains: ['media.example'] },
    )
    expect(guarded.action).toBe('confirm')
    expect((guarded as Extract<BrowserPolicyDecision, { action: 'confirm' }>).detail).toContain(
      'ephemeral-signed-url',
    )
  })

  it('resource.smart-download 显式 URL 不在白名单内 → block', () => {
    const d = evaluateBrowserActionPolicy(
      'resource.smart-download',
      { url: 'https://cdn.evil.example/v.mp4', quality: 'best' },
      { allowedDomains: ['media.example'] },
    )

    expect(d.action).toBe('block')
    const b = d as Extract<BrowserPolicyDecision, { action: 'block' }>
    expect(b.ruleName).toBe('domain-allowlist')
    expect(b.message).toContain('cdn.evil.example')
  })
})

describe('evaluateBrowserActionPolicy — BR-30 媒体下载护栏', () => {
  it('临时签名 URL 下载（GitHub private-user-images JWT）→ 从 read 升级为 confirm', () => {
    // 修前：resource.download contract risk=read → allow（无任何确认，BR-30 误下载根因）。
    expect(getBrowserCommandRisk('resource.download')).toBe('read')
    const d = evaluateBrowserActionPolicy('resource.download', {
      url: 'https://private-user-images.githubusercontent.com/1/a.mp4?jwt=eyJ',
    })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.actionType).toBe('resource.download')
    expect(c.detail).toContain('guardrail=[ephemeral-signed-url]')
    expect(c.reason).toContain('临时签名 URL')
  })

  it('AWS 预签名 URL 的 stream.download → confirm', () => {
    const d = evaluateBrowserActionPolicy('stream.download', {
      url: 'https://b.s3.amazonaws.com/v.m3u8?X-Amz-Signature=abc&X-Amz-Expires=900',
    })
    expect(d.action).toBe('confirm')
  })

  it('大文件（body.size > 阈值）→ confirm，detail 标 suggestAsync', () => {
    const d = evaluateBrowserActionPolicy('resource.download', {
      url: 'https://example.com/big.mp4',
      size: 200 * 1024 * 1024,
    })
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.detail).toContain('guardrail=[large-file]')
    expect(c.detail).toContain('suggestAsync=true')
  })

  it('跨站资源（host 注入 pageUrl）→ confirm', () => {
    const d = evaluateBrowserActionPolicy(
      'resource.download',
      { url: 'https://cdn.other.com/v.mp4' },
      { pageUrl: 'https://app.example.com/watch' },
    )
    expect(d.action).toBe('confirm')
    const c = d as Extract<BrowserPolicyDecision, { action: 'confirm' }>
    expect(c.detail).toContain('cross-origin')
  })

  it('普通同站下载（无风险信号）→ 仍 read→allow（零行为变更，不退化正常采集）', () => {
    const d = evaluateBrowserActionPolicy('resource.download', {
      url: 'https://example.com/photo.jpg',
    })
    expect(d.action).toBe('allow')
  })

  it('未提供 pageUrl 时不强行判跨站 → allow（闸门不猜页面上下文）', () => {
    const d = evaluateBrowserActionPolicy('resource.download', {
      url: 'https://cdn.other.com/v.mp4',
    })
    expect(d.action).toBe('allow')
  })

  it('护栏在 block 之后：临时签名 URL + 落盘越界 → 仍 block（安全硬线优先）', () => {
    const d = evaluateBrowserActionPolicy(
      'resource.download',
      {
        url: 'https://private-user-images.githubusercontent.com/1/a.mp4?jwt=x',
        save_path: '/nonexistent-tabtin-test/elsewhere/x.mp4',
      },
      { workspaceRoots: [WS_ROOT] },
    )
    expect(d.action).toBe('block')
  })

  it('smart-download 无 url（页面挑）+ 无 size → allow（闸门拿不到目标，靠 skill/hook 护栏）', () => {
    const d = evaluateBrowserActionPolicy('resource.smart-download', { quality: 'best' })
    expect(d.action).toBe('allow')
  })

  it('非下载类 read 命令不受护栏影响（resource.list → allow）', () => {
    expect(evaluateBrowserActionPolicy('resource.list', {})).toEqual({ action: 'allow' })
    expect(evaluateBrowserActionPolicy('resource.probe', {})).toEqual({ action: 'allow' })
    expect(evaluateBrowserActionPolicy('stream.info', {})).toEqual({ action: 'allow' })
  })
})
