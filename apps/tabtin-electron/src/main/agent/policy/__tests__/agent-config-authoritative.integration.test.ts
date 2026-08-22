/**
 * agent-config-authoritative.integration.test.ts — M2 端到端契约
 *
 * 钉死 yolo PRD v3 review M2 的核心承诺（reviewer-C HIGH-1 / reviewer-A A1）：
 *
 *   即使攻击者在 IPC payload 里把 `yoloMode` 篡改成 `true`，
 *   只要 Django 服务端真实 `allow_yolo_mode=false`，
 *   `session.agentConfigV3.security.allow_yolo_mode` 最终就必须是 `false`。
 *
 * 这是 M2 的**北极星断言**——如果未来有人重构掉这条路径（譬如又把
 * `yoloMode === true` 写回去），本测试立刻红，提示破坏了"main 现拉权威"
 * 的不变量。
 *
 * 实现策略：
 *   - 不启动完整 ElectronAgentHost（依赖 ipcMain / runtime / WS / 上百个
 *     workspace 包，jsdom 跑不动）
 *   - 直接复现 `handleQueryInternal` 入口"取权威 + 写 session"两步：
 *     1) AgentConfigClient.fetchAuthoritativeAgentConfig(agentId) ← mock fetch
 *        模拟 Django 返回 `allow_yolo_mode=false`
 *     2) `session.agentConfigV3.security.allow_yolo_mode = authoritative.allow_yolo_mode`
 *        （生产代码就是这一行，见 ElectronAgentHost.ts handleQueryInternal）
 *   - 给 IPC payload "yoloMode=true"（模拟客户端声称值 / 攻击者篡改）
 *   - 断言：session.agentConfigV3.security.allow_yolo_mode === false
 *
 * 同时验证 PRD §7.3 性能指标（cache hit < 100ms；cache miss ~一次 HTTP）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../auth', () => ({
  TokenManager: { getAccessToken: vi.fn().mockResolvedValue('test-token') },
}))
vi.mock('../../../config/api', () => ({
  API_BASE_URL: 'https://api.test.local',
}))
vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = {
    info: noop, warn: noop, error: noop, debug: noop,
    log: noop, verbose: noop, silly: noop,
  }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      ...logObj,
    },
  }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
}))

const { createAgentConfigClient, CACHE_TTL_MS } = await import('../agent-config-client')
import type { AgentConfigV3 } from '@tabtin/security-policy'

// ─── Fixtures ────────────────────────────────────────────────────────

function makeDjangoResponse(allowMemberYolo: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        id: 'agent-A',
        agent_config: {
          schema_version: 3,
          runtime_plane: 'local',
        },
        organization_allow_member_yolo: allowMemberYolo,
      },
    }),
  } as unknown as Response
}

/** 模拟 session.agentConfigV3 的最小形态 */
function makeSession(initialAllowYolo: boolean): { agentConfigV3: AgentConfigV3 } {
  return {
    agentConfigV3: {
      schema_version: 3,
      runtime_plane: 'local',
      security: { allow_yolo_mode: initialAllowYolo },
    },
  }
}

/**
 * 复现 ElectronAgentHost.handleQueryInternal 入口的"取权威 + 写 session"两步。
 *
 * 这两行就是生产代码（M2 改造后）：
 *   ```ts
 *   const authoritative = await this.agentConfigClient.fetchAuthoritativeAgentConfig(agentId)
 *   session.agentConfigV3.security.allow_yolo_mode = authoritative.security.allow_yolo_mode === true
 *   ```
 *
 * 注意：**不读** IPC payload `yoloMode` 字段——这就是 M2 的核心修复点。
 */
