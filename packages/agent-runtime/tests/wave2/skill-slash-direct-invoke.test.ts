import { describe, it, expect } from 'vitest';
import { createRuntime } from '../../src/runtime-assembly.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from '../test-utils.js';
import type {
  StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import type { ToolResult } from '../../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../../src/engine/contracts/kernel.js';
import { bindTestAgentModesToolGate } from '../helpers/agent-modes-tool-gate.js';

/**
 *  斜杠命令直链 Skill — runtime 侧 envelope 集成测试。
 *
 * 用户通过 `/skill args` 明确选定 Skill：runtime 在首次 LLM 调用前确定性执行
 * skill_invoke 展开（等价于 LLM 主动调工具，但省掉 meta-prompt + 决策 + 工具往返），
 * 消除斜杠场景下 LLM 上下文里冗余的第二条 user 输入。
 *
 * 放在 tests/wave2/，纳入 Agent Runtime 默认测试套件。
 */

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

function makeSkillActivation(spy?: (input: unknown) => void) {
  return async (input: unknown): Promise<ToolResult> => {
      spy?.(input);
      const { skill, args } = (input ?? {}) as { skill?: string; args?: string };
      return {
        content: `正在执行技能：${skill}`,
        newMessages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: `<skill_instructions key="${skill}">\nBODY args=${args ?? ''}\n</skill_instructions>` },
            ],
          },
        ],
        contextModifier: {
          activeSkill: { skillKey: String(skill), primaryEnv: undefined },
        },
      };
  };
}

function makeSkillActivationError(content: string) {
  return async (): Promise<ToolResult> => ({
      content,
      isError: true,
    });
}

function simpleTextProvider() {
  return createMockProvider([
    [
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ],
  ]);
}

