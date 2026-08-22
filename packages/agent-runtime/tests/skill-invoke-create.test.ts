/**
 * `skill_invoke` / `skill_create` 单元测试（H25）
 *
 * 覆盖：
 *   I1 skill_invoke: key 正确 → 返回 newMessages + contextModifier
 *   I2 skill_invoke: key 不存在 → isError
 *   I3 skill_invoke: ext: 前缀 → 拒绝
 *   I4 skill_invoke: content 超 30k → 截断
 *   C1 skill_create: 正常创建 → 调用 writeSkill 回调
 *   C2 skill_create: slug 格式不合法 → isError
 */

import { describe, expect, it, vi } from 'vitest';
import { createSkillActivation, type SkillInvokeDeps } from '../src/skills/skill-activation.js';
import { createSkillCreateTool, type SkillCreateDeps } from '../src/tools/skill-create-tool.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type { SkillRecord } from '../src/tools/skills-tools.js';
import { resolveSpaceSkillDir } from '@tabtin/terminal-core';

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<SkillRecord>): SkillRecord {
  return {
    canonicalKey: 'user:code-review',
    name: '代码审查',
    description: 'Review code for quality and style.',
    whenToUse: 'When the user asks for a code review.',
    content:
      '---\nslug: code-review\nname: 代码审查\ndescription: Review code\nallowed-tools: run_terminal_command read_file\neffort: high\n---\n\n## Instructions\nReview the code thoroughly.',
    ...overrides,
  };
}

function injectedText(result: { newMessages?: Array<{ content: unknown }> }): string {
  return ((result.newMessages![0].content as Array<{ type: string; text: string }>)[0]).text;
}

// ─── skill_invoke ────────────────────────────────────────────────────