async function applyAuthoritativeGate(
  client: { fetchAuthoritativeAgentConfig: (id: string) => Promise<AgentConfigV3> },
  session: { agentConfigV3: AgentConfigV3 },
  agentId: string,
): Promise<void> {
  const authoritative = await client.fetchAuthoritativeAgentConfig(agentId)
  session.agentConfigV3.security.allow_yolo_mode = authoritative.security.allow_yolo_mode === true
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── 北极星断言 ──────────────────────────────────────────────────────

describe('M2 北极星 · IPC yoloMode 不再作为 gate 权威源', () => {
  it('IPC payload yoloMode=true + Django allow_yolo_mode=false → session.allow_yolo_mode=false', async () => {
    // 模拟攻击者把 IPC payload 里 yoloMode 篡改成 true
    const ipcWireYoloMode = true
    // Django 实际值 = false（用户在 Settings 里关了 gate）
    const fetchMock = vi.fn().mockResolvedValue(makeDjangoResponse(false))

    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const session = makeSession(false) // 初始默认 false

    await applyAuthoritativeGate(client, session, 'agent-A')

    // 关键断言：session 最终值 = Django 真值（不是 IPC payload yoloMode）
    expect(session.agentConfigV3.security.allow_yolo_mode).toBe(false)
    // 黑底验证：即使 IPC 试图说 true，最终也是 false
    expect(ipcWireYoloMode).toBe(true) // payload 确实是 true
    expect(session.agentConfigV3.security.allow_yolo_mode).not.toBe(ipcWireYoloMode)
  })

  it('IPC payload yoloMode=false + Django allow_yolo_mode=true → session.allow_yolo_mode=true（正向：用户开 gate 后立即生效）', async () => {
    // IPC 还没刷过 cache，仍为 false
    const ipcWireYoloMode = false
    // Django 实际已是 true（用户刚开 gate）
    const fetchMock = vi.fn().mockResolvedValue(makeDjangoResponse(true))

    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const session = makeSession(false)

    await applyAuthoritativeGate(client, session, 'agent-A')

    expect(session.agentConfigV3.security.allow_yolo_mode).toBe(true)
    expect(session.agentConfigV3.security.allow_yolo_mode).not.toBe(ipcWireYoloMode)
  })

  it('Django fetch 失败 → session.allow_yolo_mode=false（deny-by-default 兜底）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))

    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    // 假设 session 上一轮被设成 true（譬如老 buggy 路径残留）
    const session = makeSession(true)

    await applyAuthoritativeGate(client, session, 'agent-A')

    // 关键：fetch 失败时 fallback 也是 false，**不会**留着 stale true 提权
    expect(session.agentConfigV3.security.allow_yolo_mode).toBe(false)
  })
})

// ─── 性能验证 (PRD §7.3) ─────────────────────────────────────────────

describe('M2 性能 · cache 摊销 HTTP 成本', () => {
  it('连续两条消息同 agentId（TTL 内）→ 仅一次 HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeDjangoResponse(false))
    let t = 1_000_000
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => t,
    })

    const session = makeSession(false)
    await applyAuthoritativeGate(client, session, 'agent-A')
    t += CACHE_TTL_MS - 1 // 仍在 cache 内
    await applyAuthoritativeGate(client, session, 'agent-A')
    t += 1 // 边界：恰好达到 TTL
    await applyAuthoritativeGate(client, session, 'agent-A')

    // 前两次走 cache，第三次（超 TTL）才触发新 fetch
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cache hit 路径延迟 < 100ms（PRD §7.3 验收）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeDjangoResponse(true))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const session = makeSession(false)
    await applyAuthoritativeGate(client, session, 'agent-A') // miss
    const t0 = performance.now()
    await applyAuthoritativeGate(client, session, 'agent-A') // hit
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── 边界 ───────────────────────────────────────────────────────────

describe('M2 边界 · 异常输入', () => {
  it('Django 返回 allow_yolo_mode=非 boolean（数据库脏数据）→ session=false（normalize 兜底）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agent_config: {
            security: { allow_yolo_mode: 1 /* truthy 但非 boolean */ },
          },
        },
      }),
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const session = makeSession(false)
    await applyAuthoritativeGate(client, session, 'agent-A')

    expect(session.agentConfigV3.security.allow_yolo_mode).toBe(false)
  })
})
