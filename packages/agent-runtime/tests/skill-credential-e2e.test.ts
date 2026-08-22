/**
 * Wave 1.5 · P0-3 补丁：端到端 smoke 测试
 *
 * 反思 3 根因：Wave 1.5 所有测试都是 mock（curl httpbin / mock resolver /
 * mock `_lookup_credential_id_from_space`），没有用真实 SKILL.md + 真实
 * 调用链路跑通过。这让 P0-1（primary_env 传递链路断裂）在 mock 场景下
 * 完全不暴露——只要测试里手工在 `meta.primaryEnv` 上赋值，整条链路
 * 看起来就是通的，但真实 SKILL.md 里写了 `primary_env: DEEPSEEK_API_KEY`
 * 的 Skill 却跑不通。
 *
 * 本测试覆盖的**端到端链路**（无 mock 宿主 populate）：
 *
 *   1. 真实 SKILL.md 字符串（含 `primary_env: DEEPSEEK_API_KEY` 的 frontmatter）
 *   2. skill_invoke 工具解析 frontmatter → contextModifier.activeSkill.primaryEnv
 *   3. query.ts 写入 state.__activeSkillPrimaryEnv
 *   4. 下一轮构造 ToolContext 时 skillContext.primaryEnv = 'DEEPSEEK_API_KEY'
 *   5. ShellCap execute_command 工具调用 SkillContextProvider 时 primaryEnv
 *      参数被真实透传（W2.3 起凭据注入入口已从 legacy `bash` core-tool 迁
 *      到 ShellCap.execute_command；本测试同步迁路径以验证新链路）
 *
 * **为什么这是真正的 E2E（而非 unit）**：
 *   - 不预设 `skill.meta.primaryEnv`——只给 `skill.content`（SKILL.md 原文）；
 *   - 不替换 extractSkillMeta、不 stub LocalSkillRegistry；
 *   - 唯一的 mock 是最外边界（resolver 回调，代表 HTTP 层；以及 BackendSession
 *     的 exec 实现，代表本地子进程层）——让测试不依赖真实 Django 后端，
 *     但整条 runtime → ShellCap → SkillContextProvider 的 TS 链路 100% 跑真代码。
 *
 * **覆盖的多 YAML 写法**（新增 P0-1 要求）：
 *   - E2E-1: `primary_env: DEEPSEEK_API_KEY`（snake_case，Python 习惯）
 *   - E2E-2: `primaryEnv: GEMINI_API_KEY`（camelCase，JS 习惯）
 *   - E2E-3: `primary-env: MOONSHOT_API_KEY`（kebab-case，allowed-tools 同风格）
 *   - E2E-4: 带双引号 `primary_env: "FOO_KEY"`
 *   - E2E-5: 带行内注释 `primary_env: BAR_KEY  # 我的自建 LLM`
 *
 * 还覆盖一个**反例**（E2E-N1）：frontmatter 里没写 primary_env → resolver
 * 收到 primaryEnv=undefined（走到后端 `_derive_generic` 时应该返回 422，
 * 前端据此降级；此处只断言 resolver 的入参正确）。
 *
 * **W11 修复**：原文件用 `createCoreTools({ skillCredentialResolver, policy })`
 * 装配 + LLM 第二轮调 `bash` 工具。但 PRD 08 W6 删 `bash` 后 createCoreTools
 * 已不接受这两个参数，且 `bash` 工具已被 ShellCap.execute_command 取代——
 * resolver 的真正注入点也从 core-tools 迁到 ShellCap.skillContextProvider。
 * 本次重写按新 ShellCap 装配方式跑同一条产品语义链路。
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
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import type { SkillRecord } from '../src/tools/skills-tools.js';
import { ShellCap } from '../src/capability/core/shell.js';
import type { SkillContextProvider } from '../src/capability/core/shell.js';
import type {
  PtyManagerBridge,
  AgentCommandRequest,
  AgentCommandResult,
  AgentSpawnDetachedResult,
  AgentReadOptions,
  AgentReadResult,
  AgentKillSignal,
  AgentSessionEventName,
  AgentSessionEventHandler,
  AgentSessionUnsubscribe,
} from '@tabtin/terminal-core';
import { testHardlineChecker } from './helpers/hardline-checker.js';
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

/**
 * 构造一个 SkillRecord，只给 `content`（真实 SKILL.md 原文），
 * **不**预设 meta/primaryEnv 结构化字段——验证端到端能从 content 解析出来。
 */