describe('#3096 skillSlashInvoke — runtime 斜杠直链', () => {
  it('agent 模式：首次 LLM 调用前确定性展开 skill，emit source=skill_invoke 的 user 事件', async () => {
    let invokedWith: unknown;
    const activation = makeSkillActivation((input) => { invokedWith = input; });
    const rt = createRuntime(makeConfig({ provider: simpleTextProvider(), skillActivation: activation }));

    const events = await collectEvents(
      rt.query({
      hostRunId: 'test-run',
        prompt: '/meeting-notes summarize today',
        skillSlashInvoke: { skillKey: 'app:office/meeting-notes', args: 'summarize today' },
      }),
    );

    // skill_invoke 被确定性调用（不经 LLM 决策）
    expect(invokedWith).toEqual({
      skill: 'app:office/meeting-notes',
      args: 'summarize today',
      agentRunId: 'test-run',
    });

    const userEvents = events.filter((e) => e.type === 'agent.stream.user');
    // 主 user 事件（斜杠原文） + skill 注入 user 事件
    expect(userEvents.length).toBe(2);
    const primary = userEvents[0].payload as Record<string, unknown>;
    const injected = userEvents[1].payload as Record<string, unknown>;
    expect(primary.content).toBe('/meeting-notes summarize today');
    expect(primary.source).toBeUndefined();
    expect(injected.source).toBe('skill_invoke');
    expect(String(injected.content)).toContain('skill_instructions');
    expect(String(injected.content)).toContain('app:office/meeting-notes');
    expect(injected.blocks_json).toEqual([{ type: 'text', text: injected.content }]);

    // skill 注入必须在首个 assistant message_start 之前（首次 LLM 已能看到 skill 正文）
    const injectedIdx = events.findIndex(
      (e) => e.type === 'agent.stream.user' && (e.payload as Record<string, unknown>).source === 'skill_invoke',
    );
    const firstAssistantIdx = events.findIndex((e) => e.type === 'agent.stream.message_start');
    expect(injectedIdx).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIdx).toBeGreaterThan(injectedIdx);
  });

  it('受限模式（agentMode=plan）：仍展开只读 Skill 入口', async () => {
    let invoked = false;
    const activation = makeSkillActivation(() => { invoked = true; });
    //  /  Stage 4：受限模式经 ToolGate.isRestrictedMode（测试包装 agent-modes）。
    const rt = createRuntime(makeConfig({
      provider: simpleTextProvider(),
      skillActivation: activation,
      agentMode: 'plan',
      bindToolGate: (cfg) => bindTestAgentModesToolGate(cfg),
    }));

    const events = await collectEvents(
      rt.query({
      hostRunId: 'test-run',
        prompt: '/meeting-notes summarize',
        skillSlashInvoke: { skillKey: 'app:office/meeting-notes', args: 'summarize' },
      }),
    );

    expect(invoked).toBe(true);
    const skillUser = events.find(
      (e) => e.type === 'agent.stream.user' && (e.payload as Record<string, unknown>).source === 'skill_invoke',
    );
    expect(skillUser).toBeDefined();
    const notice = events.find(
      (e) => e.type === 'agent.stream.system_notice'
        && (e.payload as Record<string, unknown>).notice_type === 'skill_slash_restricted_mode',
    );
    expect(notice).toBeUndefined();
  });

  it('Skill 激活器未配置：emit unavailable notice，不注入 user 消息', async () => {
    const rt = createRuntime(makeConfig({ provider: simpleTextProvider(), tools: createMockToolProvider([]) }));

    const events = await collectEvents(
      rt.query({
      hostRunId: 'test-run',
        prompt: '/meeting-notes',
        skillSlashInvoke: { skillKey: 'app:office/meeting-notes' },
      }),
    );

    const skillUser = events.find(
      (e) => e.type === 'agent.stream.user' && (e.payload as Record<string, unknown>).source === 'skill_invoke',
    );
    expect(skillUser).toBeUndefined();
    const notice = events.find(
      (e) => e.type === 'agent.stream.system_notice'
        && (e.payload as Record<string, unknown>).notice_type === 'skill_slash_unavailable',
    );
    expect(notice).toBeDefined();
  });

  it('skill_invoke 返回 JSON 错误时，slash notice 只显示 error 字段', async () => {
    const displayError = '技能 `app:tabmemo/tabmemo-operator` 存在，但当前 Agent 未启用。请在 Agent 技能设置中添加并开启该技能后再试。';
    const activation = makeSkillActivationError(JSON.stringify({
      success: false,
      error_kind: 'skill_not_found',
      reason: 'not_enabled_for_agent',
      key: 'app:tabmemo/tabmemo-operator',
      hint: 'The skill exists locally but is not in the current Agent carry/enable set.',
      error: displayError,
    }));
    const rt = createRuntime(makeConfig({ provider: simpleTextProvider(), skillActivation: activation }));

    const events = await collectEvents(
      rt.query({
      hostRunId: 'test-run',
        prompt: '/tabmemo-operator',
        skillSlashInvoke: { skillKey: 'app:tabmemo/tabmemo-operator' },
      }),
    );

    const notice = events.find(
      (e) => e.type === 'agent.stream.system_notice'
        && (e.payload as Record<string, unknown>).notice_type === 'skill_slash_error',
    );
    expect(notice).toBeDefined();
    const content = String((notice?.payload as Record<string, unknown> | undefined)?.content ?? '');
    expect(content).toBe(displayError);
    expect(content).not.toContain('error_kind');
    expect(content).not.toContain('hint');
    expect(content).not.toContain('"success"');
  });

  it('无 skillSlashInvoke 时行为不变（不注入额外 user 事件）', async () => {
    const rt = createRuntime(makeConfig({ provider: simpleTextProvider() }));

    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: '普通消息' }));
    const userEvents = events.filter((e) => e.type === 'agent.stream.user');
    expect(userEvents.length).toBe(1);
    expect((userEvents[0].payload as Record<string, unknown>).source).toBeUndefined();
  });

  it('#7713 斜杠 enablement 刷新先于 beforeRun 快照和 skill_invoke', async () => {
    const order: string[] = [];
    const activation = makeSkillActivation(() => {
      order.push('skill_invoke');
    });
    const rt = createRuntime(makeConfig({
      provider: simpleTextProvider(),
      skillActivation: activation,
      refreshSkillEnablementForSlash: async () => {
        order.push('refreshEnablement');
      },
      hooks: {
        beforeRun: async () => {
          order.push('beforeRun');
        },
      },
    }));

    await collectEvents(
      rt.query({
      hostRunId: 'test-run',
        prompt: '/meeting-notes',
        skillSlashInvoke: { skillKey: 'app:office/meeting-notes' },
      }),
    );

    expect(order).toEqual(['refreshEnablement', 'beforeRun', 'skill_invoke']);
  });
});
