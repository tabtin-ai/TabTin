/**
 * `createSkillsTools` 单元测试（Wave B · M3）
 *
 * 覆盖：
 *   S1 正常 read：key 命中，返回 SKILL.md 正文（与 registry 内容字符完全一致）
 *   S2 read key 不存在：返回中文"未找到技能"错误（isError=true，引导改用 search）
 *   S3 read `ext:` / `tin:` 前缀：返回 §5.X / U-1 固定错误文案
 *   S4 read key 格式不合法（空、非 canonical）：input schema 层面拦截
 *   S5 read 回调抛错：工具转成 tool result 错误，不把原始 Error 冒泡炸引擎
 *   S6 search 正常：匹配列表含 key/name/description 精简字段，不含 content
 *   S7 search 空 query：返回 error，不调回调
 *   S8 search limit 生效：用户传 1 时返回 1 条；非法值回退默认
 *   S9 search 回调抛错：同 S5 模式兜底
 *   S10 tool schema 基本结构断言
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createSkillsTools,
  SKILLS_UNSUPPORTED_PREFIX_MESSAGE,
  type SkillRecord,
  type SkillsToolsDeps,
} from '../src/tools/skills-tools.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

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

function makeSkill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    canonicalKey: 'user:code-style-check',
    name: '代码风格检查',
    description: 'Check Python/JS code style via configured linters.',
    whenToUse: 'When the user wants to enforce code style.',
    content:
      '---\nslug: code-style-check\nname: 代码风格检查\ndescription: Check Python/JS code style\n---\n\n## Overview\nLint everything.',
    ...overrides,
  };
}

function findTool(
  tools: ReturnType<typeof createSkillsTools>,
  name: 'skills_read' | 'skills_search',
): ReturnType<typeof createSkillsTools>[number] {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe('createSkillsTools — schema / shape', () => {
  it('S10: 工厂返回 skills_read 和 skills_search 两个工具，均为只读', () => {
    const tools = createSkillsTools({
      getSkill: () => undefined,
      search: () => [],
    });

    expect(tools.map((t) => t.name).sort()).toEqual([
      'skills_read',
      'skills_search',
    ]);
    for (const t of tools) {
      expect(t.isReadOnly).toBe(true);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema).toBeDefined();
    }

    const read = findTool(tools, 'skills_read');
    expect((read.inputSchema as { required?: string[] }).required).toEqual([
      'key',
    ]);
    const readProps = (read.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(readProps).not.toHaveProperty('section');
    expect(readProps).not.toHaveProperty('keys');
    expect(Object.keys(readProps ?? {}).sort()).toEqual(['key', 'path']);

    const search = findTool(tools, 'skills_search');
    expect((search.inputSchema as { required?: string[] }).required).toEqual([
      'query',
    ]);
  });
});
describe('createSkillsTools — skills_read', () => {
  it('S1: key 命中时返回完整 SKILL.md 正文', async () => {
    const skill = makeSkill({});
    const deps: SkillsToolsDeps = {
      getSkill: vi.fn((key: string) =>
        key === skill.canonicalKey ? skill : undefined,
      ),
      search: () => [],
    };
    const read = findTool(createSkillsTools(deps), 'skills_read');

    const result = await read.execute(
      { key: skill.canonicalKey },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(skill.content);
    expect(deps.getSkill).toHaveBeenCalledWith(
      skill.canonicalKey,
      expect.any(Object),
    );
  });

  it('S1-no-section: 即使输入带 section 也返回完整 SKILL.md', async () => {
    const skill = makeSkill({
      content:
        '# Root\n\nIntro.\n\n' +
        '## First Path\n\nA.\n\n' +
        '## Second Path\n\nB.',
    });
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
      }),
      'skills_read',
    );

    const result = await read.execute(
      { key: skill.canonicalKey, section: 'first-path' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(skill.content);
    expect(result.content).toContain('## Second Path');
  });

  it('S1+: key 首尾空格会被 trim 后查询', async () => {
    const skill = makeSkill({});
    const getSkill = vi.fn((key: string) =>
      key === skill.canonicalKey ? skill : undefined,
    );
    const read = findTool(
      createSkillsTools({ getSkill, search: () => [] }),
      'skills_read',
    );

    const result = await read.execute(
      { key: `  ${skill.canonicalKey}  ` },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(getSkill).toHaveBeenCalledWith(
      skill.canonicalKey,
      expect.any(Object),
    );
  });

  it('S11: 注入 listSkillResources 时，无 path 的 read 会在正文末尾附资源清单', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
        listSkillResources: () => [
          { path: 'references/cli-reference.md', summary: 'CLI 全命令参考' },
          { path: 'examples/two-phase.md' },
        ],
      }),
      'skills_read',
    );

    const result = await read.execute({ key: skill.canonicalKey }, makeContext());

    expect(result.isError).toBeFalsy();
    const content = result.content as string;
    expect(content.startsWith(skill.content)).toBe(true);
    expect(content).toContain('附属文档');
    expect(content).toContain('`references/cli-reference.md` — CLI 全命令参考');
    expect(content).toContain('`examples/two-phase.md`');
    expect(content).toContain(
      `skills_read(key="${skill.canonicalKey}", path="references/cli-reference.md")`,
    );
  });

  it('S11-empty: listSkillResources 返回空时不追加清单（正文原样）', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
        listSkillResources: () => [],
      }),
      'skills_read',
    );
    const result = await read.execute({ key: skill.canonicalKey }, makeContext());
    expect(result.content).toBe(skill.content);
  });

  it('S12: 传 path 时走 readSkillResource 返回附属文件全文', async () => {
    const skill = makeSkill({});
    const readSkillResource = vi.fn(async (_key: string, relPath: string) => ({
      ok: true as const,
      path: relPath,
      content: '# CLI Reference\n\nfull body',
    }));
    const read = findTool(
      createSkillsTools({ getSkill: () => skill, search: () => [], readSkillResource }),
      'skills_read',
    );

    const result = await read.execute(
      { key: skill.canonicalKey, path: 'references/cli-reference.md' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('# CLI Reference\n\nfull body');
    expect(readSkillResource).toHaveBeenCalledWith(
      skill.canonicalKey,
      'references/cli-reference.md',
      expect.any(Object),
    );
  });

  it('S12-fail: readSkillResource 返回 ok=false 时转成 tool error', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
        readSkillResource: () => ({ ok: false as const, error: '路径越界：../x 不在该 skill 目录内。' }),
      }),
      'skills_read',
    );
    const result = await read.execute(
      { key: skill.canonicalKey, path: '../x' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.error).toContain('路径越界');
  });

  it('S12-guess-none: 读不存在的 path 且该 skill 无 references → 错误提示「没有附属文件、别猜」', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
        listSkillResources: () => [], // 该 skill 没有任何附属文件
        readSkillResource: () => ({
          ok: false as const,
          error: '附属文件不存在或无法读取：references/cli-reference.md',
        }),
      }),
      'skills_read',
    );
    const result = await read.execute(
      { key: skill.canonicalKey, path: 'references/cli-reference.md' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.hint).toContain('没有附属文档');
    expect(parsed.available_paths).toEqual([]);
  });

  it('S12-guess-wrong: 读错 path 但该 skill 有别的 references → 错误里列出真实可用清单供自纠', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({
        getSkill: () => skill,
        search: () => [],
        listSkillResources: () => [
          { path: 'references/operations.md', summary: '操作序列' },
        ],
        readSkillResource: () => ({
          ok: false as const,
          error: '附属文件不存在或无法读取：references/cli-reference.md',
        }),
      }),
      'skills_read',
    );
    const result = await read.execute(
      { key: skill.canonicalKey, path: 'references/cli-reference.md' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.hint).toContain('references/operations.md');
    expect(parsed.available_paths).toEqual(['references/operations.md']);
  });

  it('S12-unsupported: 传 path 但宿主未注入 readSkillResource → 明确错误', async () => {
    const skill = makeSkill({});
    const read = findTool(
      createSkillsTools({ getSkill: () => skill, search: () => [] }),
      'skills_read',
    );
    const result = await read.execute(
      { key: skill.canonicalKey, path: 'references/cli-reference.md' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('不支持按 path 读取');
  });

  it('S2: key 不存在时返回中文未找到错误，isError=true', async () => {
    const read = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_read',
    );
    const result = await read.execute(
      { key: 'user:not-exists' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('未找到技能');
    expect(result.content).toContain('`user:not-exists`');
    expect(result.content).toContain('skills_search');
  });

  it.each([
    ['disabled', false, '未启用'],
    ['not_ready', true, '尚未就绪'],
    ['not_installed', false, '尚未安装'],
    ['not_found', false, '未找到技能'],
  ] as const)(
    'S2.1: 结构化解析状态 %s 不再折叠成模糊的未找到',
    async (reason, retryable, expectedMessage) => {
      const read = findTool(
        createSkillsTools({
          getSkill: () => ({ status: reason }),
          search: () => [],
        }),
        'skills_read',
      );

      const result = await read.execute({ key: 'user:known-skill' }, makeContext());
      const parsed = JSON.parse(result.content as string);

      expect(result.isError).toBe(true);
      expect(parsed.reason).toBe(reason);
      expect(parsed.retryable).toBe(retryable);
      expect(parsed.error).toContain(expectedMessage);
      expect(parsed.error_kind).toBe(
        reason === 'disabled'
          ? 'skill_disabled'
          : reason === 'not_ready'
            ? 'skill_not_ready'
            : reason === 'not_installed'
              ? 'skill_not_installed'
              : 'skill_not_found',
      );
    },
  );

  it('S2.2: available 结构化结果与旧 SkillRecord 返回值行为一致', async () => {
    const skill = makeSkill({ content: 'STRUCTURED-BODY' });
    const read = findTool(
      createSkillsTools({
        getSkill: () => ({ status: 'available', skill }),
        search: () => [],
      }),
      'skills_read',
    );

    const result = await read.execute({ key: skill.canonicalKey }, makeContext());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('STRUCTURED-BODY');
  });

  it('S3: `ext:` 前缀返回固定中文错误文案（jsonError envelope 中 error 字段）', async () => {
    const read = findTool(
      createSkillsTools({
        // 这个回调**不应被调用**——前缀检查在先
        getSkill: vi.fn(() => {
          throw new Error('should not be called');
        }),
        search: () => [],
      }),
      'skills_read',
    );
    const result = await read.execute({ key: 'ext:something' }, makeContext());

    expect(result.isError).toBe(true);
    // W13 后走 jsonError envelope：原 message 在顶层 `error` 字段
    const parsed = JSON.parse(result.content as string);
    expect(parsed.error).toBe(SKILLS_UNSUPPORTED_PREFIX_MESSAGE);
    expect(parsed.error).toContain('仅在在线模式下可用');
    expect(parsed.error_kind).toBe('skill_unsupported_prefix');
  });

  it('S3: `tin:` 前缀同样返回固定中文错误文案（忽略大小写）', async () => {
    const read = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_read',
    );
    const r1 = await read.execute({ key: 'tin:weather' }, makeContext());
    const r2 = await read.execute({ key: 'TIN:WEATHER' }, makeContext());
    const r3 = await read.execute({ key: 'Ext:Foo' }, makeContext());

    for (const r of [r1, r2, r3]) {
      expect(r.isError).toBe(true);
      const parsed = JSON.parse(r.content as string);
      expect(parsed.error).toBe(SKILLS_UNSUPPORTED_PREFIX_MESSAGE);
      expect(parsed.error_kind).toBe('skill_unsupported_prefix');
    }
  });

  it('S4: 空 key 返回 error', async () => {
    const read = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_read',
    );
    const result = await read.execute({ key: '   ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe('string');
    expect((result.content as string).toLowerCase()).toContain('key');
  });

  it('S4: 非 canonical 格式（没有冒号）返回格式错误', async () => {
    const read = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_read',
    );
    const result = await read.execute(
      { key: 'not-a-valid-key' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('格式不合法');
  });

  it('S4: 缺省 input / key 非字符串 → 返回 error', async () => {
    const read = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_read',
    );

    const r1 = await read.execute({}, makeContext());
    const r2 = await read.execute({ key: 123 }, makeContext());
    const r3 = await read.execute(null, makeContext());

    for (const r of [r1, r2, r3]) {
      expect(r.isError).toBe(true);
    }
  });

  it('S5: getSkill 回调抛错 → 转成 tool result error，不冒泡', async () => {
    const read = findTool(
      createSkillsTools({
        getSkill: () => {
          throw new Error('registry down');
        },
        search: () => [],
      }),
      'skills_read',
    );
    const result = await read.execute(
      { key: 'user:code-style-check' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('内部错误');
    expect(result.content).not.toContain('registry down');
    expect(JSON.parse(result.content as string).hint).toContain('skill registry');
  });
});

describe('createSkillsTools — skills_search', () => {
  it('S6: 正常 query 返回匹配列表（精简字段，不含 content）', async () => {
    const hit = makeSkill({});
    const deps: SkillsToolsDeps = {
      getSkill: () => undefined,
      search: vi.fn((q: string, opts?: { limit?: number }) => {
        expect(q).toBe('python style');
        expect(opts?.limit).toBe(10);
        return [hit];
      }),
    };
    const search = findTool(createSkillsTools(deps), 'skills_search');

    const result = await search.execute(
      { query: 'python style' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.query).toBe('python style');
    expect(parsed.count).toBe(1);
    expect(parsed.results[0]).toMatchObject({
      key: hit.canonicalKey,
      name: hit.name,
      description: hit.description,
      when_to_use: hit.whenToUse,
    });
    // 不应泄漏 SKILL.md 正文——LLM 要拿正文必须另调 skills_read
    expect(parsed.results[0].content).toBeUndefined();
    expect(typeof parsed.hints).toBe('string');
  });

  it('S6+: 匹配为空时 hints 引导查看 <skills> 段', async () => {
    const search = findTool(
      createSkillsTools({ getSkill: () => undefined, search: () => [] }),
      'skills_search',
    );
    const result = await search.execute({ query: 'nothing' }, makeContext());

    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(parsed.hints).toContain('未匹配到技能');
  });

  it('S6++: 注册表未就绪时返回 skill_not_ready，而不是空成功列表', async () => {
    const search = findTool(
      createSkillsTools({
        getSkill: () => undefined,
        search: () => ({ status: 'not_ready', retryable: true }),
      }),
      'skills_search',
    );
    const result = await search.execute({ query: 'python' }, makeContext());
    const parsed = JSON.parse(result.content as string);

    expect(result.isError).toBe(true);
    expect(parsed.error_kind).toBe('skill_not_ready');
    expect(parsed.reason).toBe('not_ready');
    expect(parsed.retryable).toBe(true);
  });

  it('S7: 空 query 返回 error，不调回调', async () => {
    const searchFn = vi.fn(() => [] as SkillRecord[]);
    const search = findTool(
      createSkillsTools({ getSkill: () => undefined, search: searchFn }),
      'skills_search',
    );
    const r1 = await search.execute({ query: '' }, makeContext());
    const r2 = await search.execute({ query: '   ' }, makeContext());

    for (const r of [r1, r2]) {
      expect(r.isError).toBe(true);
    }
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('S8: limit=1 时 registry 收到 limit=1；超过最大值 50 被 clamp', async () => {
    const searchFn = vi.fn((_q: string, opts?: { limit?: number }) => {
      const arr: SkillRecord[] = Array.from({ length: 100 }, (_, i) =>
        makeSkill({
          canonicalKey: `user:skill-${i}`,
          name: `skill-${i}`,
          description: `desc-${i}`,
        }),
      );
      const limit = opts?.limit ?? 10;
      return arr.slice(0, limit);
    });
    const search = findTool(
      createSkillsTools({ getSkill: () => undefined, search: searchFn }),
      'skills_search',
    );

    const r1 = await search.execute(
      { query: 'skill', limit: 1 },
      makeContext(),
    );
    expect(searchFn).toHaveBeenLastCalledWith(
      'skill',
      { limit: 1 },
      expect.any(Object),
    );
    const p1 = JSON.parse(r1.content as string);
    expect(p1.count).toBe(1);

    // 超过 50 → clamp 到 50
    await search.execute({ query: 'skill', limit: 9999 }, makeContext());
    expect(searchFn).toHaveBeenLastCalledWith(
      'skill',
      { limit: 50 },
      expect.any(Object),
    );

    // limit 非法（字符串）→ 回退默认
    await search.execute(
      { query: 'skill', limit: 'abc' as unknown as number },
      makeContext(),
    );
    expect(searchFn).toHaveBeenLastCalledWith(
      'skill',
      { limit: 10 },
      expect.any(Object),
    );
  });

  it('S9: search 回调抛错 → 返回 error tool result', async () => {
    const search = findTool(
      createSkillsTools({
        getSkill: () => undefined,
        search: () => {
          throw new Error('search backend gone');
        },
      }),
      'skills_search',
    );
    const result = await search.execute({ query: 'anything' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('内部错误');
    expect(result.content).not.toContain('search backend gone');
    expect(JSON.parse(result.content as string).hint).toContain('skill registry');
  });
});

// ───  RB1：工具透传 host 装配期烘进 deps 的 spaceId / organizationId ──────
//
// 问题背景：业务工具是业务耦合的，其 spaceId/organizationId 由 host 在装配
// ToolProvider 时烘进 `deps`（host 装配期已手握这两个 id；切 Space 会重建 runtime，
// 故是 per-runtime 常量，可安全烘焙）。#6009 前工具从运行时 `ToolContext` 读业务
// id， 起改用 `deps.spaceId` / `deps.organizationId` 的烘焙值构造回调上下文
// （L18 Space 级过滤 hook）。故本组测试把业务 id 烘进 deps，而非放进 ToolContext。

describe('createSkillsTools — 透传烘进 deps 的 spaceId / organizationId 给宿主回调（ RB1）', () => {
  it('P0-2/read: deps 烘进的 spaceId / organizationId 透传给 deps.getSkill', async () => {
    const skill = makeSkill({});
    const getSkill = vi.fn((
      _key: string,
      _ctx?: Parameters<NonNullable<SkillsToolsDeps['getSkill']>>[1],
    ) => skill);
    const read = findTool(
      //  RB1：业务 id 在 host 装配期烘进 deps，不再从 ToolContext 读。
      createSkillsTools({ getSkill, search: () => [], spaceId: 'sp-42', organizationId: 'wt-99' }),
      'skills_read',
    );

    await read.execute({ key: skill.canonicalKey }, makeContext());

    expect(getSkill).toHaveBeenCalledTimes(1);
    const [callKey, callCtx] = getSkill.mock.calls[0];
    expect(callKey).toBe(skill.canonicalKey);
    expect(callCtx).toEqual({ spaceId: 'sp-42', organizationId: 'wt-99' });
  });

  it('P0-2/read: deps 未烘 spaceId 时透传 { spaceId: undefined, organizationId: undefined }', async () => {
    const getSkill = vi.fn((
      _key: string,
      _ctx?: Parameters<NonNullable<SkillsToolsDeps['getSkill']>>[1],
    ) => undefined);
    const read = findTool(
      createSkillsTools({ getSkill, search: () => [] }),
      'skills_read',
    );

    await read.execute({ key: 'user:whatever' }, makeContext());

    expect(getSkill).toHaveBeenCalledTimes(1);
    const callCtx = getSkill.mock.calls[0][1];
    expect(callCtx).toEqual({ spaceId: undefined, organizationId: undefined });
  });

  it('P0-2/search: deps 烘进的 ctx 透传给 deps.search（含 options）', async () => {
    const searchFn = vi.fn((
      _query: string,
      _options?: Parameters<NonNullable<SkillsToolsDeps['search']>>[1],
      _ctx?: Parameters<NonNullable<SkillsToolsDeps['search']>>[2],
    ) => [] as SkillRecord[]);
    const search = findTool(
      //  RB1：业务 id 烘进 deps。
      createSkillsTools({ getSkill: () => undefined, search: searchFn, spaceId: 'sp-A', organizationId: 'wt-B' }),
      'skills_search',
    );

    await search.execute({ query: 'python', limit: 5 }, makeContext());

    expect(searchFn).toHaveBeenCalledTimes(1);
    const [callQ, callOpts, callCtx] = searchFn.mock.calls[0];
    expect(callQ).toBe('python');
    expect(callOpts).toEqual({ limit: 5 });
    expect(callCtx).toEqual({ spaceId: 'sp-A', organizationId: 'wt-B' });
  });

  it('P0-2/兼容性: 老 arity-1/arity-2 deps（不接 ctx）仍可注入，TS 逆变 + 运行时忽略 ctx', async () => {
    // 这条测试不只是运行时 ok，还是"TS 签名兼容性"的契约——
    // ElectronAgentHost 里现有的 `(key) => registry.getByKey(key)` 必须继续可用。
    const skill = makeSkill({});
    const legacyDeps: SkillsToolsDeps = {
      getSkill: (key) => (key === skill.canonicalKey ? skill : undefined),
      search: (q) => (q.includes('code') ? [skill] : []),
    };
    const tools = createSkillsTools(legacyDeps);
    const read = findTool(tools, 'skills_read');
    const search = findTool(tools, 'skills_search');

    const r1 = await read.execute(
      { key: skill.canonicalKey },
      makeContext(),
    );
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toBe(skill.content);

    const r2 = await search.execute(
      { query: 'code' },
      makeContext(),
    );
    const parsed = JSON.parse(r2.content as string);
    expect(parsed.count).toBe(1);
  });
});
