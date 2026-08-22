import { describe, expect, it } from 'vitest'
import { PromptForwardPayloadSchema } from '../src/prompt.js'

/**
 * ：未决审批 interrupt_state 带显式 null 时，整包 prompt.forward 不得被拒。
 */
describe('PromptForwardPayloadSchema interrupt_state null tolerance', () => {
  it('accepts pending approvals with null outcome/scope/resolved_at/version', () => {
    const parsed = PromptForwardPayloadSchema.safeParse({
      task_id: 'task-1',
      prompt: 'hello',
      agent_config: { type: 'local' },
      workspace_id: 'workspace-1',
      interrupt_state: {
        version: null,
        pending_approvals: [
          {
            batch_id: 'batch-1',
            request_id: 'req-1',
            tool_call_id: 'tc-1',
            tool_name: 'execute_command',
            status: 'pending',
            outcome: null,
            scope: null,
            resolved_at: null,
          },
        ],
      },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.interrupt_state?.version).toBeNull()
      expect(parsed.data.interrupt_state?.pending_approvals?.[0]?.outcome).toBeNull()
    }
  })
})
