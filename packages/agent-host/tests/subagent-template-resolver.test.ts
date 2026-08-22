/**
 * host SubAgentTemplate 解析单测。
 */
import { describe, expect, it } from 'vitest'
import {
  mapRawTemplateToSnapshot,
  resolveTemplateSpawn,
  type SubAgentTemplateSnapshot,
} from '../src/configuration/subagent-template-resolver.js'
import { expandTemplateIntoAgentInput } from '../src/configuration/expand-template-input.js'

function makeSnapshot(overrides: Partial<SubAgentTemplateSnapshot> = {}): SubAgentTemplateSnapshot {
  return {
    id: 'tpl-1',
    name: '模板',
    description: '',
    systemPrompt: 'persona',
    subagentType: 'execute',
    allowedTools: [],
    deniedTools: [],
    modelId: '',
    thinkingLevel: '',
    defaultMode: 'wait',
    version: 1,
    isEnabled: true,
    ...overrides,
  }
}

function getter(snapshots: SubAgentTemplateSnapshot[]) {
  const map = new Map(snapshots.map((s) => [s.id, s]))
  return () => map
}

describe('resolveTemplateSpawn', () => {
  it('命中启用模板返回规范化结果', () => {
    const snap = makeSnapshot({
      systemPrompt: '  hello  ',
      modelId: 'm1',
      allowedTools: ['read_file'],
      deniedTools: ['write_file'],
    })
    const res = resolveTemplateSpawn('tpl-1', getter([snap]))
    expect(res).toMatchObject({
      personaPrompt: 'hello',
      modelId: 'm1',
      allowedTools: ['read_file'],
      deniedTools: ['write_file'],
      readonly: false,
    })
  })

  it('explore / plan 强制只读', () => {
    expect(resolveTemplateSpawn('tpl-1', getter([makeSnapshot({ subagentType: 'explore' })]))?.readonly).toBe(true)
    expect(resolveTemplateSpawn('tpl-1', getter([makeSnapshot({ subagentType: 'plan' })]))?.readonly).toBe(true)
  })

  it('未命中 / 禁用 / 无快照源 → null', () => {
    expect(resolveTemplateSpawn('nope', getter([makeSnapshot()]))).toBeNull()
    expect(resolveTemplateSpawn('tpl-1', getter([makeSnapshot({ isEnabled: false })]))).toBeNull()
    expect(resolveTemplateSpawn('tpl-1', undefined)).toBeNull()
    expect(resolveTemplateSpawn(undefined, getter([makeSnapshot()]))).toBeNull()
    expect(resolveTemplateSpawn('   ', getter([makeSnapshot()]))).toBeNull()
  })

  it('空白 persona 归一为空串', () => {
    const res = resolveTemplateSpawn('tpl-1', getter([makeSnapshot({ systemPrompt: '   ' })]))
    expect(res?.personaPrompt).toBe('')
  })
})

describe('mapRawTemplateToSnapshot', () => {
  it('映射 Django 原始记录', () => {
    const snap = mapRawTemplateToSnapshot({
      id: 'a',
      name: '角色',
      description: 'd',
      system_prompt: 'sp',
      subagent_type: 'explore',
      allowed_tools: ['read_file'],
      denied_tools: ['bash'],
      model_id: 'm',
      thinking_level: 'high',
      default_mode: 'background',
      max_turns: 9,
      version: 2,
      is_enabled: true,
    })
    expect(snap).toMatchObject({
      id: 'a',
      name: '角色',
      subagentType: 'explore',
      defaultMode: 'background',
      version: 2,
    })
  })

  it('忽略遗留 max_turns，子 Agent 轮次只走运行资源配置', () => {
    const snap = mapRawTemplateToSnapshot({
      id: 'a',
      name: '角色',
      max_turns: 9,
    })
    expect(snap).not.toHaveProperty('maxTurns')
  })

  it('缺 id / name → null；未知 type → execute；禁用保留', () => {
    expect(mapRawTemplateToSnapshot({ name: '无 id' })).toBeNull()
    expect(mapRawTemplateToSnapshot({ id: 'x' })).toBeNull()
    expect(mapRawTemplateToSnapshot({ id: 'x', name: 'n', subagent_type: 'weird' })?.subagentType).toBe('execute')
    expect(mapRawTemplateToSnapshot({ id: 'x', name: 'n', is_enabled: false })?.isEnabled).toBe(false)
  })
})

describe('expandTemplateIntoAgentInput', () => {
  it('展开模板到通用 agent 入参（含 defaultBackground）；persona 走侧信道', async () => {
    const expanded = await expandTemplateIntoAgentInput(
      { prompt: 'x', template_id: 'tpl-1' },
      getter([makeSnapshot({
        subagentType: 'plan',
        systemPrompt: 'P',
        modelId: 'm1',
        defaultMode: 'background',
      })]),
      ['read_file', 'write_file'],
    )

    expect(expanded.input).toMatchObject({
      template_id: 'tpl-1',
      model: 'm1',
      readonly: true,
      background: true,
    })
    expect(expanded.input).not.toHaveProperty('max_turns')
    expect(expanded.input).not.toHaveProperty('persona_prompt')
    expect(expanded.input).not.toHaveProperty('template_name')
    expect(expanded.personaPrompt).toBe('P')
    expect(expanded).not.toHaveProperty('maxTurns')
  })
})
