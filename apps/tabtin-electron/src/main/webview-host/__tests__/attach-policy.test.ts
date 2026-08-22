/**
 * attach-policy 白名单纯函数测试（ 安全防回归）
 *
 * 口径：will-attach-webview 是 renderer 声明 <webview> 的唯一安全裁决点，
 * renderer 可控输入（src / partition / preload / allowpopups / webPreferences）
 * 全部要过白名单。正/负对照成对出现。
 */

import { describe, it, expect } from 'vitest'
import * as path from 'path'
import {
  evaluateWillAttachWebview,
  extractTinInstanceId,
  isBrowserGuestPartitionAllowed,
  isTinGuestPartition,
  isPathInsideRoot,
  resolvePreloadPath,
  type AttachPolicyConfig,
} from '../attach-policy'

const KNOWN_TIN_ID = '5f0c2a1b-3d4e-4f60-8a9b-0c1d2e3f4a5b'
const UNKNOWN_TIN_ID = '99999999-9999-4999-8999-999999999999'

const policy: AttachPolicyConfig = {
  tinSandboxRoot: '/Users/test/Library/Application Support/tabtin/tin-sandboxes',
  isKnownTinInstance: (id) => id === KNOWN_TIN_ID,
}

const evaluate = (
  webPreferences: Record<string, unknown>,
  params: Record<string, unknown>,
) => evaluateWillAttachWebview(webPreferences, params, policy)

describe('attach-policy: partition 命名纪律', () => {
  it('放行：空 partition（共享默认 session，对齐 WCV forEmbedded）', () => {
    expect(isBrowserGuestPartitionAllowed('')).toBe(true)
  })

  it('放行：persist: + 已知业务前缀', () => {
    expect(isBrowserGuestPartitionAllowed('persist:tabtin:env:default')).toBe(true)
    expect(isBrowserGuestPartitionAllowed('persist:tabtin:organization:abc:browser')).toBe(true)
    expect(isBrowserGuestPartitionAllowed('persist:task-abc123')).toBe(true)
    expect(isBrowserGuestPartitionAllowed('persist:account-user-1')).toBe(true)
    expect(isBrowserGuestPartitionAllowed('persist:marketplace-appx')).toBe(true)
  })

  it('放行：temp- 临时（非 persist）', () => {
    expect(isBrowserGuestPartitionAllowed('temp-task1')).toBe(true)
  })

  it('拒绝：未知前缀 / 裸 persist / 前缀后为空', () => {
    expect(isBrowserGuestPartitionAllowed('persist:evil-thing')).toBe(false)
    expect(isBrowserGuestPartitionAllowed('persist:')).toBe(false)
    expect(isBrowserGuestPartitionAllowed('persist:task-')).toBe(false)
    expect(isBrowserGuestPartitionAllowed('random-partition')).toBe(false)
    expect(isBrowserGuestPartitionAllowed('tabtin:env:default')).toBe(false) // 缺 persist:
  })

  it('拒绝：非法字符（含空格 / 斜杠 / 路径穿越形态）', () => {
    expect(isBrowserGuestPartitionAllowed('persist:task-a b')).toBe(false)
    expect(isBrowserGuestPartitionAllowed('persist:task-../x')).toBe(false)
  })

  it('tin partition 识别：persist:tin-<严格 UUID> 才是 tin，其余不是', () => {
    expect(isTinGuestPartition(`persist:tin-${KNOWN_TIN_ID}`)).toBe(true)
    expect(extractTinInstanceId(`persist:tin-${KNOWN_TIN_ID}`)).toBe(KNOWN_TIN_ID)
    // 非 UUID 形态不能借 tin- 前缀混进 tin 分支
    expect(isTinGuestPartition('persist:tin-2f3a')).toBe(false)
    expect(isTinGuestPartition('persist:tin-')).toBe(false)
    expect(isTinGuestPartition('persist:task-1')).toBe(false)
  })
})

