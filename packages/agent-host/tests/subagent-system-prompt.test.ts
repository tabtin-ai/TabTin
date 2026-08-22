/**
 * 子 Agent system prompt 重烘焙（ Stage 2b，自 agent-runtime 迁入）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '@tabtin/agent-prompt'
import {
  resolveReadonlySubagentSystemPrompt,
  resolveSubagentSystemPrompt,
  createSystemPromptProvider,
} from '../src/prompt/subagent-system-prompt.js'
import { assembleSystemPrompt } from '../src/prompt/system-prompt-assembler.js'

describe('#6674 system prompt assembly', () => {
  it('default keeps personal rules in main/subagent system while custom stays out', () => {
    const assembled = assembleSystemPrompt(
      {
        personalRules: '个人自由文本',
        customRules: 'Agent 自由文本',
      },
      { agentMode: 'agent', tools: [] },
    )
    expect(assembled.systemPrompt).toContain('个人自由文本')
    expect(assembled.systemPrompt).not.toContain('Agent 自由文本')
    expect(assembled.buildConfig.personalRules).toBe('个人自由文本')
    expect(assembled.buildConfig.customRules).toBeUndefined()

    const child = resolveSubagentSystemPrompt(
      assembled.systemPrompt,
      assembled.buildConfig,
      'agent',
    )
    expect(child).toContain('个人自由文本')
    expect(child).not.toContain('Agent 自由文本')
    expect(child).toContain('<safety>')
  })

  it('explicit Electron opt-in removes personal rules from main/subagent system', () => {
    const assembled = assembleSystemPrompt(
      {
        personalRules: '个人自由文本',
        customRules: 'Agent 自由文本',
        personalRulesPlacement: 'pre-user-context',
      },
      { agentMode: 'agent', tools: [] },
    )
    expect(assembled.systemPrompt).not.toContain('个人自由文本')
    expect(assembled.systemPrompt).not.toContain('Agent 自由文本')
    expect(assembled.buildConfig.personalRules).toBeUndefined()
    expect(assembled.buildConfig.customRules).toBeUndefined()

    const child = resolveSubagentSystemPrompt(
      assembled.systemPrompt,
      assembled.buildConfig,
      'agent',
    )
    expect(child).not.toContain('个人自由文本')
    expect(child).not.toContain('Agent 自由文本')
  })

  it('Daemon source does not opt in, so shared default retains personal rules', () => {
    const daemonAssembly = readFileSync(
      resolve(
        __dirname,
        '../../../apps/tabtin-daemon/src/agent/runtime/daemon-runtime-assembly.ts',
      ),
      'utf8',
    )
    expect(daemonAssembly).toContain('personalRules,')
    expect(daemonAssembly).not.toContain('personalRulesPlacement')
    expect(daemonAssembly).not.toContain('getPersonalRules:')
  })
})

describe('resolveReadonlySubagentSystemPrompt', () => {
  it('rebuilds with ask agent_mode section when buildConfig provided', () => {
    const parent = buildSystemPrompt({
      agentMode: 'agent',
      tools: [{ name: 'read_file', description: 'Read' }],
    })
    const child = resolveReadonlySubagentSystemPrompt(
      parent,
      { agentMode: 'agent', tools: [{ name: 'read_file', description: 'Read' }] },
      [{ name: 'read_file', description: 'Read' }],
    )
    expect(child).toContain('<agent_mode>')
    expect(child).toMatch(/Ask|问答/)
    expect(child).not.toContain('<execution>')
  })

  it('fallback appends ask section when no buildConfig', () => {
    const child = resolveReadonlySubagentSystemPrompt('plain parent', undefined)
    expect(child).toMatch(/Ask|问答|<agent_mode>/)
  })
})

describe('resolveSubagentSystemPrompt · 群模式子 Agent 去编排者身份', () => {
  const groupBuildConfig = {
    agentMode: 'group' as const,
    tools: [{ name: 'agent', description: 'dispatch subagent' }],
    subagentCatalog: [
      {
        name: '报数员',
        subagentType: 'execute' as const,
        description: '负责报数',
        templateId: 'tpl-1',
      },
    ],
  }

  it('前提：PMO 模式父 prompt 确实含项目管理者身份 + 团队名册', () => {
    const parent = buildSystemPrompt(groupBuildConfig)
    expect(parent).toContain('<subagent_catalog>')
    expect(parent).toMatch(/项目管理者|PMO/)
  })

  it("mode='agent'：剥掉 group.md 项目管理者身份与 <subagent_catalog>，换成执行段", () => {
    const parent = buildSystemPrompt(groupBuildConfig)
    const child = resolveSubagentSystemPrompt(parent, groupBuildConfig, 'agent', [
      { name: 'read_file', description: 'Read' },
    ])
    expect(child).not.toContain('<subagent_catalog>')
    expect(child).not.toContain('报数员')
    expect(child).not.toMatch(/项目管理者|PMO 模式/)
    expect(child).toContain('<execution>')
  })

  it("mode='ask'：群父也换成 ask 段、去名册", () => {
    const parent = buildSystemPrompt(groupBuildConfig)
    const child = resolveSubagentSystemPrompt(parent, groupBuildConfig, 'ask', [
      { name: 'read_file', description: 'Read' },
    ])
    expect(child).not.toContain('<subagent_catalog>')
    expect(child).toMatch(/Ask|问答/)
    expect(child).not.toContain('<execution>')
  })

  it('fallback（无 buildConfig）：字符串路径也剥掉 <subagent_catalog> 并换段', () => {
    const parent = buildSystemPrompt(groupBuildConfig)
    const child = resolveSubagentSystemPrompt(parent, undefined, 'agent')
    expect(child).not.toContain('<subagent_catalog>')
  })
})

describe('createSystemPromptProvider', () => {
  it('resolveSubagentPrompt 委托 resolveSubagentSystemPrompt', () => {
    const provider = createSystemPromptProvider()
    const parent = buildSystemPrompt({
      agentMode: 'group',
      tools: [{ name: 'agent', description: 'dispatch' }],
      subagentCatalog: [
        {
          name: '报数员',
          subagentType: 'execute',
          description: '负责报数',
          templateId: 'tpl-1',
        },
      ],
    })
    const child = provider.resolveSubagentPrompt({
      parentPrompt: parent,
      buildConfig: {
        agentMode: 'group',
        tools: [{ name: 'agent', description: 'dispatch' }],
        subagentCatalog: [
          {
            name: '报数员',
            subagentType: 'execute',
            description: '负责报数',
            templateId: 'tpl-1',
          },
        ],
      },
      mode: 'agent',
      childTools: [{ name: 'read_file', description: 'Read' }],
    })
    expect(child).not.toContain('<subagent_catalog>')
    expect(child).toContain('<execution>')
  })
})
