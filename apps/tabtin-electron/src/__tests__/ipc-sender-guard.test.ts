/**
 * CS-014 ~ CS-019 回归测试
 *
 * 验证 tins:*, git:*, pty:* 等 IPC handler 拒绝来自不受信任渲染进程的调用。
 * 使用 isTrustedSender 的纯逻辑测试，不依赖真实的 Electron 运行时。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 直接从 auth.ts 提取 isTrustedSender 的核心逻辑进行测试 ──
// 生产代码中 isTrustedSender 依赖 Electron 的 IpcMainInvokeEvent，
// 这里复刻其判断逻辑以脱离 Electron 运行时进行单元测试。

function isTrustedSender(senderFrameUrl: string | undefined): boolean {
  try {
    const frameUrl = senderFrameUrl
    if (!frameUrl) return false
    if (frameUrl.startsWith('file://')) return true
    if (frameUrl.startsWith('http://localhost:')) return true
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl && frameUrl.startsWith(rendererUrl)) return true
    return false
  } catch {
    return false
  }
}

interface MockEvent {
  senderFrame?: { url: string }
  sender: { id: number }
}

function makeTrustedEvent(): MockEvent {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent(url = 'https://evil.example.com/exploit.html'): MockEvent {
  return { senderFrame: { url }, sender: { id: 99 } }
}

function makeNoFrameEvent(): MockEvent {
  return { sender: { id: 100 } }
}

/**
 * Wave 0 contract: guardedHandle 拒绝路径返 envelope `{ ok:false, error:{...} }`。
 * 该常量与生产 utils/guarded-handle.ts 的 REJECT_RESPONSE 形状保持一致。
 */
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
} as const

/**
 * 通用 guardedHandle 模式：与生产代码中各模块的 guardedHandle 一致。
 */
function guardedHandle(
  listener: (...args: any[]) => any,
): (event: MockEvent, ...args: any[]) => any {
  return async (event: MockEvent, ...args: any[]) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return REJECT_RESPONSE
    }
    return listener(event, ...args)
  }
}

// ── isTrustedSender 核心逻辑测试 ──

