import { describe, expect, it } from 'vitest'
import {
  createRuntime,
  type StreamEvent,
} from '@tabtin/agent-runtime'
import type {
  EngineConfig,
  LLMProvider,
  LLMRequest,
} from '@tabtin/agent-runtime/engine'
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from '../../agent-runtime/tests/test-utils.js'
import type { WorkingDirType } from '@tabtin/agent-prompt'
import { assembleSystemPrompt } from '../src/prompt/system-prompt-assembler.js'
import { buildWorktreeRoutingHook } from '../src/hooks/worktree-routing-hook.js'

async function drain(generator: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of generator) {
    // Provider request capture is the assertion surface.
  }
}

async function captureSystemPrompt(workingDirType?: WorkingDirType): Promise<string> {
  const captured: LLMRequest[] = []
  const provider: LLMProvider = {
    async *createStream(request) {
      captured.push(request)
      yield { type: 'text_delta', text: 'done' }
      yield { type: 'stop', stopReason: 'end_turn' }
    },
  }
  const { systemPrompt } = assembleSystemPrompt(
    { workingDirType },
    { agentMode: 'agent', tools: [] },
  )
  const config: EngineConfig = {
    provider,
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'worktree-routing-prompt' },
    model: 'test-model',
    systemPrompt,
    hooks: buildWorktreeRoutingHook({ workingDirType }),
  }

  await drain(createRuntime(config).query({ hostRunId: 'test-run', prompt: '开始' }))

  expect(captured).toHaveLength(1)
  const system = captured[0]!.system
  return typeof system === 'string' ? system : JSON.stringify(system)
}

describe('对话 worktree CLI 路由 hook', () => {
  it.each(['code', 'mixed'] as const)('%s 代码场景注入平台路由规则', async (workingDirType) => {
    const system = await captureSystemPrompt(workingDirType)

    expect(system).toContain('section:cli_commands source:worktree-routing')
    expect(system).toContain('<worktree_routing>')
    expect(system).toContain('`tabtin code worktree create`')
    expect(system).toContain('`tabtin code worktree switch`')
    expect(system).toContain('必须在前台等待命令完成')
    expect(system).toContain('用户未指定路径时不要添加 `--path`')
  })

  it.each([undefined, 'doc'] as const)('%s 场景不注入 worktree 路由', async (workingDirType) => {
    const system = await captureSystemPrompt(workingDirType)
    expect(system).not.toContain('<worktree_routing>')
    expect(system).not.toContain('source:worktree-routing')
  })
})
