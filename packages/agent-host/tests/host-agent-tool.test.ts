/**
 * ：host agent 工具包装 —— 模板展开 + runtime 同构 spawn。
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BudgetTracker, createAgentTool, SubagentManager } from '@tabtin/agent-runtime'
import { createHostAgentTool } from '../src/configuration/host-agent-tool.js'
import type { SubAgentTemplateSnapshot } from '../src/configuration/subagent-template-resolver.js'
import * as childDeliverables from '../src/delivery/child-deliverables.js'
import { createMockPermissionHandler, createMockToolProvider } from '../../agent-runtime/tests/test-utils.js'
import type { LLMProvider, LLMRequest, LLMResponseChunk, ModelCatalogEntry } from '@tabtin/agent-runtime/engine'
import type { Message } from '@tabtin/agent-runtime/engine'
import type { StreamEvent } from '@tabtin/agent-runtime/engine'
import type { Tool } from '@tabtin/agent-runtime/engine'

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-template',
    runtimeId: 'rt-template',
    toolUseId: 'toolu_parent',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  }
}

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: `${name} ok` }),
  }
}

function makeProvider(requests: LLMRequest[]): LLMProvider {
  return {
    async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
      requests.push(request)
      yield { type: 'text_delta', text: 'child done' }
      yield { type: 'stop', stopReason: 'end_turn' }
    },
  }
}

function makeToolUseProvider(requests: LLMRequest[]): LLMProvider {
  return {
    async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
      requests.push(request)
      yield { type: 'tool_use', toolUse: { id: `tu-${requests.length}`, name: 'read_file', input: {} } }
      yield { type: 'stop', stopReason: 'tool_use' }
    },
  }
}

function makeSnapshot(overrides: Partial<SubAgentTemplateSnapshot> = {}): SubAgentTemplateSnapshot {
  return {
    id: 'tpl-1',
    name: '模板子 Agent',
    description: '',
    systemPrompt: '必须以 TEMPLATE_PERSONA 开头。',
    subagentType: 'execute',
    allowedTools: ['read_file', 'write_file'],
    deniedTools: ['write_file'],
    modelId: 'child-model',
    thinkingLevel: '',
    defaultMode: 'wait',
    version: 7,
    isEnabled: true,
    ...overrides,
  }
}

const childModelEntry: ModelCatalogEntry = {
  id: 'child-model',
  displayName: 'Child Model',
  capabilities: {
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_096,
    maxInputTokens: 64_000,
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsPromptCaching: false,
    cacheType: 'none',
  },
}


describe('createHostAgentTool template expansion', () => {
  it('applies template persona, model, readonly and tool filters', async () => {
    const requests: LLMRequest[] = []
    const events: StreamEvent[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-'))
    const tool = createHostAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([
        makeTool('read_file'),
        makeTool('write_file'),
        makeTool('run_terminal_command'),
      ]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      getTemplateSnapshots: () => new Map([['tpl-1', makeSnapshot({ subagentType: 'plan' })]]),
    })

    const result = await tool.execute(
      { prompt: 'use template', template_id: 'tpl-1', description: 'template spawn' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    )

    expect(result.isError).toBeFalsy()
    expect(requests[0].model).toBe('child-model')
    expect(JSON.stringify(requests[0].system)).toContain('TEMPLATE_PERSONA')
    const toolNames = (requests[0].tools ?? []).map((t) => t.name)
    expect(toolNames).toContain('read_file')
    expect(toolNames).not.toContain('write_file')
    expect(toolNames).not.toContain('run_terminal_command')

    const started = events.find((e) => e.type === 'agent.stream.subagent_started')
    expect(started?.payload).toMatchObject({
      speaker: {
        source: 'template',
        template_id: 'tpl-1',
      },
    })
    expect((started?.payload as { speaker?: { template_name?: string } })?.speaker?.template_name)
      .toBeUndefined()
  })

  it('disabled / missing template falls back to ad-hoc spawn', async () => {
    const requests: LLMRequest[] = []
    const events: StreamEvent[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-disabled-'))
    const tool = createHostAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      getTemplateSnapshots: () => new Map(),
    })

    await tool.execute(
      { prompt: 'use template', template_id: 'tpl-1' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    )

    expect(requests[0].model).toBe('parent-model')
    expect(JSON.stringify(requests[0].system)).not.toContain('TEMPLATE_PERSONA')
    const started = events.find((e) => e.type === 'agent.stream.subagent_started')
    expect(started?.payload).toMatchObject({
      speaker: { source: 'inherit' },
    })
    expect((started?.payload as { speaker?: { template_id?: string } })?.speaker?.template_id)
      .toBeUndefined()
  })

  it('refreshes template map each spawn', async () => {
    const requests: LLMRequest[] = []
    let snapshot: SubAgentTemplateSnapshot | null = makeSnapshot()
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-refresh-'))
    const tool = createHostAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      getTemplateSnapshots: () => (snapshot ? new Map([[snapshot.id, snapshot]]) : new Map()),
    })

    await tool.execute({ prompt: 'enabled', template_id: 'tpl-1' }, makeContext())
    snapshot = null
    await tool.execute({ prompt: 'disabled', template_id: 'tpl-1' }, makeContext())

    expect(JSON.stringify(requests[0].system)).toContain('TEMPLATE_PERSONA')
    expect(requests[1].model).toBe('parent-model')
    expect(JSON.stringify(requests[1].system)).not.toContain('TEMPLATE_PERSONA')
  })

  it('template allowedTools caps explicit tool_domains', async () => {
    const requests: LLMRequest[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-scope-'))
    const tool = createHostAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([
        makeTool('read_file'),
        makeTool('run_terminal_command'),
      ]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      getTemplateSnapshots: () => new Map([['tpl-1', makeSnapshot({
        allowedTools: ['read_file'],
        deniedTools: [],
        subagentType: 'execute',
      })]]),
    })

    await tool.execute(
      { prompt: 'use template', template_id: 'tpl-1', tool_domains: ['run_terminal_command'] },
      makeContext(),
    )

    const toolNames = (requests[0].tools ?? []).map((t) => t.name)
    expect(toolNames).not.toContain('run_terminal_command')
    expect(toolNames).not.toContain('read_file')
  })

  it('uses shared maxChildTurns instead of template-specific maxTurns', async () => {
    const requests: LLMRequest[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-max-turns-'))
    const tool = createHostAgentTool({
      provider: makeToolUseProvider(requests),
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
      maxChildTurns: 1,
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      getTemplateSnapshots: () => new Map([['tpl-1', makeSnapshot({
        subagentType: 'execute',
        allowedTools: ['read_file'],
        deniedTools: [],
      })]]),
    })

    await tool.execute({ prompt: 'use template', template_id: 'tpl-1' }, makeContext())
    expect(requests).toHaveLength(1)
  })

  it('background spawn keeps frozen template persona after host execute returns', async () => {
    const requests: LLMRequest[] = []
    let resolveHang!: () => void
    const hang = new Promise<void>((resolve) => { resolveHang = resolve })
    const hangingProvider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        requests.push(request)
        await hang
        yield { type: 'text_delta', text: 'bg done' }
        yield { type: 'stop', stopReason: 'end_turn' }
      },
    }
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-bg-persona-'))
    const budgetTracker = new BudgetTracker()
    const manager = new SubagentManager({
      parentThreadId: 'thread-template-bg',
      budgetTracker,
      enqueueNotification: () => true,
    })
    manager.rebindLiveDeps({ budgetTracker })
    const tool = createHostAgentTool({
      provider: hangingProvider,
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template-bg' },
      model: 'parent-model',
      modelCatalog: [childModelEntry],
      budgetTracker,
      subagentManager: manager,
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-template-bg' },
      getTemplateSnapshots: () => new Map([['tpl-1', makeSnapshot({
        systemPrompt: '必须以 TEMPLATE_PERSONA 开头。',
        defaultMode: 'background',
        allowedTools: ['read_file'],
        deniedTools: [],
      })]]),
    })

    const result = await tool.execute(
      { prompt: 'bg template', template_id: 'tpl-1', description: 'bg' },
      makeContext(),
    )
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('已在后台启动')
    expect(requests).toHaveLength(0)

    resolveHang()
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0)
    })
    expect(JSON.stringify(requests[0].system)).toContain('TEMPLATE_PERSONA')
    await manager.dispose()
  })
})

describe('createHostAgentTool vs bare createAgentTool', () => {
  it('bare runtime tool ignores template_id business fields without host wrap', async () => {
    const requests: LLMRequest[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-bare-'))
    const tool = createAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-template' },
      model: 'parent-model',
    })

    await tool.execute({ prompt: 'x', template_id: 'tpl-1' }, makeContext())
    expect(requests[0].model).toBe('parent-model')
  })
})

describe('createHostAgentTool deliverables enrich', () => {
  it('foreground COMPLETED + tool_result include collected deliverables', async () => {
    const requests: LLMRequest[] = []
    const events: StreamEvent[] = []
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-tool-deliverables-'))
    const spy = vi.spyOn(childDeliverables, 'collectChildDeliverables').mockResolvedValue([
      {
        artifact_kind: 'local_file',
        relative_path: 'out/a.md',
        filename: 'a.md',
      },
    ])

    const tool = createHostAgentTool({
      provider: makeProvider(requests),
      tools: createMockToolProvider([makeTool('read_file')]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir, threadId: 'thread-deliverables' },
      model: 'parent-model',
    }, {
      sessionConfig: { sessionDir, threadId: 'thread-deliverables' },
      getTemplateSnapshots: () => new Map(),
    })

    const result = await tool.execute(
      { prompt: 'do work', description: 'deliverables spawn' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    )

    expect(typeof result.content).toBe('string')
    expect(result.content as string).toContain('tabtin-subagent-deliverables')
    expect(result.content as string).toContain('out/a.md')

    const completed = events.find((e) => e.type === 'agent.stream.subagent_completed')
    expect(completed?.payload).toMatchObject({
      deliverables: [
        {
          artifact_kind: 'local_file',
          relative_path: 'out/a.md',
          filename: 'a.md',
        },
      ],
    })
    spy.mockRestore()
  })
})