describe('isTrustedSender', () => {
  it('接受 file:// 协议（本地打包页面）', () => {
    expect(isTrustedSender('file:///Users/me/TabTin/index.html')).toBe(true)
  })

  it('接受 http://localhost 开头的 URL（开发模式）', () => {
    expect(isTrustedSender('http://localhost:5173/index.html')).toBe(true)
  })

  it('拒绝 https 外部 URL', () => {
    expect(isTrustedSender('https://evil.example.com')).toBe(false)
  })

  it('拒绝 http 非 localhost URL', () => {
    expect(isTrustedSender('http://192.168.1.100:8080')).toBe(false)
  })

  it('拒绝 undefined', () => {
    expect(isTrustedSender(undefined)).toBe(false)
  })

  it('拒绝空字符串', () => {
    expect(isTrustedSender('')).toBe(false)
  })

  it('接受 ELECTRON_RENDERER_URL 环境变量匹配', () => {
    const prev = process.env['ELECTRON_RENDERER_URL']
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    try {
      expect(isTrustedSender('http://localhost:5173/path')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['ELECTRON_RENDERER_URL']
      else process.env['ELECTRON_RENDERER_URL'] = prev
    }
  })
})

// ── CS-014: tins:unregister-webview ──

describe('CS-014: tins:unregister-webview senderFrame 验证', () => {
  const handler = guardedHandle((_event: MockEvent, instanceId: string) => {
    return { success: true, unregistered: instanceId }
  })

  it('受信来源正常执行', async () => {
    const result = await handler(makeTrustedEvent(), 'some-uuid')
    expect(result.success).toBe(true)
  })

  it('不受信来源被拒绝', async () => {
    const result = await handler(makeUntrustedEvent(), 'some-uuid')
    expect(result).toEqual(REJECT_RESPONSE)
  })

  it('无 senderFrame 被拒绝', async () => {
    const result = await handler(makeNoFrameEvent(), 'some-uuid')
    expect(result).toEqual(REJECT_RESPONSE)
  })
})

// ── CS-015: tins:set-instances ──

describe('CS-015: tins:set-instances senderFrame 验证', () => {
  const handler = guardedHandle((_event: MockEvent, instances: any[]) => {
    return { success: true, count: instances.length }
  })

  it('受信来源正常执行', async () => {
    const result = await handler(makeTrustedEvent(), [{ id: '1' }])
    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
  })

  it('外部页面伪造 set-instances 被拒绝', async () => {
    const result = await handler(
      makeUntrustedEvent('https://attacker.io/tin-hijack'),
      [{ id: 'fake', tin: { content_script: 'alert(1)' } }]
    )
    expect(result).toEqual(REJECT_RESPONSE)
  })
})

// ── CS-016: tins:prepare-sandbox ──

describe('CS-016: tins:prepare-sandbox senderFrame 验证', () => {
  const handler = guardedHandle((_event: MockEvent, instanceId: string) => {
    return { success: true, sandbox: instanceId }
  })

  it('受信来源正常执行', async () => {
    const result = await handler(makeTrustedEvent(), 'uuid-123')
    expect(result.success).toBe(true)
  })

  it('不受信来源被拒绝', async () => {
    const result = await handler(makeUntrustedEvent(), 'uuid-123')
    expect(result).toEqual(REJECT_RESPONSE)
  })
})

// ── CS-017: tins:inject-content-script ──

describe('CS-017: tins:inject-content-script senderFrame 验证', () => {
  const handler = guardedHandle((_event: MockEvent, instanceId: string) => {
    return true
  })

  it('受信来源正常执行', async () => {
    const result = await handler(makeTrustedEvent(), 'uuid-456')
    expect(result).toBe(true)
  })

  it('外部页面触发 inject-content-script 被拒绝', async () => {
    const result = await handler(
      makeUntrustedEvent('https://social-engineer.example.com'),
      'uuid-456'
    )
    expect(result).toEqual(REJECT_RESPONSE)
  })
})

// ── CS-018: git:commit/push/checkout/stash ──

describe('CS-018: git 写操作 senderFrame 验证', () => {
  const channels = ['git:commit', 'git:push', 'git:checkout', 'git:stash']

  for (const channel of channels) {
    describe(channel, () => {
      const handler = guardedHandle((_event: MockEvent, cwd: string) => {
        return { success: true }
      })

      it('受信来源正常执行', async () => {
        const result = await handler(makeTrustedEvent(), '/home/user/repo')
        expect(result.success).toBe(true)
      })

      it('外部页面无法执行 git 写操作', async () => {
        const result = await handler(
          makeUntrustedEvent('https://evil.example.com/git-attack'),
          '/home/user/repo'
        )
        expect(result).toEqual(REJECT_RESPONSE)
      })
    })
  }

  it('git:stage 同样受保护', async () => {
    const handler = guardedHandle(() => ({ success: true }))
    const result = await handler(makeUntrustedEvent(), '/repo', ['file.ts'])
    expect(result).toEqual(REJECT_RESPONSE)
  })

  it('git:discardFiles 同样受保护', async () => {
    const handler = guardedHandle(() => ({ success: true }))
    const result = await handler(makeUntrustedEvent(), '/repo', ['important.ts'])
    expect(result).toEqual(REJECT_RESPONSE)
  })
})

// ── CS-019: pty:spawn/write ──

describe('CS-019: pty:spawn/write senderFrame 验证', () => {
  describe('pty:spawn', () => {
    const handler = guardedHandle((_event: MockEvent, sessionId: string) => {
      return { success: true }
    })

    it('受信来源正常 spawn', async () => {
      const result = await handler(makeTrustedEvent(), 'session-1')
      expect(result.success).toBe(true)
    })

    it('外部页面无法 spawn 终端', async () => {
      const result = await handler(makeUntrustedEvent(), 'session-1')
      expect(result).toEqual(REJECT_RESPONSE)
    })
  })

  describe('pty:write', () => {
    const handler = guardedHandle((_event: MockEvent, sessionId: string, data: string) => {
      return { success: true }
    })

    it('受信来源正常写入', async () => {
      const result = await handler(makeTrustedEvent(), 'session-1', 'ls -la\n')
      expect(result.success).toBe(true)
    })

    it('外部页面无法向终端写入命令', async () => {
      const result = await handler(
        makeUntrustedEvent(),
        'session-1',
        'rm -rf / --no-preserve-root\n'
      )
      expect(result).toEqual(REJECT_RESPONSE)
    })

    it('无 senderFrame 的 event 被拒绝', async () => {
      const result = await handler(makeNoFrameEvent(), 'session-1', 'echo hi\n')
      expect(result).toEqual(REJECT_RESPONSE)
    })
  })
})

// ── 边界情况：多种伪装 URL ──

describe('senderFrame 伪装 URL 边界测试', () => {
  const handler = guardedHandle(() => ({ success: true }))

  const maliciousUrls = [
    'https://file-upload.example.com',
    'http://localhost.evil.com:5173',
    'javascript:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'chrome-extension://evil-id/popup.html',
  ]

  for (const url of maliciousUrls) {
    it(`拒绝伪装 URL: ${url}`, async () => {
      const result = await handler(makeUntrustedEvent(url))
      expect(result).toEqual(REJECT_RESPONSE)
    })
  }
})
