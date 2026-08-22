import { describe, expect, it, vi } from 'vitest'
import {
  configsToEnablementMap,
  filterSkillsByEnablement,
  isDeviceSkillKey,
  isSkillEnabledByMap,
  SkillEnablementMapCache,
} from '../skill-enablement.js'

describe('skill-enablement', () => {
  it('识别 device canonical key / source', () => {
    expect(isDeviceSkillKey({ canonicalKey: 'device:foo' })).toBe(true)
    expect(isDeviceSkillKey({ canonicalKey: 'platform:bar', source: 'device' })).toBe(true)
    expect(isDeviceSkillKey({ canonicalKey: 'platform:bar', source: 'platform' })).toBe(false)
  })

  it('平台 Skill 使用封闭携带集；本机发现 Skill 在有效快照中默认可用', () => {
    const device = { canonicalKey: 'device:cli', source: 'device' as const }
    const platform = { canonicalKey: 'platform:table', source: 'platform' as const }

    expect(isSkillEnabledByMap(device, undefined)).toBe(false)
    expect(isSkillEnabledByMap(platform, undefined)).toBe(false)
    expect(isSkillEnabledByMap(device, {})).toBe(true)
    expect(isSkillEnabledByMap(platform, {})).toBe(false)
    expect(isSkillEnabledByMap(device, { 'device:cli': false })).toBe(false)
    expect(isSkillEnabledByMap(platform, { 'platform:table': false })).toBe(false)
    expect(isSkillEnabledByMap(device, { 'device:cli': true })).toBe(true)
    expect(isSkillEnabledByMap(platform, { 'platform:table': true })).toBe(true)
  })

  it('目录自带 skill（workspace）：无快照关闭；缺键过渡放行；显式 false 关闭', () => {
    const ws = {
      canonicalKey: 'workspace:.cursor/skills/demo',
      source: 'workspace' as const,
      sourceType: 'workspace' as const,
    }
    expect(isSkillEnabledByMap(ws, undefined)).toBe(false)
    //  过渡：有快照但缺键仍放行，避免升级静默失能
    expect(isSkillEnabledByMap(ws, {})).toBe(true)
    expect(isSkillEnabledByMap(ws, { 'workspace:.cursor/skills/demo': false })).toBe(false)
    expect(isSkillEnabledByMap(ws, { 'workspace:.cursor/skills/demo': true })).toBe(true)
  })

  it('filterSkillsByEnablement 默认保留本机发现项，平台项仍需显式启用', () => {
    const skills = [
      { canonicalKey: 'device:a', source: 'device' as const },
      { canonicalKey: 'platform:b', source: 'platform' as const },
      { canonicalKey: 'device:c', source: 'device' as const },
    ]
    expect(
      filterSkillsByEnablement(skills, { 'device:a': true }).map((s) => s.canonicalKey),
    ).toEqual(['device:a', 'device:c'])
    expect(
      filterSkillsByEnablement(skills, {
        'device:a': true,
        'platform:b': true,
      }).map((s) => s.canonicalKey),
    ).toEqual(['device:a', 'platform:b', 'device:c'])
  })

  it('configsToEnablementMap 只把 enabled===true 记为 true', () => {
    expect(
      configsToEnablementMap({
        'device:a': { enabled: true },
        'device:b': { enabled: false },
        'platform:c': {},
      }),
    ).toEqual({
      'device:a': true,
      'device:b': false,
      'platform:c': false,
    })
  })

  it('为一轮 Agent 绑定固定携带集锚点，调用方无需再传 Workspace 标识', async () => {
    const fetchMap = vi.fn(async (agentId: string) => ({
      [`device:${agentId}`]: true,
    }))
    const cache = new SkillEnablementMapCache(fetchMap)
    const agentEnablement = cache.forAgent('agent-1')

    await expect(agentEnablement.refresh({ force: true })).resolves.toEqual({
      'device:agent-1': true,
    })
    expect(agentEnablement.getSync()).toEqual({ 'device:agent-1': true })
    expect(fetchMap).toHaveBeenCalledTimes(1)
    expect(fetchMap).toHaveBeenCalledWith('agent-1')
  })

  it('拒绝绑定缺失的 Agent 身份，避免静默退化成空携带集', () => {
    const cache = new SkillEnablementMapCache(async () => ({}))

    expect(() => cache.forAgent('')).toThrow('agentId is required')
  })

  it('刷新失败时保留旧快照并报告 Agent 锚点', async () => {
    const fetchError = new Error('enablement unavailable')
    const fetchMap = vi
      .fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockResolvedValueOnce({ 'device:camera': true })
      .mockRejectedValueOnce(fetchError)
    const onFetchError = vi.fn()
    const cache = new SkillEnablementMapCache(fetchMap, 30_000, onFetchError)
    const agentEnablement = cache.forAgent('agent-1')

    await agentEnablement.refresh({ force: true })
    await expect(agentEnablement.refresh({ force: true })).resolves.toEqual({
      'device:camera': true,
    })
    expect(onFetchError).toHaveBeenCalledWith(fetchError, 'agent-1')
    expect(agentEnablement.isAuthoritative()).toBe(false)
  })

  it('isAuthoritative 仅在新鲜且未失效时为真', async () => {
    const cache = new SkillEnablementMapCache(async () => ({ 'device:cli': true }))
    const view = cache.forAgent('agent-1')
    expect(view.isAuthoritative()).toBe(false)
    await view.refresh({ force: true })
    expect(view.isAuthoritative()).toBe(true)
    view.invalidate()
    expect(view.isAuthoritative()).toBe(false)
  })

  it('同一 Agent 并发刷新 single-flight，共享同一份原子结果', async () => {
    let resolveRefresh!: (value: Record<string, boolean>) => void
    const fetchMap = vi.fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockImplementation(() => new Promise((resolve) => {
        resolveRefresh = resolve
      }))
    const agentEnablement = new SkillEnablementMapCache(fetchMap).forAgent('agent-1')

    const firstRefresh = agentEnablement.refresh({ force: true })
    const secondRefresh = agentEnablement.refresh({ force: true })
    expect(fetchMap).toHaveBeenCalledTimes(1)
    resolveRefresh({ 'device:camera': true })

    await expect(firstRefresh).resolves.toEqual({ 'device:camera': true })
    await expect(secondRefresh).resolves.toEqual({ 'device:camera': true })
    expect(agentEnablement.getSync()).toEqual({ 'device:camera': true })
  })

  it('invalidate 保留 last-good，且在途成功响应不能覆盖失效快照', async () => {
    let resolveRefresh!: (value: Record<string, boolean>) => void
    const fetchMap = vi
      .fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockResolvedValueOnce({ 'device:camera': true })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRefresh = resolve
      }))
    const agentEnablement = new SkillEnablementMapCache(fetchMap).forAgent('agent-1')
    await agentEnablement.refresh({ force: true })

    const pendingRefresh = agentEnablement.refresh({ force: true })
    agentEnablement.invalidate()
    expect(agentEnablement.getSync()).toEqual({ 'device:camera': true })
    resolveRefresh({ 'device:camera': false })

    await expect(pendingRefresh).resolves.toEqual({ 'device:camera': true })
    expect(agentEnablement.getSync()).toEqual({ 'device:camera': true })
  })

  it('invalidate 后在途失败响应继续保留 last-good', async () => {
    let rejectRefresh!: (error: unknown) => void
    const fetchMap = vi
      .fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockResolvedValueOnce({ 'device:camera': true })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject
      }))
    const agentEnablement = new SkillEnablementMapCache(fetchMap).forAgent('agent-1')
    await agentEnablement.refresh({ force: true })

    const pendingRefresh = agentEnablement.refresh({ force: true })
    agentEnablement.invalidate()
    rejectRefresh(new Error('request failed'))

    await expect(pendingRefresh).resolves.toEqual({ 'device:camera': true })
    expect(agentEnablement.getSync()).toEqual({ 'device:camera': true })
  })

  it('#7713 配置域失效保留 last-good，身份域失效硬清空', async () => {
    const fetchMap = vi
      .fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockImplementation(async (agentId) => ({
        [`user:${agentId}`]: true,
      }))
    const cache = new SkillEnablementMapCache(fetchMap)
    const a1 = cache.forAgent('agent-1')
    const a2 = cache.forAgent('agent-2')
    await a1.refresh({ force: true })
    await a2.refresh({ force: true })
    expect(a1.getSync()).toEqual({ 'user:agent-1': true })
    expect(a2.getSync()).toEqual({ 'user:agent-2': true })

    cache.invalidateAgent('agent-1')
    expect(a1.getSync()).toEqual({ 'user:agent-1': true })
    expect(a2.getSync()).toEqual({ 'user:agent-2': true })

    cache.invalidateAll()
    expect(a1.getSync()).toEqual({ 'user:agent-1': true })
    expect(a2.getSync()).toEqual({ 'user:agent-2': true })

    cache.invalidateAgent()
    expect(a1.getSync()).toBeUndefined()
    expect(a2.getSync()).toBeUndefined()
  })

  it('身份硬清空后，旧身份的在途响应不能恢复缓存', async () => {
    let resolveRefresh!: (value: Record<string, boolean>) => void
    const fetchMap = vi.fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockImplementation(() => new Promise((resolve) => {
        resolveRefresh = resolve
      }))
    const cache = new SkillEnablementMapCache(fetchMap)
    const agent = cache.forAgent('agent-1')

    const pendingRefresh = agent.refresh({ force: true })
    cache.invalidateAgent()
    resolveRefresh({ 'user:agent-1': true })

    await expect(pendingRefresh).resolves.toBeUndefined()
    expect(agent.getSync()).toBeUndefined()
  })

  it('身份硬清空后，旧身份在途失败不能泄漏 last-good', async () => {
    let rejectRefresh!: (error: unknown) => void
    const fetchMap = vi
      .fn<(agentId: string) => Promise<Record<string, boolean>>>()
      .mockResolvedValueOnce({ 'user:agent-1': true })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject
      }))
    const cache = new SkillEnablementMapCache(fetchMap)
    const agent = cache.forAgent('agent-1')
    await agent.refresh({ force: true })

    const pendingRefresh = agent.refresh({ force: true })
    cache.invalidateAgent()
    rejectRefresh(new Error('old identity request failed'))

    await expect(pendingRefresh).resolves.toBeUndefined()
    expect(agent.getSync()).toBeUndefined()
  })

  it('#9463 默认常驻：时间推移后非 force refresh 不重拉', async () => {
    const fetchMap = vi.fn(async () => ({ 'device:camera': true }))
    const cache = new SkillEnablementMapCache(fetchMap)
    const agent = cache.forAgent('agent-1')
    const now = Date.now()
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    await agent.refresh()
    dateSpy.mockReturnValue(now + 10 * 60_000)
    await agent.refresh()

    expect(fetchMap).toHaveBeenCalledTimes(1)
    expect(agent.getSync()).toEqual({ 'device:camera': true })
    dateSpy.mockRestore()
  })
})
