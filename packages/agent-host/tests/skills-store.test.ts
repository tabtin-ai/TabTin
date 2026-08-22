import { describe, expect, it, vi } from 'vitest'
import type { LocalSkill } from '@tabtin/agent-runtime/skills'
import { SkillsStore } from '../src/state/skills/skills-store.js'

function skill(
  canonicalKey: string,
  source: LocalSkill['source'] = 'app',
): LocalSkill {
  const slug = canonicalKey.split('/').at(-1) ?? canonicalKey
  return {
    canonicalKey,
    source,
    scope: 'shared',
    slug,
    name: slug,
    description: `${slug} description`,
    docPath: `/skills/${slug}/SKILL.md`,
    realpath: `/skills/${slug}/SKILL.md`,
    content: `# ${slug}`,
    rootKind: 'builtin/shared',
    indexedAt: 1,
  }
}

describe('SkillsStore.acquire', () => {
  it('返回与缓存后续刷新隔离的不可变 Run 快照', async () => {
    const fetchMap = vi.fn()
      .mockResolvedValueOnce({ 'app:first': true })
      .mockResolvedValueOnce({ 'app:first': false, 'app:second': true })
    const store = new SkillsStore(fetchMap)

    const first = await store.acquire('agent-1')
    const second = await store.acquire('agent-1', { force: true })

    expect(first.enabledMap).toEqual({ 'app:first': true })
    expect(second.enabledMap).toEqual({ 'app:first': false, 'app:second': true })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.enabledMap)).toBe(true)
  })

  it('首次拉取失败时返回 not-ready 所需的 undefined map', async () => {
    const store = new SkillsStore(async () => {
      throw new Error('offline')
    })

    await expect(store.acquire('agent-1')).resolves.toMatchObject({
      agentId: 'agent-1',
      enabledMap: undefined,
    })
  })

  it('配置失效回暖失败后，新 Run 拿不到权威结果，存量 lease 仍保留旧快照', async () => {
    const fetchMap = vi.fn()
      .mockResolvedValueOnce({ 'app:first': true })
      .mockRejectedValueOnce(new Error('temporary offline'))
      .mockResolvedValueOnce({ 'app:first': false })
    const store = new SkillsStore(fetchMap)

    const existing = await store.beginRun('run-old', 'agent-1')
    store.enablement.forAgent('agent-1').invalidate()
    await expect(store.acquire('agent-1')).resolves.toMatchObject({
      enabledMap: undefined,
    })
    expect(store.peekRun('run-old')?.enabledMap).toEqual(existing.enabledMap)
    await expect(store.acquire('agent-1')).resolves.toMatchObject({
      enabledMap: { 'app:first': false },
    })
    expect(fetchMap).toHaveBeenCalledTimes(3)
  })

  it('beginRun / endRun 按 runId 隔离，互不覆盖', async () => {
    const fetchMap = vi.fn()
      .mockResolvedValueOnce({ 'app:first': true })
      .mockResolvedValueOnce({ 'app:second': true })
    const store = new SkillsStore(fetchMap)

    const parent = await store.beginRun('run-parent', 'agent-1')
    store.enablement.forAgent('agent-1').invalidate()
    const child = await store.beginRun('run-child', 'agent-1', { force: true })

    expect(parent.enabledMap).toEqual({ 'app:first': true })
    expect(child.enabledMap).toEqual({ 'app:second': true })
    expect(store.peekRun('run-parent')?.enabledMap).toEqual({ 'app:first': true })
    expect(store.peekRun('run-child')?.enabledMap).toEqual({ 'app:second': true })

    store.endRun('run-parent')
    expect(store.peekRun('run-parent')).toBeUndefined()
    expect(store.peekRun('run-child')?.enabledMap).toEqual({ 'app:second': true })
  })

  it('在 Run 快照中统一保存 catalog 与 enablement 的可用性结论', async () => {
    const store = new SkillsStore(async () => ({
      'app:enabled': true,
      'app:disabled': false,
      'workspace:local': true,
    }))

    const snapshot = await store.beginRun('run-1', 'agent-1', {
      catalog: {
        registrySkills: [skill('app:enabled'), skill('app:disabled')],
        personalPluginSkills: [skill('user:plugin', 'user')],
        workspaceSkills: [
          { ...skill('workspace:local', 'user'), sourceType: 'workspace' },
        ],
      },
    })

    expect(snapshot.resolve('app:enabled')).toMatchObject({ status: 'available' })
    expect(snapshot.resolve('app:disabled')).toMatchObject({ status: 'disabled' })
    expect(snapshot.resolve('user:plugin')).toMatchObject({ status: 'disabled' })
    expect(snapshot.resolve('workspace:local')).toMatchObject({ status: 'available' })
    expect(snapshot.resolve('app:unknown')).toEqual({ status: 'not_found' })
    expect(snapshot.availableSkills.map(item => item.canonicalKey)).toEqual([
      'app:enabled',
      'workspace:local',
    ])
  })

  it('enablement 未就绪时保留 catalog 事实并返回 not_ready', async () => {
    const store = new SkillsStore(async () => {
      throw new Error('offline')
    })

    const snapshot = await store.beginRun('run-1', 'agent-1', {
      catalog: { registrySkills: [skill('platform:visualization/widget', 'platform')] },
    })

    expect(snapshot.resolve('platform:visualization/widget')).toEqual({
      status: 'not_ready',
      retryable: true,
    })
    expect(snapshot.resolve('platform:missing')).toEqual({ status: 'not_found' })
    expect(snapshot.availableSkills).toEqual([])
  })

  it('目录缺失但 Agent 已启用时返回 not_installed', async () => {
    const store = new SkillsStore(async () => ({
      'app:missing-locally': true,
    }))

    const snapshot = await store.beginRun('run-1', 'agent-1', {
      catalog: { registrySkills: [] },
    })

    expect(snapshot.resolve('app:missing-locally')).toEqual({
      status: 'not_installed',
    })
  })

  it('Run 建立后 registry 输入变化不会改变已冻结的 Skill 正文', async () => {
    const store = new SkillsStore(async () => ({ 'app:first': true }))
    const original = skill('app:first')
    const snapshot = await store.beginRun('run-1', 'agent-1', {
      catalog: { registrySkills: [original] },
    })

    original.content = '# changed after beginRun'

    expect(snapshot.resolve('app:first')).toMatchObject({
      status: 'available',
      skill: { content: '# app:first' },
    })
  })
})
