/**
 *  /  — Space 激活预热调度模块单测。
 *
 * 验证：
 *  1. handler 已注册时，requestSpacePrewarm 触发一次预热；
 *  2. 同 (organizationId, spaceId) 在飞期间重复请求合并（不产生风暴）；
 *  3. 在飞预热完成后可再次触发（缓存过期后的正常再预热路径）；
 *  4. handler reject 不上抛（fire-and-forget 静默失败）；
 *  5. 缺 organizationId / spaceId（取消选中 Space 等）静默跳过；
 *  6. handler 未注册（host 延迟初始化中）时缓存最后一次请求，注册时补发。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { PrewarmScheduler } from '@tabtin/agent-host/state'

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  bindPrewarmScheduler,
  setSpacePrewarmHandler,
  setAgentEnablementPrewarmHandler,
  requestSpacePrewarm,
  requestAgentEnablementPrewarm,
  resetSpacePrewarmForTest,
  unbindPrewarmSchedulerForTests,
} from '../space-prewarm'

/** 手动控制 resolve 的 handler stub，用于制造「在飞」窗口。 */
function makeDeferredHandler() {
  const calls: Array<{ organizationId: string; spaceId: string }> = []
  let release: () => void = () => {}
  const handler = vi.fn((organizationId: string, spaceId: string) => {
    calls.push({ organizationId, spaceId })
    return new Promise<void>((resolve) => {
      release = resolve
    })
  })
  return { handler, calls, releaseCurrent: () => release() }
}

beforeEach(() => {
  const scheduler = new PrewarmScheduler()
  bindPrewarmScheduler(() => scheduler)
  resetSpacePrewarmForTest()
})

afterEach(() => {
  unbindPrewarmSchedulerForTests()
})

