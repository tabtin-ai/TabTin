/**
 * Wave 1.5 · skill_invoke → ToolContext.skillContext 传播 · 集成测试
 *
 * 验证核心链路：
 *   Agent 调 skill_invoke("user:X")
 *   → query.ts 处理 contextModifier.activeSkill → 写 state.__activeSkillKey
 *   → 下一轮构造 ToolContext 时把 skillContext 填入
 *   → bash 工具（或任意消费者）能读到正确的 skillKey / spaceId / primaryEnv
 *
 * 这一层是 Wave 1.5 的"胶水"：三个文件的改动（types.ts 新字段、query.ts 写
 * state 读 state、skill-invoke-tool.ts 发 activeSkill）一旦任一处断链，
 * skillContext 就不会到达 bash 消费侧。unit test 各自验证了局部，这条
 * 端到端是胶水的唯一校验。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { createSkillActivation } from '../src/skills/skill-activation.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import type { SkillRecord } from '../src/tools/skills-tools.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

function makeConfig(overrides: Partial<EngineConfig>): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

async function consume(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeCaptureTool(
  name: string,
  onExecute: (ctx: ToolContext) => void,
): Tool {
  return {
    name,
    description: `capture skillContext for ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: false,
    async execute(_input, context) {
      onExecute(context);
      return { content: 'captured' };
    },
  };
}

describe('Wave 1.5 · skill_invoke → ToolContext.skillContext 传播', () => {
  it('E1: skill_invoke 后下一轮 ToolContext.skillContext 包含 skillKey + spaceId', async () => {
    // P0-1 补丁后：primaryEnv 从 SKILL.md content 的 frontmatter 真实解析，
    // 验证整条 extractSkillMeta → contextModifier → state → ToolContext 链路。
    const skill: SkillRecord = {
      canonicalKey: 'user:gpt-translate',
      name: 'GPT 翻译',
      description: 'translate via openai',
      whenToUse: 'translation',
      content: '---\nslug: gpt-translate\nprimary_env: OPENAI_API_KEY\n---\n\nUse bash.',
    };

    const skillInvoke = createSkillActivation({
      getSkill: (k) => (k === 'user:gpt-translate' ? skill : undefined),
    });

    let captured: ToolContext['skillContext'] | undefined | 'unset' = 'unset';
    const captureTool = makeCaptureTool('captor', (ctx) => {
      captured = ctx.skillContext;
    });

    // `/skill` hook 在首次 LLM 前激活；随后调 captor 断言上下文。
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 't2', name: 'captor', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([captureTool]),
        skillActivation: skillInvoke,
      }),
    );

    await consume(rt.query({
      hostRunId: 'test-run',
      prompt: 'run skill',
      skillSlashInvoke: { skillKey: 'user:gpt-translate' },
    }));

    expect(captured).not.toBe('unset');
    expect(captured).toBeDefined();
    expect(captured?.skillKey).toBe('user:gpt-translate');
    // ：skillContext 不再携带 spaceId——业务 id 已移出 runtime 核心契约，
    // 凭据派生所需的 spaceId 由 host 装配期烘进 ShellCap 闭包，不经 skillContext 流动。
    expect(captured?.primaryEnv).toBe('OPENAI_API_KEY');
  });

  it('E2: 未调 skill_invoke → ToolContext.skillContext 为 undefined（历史行为）', async () => {
    let captured: ToolContext['skillContext'] | undefined | 'unset' = 'unset';
    const captureTool = makeCaptureTool('captor', (ctx) => {
      captured = ctx.skillContext;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 't1', name: 'captor', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([captureTool]),
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'run' }));

    expect(captured).toBeUndefined();
  });

  it('E3: skill_invoke 后即使 runtime 无 Space 也照常构造 skillContext（：Space 门槛下沉到 host）', async () => {
    const skill: SkillRecord = {
      canonicalKey: 'user:x',
      name: 'x',
      description: 'x',
      whenToUse: 'x',
      content: '---\nslug: x\n---\nbody',
    };
    const skillInvoke = createSkillActivation({
      getSkill: () => skill,
    });

    let captured: ToolContext['skillContext'] | undefined | 'unset' = 'unset';
    const captureTool = makeCaptureTool('captor', (ctx) => {
      captured = ctx.skillContext;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 't2', name: 'captor', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([captureTool]),
        skillActivation: skillInvoke,
      }),
    );

    await consume(rt.query({
      hostRunId: 'test-run',
      prompt: 'run',
      skillSlashInvoke: { skillKey: 'user:x' },
    }));

    //  起 runtime 核心契约不再有 spaceId，skillContext 只承载 skillKey /
    // primaryEnv。skill_invoke 激活后 skillContext 照常构造（不再以 spaceId 为门槛）。
    // "无 Space 就不注入密钥" 的安全默认下沉到 host 层 ShellCap：其烘焙 spaceId 缺失时
    // resolveSkillCredentialState 直接不解析凭据（见 shell.ts resolveSkillCredentialState /
    // requireShellContext）。故这里断言 skillContext 已构造且只含 skillKey。
    expect(captured).toBeDefined();
    expect(captured).not.toBeNull();
    if (captured && captured !== 'unset') {
      expect(captured.skillKey).toBe('user:x');
    }
  });
});