describe('skill_invoke', () => {
  it('I1: key 正确 → 返回 newMessages + contextModifier', async () => {
    const skill = makeSkill();
    const deps: SkillInvokeDeps = {
      getSkill: vi.fn((key: string) =>
        key === 'user:code-review' ? skill : undefined,
      ),
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.isError).toBeFalsy();
    expect(result.newMessages).toBeDefined();
    expect(result.newMessages!.length).toBe(1);
    expect(result.newMessages![0].role).toBe('user');

    expect(result.contextModifier).toBeDefined();
    expect(result.contextModifier!.allowedTools).toEqual(['run_terminal_command', 'read_file']);
    expect(result.contextModifier!.effortOverride).toBe('high');

  });

  it('I1-no-section: 即使输入带 section 也注入完整 skill body', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: code-review\nname: 代码审查\ndescription: Review code\nallowed-tools: run_terminal_command read_file\neffort: high\n---\n\n' +
        '# Root\n\nIntro.\n\n' +
        '## Fast Review\n\nUse lightweight checks.\n\n' +
        '## Deep Review\n\nUse full analysis.',
    });
    const activate = createSkillActivation({ getSkill: () => skill });
    const result = await activate({ skill: 'user:code-review', section: 'fast-review' });

    expect(result.isError).toBeFalsy();
    expect(injectedText(result)).toContain('## Fast Review');
    expect(injectedText(result)).toContain('## Deep Review');
    expect(injectedText(result)).not.toContain('section="fast-review"');
  });

  it('I2: key 不存在 → isError', async () => {
    const deps: SkillInvokeDeps = {
      getSkill: () => undefined,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到技能');
  });

  it('I2b: DB 已启用但本地无 SKILL.md → 可诊断错误', async () => {
    const deps: SkillInvokeDeps = {
      getSkill: () => undefined,
      isSkillEnabled: (key) => key === 'user:team-shared',
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:team-shared' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('本机尚未安装 SKILL.md');
    expect(result.content).toContain('已在当前 Agent 启用');
    expect(result.content).toContain('enabled_but_not_installed_locally');
    expect(result.content).not.toContain('可能已被删除或未安装');
  });

  it('I2c: 本地存在但当前 Agent 未启用 → 可诊断错误', async () => {
    const deps: SkillInvokeDeps = {
      getSkill: () => undefined,
      isSkillEnabled: () => false,
      skillExists: (key) => key === 'platform:device/operations',
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'platform:device/operations' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('当前 Agent 未启用');
    expect(result.content).toContain('not_enabled_for_agent');
    expect(result.content).not.toContain('可能已被删除或未安装');
  });

  it('I2d: enablement 快照未就绪 → 可重试错误而非未启用', async () => {
    const activate = createSkillActivation({
      getSkill: () => ({ status: 'not_ready', retryable: true }),
    });
    const result = await activate({ skill: 'platform:device/operations' });
    const parsed = JSON.parse(result.content as string);

    expect(result.isError).toBe(true);
    expect(parsed.reason).toBe('not_ready');
    expect(parsed.retryable).toBe(true);
    expect(parsed.error).toContain('尚未就绪');
    expect(parsed.error_kind).toBe('skill_not_ready');
  });

  it('I3: ext: 前缀 → 拒绝', async () => {
    const deps: SkillInvokeDeps = {
      getSkill: vi.fn(() => {
        throw new Error('should not be called');
      }),
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'ext:weather' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('仅在在线模式下可用');
    expect(deps.getSkill).not.toHaveBeenCalled();
  });

  it('B-1 Wave 2g: validateModel 返回 false → 忽略 modelOverride + content 附提示', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nmodel: claude-nonexistent-99\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
      validateModel: (id) => id === 'claude-opus-4-6',
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.isError).toBeFalsy();
    expect(result.contextModifier?.modelOverride).toBeUndefined();
    // 中文文案
    expect(String(result.content)).toContain('不在当前可用模型列表');
    expect(String(result.content)).toContain('claude-nonexistent-99');
    expect(String(result.content)).toContain('frontmatter');
  });

  it('B-1 Wave 2g: validateModel 返回 true → 透传 modelOverride', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nmodel: claude-opus-4-6\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
      validateModel: () => true,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.isError).toBeFalsy();
    expect(result.contextModifier?.modelOverride).toBe('claude-opus-4-6');
    expect(String(result.content)).not.toContain('不在当前可用模型列表');
  });

  it('B-1 Wave 2g: 未注入 validateModel → 兼容历史行为（透传）', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nmodel: random-name\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.modelOverride).toBe('random-name');
  });

  it('B-2 Wave 2g: allowed-tools 多行 YAML 数组写法可被正确解析', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  - run_terminal_command\n  - read_file\n  - "grep_search"\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['run_terminal_command', 'read_file', 'grep_search']);
  });

  it('B-2 Wave 2g: retired tool names in allowed-tools are dropped', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  - bash\n  - execute_command\n  - read_file\n  - file_read\n  - "web_fetch"\n  - skills.search\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['read_file']);
  });

  it('B-2 Wave 2g: 多行 YAML 跳过 # 注释行', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  # 暂时保守\n  - run_terminal_command\n  # 注释掉的\n  - read_file\n---\nBody.',
    });
    const activate = createSkillActivation({
      getSkill: () => skill,
    });
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['run_terminal_command', 'read_file']);
  });

  it('B-2 Wave 2g: --- 与 -5 不会被误认为列表项', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  - run_terminal_command\n---\nBody after frontmatter.',
    });
    const activate = createSkillActivation({
      getSkill: () => skill,
    });
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['run_terminal_command']);
  });

  it('B-2 Wave 2g: 嵌套对象写法被安全忽略（不崩溃、不丢纯字符串项）', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  - run_terminal_command\n  - name: complex_tool\n  - read_file\n---\nBody.',
    });
    const activate = createSkillActivation({ getSkill: () => skill });
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['run_terminal_command', 'read_file']);
  });

  it('B-2 Wave 2g: allowed-tools 多行与其他字段混合顺序不影响解析', async () => {
    const skill = makeSkill({
      content:
        '---\nslug: x\nname: X\ndescription: X\nallowed-tools:\n  - run_terminal_command\n  - read_file\neffort: medium\nmodel: m1\n---\nBody.',
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.contextModifier?.allowedTools).toEqual(['run_terminal_command', 'read_file']);
    expect(result.contextModifier?.effortOverride).toBe('medium');
    expect(result.contextModifier?.modelOverride).toBe('m1');
  });

  it('I4: content 超 30k → 截断', async () => {
    const longBody = 'x'.repeat(40_000);
    const skill = makeSkill({
      content: `---\nslug: big\nname: Big\ndescription: Big skill\n---\n${longBody}`,
    });
    const deps: SkillInvokeDeps = {
      getSkill: () => skill,
    };
    const activate = createSkillActivation(deps);
    const result = await activate({ skill: 'user:code-review' });

    expect(result.isError).toBeFalsy();
    const text = injectedText(result);
    expect(text.length).toBeLessThanOrEqual(30_000 + 200);
    expect(text).toContain('截断');
  });

  it('PP-1: Personal Plugin local-service skill 注入平台 runtime 启动指令', async () => {
    const skill = makeSkill({
      canonicalKey: 'user:cowart-open-canvas',
      name: 'cowart-open-canvas',
      content:
        '---\nslug: cowart-open-canvas\nname: Cowart Open Canvas\ndescription: Open canvas\n---\n' +
        './scripts/start-canvas.sh /path/to/user/codex-project\nfind ~ -name "start-canvas.sh"',
      personalPluginId: 'cowart',
      personalPluginDisplayName: 'Cowart',
      personalPluginRuntime: {
        serviceId: 'canvas',
        title: 'Cowart',
        requireMcp: true,
      },
    });
    const activate = createSkillActivation({
      getSkill: () => skill,
    });
    const result = await activate({ skill: 'user:cowart-open-canvas' });

    expect(result.isError).toBeFalsy();
    const text = injectedText(result);
    expect(text).toContain('run_terminal_command');
    expect(text).toContain("'tabtin' 'plugin' 'launch' 'cowart'");
    expect(text).toContain("'--service-id' 'canvas'");
    expect(text).toContain("'--require-mcp'");
    expect(text).toContain("'--open-browser'");
    expect(text).toContain('不要搜索文件系统');
    expect(text).not.toContain('find ~');
    expect(text).not.toContain('./scripts/start-canvas.sh');
  });
});