function makeSkillFromContent(canonicalKey: string, content: string): SkillRecord {
  return {
    canonicalKey,
    name: canonicalKey,
    description: `auto-gen for ${canonicalKey}`,
    whenToUse: 'e2e test',
    content,
  };
}

/**
 * 构造一个最小的 PtyManagerBridge mock，executeAgentCommand 永远返回
 * status='ok' / exitCode=0 / stdout='ok'。
 *
 * **WP1（2026-05-13）**：原 BackendSession mock 在 ShellCap 接 PtyManagerBridge
 * 后退役——ShellCap 不再调 session.exec。改用 bridge mock 喂同款"不抛错且立
 * 刻返回"语义即可，测试断言 SkillContextProvider 收到的 primaryEnv 不变。
 */
function makeMockBridge(): PtyManagerBridge {
  return {
    async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
      return {
        status: 'ok',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        truncated: false,
        outputBytes: 2,
        cwd: req.cwd ?? '/tmp',
        sessionId: 'sk-e2e-pty-session',
      };
    },
    async spawnAgentSessionDetached(_req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> {
      throw new Error('skill-credential-e2e tests do not exercise background path');
    },
    async readAgentSessionOutput(_id: string, _o?: AgentReadOptions): Promise<AgentReadResult> {
      throw new Error('not used');
    },
    async killAgentSession(_id: string, _s?: AgentKillSignal): Promise<void> {},
    subscribe<E extends AgentSessionEventName>(
      _e: E,
      _h: AgentSessionEventHandler<E>,
    ): AgentSessionUnsubscribe {
      return () => {};
    },
  };
}

/**
 * 跑一整条端到端，返回 SkillContextProvider 被调用时收到的 params 列表。
 *
 * 装配链路：
 *   1. SkillContextProvider mock：记录 resolveCredentials 入参（这就是真实
 *      宿主层向 ShellCap 注入凭据的接口）
 *   2. ShellCap.bind(mockSession)：让 execute_command handler 跑通到 cap 内的
 *      `_skillContextProvider.resolveCredentials(...)` 调用点
 *   3. createMockToolProvider 装 [skillInvokeTool, ...shellCap.tools()]：让
 *      LLM 第一轮的 skill_invoke 与第二轮的 execute_command 都能命中真工具
 *   4. provider 给 3 轮脚本：(1) skill_invoke → (2) execute_command → (3) end
 */