describe('attach-policy: 浏览器 guest', () => {
  it('放行：https src + 合法 partition，强制安全 webPreferences 并 strip preload 键', () => {
    const decision = evaluate({}, { src: 'https://example.com', partition: 'persist:tabtin:env:default' })
    expect(decision.action).toBe('allow')
    if (decision.action !== 'allow') return
    expect(decision.guestKind).toBe('browser')
    expect(decision.enforceWebPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
    })
    expect(decision.stripKeys).toEqual(expect.arrayContaining(['preload', 'preloadURL']))
  })

  it('放行：about:blank / 空 src（未设 src 的初始 attach）', () => {
    expect(evaluate({}, { src: 'about:blank', partition: '' }).action).toBe('allow')
    expect(evaluate({}, { src: '', partition: '' }).action).toBe('allow')
  })

  it('拒绝：恶意 preload（任何属性级 preload 都不放行）', () => {
    const decision = evaluate(
      { preload: '/tmp/evil-preload.js' },
      { src: 'https://example.com', partition: 'persist:tabtin:env:default' },
    )
    expect(decision.action).toBe('deny')
  })

  it('拒绝：preloadURL 形态的注入', () => {
    const decision = evaluate(
      { preloadURL: 'file:///tmp/evil.js' },
      { src: 'https://example.com', partition: '' },
    )
    expect(decision.action).toBe('deny')
  })

  it('nodeintegration 请求被强制覆盖为 false（不 deny，覆盖后放行）', () => {
    const decision = evaluate(
      { nodeIntegration: true, sandbox: false, contextIsolation: false },
      { src: 'https://example.com', partition: '' },
    )
    expect(decision.action).toBe('allow')
    if (decision.action !== 'allow') return
    expect(decision.enforceWebPreferences.nodeIntegration).toBe(false)
    expect(decision.enforceWebPreferences.sandbox).toBe(true)
    expect(decision.enforceWebPreferences.contextIsolation).toBe(true)
  })

  it('拒绝：非法 src（file / javascript / chrome / data）', () => {
    for (const src of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome://settings',
      'data:text/html,<script>1</script>',
      'about:config',
    ]) {
      const decision = evaluate({}, { src, partition: '' })
      expect(decision.action, `src=${src} 应被拒绝`).toBe('deny')
    }
  })

  it('拒绝：坏 partition', () => {
    const decision = evaluate({}, { src: 'https://example.com', partition: 'persist:evil' })
    expect(decision.action).toBe('deny')
  })

  it('放行：allowpopups（popup 由主进程 setWindowOpenHandler 接管）', () => {
    const decision = evaluate({}, { src: 'https://example.com', partition: '', allowpopups: 'true' })
    expect(decision.action).toBe('allow')
  })
})

describe('attach-policy: 浏览器 guest 的受限 file:// 放行', () => {
  const previewRoot = '/Users/test/space-work-dir'
  // 谓词只放行落在 previewRoot 内的 file://（模拟 handler 注入的 isAllowedLocalFileUrl）
  const policyWithFile: AttachPolicyConfig = {
    tinSandboxRoot: policy.tinSandboxRoot,
    isKnownTinInstance: policy.isKnownTinInstance,
    isAllowedBrowserFileSrc: (src) => {
      try {
        const url = new URL(src)
        if (url.protocol !== 'file:') return false
        return isPathInsideRoot(decodeURIComponent(url.pathname), previewRoot)
      } catch {
        return false
      }
    },
  }
  const evalWithFile = (params: Record<string, unknown>) =>
    evaluateWillAttachWebview({}, params, policyWithFile)

  it('放行：预览根内的 file:// src（浏览器 guest，强制安全 webPreferences）', () => {
    const src = `file://${previewRoot}/report.html`
    const decision = evalWithFile({ src, partition: '' })
    expect(decision.action).toBe('allow')
    if (decision.action !== 'allow') return
    expect(decision.guestKind).toBe('browser')
    expect(decision.enforceWebPreferences).toMatchObject({ sandbox: true, webSecurity: true })
    expect(decision.stripKeys).toEqual(expect.arrayContaining(['preload', 'preloadURL']))
  })

  it('拒绝：预览根外的 file:// src（越权）', () => {
    expect(evalWithFile({ src: 'file:///etc/passwd', partition: '' }).action).toBe('deny')
    expect(evalWithFile({ src: `file://${previewRoot}-evil/x.html`, partition: '' }).action).toBe('deny')
  })

  it('拒绝：谓词未注入时 file:// 一律 fail-closed（默认 policy 无 isAllowedBrowserFileSrc）', () => {
    const src = `file://${previewRoot}/report.html`
    expect(evaluate({}, { src, partition: '' }).action).toBe('deny')
  })

  it('拒绝：谓词存在但 src 非 file 协议（javascript / data 仍拦下）', () => {
    expect(evalWithFile({ src: 'javascript:alert(1)', partition: '' }).action).toBe('deny')
    expect(evalWithFile({ src: 'data:text/html,<script>1</script>', partition: '' }).action).toBe('deny')
  })

  it('放行：预览根内 file:// 但 partition 非法时仍按命名纪律拒绝（放行不绕过 partition 门）', () => {
    const src = `file://${previewRoot}/report.html`
    expect(evalWithFile({ src, partition: 'persist:evil' }).action).toBe('deny')
  })
})