// ─── skill_create ────────────────────────────────────────────────────

describe('skill_create', () => {
  it('schema uses canonical tool names only', () => {
    const tool = createSkillCreateTool({ writeSkill: vi.fn(async () => '') });
    const visibleContract = `${tool.description}\n${JSON.stringify(tool.inputSchema)}`;

    expect(visibleContract).toContain('run_terminal_command');
    expect(visibleContract).toContain('read_file');
    expect(visibleContract).not.toMatch(/["` ](?:bash|web_fetch|file_read|file_write|file_delete|execute_command|skills\.search)["` ]/);
  });

  it('C1: 正常创建 → 调用 writeSkill 回调', async () => {
    const writeSkill = vi.fn(async () =>
      `${resolveSpaceSkillDir('/platform-data', 'organization-1', 'space-1', 'daily-report')}/SKILL.md`,
    );
    //  RB1：业务 id 由 host 装配期烘进 deps，不再从 ToolContext 读。
    const deps: SkillCreateDeps = { writeSkill, spaceId: 'space-1', organizationId: 'organization-1' };
    const tool = createSkillCreateTool(deps);

    const result = await tool.execute(
      {
        slug: 'daily-report',
        name: '日报生成',
        description: 'Generate daily reports.',
        content: '## Steps\n1. Gather data\n2. Format report',
      },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.slug).toBe('daily-report');
    expect(parsed.canonicalKey).toBe('user:daily-report');
    expect(parsed.filePath).toContain('SKILL.md');

    expect(writeSkill).toHaveBeenCalledTimes(1);
    expect(writeSkill).toHaveBeenCalledWith(
      'daily-report',
      expect.stringContaining('slug: daily-report'),
      { spaceId: 'space-1', organizationId: 'organization-1' },
    );
    expect(writeSkill).toHaveBeenCalledWith(
      'daily-report',
      expect.stringContaining('## Steps'),
      { spaceId: 'space-1', organizationId: 'organization-1' },
    );
  });

  it('C2: slug 格式不合法 → isError', async () => {
    const deps: SkillCreateDeps = {
      writeSkill: vi.fn(async () => ''),
    };
    const tool = createSkillCreateTool(deps);

    const cases = ['UPPER', 'has spaces', 'special!chars', '123_under'];
    for (const slug of cases) {
      const result = await tool.execute(
        { slug, name: 'Test', description: 'Test', content: 'body' },
        makeContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('格式不合法');
    }

    expect(deps.writeSkill).not.toHaveBeenCalled();
  });

  it('C3: allowed_tools 拒绝退役工具名', async () => {
    const deps: SkillCreateDeps = {
      writeSkill: vi.fn(async () => ''),
    };
    const tool = createSkillCreateTool(deps);

    const result = await tool.execute(
      {
        slug: 'legacy-tools',
        name: 'Legacy Tools',
        description: 'Should reject retired tool names.',
        content: 'body',
        allowed_tools: ['bash', 'execute_command', 'file_read'],
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('已退役工具名');
    expect(result.content).toContain('execute_command');
    expect(result.content).toContain('file_read');
    expect(deps.writeSkill).not.toHaveBeenCalled();
  });

  // ：注册契约 organization_id + agent_id；失败不得标成 invalid_param_format
  it('C4: 注册成功时传 organizationId/agentId，并写入本地文件', async () => {
    const writeSkill = vi.fn(async () => '/tmp/skills/lark-cli-auto/SKILL.md');
    const registerSkill = vi.fn(async () => ({
      skill_id: 'sk_1',
      slug: 'lark-cli-auto',
    }));
    const deps: SkillCreateDeps = {
      writeSkill,
      registerSkill,
      organizationId: 'org-1',
      agentId: 'agent-1',
      spaceId: 'space-1',
    };
    const tool = createSkillCreateTool(deps);

    const result = await tool.execute(
      {
        slug: 'lark-cli-auto',
        name: '飞书 CLI 自动调用',
        description: 'Use installed lark-cli when Feishu is mentioned.',
        content: 'Run lark-cli whoami first.',
      },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(registerSkill).toHaveBeenCalledWith({
      organizationId: 'org-1',
      agentId: 'agent-1',
      name: '飞书 CLI 自动调用',
      description: 'Use installed lark-cli when Feishu is mentioned.',
      slug: 'lark-cli-auto',
    });
    expect(writeSkill).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.skill_id).toBe('sk_1');
  });

  it('C5: 注册 422 不得映射为 invalid_param_format，且不写本地文件', async () => {
    const writeSkill = vi.fn(async () => '/tmp/skills/x/SKILL.md');
    const registerSkill = vi.fn(async () => ({
      error: 'API 422: organization_id is required',
      status: 422,
      body: { detail: 'organization_id is required' },
    }));
    const deps: SkillCreateDeps = {
      writeSkill,
      registerSkill,
      organizationId: 'org-1',
      agentId: 'agent-1',
    };
    const tool = createSkillCreateTool(deps);

    const result = await tool.execute(
      {
        slug: 'lark-cli-auto',
        name: '飞书 CLI 自动调用',
        description: 'desc',
        content: 'body',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.error_kind).toBe('upstream_error');
    expect(parsed.error_kind).not.toBe('invalid_param_format');
    expect(parsed.upstream_status).toBe(422);
    expect(parsed.hint).toMatch(/Do not retry skill_create by rewriting content/i);
    expect(writeSkill).not.toHaveBeenCalled();
  });

  it('C6: 本地 slug 非法仍为 invalid_param_format，且无 upstream_status', async () => {
    const registerSkill = vi.fn(async () => ({ skill_id: 'sk' }));
    const deps: SkillCreateDeps = {
      writeSkill: vi.fn(async () => ''),
      registerSkill,
      organizationId: 'org-1',
    };
    const tool = createSkillCreateTool(deps);

    const result = await tool.execute(
      { slug: 'Bad_Slug', name: 'x', description: 'y', content: 'z' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.error_kind).toBe('invalid_param_format');
    expect(parsed.upstream_status).toBeUndefined();
    expect(registerSkill).not.toHaveBeenCalled();
  });
});
