import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '@tabtin/agent-runtime/engine'
import { AgentWorktreeTransitionQueue } from '../agent-worktree-transition'
import { buildAgentWorktreeLifecycleHook } from '../agent-worktree-lifecycle-hook'

const tool: Tool = {
  name: 'write_file',
  description: 'test write',
  isReadOnly: false,
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'ok' }),
}

describe('Agent worktree lifecycle hook', () => {
  it('跳过已安排交接后的同批工具，并在发起工具过边界后请求 handoff', async () => {
    const transitions = new AgentWorktreeTransitionQueue()
    transitions.schedule({
      sessionId: 'session-1',
      runId: 'run-1',
      toolUseId: 'tool-create',
      previousRootPath: '/repo',
      targetRootPath: '/repo-wt',
      created: true,
    })
    transitions.markOperationCompleted('run-1')
    const hook = buildAgentWorktreeLifecycleHook({ transitions })
    const skipCurrentTool = vi.fn()

    await hook.beforeTool?.({
      runId: 'run-1',
      toolUseId: 'tool-write-later',
      tool,
      input: {},
      skipCurrentTool,
    } as never)

    expect(skipCurrentTool).toHaveBeenCalledWith('agent_worktree_transition_pending')

    const requestStopAfterToolResults = vi.fn()
    await hook.afterToolResult?.({
      runId: 'run-1',
      iteration: 0,
      results: [{
        toolName: 'run_terminal_command',
        toolUseId: 'tool-create',
        input: {},
        result: { content: 'created' },
        durationMs: 1,
      }],
      requestStopAfterToolResults,
    } as never)

    expect(transitions.peekRun('run-1')?.boundaryReached).toBe(true)
    expect(requestStopAfterToolResults).toHaveBeenCalledWith('agent_worktree_transition')
  })

  it('先记录无 pending 的工具边界，拒绝同一后台工具稍后登记切换', async () => {
    const transitions = new AgentWorktreeTransitionQueue()
    const hook = buildAgentWorktreeLifecycleHook({ transitions })
    const requestStopAfterToolResults = vi.fn()

    await hook.afterToolResult?.({
      runId: 'run-late',
      iteration: 0,
      results: [{
        toolName: 'run_terminal_command',
        toolUseId: 'tool-background',
        input: {},
        result: { content: 'running' },
        durationMs: 1,
      }],
      requestStopAfterToolResults,
    } as never)

    expect(requestStopAfterToolResults).not.toHaveBeenCalled()
    expect(transitions.schedule({
      sessionId: 'session-late',
      runId: 'run-late',
      toolUseId: 'tool-background',
      previousRootPath: '/repo',
      targetRootPath: '/repo-wt',
      created: true,
    })).toMatchObject({
      ok: false,
      code: 'tool_boundary_passed',
    })
  })

  it('不会跳过其他 run 的工具', async () => {
    const transitions = new AgentWorktreeTransitionQueue()
    transitions.schedule({
      sessionId: 'session-1',
      runId: 'run-1',
      toolUseId: 'tool-create',
      previousRootPath: '/repo',
      targetRootPath: '/repo-wt',
      created: true,
    })
    const hook = buildAgentWorktreeLifecycleHook({ transitions })
    const skipCurrentTool = vi.fn()

    await hook.beforeTool?.({
      runId: 'run-2',
      toolUseId: 'tool-unrelated',
      tool,
      input: {},
      skipCurrentTool,
    } as never)

    expect(skipCurrentTool).not.toHaveBeenCalled()
  })
})