async function runE2E(
  skill: SkillRecord,
): Promise<Array<{ skillKey: string; spaceId: string; agentId: string; primaryEnv?: string }>> {
  const skillInvokeTool = createSkillActivation({
    getSkill: (key) => (key === skill.canonicalKey ? skill : undefined),
  });

  const resolverCalls: Array<{
    skillKey: string;
    spaceId: string;
    agentId: string;
    primaryEnv?: string;
  }> = [];
  const provider: SkillContextProvider = {
    async resolveCredentials(params, _signal) {
      // 记录真实收到的 primaryEnv——这是 E2E 链路断裂时会 undefined 的唯一点
      resolverCalls.push({
        skillKey: params.skillKey,
        spaceId: params.spaceId,
        agentId: params.agentId,
        primaryEnv: params.primaryEnv,
      });
      // 返回 null 让 ShellCap 降级为不注入（本测试只关心 params 是否到达，不关心注入）
      return null;
    },
  };

  //  RB2：ShellCap 的凭据派生 / requireShellContext 读的是 host 装配期
  // 烘进的 spaceId，不再从 ToolContext 取业务 id——故把 spaceId 烘进 ShellCap，
  // resolver 收到的 params.spaceId 即此烘焙值。
  const shellCap = new ShellCap({
      checkHardlineCommand: testHardlineChecker,
    ptyManagerBridge: makeMockBridge(),
    skillContextProvider: provider,
    spaceId: 'space-e2e',
    agentId: 'agent-e2e',
  });

  // `/skill` hook 在首次 LLM 前激活；随后调 run_terminal_command 触发 resolver。
  const llmProvider = createMockProvider([
    [
      {
        type: 'tool_use',
        toolUse: { id: 't2', name: 'run_terminal_command', input: { command: 'true' } },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ],
    [
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ],
  ]);

  const rt = createRuntime(
    makeConfig({
      provider: llmProvider,
      tools: createMockToolProvider(shellCap.tools()),
      skillActivation: skillInvokeTool,
    }),
  );

  await consume(rt.query({
    hostRunId: 'test-run',
    prompt: 'run skill',
    skillSlashInvoke: { skillKey: skill.canonicalKey },
  }));
  return resolverCalls;
}

describe('Wave 1.5 · P0-3 · Skill 凭据端到端（真实 SKILL.md frontmatter，ShellCap 路径）', () => {
  it('E2E-1: snake_case `primary_env:` → resolver 收到真实值（deepseek 非映射表服务）', async () => {
    const skill = makeSkillFromContent(
      'user:deepseek-translate',
      [
        '---',
        'slug: deepseek-translate',
        'name: deepseek-translate',
        'description: use deepseek for translation',
        'primary_env: DEEPSEEK_API_KEY',
        '---',
        '',
        'Run curl with $DEEPSEEK_API_KEY.',
      ].join('\n'),
    );

    const calls = await runE2E(skill);

    expect(calls).toHaveLength(1);
    expect(calls[0].skillKey).toBe('user:deepseek-translate');
    expect(calls[0].spaceId).toBe('space-e2e');
    // **核心断言**：primaryEnv 从 SKILL.md 正文的 frontmatter 成功传递到 resolver。
    // 原 bug：这里会是 undefined（meta 链路断裂），后端 422。
    expect(calls[0].primaryEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('E2E-2: camelCase `primaryEnv:` → resolver 收到真实值（gemini）', async () => {
    const skill = makeSkillFromContent(
      'user:gemini-summarize',
      [
        '---',
        'slug: gemini-summarize',
        'name: gemini-summarize',
        'description: summarize via gemini',
        'primaryEnv: GEMINI_API_KEY',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('GEMINI_API_KEY');
  });

  it('E2E-3: kebab-case `primary-env:` → resolver 收到真实值（moonshot）', async () => {
    const skill = makeSkillFromContent(
      'user:moonshot-chat',
      [
        '---',
        'slug: moonshot-chat',
        'name: moonshot-chat',
        'description: chat via moonshot',
        'primary-env: MOONSHOT_API_KEY',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('MOONSHOT_API_KEY');
  });

  it('E2E-4: 带双引号的 YAML 值 `primary_env: "FOO_KEY"`', async () => {
    const skill = makeSkillFromContent(
      'user:foo-skill',
      [
        '---',
        'slug: foo-skill',
        'name: foo-skill',
        'description: foo',
        'primary_env: "FOO_KEY"',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('FOO_KEY');
  });

  it('E2E-5: 带行内注释 `primary_env: BAR_KEY  # 自建 LLM`', async () => {
    const skill = makeSkillFromContent(
      'user:bar-skill',
      [
        '---',
        'slug: bar-skill',
        'name: bar-skill',
        'description: bar',
        'primary_env: BAR_KEY  # 自建 LLM 的环境变量',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('BAR_KEY');
  });

  it('E2E-N1: frontmatter 未写 primary_env → resolver 收到 undefined（走后端映射表兜底）', async () => {
    // service_name 在后端映射表里（openai）的场景：primary_env 可缺省
    const skill = makeSkillFromContent(
      'user:openai-translate',
      [
        '---',
        'slug: openai-translate',
        'name: openai-translate',
        'description: openai translate',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBeUndefined();
    // skillKey / spaceId 仍然正确——只是 primaryEnv 这一维是 undefined
    expect(calls[0].skillKey).toBe('user:openai-translate');
  });

  it('E2E-6: lenient 行为 — 多写法同时声明时取第一次出现（发 warn，不静默覆盖）', async () => {
    // 三视角技术优雅 Review #8：lenient 行为必须在测试名字里显性化。
    // 为什么取"第一次"而不是 throw / 取最后一次：
    //   - 保持 Skill 加载**容错**（用户改代码忘删旧写法，不要整条 Skill 炸）；
    //   - 静默"取最后一次"等于悄悄覆盖，下次 primary_env 名字对不上排查极难；
    //   - extractSkillMeta 会发 console.warn 提示作者修正——lenient + 可观察。
    //
    // 若未来要求严格（对齐 js-yaml 行为），此处改为 throw 即可；测试也要
    // 同步改，所以单独起一条显式验证。
    const skill = makeSkillFromContent(
      'user:multi-style',
      [
        '---',
        'slug: multi-style',
        'name: multi-style',
        'description: test multi-style frontmatter',
        'primary_env: FIRST_KEY',
        'primaryEnv:  SECOND_KEY',
        'primary-env: THIRD_KEY',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('FIRST_KEY');
  });

  it('E2E-7: 大小写混写 `Primary_env:` / `PRIMARYENV:` 也识别（产品 Review D）', async () => {
    // Skill 作者从外部 README 复制时常出现大小写偏差。
    // 不识别会导致"看起来写了 primary_env 但没生效"，定位成本极高。
    const skill = makeSkillFromContent(
      'user:caps-style',
      [
        '---',
        'slug: caps-style',
        'name: caps-style',
        'description: test case sensitivity',
        'Primary_env: CAPS_KEY',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBe('CAPS_KEY');
  });

  it('E2E-8: 无 frontmatter 的 SKILL.md → primaryEnv=undefined（漏测补齐）', async () => {
    // 极端 case：正文里没有 --- frontmatter 段。extractSkillMeta 应返回
    // `body=原文`，primaryEnv 为 undefined；skill_invoke 仍能正常激活，只是
    // execute_command 调用时 primaryEnv 不传。
    const skill = makeSkillFromContent(
      'user:no-frontmatter',
      'This skill has no frontmatter at all. Just plain markdown body.',
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBeUndefined();
  });

  it('E2E-9: primary_env 空串 → 视作未设置（primaryEnv=undefined）', async () => {
    // 用户写 `primary_env: ""` 或 `primary_env:` 后空行——视作 unset。
    // 当前 stripInlineDecor 对 `""` 会剥成空串，后面的 `if (rawValue)` 判
    // 假跳过 → primaryEnv 保持 undefined。
    const skill = makeSkillFromContent(
      'user:empty-primary-env',
      [
        '---',
        'slug: empty-primary-env',
        'name: empty-primary-env',
        'description: d',
        'primary_env: ""',
        '---',
        'body',
      ].join('\n'),
    );

    const calls = await runE2E(skill);
    expect(calls[0].primaryEnv).toBeUndefined();
  });
});

// 说明：parseSkillDoc（registry/scanner 路径）的 primary_env 归一化属于
// LocalSkillRegistry 的 unit 覆盖范围，本 E2E 文件专注 skill_invoke →
// execute_command resolver 这条**运行时链路**——三种 YAML 写法的归一化
// 已由 E2E-1 / E2E-2 / E2E-3 在 runtime 层真实跑过，重复覆盖收益有限
// 且引入 js-yaml 的 vitest 解析问题（workspace 内 pnpm 未链接）。
//
// 若需补 parseSkillDoc 专项单测，建议新开
// `tests/skill-doc-parser.test.ts` 并在 vitest 配置里声明 js-yaml 可解析。
