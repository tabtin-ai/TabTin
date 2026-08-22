import { describe, expect, it, vi } from 'vitest'
import {
  hasUserInputContent,
  decodeForwardRequest,
  decodeForwardRequestDetailed,
} from '../src/conversation/forward-request-decoder.js'

const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
}

const DEFAULT_AGENT_CONFIG = { type: 'local' } as const
// ：wire schema 强制 `workspace_id: z.string().min(1)`。测试用例默认注入
// 一个占位值保证 zod 校验通过；单个用例可在 payload 里显式覆盖以断言解码结果。
const DEFAULT_WORKSPACE_ID = 'workspace-default'

function envelope(
  payload: Record<string, unknown>,
  threadId = 'chat-session-session-1',
) {
  // wire schema 强制 `agent_config: AgentBackendConfigSchema`。测试用例默认注入
  // `{ type: 'local' }` 保证 zod 校验通过；单个用例可在 payload 里显式覆盖。
  const withDefaults: Record<string, unknown> = {
    agent_config: DEFAULT_AGENT_CONFIG,
    workspace_id: DEFAULT_WORKSPACE_ID,
    ...payload,
  }
  return {
    thread_id: threadId,
    payload: withDefaults,
  } as never
}

describe('decodeForwardRequest', () => {
  it('rejects requests without task id or usable user input', () => {
    expect(decodeForwardRequest(envelope({ prompt: 'hello' }), logger)).toBeNull()
    expect(decodeForwardRequest(envelope({ task_id: 'prompt-1', prompt: '  ' }), logger)).toBeNull()
  })

  it('accepts a valid attachment without text', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: '',
        attachments: [{ type: 'file', file_id: 'file-1' }],
      }),
      logger,
    )

    expect(request?.threadId).toBe('session-1')
    expect(request?.attachments).toHaveLength(1)
  })

  it('accepts user_message_blocks without text/attachments ', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: '',
        user_message_blocks: [{ type: 'table_selection', table_id: 't1', preview: '表' }],
      }),
      logger,
    )

    expect(request?.userMessageBlocks).toEqual([
      { type: 'table_selection', table_id: 't1', preview: '表' },
    ])
  })

  it('#7879 decodes the visible user sender independently from runtime owner', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: '共享发言',
        sender_user_id: 'grantee-1',
      }),
      logger,
    )

    expect(request?.senderUserId).toBe('grantee-1')
  })

  it('#9234 decodes skill_slash_invoke to skillSlashInvoke', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: '/table-modeling 帮我建表',
        skill_slash_invoke: {
          skill_key: 'app:tabdata/table-modeling',
          args: '帮我建表',
        },
      }),
      logger,
    )

    expect(request?.skillSlashInvoke).toEqual({
      skillKey: 'app:tabdata/table-modeling',
      args: '帮我建表',
    })
  })

  it('rejects empty-object user_message_blocks as missing content', () => {
    expect(
      decodeForwardRequest(
        envelope({
          task_id: 'prompt-1',
          prompt: '',
          user_message_blocks: [{}],
        }),
        logger,
      ),
    ).toBeNull()
    expect(hasUserInputContent('', undefined, [{}])).toBe(false)
    expect(hasUserInputContent('', undefined, [{ type: 'file', file_id: 'f1' }])).toBe(true)
  })

  it('uses the business session as the runtime identity while preserving task correlation', () => {
    const runId = '5a4db13f-b50c-4b46-b031-358c04f64c42'
    const request = decodeForwardRequest(
      envelope({ task_id: 'prompt-1', run_id: runId, prompt: 'hello' }),
      logger,
    )

    expect(request).toMatchObject({
      threadId: 'session-1',
      runId,
      taskId: 'prompt-1',
    })
    expect(request?.relaySessionId).toBeUndefined()
  })

  it('maps consecutive forwarded turns onto one stable runtime identity', () => {
    const first = decodeForwardRequest(
      envelope({ task_id: 'prompt-first', prompt: 'first' }),
      logger,
    )
    const second = decodeForwardRequest(
      envelope({ task_id: 'prompt-second', prompt: 'second' }),
      logger,
    )

    expect(first?.threadId).toBe('session-1')
    expect(second?.threadId).toBe('session-1')
    expect(first?.taskId).toBe('prompt-first')
    expect(second?.taskId).toBe('prompt-second')
  })

  it('keeps a non-conversation forward isolated by task identity', () => {
    const request = decodeForwardRequest(
      envelope({ task_id: 'prompt-background', prompt: 'run' }, 'background-task'),
      logger,
    )

    expect(request?.threadId).toBe('prompt-background')
  })

  it('normalizes modes and positive model limits', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        agent_mode: 'plan',
        interaction_mode: 'scheduled',
        personal_rules: 'always cite sources',
        context_window_tokens: '64000',
        max_output_tokens: 8192,
      }),
      logger,
    )

    expect(request).toMatchObject({
      agentMode: 'plan',
      interactionMode: 'scheduled',
      personalRules: 'always cite sources',
      modelContextWindow: 64000,
      modelMaxOutput: 8192,
    })
  })

  it('decodes supports_document_input for  native document feed', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        supports_document_input: true,
        supports_video_input: true,
      }),
      logger,
    )

    expect(request).toMatchObject({
      modelSupportsDocumentInput: true,
      modelSupportsVideoInput: true,
    })
  })

  it('decodes workspace_id for execution-field binding', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        workspace_id: 'ws-1',
        agent_id: 'agent-1',
      }),
      logger,
    )

    expect(request).toMatchObject({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
    })
  })

  it('decodes the Agent mention interrupt flag', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: '@Agent handle this task',
        interrupt_active: true,
      }),
      logger,
    )

    expect(request?.interruptActive).toBe(true)
  })

  it('decodes FocusSnapshot app_context and keeps host-only passthrough keys', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        app_context: {
          appType: 'tabmemo',
          appMeta: { current_memo_id: 'memo_1', current_memo_title: '灵感' },
          spaceId: 'space-1',
          collaborationSpaceId: 'proj-1',
        },
      }),
      logger,
    )

    expect(request?.appContext).toMatchObject({
      appType: 'tabmemo',
      spaceId: 'space-1',
      collaborationSpaceId: 'proj-1',
    })
    expect(request?.appContext?.appMeta).toMatchObject({
      current_memo_id: 'memo_1',
      current_memo_title: '灵感',
    })
  })

  it('maps a remote conversation _invoked_from onto the originating workspace scope', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'open zhihu',
        app_context: {
          appType: 'chat',
          _invoked_from: 'conversation:session-origin',
        },
      }),
      logger,
    )

    expect(request?.appContext).toMatchObject({
      _invoked_from: 'conversation:session-origin',
      tabScopeKey: 'conversation:session-origin',
      workspaceScopeKey: 'conversation:session-origin',
    })
  })

  it('maps a remote desktop _invoked_from onto the originating workspace scope', () => {
    const desktopScope = 'desktop:organization:org-1:user:user-1'
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'open zhihu',
        app_context: {
          appType: 'chat',
          _invoked_from: desktopScope,
        },
      }),
      logger,
    )

    expect(request?.appContext).toMatchObject({
      _invoked_from: desktopScope,
      tabScopeKey: desktopScope,
      workspaceScopeKey: desktopScope,
    })
  })

  it('keeps explicit workspace scope fields ahead of legacy _invoked_from', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'open zhihu',
        app_context: {
          _invoked_from: 'conversation:legacy-session',
          tabScopeKey: 'conversation:explicit-session',
          workspaceScopeKey: 'conversation:explicit-session',
        },
      }),
      logger,
    )

    expect(request?.appContext).toMatchObject({
      tabScopeKey: 'conversation:explicit-session',
      workspaceScopeKey: 'conversation:explicit-session',
    })
  })

  it('does not treat a non-workspace _invoked_from marker as a tab scope', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'run mention',
        app_context: {
          _invoked_from: 'tabchat_mention',
        },
      }),
      logger,
    )

    expect(request?.appContext).toMatchObject({
      _invoked_from: 'tabchat_mention',
    })
    expect(request?.appContext).not.toHaveProperty('tabScopeKey')
    expect(request?.appContext).not.toHaveProperty('workspaceScopeKey')
  })

  it('strips non-object app_context and continues decoding ( P1-6)', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        app_context: 'tabdoc',
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.prompt).toBe('hello')
      expect(result.request.threadId).toBe('session-1')
      expect(result.request.appContext).toBeUndefined()
    }
  })

  it('strips illegal Focus app_context (body in appMeta) without blocking prompt ( P1-6)', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello from body',
        app_context: {
          appType: 'tabdoc',
          appMeta: { content: 'should-not-block-forward' },
        },
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.prompt).toBe('hello from body')
      expect(result.request.appContext).toBeUndefined()
    }
  })

  it('strips openTabs missing type without blocking prompt ( P1-6)', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'keep going',
        app_context: {
          appType: 'tabdoc',
          openTabs: [{ id: 'doc-1', active: true }],
        },
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.prompt).toBe('keep going')
      expect(result.request.appContext).toBeUndefined()
    }
  })

  it('extends fields covered by the Daemon path: approval_grant, disabled_apps, operation_switches, execution_limits, memory_capability, space/organization, working_dir_type, enabled_apps, attachment_strategy, agent_config, cli_reference', () => {
    const request = decodeForwardRequest(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        approval_mode: 'auto',
        approval_grant: 'full_access',
        agent_config: {
          type: 'local',
          disabled_apps: ['tabdata'],
          disabled_tool_prefixes: ['sql'],
        },
        operation_switches: { git_push: 'confirm' },
        authorization_rules: { read: 'auto' },
        device_permissions: { screen_capture: 'block' },
        execution_limits: { max_iterations_per_run: 300, max_credits_per_run: 5.5 },
        memory_capability: true,
        working_dir_type: 'code',
        workspace_root: '/Users/me/TabTin/org/my-space',
        space_id: 'space-1',
        space_name: 'Space One',
        organization_name: 'Org One',
        attachment_strategy: 'cloud_only',
        enabled_apps: [
          { key: 'tabdata', display_name: 'TabData', capability: 'sql', cli_key: 'data', aliases: ['excel'] },
        ],
        cli_reference: '# tabtin capabilities tools ...',
      }),
      logger,
    )

    expect(request).toMatchObject({
      approvalMode: 'auto',
      approvalGrant: 'full_access',
      disabledApps: ['tabdata'],
      disabledToolPrefixes: ['sql'],
      operationSwitches: { git_push: 'confirm' },
      authorizationRules: { read: 'auto' },
      devicePermissions: { screen_capture: 'block' },
      executionLimits: { max_iterations_per_run: 300, max_credits_per_run: 5.5 },
      memoryCapability: true,
      workingDirType: 'code',
      workingDir: '/Users/me/TabTin/org/my-space',
      spaceId: 'space-1',
      spaceName: 'Space One',
      organizationName: 'Org One',
      attachmentStrategy: 'cloud_only',
      cliReference: '# tabtin capabilities tools ...',
    })
    expect(request?.enabledApps).toEqual([
      {
        key: 'tabdata',
        displayName: 'TabData',
        capability: 'sql',
        cliKey: 'data',
        aliases: ['excel'],
      },
    ])
    expect(request?.agentConfig).toMatchObject({ type: 'local' })
    expect(request?.parsedPayload?.task_id).toBe('prompt-1')
  })
})