describe('attach-policy: tin 沙箱 guest（ 前置）', () => {
  const tinPartition = `persist:tin-${KNOWN_TIN_ID}`
  const tinPreload = path.join(policy.tinSandboxRoot, KNOWN_TIN_ID, 'preload.js')
  const tinHtml = `file://${path.join(policy.tinSandboxRoot, KNOWN_TIN_ID, 'panel.html')}`

  it('放行：tin partition + 沙箱内 preload + file src', () => {
    const decision = evaluate(
      { preload: tinPreload },
      { src: tinHtml, partition: tinPartition },
    )
    expect(decision.action).toBe('allow')
    if (decision.action !== 'allow') return
    expect(decision.guestKind).toBe('tin')
    expect(decision.enforceWebPreferences.sandbox).toBe(true)
  })

  it('放行：tin data:text/html src（无 htmlPath 的回退形态）', () => {
    const decision = evaluate({}, { src: 'data:text/html;charset=utf-8,hello', partition: tinPartition })
    expect(decision.action).toBe('allow')
  })

  it('拒绝：tin preload 逃逸沙箱目录（.. 穿越）', () => {
    const escape = path.join(policy.tinSandboxRoot, '..', 'evil.js')
    const decision = evaluate({ preload: escape }, { src: tinHtml, partition: tinPartition })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：tin preload 指向沙箱外绝对路径', () => {
    const decision = evaluate({ preload: '/tmp/evil.js' }, { src: tinHtml, partition: tinPartition })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：tin src 指向沙箱外 file://', () => {
    const decision = evaluate({}, { src: 'file:///etc/passwd', partition: tinPartition })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：tin guest 请求 allowpopups', () => {
    const decision = evaluate({}, { src: tinHtml, partition: tinPartition, allowpopups: 'true' })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：tin src 是 http（tin 只能加载本地沙箱物料）', () => {
    const decision = evaluate({}, { src: 'https://evil.example.com', partition: tinPartition })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：伪造的 tin partition（UUID 合法但实例不存在）——防冒用 data:/file: 放行', () => {
    const decision = evaluate({}, {
      src: 'data:text/html;charset=utf-8,evil',
      partition: `persist:tin-${UNKNOWN_TIN_ID}`,
    })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：非 UUID 的 tin- 前缀 partition 落入浏览器分支并被命名纪律拦下', () => {
    const decision = evaluate({}, { src: 'data:text/html,evil', partition: 'persist:tin-x' })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：实例校验器未注入时 fail-closed', () => {
    const decision = evaluateWillAttachWebview({}, { src: tinHtml, partition: tinPartition }, {
      tinSandboxRoot: policy.tinSandboxRoot,
    })
    expect(decision.action).toBe('deny')
  })

  it('拒绝：跨实例读取（preload/src 指向其他 tin 实例目录）', () => {
    const otherPreload = path.join(policy.tinSandboxRoot, UNKNOWN_TIN_ID, 'preload.js')
    expect(evaluate({ preload: otherPreload }, { src: tinHtml, partition: tinPartition }).action).toBe('deny')
    const otherHtml = `file://${path.join(policy.tinSandboxRoot, UNKNOWN_TIN_ID, 'panel.html')}`
    expect(evaluate({}, { src: otherHtml, partition: tinPartition }).action).toBe('deny')
  })
})

describe('attach-policy: 路径帮助函数', () => {
  it('resolvePreloadPath：file:// URL 与绝对路径都解析；相对路径拒绝', () => {
    expect(resolvePreloadPath('file:///a/b/c.js')).toBe(path.resolve('/a/b/c.js'))
    expect(resolvePreloadPath('/a/b/c.js')).toBe(path.resolve('/a/b/c.js'))
    expect(resolvePreloadPath('relative/evil.js')).toBeNull()
  })

  it('resolvePreloadPath：URL 编码的穿越被展开后仍受 isPathInsideRoot 约束', () => {
    const sneaky = resolvePreloadPath('file:///root/tin-sandboxes/%2e%2e/evil.js')
    expect(sneaky).not.toBeNull()
    expect(isPathInsideRoot(sneaky!, '/root/tin-sandboxes')).toBe(false)
  })

  it('isPathInsideRoot：前缀相似目录不误放行', () => {
    expect(isPathInsideRoot('/root/tin-sandboxes-evil/x.js', '/root/tin-sandboxes')).toBe(false)
    expect(isPathInsideRoot('/root/tin-sandboxes/x.js', '/root/tin-sandboxes')).toBe(true)
  })
})