describe('space-prewarm — Space 激活预热调度', () => {
  it('handler 已注册时触发一次预热', () => {
    const { handler } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)

    requestSpacePrewarm('wt-1', 'sp-1')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('wt-1', 'sp-1')
  })

  it('同 space 在飞预热合并，不同 space 各自触发', () => {
    const { handler } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)

    requestSpacePrewarm('wt-1', 'sp-1')
    requestSpacePrewarm('wt-1', 'sp-1')
    requestSpacePrewarm('wt-1', 'sp-1')
    requestSpacePrewarm('wt-1', 'sp-2')

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(1, 'wt-1', 'sp-1')
    expect(handler).toHaveBeenNthCalledWith(2, 'wt-1', 'sp-2')
  })

  it('在飞预热完成后同 space 可再次触发', async () => {
    const { handler, releaseCurrent } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)

    requestSpacePrewarm('wt-1', 'sp-1')
    releaseCurrent()
    // 等 finally 清掉 in-flight 记录
    await vi.waitFor(() => {
      requestSpacePrewarm('wt-1', 'sp-1')
      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  it('handler reject 不上抛，且失败后同 space 可重试', async () => {
    const handler = vi.fn(() => Promise.reject(new Error('backend down')))
    setSpacePrewarmHandler(handler)

    expect(() => requestSpacePrewarm('wt-1', 'sp-1')).not.toThrow()
    await vi.waitFor(() => {
      requestSpacePrewarm('wt-1', 'sp-1')
      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  it('缺 organizationId / spaceId 时静默跳过', () => {
    const { handler } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)

    requestSpacePrewarm(null, 'sp-1')
    requestSpacePrewarm('wt-1', null)
    requestSpacePrewarm(undefined, undefined)
    requestSpacePrewarm('', 'sp-1')

    expect(handler).not.toHaveBeenCalled()
  })

  it('handler 未注册时缓存最后一次请求，注册时补发', () => {
    // host 延迟初始化前，renderer 已切了两次 Space
    requestSpacePrewarm('wt-1', 'sp-old')
    requestSpacePrewarm('wt-1', 'sp-new')

    const { handler } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)

    // 只补发最后一次（用户当前所在 Space），不重放历史
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('wt-1', 'sp-new')
  })

  it('注销 handler（host stop）后不再触发，也不缓存补发到旧 handler', () => {
    const { handler } = makeDeferredHandler()
    setSpacePrewarmHandler(handler)
    setSpacePrewarmHandler(null)

    requestSpacePrewarm('wt-1', 'sp-1')

    expect(handler).not.toHaveBeenCalled()
  })
})

// ─── 源码契约：预热的挂载点与边界不被后续改动悄悄拆掉 ───────────────
//
// ElectronAgentHost 无法在 vitest 里直接实例化（重 electron 依赖），
// 按仓库既有模式（mode-soft-switch-and-perf.test.ts）对源码做契约断言。

describe('space-prewarm 源码契约', () => {
  const hostSource = fs.readFileSync(
    path.resolve(__dirname, '../ElectronAgentHost.ts'),
    'utf-8',
  )
  const runtimeAssemblySource = fs.readFileSync(
    path.resolve(__dirname, '../runtime/electron-runtime-assembly.ts'),
    'utf-8',
  )
  const ipcRegistrySource = fs.readFileSync(
    path.resolve(__dirname, '../../ipc-registry.ts'),
    'utf-8',
  )

  it('host 在 start 注册预热 handler、stop 注销，并暖宿主目录', () => {
    expect(hostSource).toContain('setSpacePrewarmHandler((organizationId, spaceId) =>')
    expect(hostSource).toContain('setAgentEnablementPrewarmHandler((agentId) =>')
    expect(hostSource).toContain('setSpacePrewarmHandler(null)')
    expect(hostSource).toContain('setAgentEnablementPrewarmHandler(null)')
    expect(hostSource).toContain("warmHostCapabilityCatalogs('host-start')")
    expect(hostSource).toContain("warmHostCapabilityCatalogs('skills-ready')")
  })

  it('prewarmSpaceContext 覆盖 skills / catalog / CLI 缓存（画像改挂 Agent）', () => {
    expect(hostSource).toContain('async prewarmSpaceContext(')
    expect(hostSource).toContain('this.runtimeAssembly.loadSubagentCatalogAsync(spaceId)')
    expect(hostSource).toContain("warmCliCommandsMaterialized('space-prewarm')")
    expect(hostSource).toContain('createGatedCliListingFetcher(organizationId)({})')
    expect(hostSource).toContain('ensureUserSkills(userId)')
    expect(hostSource).toContain('ensureOrganizationSkills(userId, organizationId)')
    const start = hostSource.indexOf('async prewarmSpaceContext(')
    const end = hostSource.indexOf('async prewarmAgentEnablement(')
    const methodSource = hostSource.slice(start, end)
    expect(methodSource).not.toContain('loadUserPortraitAsync(')
  })

  it('prewarmSpaceContext 不预建完整 runtime、不预拉无缓存的模板全量快照', () => {
    const start = hostSource.indexOf('async prewarmSpaceContext(')
    const end = hostSource.indexOf('async prewarmAgentEnablement(')
    const methodSource = hostSource.slice(start, end)
    expect(methodSource.length).toBeGreaterThan(0)
    expect(methodSource).not.toContain('createRuntimeForSession(')
    expect(methodSource).not.toContain('getRuntimeFactory().resolve(')
    expect(methodSource).not.toContain('loadSubagentTemplatesFullAsync')
  })

  it('space:set-active 触发 Space 预热；Agent upsert 触发 enablement + MCP + 画像预热', () => {
    expect(ipcRegistrySource).toContain('requestSpacePrewarm(organizationId, spaceId)')
    expect(hostSource).toContain('requestAgentEnablementPrewarm(agent.id)')
    expect(hostSource).toContain('skillEnablementCache.forAgent(agentId).refresh()')
    expect(hostSource).toContain('createMcpListingFetcher(agentId)({})')
    expect(hostSource).toContain('loadUserPortraitAsync(organizationId, agentId)')
  })

  it('Agent 预热同步物化携带集中已启用但本地缺失的 App Skill', () => {
    const start = hostSource.indexOf('async prewarmAgentEnablement(')
    const end = hostSource.indexOf('async prewarmSessionRuntime(', start)
    const methodSource = hostSource.slice(start, end)

    expect(methodSource).toContain('getCLIOrganizationId()')
    expect(methodSource).toContain('getCLISpaceId()')
    expect(methodSource).toContain(
      'this.runtimeAssembly.reconcileSpaceAppSkills(organizationId, spaceId, agentId)',
    )
    expect(runtimeAssemblySource).toContain(
      '`/agents/${encodeURIComponent(agentId)}/skills`',
    )
  })

  it('草稿 session 预 acquire 走 prewarmSessionRuntime + IPC，不塞进 Space 预热', () => {
    expect(hostSource).toContain('async prewarmSessionRuntime(')
    expect(hostSource).toContain("agent-engine:prewarm-runtime")
    expect(hostSource).toContain('getRuntimeFactory().resolve(runtimeRequest)')
    expect(hostSource).toContain('loadHostTurnBundle({')
  })
})


describe('space-prewarm — Agent enablement 预热', () => {
  it('handler 已注册时触发一次 enablement 预热', () => {
    const handler = vi.fn(async () => {})
    setAgentEnablementPrewarmHandler(handler)

    requestAgentEnablementPrewarm('agent-1')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('agent-1')
  })

  it('同 agent 在飞合并；缺 agentId 跳过', () => {
    const handler = vi.fn(() => new Promise<void>(() => {}))
    setAgentEnablementPrewarmHandler(handler)

    requestAgentEnablementPrewarm('agent-1')
    requestAgentEnablementPrewarm('agent-1')
    requestAgentEnablementPrewarm('  ')
    requestAgentEnablementPrewarm(null)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handler 未注册时缓存最后一次 Agent 请求，注册时补发', () => {
    requestAgentEnablementPrewarm('agent-old')
    requestAgentEnablementPrewarm('agent-new')

    const handler = vi.fn(async () => {})
    setAgentEnablementPrewarmHandler(handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('agent-new')
  })

  it('注销 handler 后请求写入 pending，不调用旧 handler', () => {
    const handler = vi.fn(async () => {})
    setAgentEnablementPrewarmHandler(handler)
    setAgentEnablementPrewarmHandler(null)

    requestAgentEnablementPrewarm('agent-1')

    expect(handler).not.toHaveBeenCalled()
  })
})