describe('decodeForwardRequestDetailed', () => {
  it('returns schema_invalid for malformed wire payload (agent_config missing / wrong type)', () => {
    // wire schema 强制 agent_config 为 object；给一个 string 让 zod 报错，
    // 主宿主可基于 result.error 上报生命周期。
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
        agent_config: 'not-an-object',
      }),
      { warn: vi.fn(), debug: vi.fn() },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema_invalid')
      expect(result.error).toContain('Invalid prompt.forward payload')
    }
  })

  it('returns missing_content when zod-valid payload lacks usable user input', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: '',
        attachments: [],
      }),
      logger,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing_content')
    }
  })

  it('returns ok + camelCase request on success', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'hello',
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.threadId).toBe('session-1')
      expect(result.request.agentConfig?.type).toBe('local')
    }
  })

  it('decodes structured /skill activation for deterministic runtime prelude', () => {
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: '/meeting-notes 整理今天的会议',
        skill_slash_invoke: {
          skill_key: 'app:office/meeting-notes',
          args: '整理今天的会议',
        },
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.skillSlashInvoke).toEqual({
        skillKey: 'app:office/meeting-notes',
        args: '整理今天的会议',
      })
    }
  })

  it('accepts pending interrupt_state with explicit null fields ', () => {
    // api-test / 未部署清洗补丁的 Django 会把未决审批的 outcome/scope/resolved_at
    // 以及 version 序列化成 null；decoder 不得整包 schema_invalid。
    const result = decodeForwardRequestDetailed(
      envelope({
        task_id: 'prompt-1',
        prompt: 'continue after approval hang',
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
            {
              batch_id: 'batch-1',
              request_id: 'req-2',
              tool_call_id: 'tc-2',
              tool_name: 'write_file',
              status: 'pending',
              outcome: null,
              scope: null,
              resolved_at: null,
            },
          ],
        },
      }),
      logger,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.pendingApprovalsSerialized).toHaveLength(2)
      expect(result.request.pendingApprovalsSerialized?.[0]).toMatchObject({
        requestId: 'req-1',
        status: 'pending',
      })
      expect(result.request.pendingApprovalsSerialized?.[0]?.outcome).toBeUndefined()
    }
  })
})

describe('hasUserInputContent', () => {
  it('ignores malformed attachments', () => {
    expect(hasUserInputContent('', [{}])).toBe(false)
    expect(hasUserInputContent('', [{ type: 'image', url: 'https://example.com/a.png' }])).toBe(true)
  })
})
