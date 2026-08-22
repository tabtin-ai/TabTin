/**
 * SkillsCap 单测 —— W2.2.1。
 *
 * 覆盖：
 *   1. type / category 静态契约
 *   2. tools() 复用 createSkillsTools 的 skills_search / skills_read
 *      （同名 + 同 schema + 同行为）
 *   3. handler 调外部注入的 getSkill / search 回调
 *   4. instructions() 已下线（阶段 2.3，Capability.instructions?() 整接口删除）
 *   5. hooks().beforeIteration 调 fetchSkills + 写 state.__skillsHint
 *   6. 指纹缓存生效：同样的 skills 列表第二轮跳过 truncateSkillsWithinBudget
 *   7. fetchSkills 抛错 → 保留当前 Run 的 skills listing（D1 抗闪烁）
 *   8. fetchSkills 返回 null → 首次清空 __skillsHint，已有结果时保留
 *   9. clone() 后指纹缓存清零（避免 cross-session 污染）
 *  10. 构造时缺 getSkill / search 抛错（fail-fast）
 *  11. 构造时缺 fetchSkills → hooks() 返回 null（不注入 __skillsHint）
 *  12. 配置 contextWindowTokens 透传到 truncateSkillsWithinBudget
 *
 * ：SkillsCap 已从 agent-runtime 迁到 @tabtin/agent-host，本单测随源迁来；
 * 对源的 import 指向 host 的 `src/capabilities/skills.js`，契约类型走 @tabtin/agent-runtime 公共面。
 *  起 fetchSkills context 只含 `query`（spaceId/organizationId 已烘进 host 闭包）。
 */

import { describe, expect, it, vi } from 'vitest';
import { SkillsCap } from '../src/capabilities/skills.js';
import {
  makeFakeSession,
  makeBeforeModelCtx,
  makeIterationCtx,
  makeRunCtx,
  sectionContent,
} from './fixtures/fake-capabilities.js';
import type {
  SkillRecord,
  SkillsToolsCallbackContext,
} from '@tabtin/agent-runtime/tools';
// W2.2.3 解耦：协议类型 SSoT 在 skills/skill-listing-types.ts（经 /skills barrel 导出）。
import type {
  SkillsFetchContext,
  SkillListingResult,
  SkillMeta,
} from '@tabtin/agent-runtime/skills';
import type {
  Message,
  EngineState,
  ToolContext,
} from '@tabtin/agent-runtime/engine';
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine';

async function skillsListingAfterBeforeRun(
  cap: SkillsCap,
  state: EngineState,
): Promise<string | undefined> {
  const hooks = cap.hooks!();
  await hooks.beforeRun!(makeRunCtx(state));
  const ctx = makeBeforeModelCtx(state);
  await hooks.beforeModel!(ctx);
  return sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.skills_listing);
}

async function skillsStaticIndexAfterBeforeRun(
  cap: SkillsCap,
  state: EngineState,
): Promise<string | undefined> {
  const hooks = cap.hooks!();
  await hooks.beforeRun!(makeRunCtx(state));
  const ctx = makeBeforeModelCtx(state);
  await hooks.beforeModel!(ctx);
  return sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.skills_index);
}

// ─── Fixture：3 个 skill ─────────────────────────────────────────────

const SKILL_A: SkillRecord = {
  canonicalKey: 'user:code-style',
  name: 'Code Style Check',
  description: '检查代码风格',
  whenToUse: '提交前',
  content: '# code-style\n\n...',
};
const SKILL_B: SkillRecord = {
  canonicalKey: 'platform:demo-table',
  name: 'Demo Table CLI',
  description: '操作示例多维表',
  whenToUse: '需要操作示例表格',
  content: '# demo-table\n\n...',
};
const SKILL_C: SkillRecord = {
  canonicalKey: 'user:db-schema',
  name: 'DB Schema Helper',
  description: '解析数据库 schema',
  content: '# db-schema\n\n...',
};

const ALL_SKILLS: SkillRecord[] = [SKILL_A, SKILL_B, SKILL_C];

function makeMetaFromRecord(r: SkillRecord): SkillMeta {
  return {
    canonicalKey: r.canonicalKey,
    name: r.name,
    description: r.description,
    whenToUse: r.whenToUse,
  };
}

function makeListing(skills: SkillRecord[]): SkillListingResult {
  return {
    skills: skills.map(makeMetaFromRecord),
    formattedContent: skills.map((s) => `- ${s.canonicalKey}: ${s.description}`).join('\n'),
  };
}

function makeFakeContext(): ToolContext {
  return {
    threadId: 'test-thread',
    // §17.6 D4：ToolContext.sessionId → runtimeId（runtime UUID）。
    runtimeId: 'test-runtime',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
  };
}

// ─── 1. 静态契约 ──────────────────────────────────────────────────────

describe('SkillsCap 静态契约', () => {
  it('type === "skills" / category === "core"（v2 形状决议命名）', () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
    });
    expect(cap.type).toBe('skills');
    expect(cap.category).toBe('core');
  });

  it('required_capability_types 返回空 Set（不依赖 filesystem）', () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
    });
    expect(cap.required_capability_types?.()?.size).toBe(0);
  });
});

// ─── 2. 构造时校验 ────────────────────────────────────────────────────

describe('SkillsCap 构造校验', () => {
  it('缺 getSkill 抛错', () => {
    expect(
      () =>
        new SkillsCap({
          search: () => [],
          // @ts-expect-error 故意缺 getSkill
          getSkill: undefined,
        }),
    ).toThrow(/getSkill is required/);
  });

  it('缺 search 抛错', () => {
    expect(
      () =>
        new SkillsCap({
          getSkill: () => undefined,
          // @ts-expect-error 故意缺 search
          search: undefined,
        }),
    ).toThrow(/search is required/);
  });
});

// ─── 3. tools() 复用 createSkillsTools ──────────────────────────────

describe('SkillsCap tools()', () => {
  it('返回 skills_search / skills_read 两件套', () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
    });
    const names = cap.tools().map((t) => t.name);
    expect(names.sort()).toEqual(['skills_read', 'skills_search']);
  });

  it('skills_read handler 调注入的 getSkill 回调', async () => {
    const getSkillCalls: Array<{
      key: string;
      ctx?: SkillsToolsCallbackContext;
    }> = [];
    const cap = new SkillsCap({
      getSkill: (key, ctx) => {
        getSkillCalls.push({ key, ctx });
        return ALL_SKILLS.find((s) => s.canonicalKey === key);
      },
      search: () => [],
    });
    await cap.bind(makeFakeSession('s1'));

    const tool = cap.tools().find((t) => t.name === 'skills_read')!;
    const result = await tool.execute(
      { key: 'user:code-style' },
      makeFakeContext(),
    );

    expect(getSkillCalls).toHaveLength(1);
    expect(getSkillCalls[0].key).toBe('user:code-style');
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('# code-style');
  });

  it('skills_search handler 调注入的 search 回调 + 透传 limit', async () => {
    const searchCalls: Array<{
      query: string;
      options?: { limit?: number };
    }> = [];
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: (query, options) => {
        searchCalls.push({ query, options });
        return ALL_SKILLS.filter((s) =>
          s.description.toLowerCase().includes(query.toLowerCase()),
        );
      },
    });
    await cap.bind(makeFakeSession('s1'));

    const tool = cap.tools().find((t) => t.name === 'skills_search')!;
    const result = await tool.execute(
      { query: 'schema', limit: 5 },
      makeFakeContext(),
    );

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe('schema');
    expect(searchCalls[0].options?.limit).toBe(5);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].key).toBe('user:db-schema');
  });
});

// ─── 4. instructions ─────────────────────────────────────────────────
// 阶段 2.3（2026-05-20）：`Capability.instructions?()` 接口下线，
// SkillsCap.instructions() + 配套测试整体删除。Skill 列表依然由
// hooks().beforeIteration 写入 state.__skillsHint，由 query.ts 的合并段
// （appendSection 'skills'）注入 effectiveSystemPrompt，行为完全等价。

// ─── 5. hooks().beforeRun + beforeModel ───────────────────────────

describe('SkillsCap hooks().beforeRun + beforeModel', () => {
  it('tools-only 模式仍执行 Run 快照生命周期', async () => {
    const events: string[] = [];
    const cap = new SkillsCap({
      beginRun: () => { events.push('begin'); },
      endRun: () => { events.push('end'); },
      getSkill: () => undefined,
      search: () => [],
    });
    const hooks = cap.hooks()!;

    await hooks.beforeRun!(makeRunCtx(makeStateLike()));
    await hooks.afterRun!(makeRunCtx(makeStateLike()));

    expect(events).toEqual(['begin', 'end']);
  });

  it('beforeRun/afterRun 包住同一 Run 的 Skill 快照生命周期', async () => {
    const events: string[] = [];
    const cap = new SkillsCap({
      beginRun: () => { events.push('begin'); },
      endRun: () => { events.push('end'); },
      fetchSkills: async () => {
        events.push('fetch');
        return makeListing(ALL_SKILLS);
      },
      getSkill: () => undefined,
      search: () => [],
    });
    const hooks = cap.hooks()!;

    await hooks.beforeRun!(makeRunCtx(makeStateLike()));
    await hooks.afterRun!(makeRunCtx(makeStateLike()));

    expect(events).toEqual(['begin', 'fetch', 'end']);
  });

  function makeStateLike(spaceId?: string, organizationId?: string): EngineState {
    return {
      __spaceId: spaceId,
      __organizationId: organizationId,
    } as EngineState;
  }

  it('fetchSkills 缺省时 hooks() 返回 null', () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
    });
    expect(cap.hooks?.()).toBeNull();
  });

  it('fetchSkills 提供时 beforeRun 拉取、beforeModel 注入 skills_listing', async () => {
    const fetchCalls: SkillsFetchContext[] = [];
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async (ctx) => {
        fetchCalls.push(ctx);
        return makeListing(ALL_SKILLS);
      },
    });

    const hooks = cap.hooks?.();
    expect(hooks).not.toBeNull();
    const state = makeStateLike('space-1', 'wt-1');
    const hint = await skillsListingAfterBeforeRun(cap, state);

    expect(fetchCalls).toHaveLength(1);
    // ：ctx 只带相关性排序 query（无 user 消息时为空串）；spaceId/organizationId
    // 已由 host 烘进闭包，不再经 Cap 透传。
    expect(fetchCalls[0]).toEqual({ query: '', runId: 'test-run' });
    expect(hint).toBeTruthy();
    expect(hint!.startsWith('<skills>')).toBe(true);
    expect(hint!.endsWith('</skills>')).toBe(true);
    expect(hint!).toContain('user:code-style');
    expect(hint!).toContain('platform:demo-table');
  });

  it('fetchSkills 透传最近 user 消息作 query 给宿主 fetcher', async () => {
    const fetchCalls: SkillsFetchContext[] = [];
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async (ctx) => {
        fetchCalls.push(ctx);
        return {
          staticIndex: '## app\n- app:tabdoc/tabdoc-operator',
          dynamicTopK: '- app:tabdoc/tabdoc-operator — 文档操作',
        };
      },
    });

    const hooks = cap.hooks!();
    const state = {
      ...makeStateLike('space-1', 'wt-1'),
      messages: [{ role: 'user', content: '继续整理一下' }],
    } as EngineState;
    await hooks.beforeRun!(makeRunCtx(state));

    // ：ctx 只透传 query，不含 spaceId/organizationId。
    expect(fetchCalls[0]).toEqual({ query: '继续整理一下', runId: 'test-run' });
    expect(cap.getRelevantBlock()).toContain('app:tabdoc/tabdoc-operator');
  });

  it('指纹缓存：相同 listing 第二轮不重新截断', async () => {
    // 包装 fetchSkills 让我们能数 listing 调用次数（截断逻辑内部不暴露
    // 调用计数，但由于 truncateSkillsWithinBudget 是纯函数我们改成数
    // fetchSkills 的次数来间接验证缓存）
    const fetchSkills = vi.fn(async () => makeListing(ALL_SKILLS));
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills,
    });

    const hooks = cap.hooks!();
    const state = makeStateLike('s', 'w');

    const firstHint = await skillsListingAfterBeforeRun(cap, state);
    const secondHint = await skillsListingAfterBeforeRun(cap, state);

    // 同一份列表两轮都应得到相同结果（指纹命中复用 lastBudgetedContent）
    expect(firstHint).toBe(secondHint);
    expect(fetchSkills).toHaveBeenCalledTimes(2);
    void hooks;
  });

  it('listing 变化时重新渲染（指纹失效）', async () => {
    let listingVersion = 1;
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => {
        if (listingVersion === 1) return makeListing([SKILL_A]);
        return makeListing([SKILL_A, SKILL_B]);
      },
    });

    const state = makeStateLike('s', 'w');

    const firstHint = (await skillsListingAfterBeforeRun(cap, state))!;
    expect(firstHint).toContain('user:code-style');
    expect(firstHint).not.toContain('platform:demo-table');

    listingVersion = 2;
    const secondHint = (await skillsListingAfterBeforeRun(cap, state))!;
    expect(secondHint).toContain('user:code-style');
    expect(secondHint).toContain('platform:demo-table');
  });

  it('同一 Run 的后续召回抛错时保留 skills_listing（D1 抗闪烁）', async () => {
    let throwNext = false;
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => {
        if (throwNext) throw new Error('HTTP 500');
        return makeListing(ALL_SKILLS);
      },
    });

    const hooks = cap.hooks!();
    const state = {
      ...makeStateLike('s', 'w'),
      messages: [{ role: 'user', content: 'first query' }],
    } as EngineState;
    await hooks.beforeRun!(makeRunCtx(state));
    const ctx1 = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx1);
    const firstHint = sectionContent(ctx1.sections, SYSTEM_SECTION_NAMES.skills_listing);
    expect(firstHint).toBeTruthy();

    throwNext = true;
    state.messages.push({ role: 'user', content: 'second query' });
    await hooks.beforeIteration!(makeIterationCtx(state));
    const ctx2 = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx2);
    expect(sectionContent(ctx2.sections, SYSTEM_SECTION_NAMES.skills_listing)).toBe(firstHint);
  });

  it('fetchSkills 返回 null 且无历史 → 清空 skills_listing', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => null,
    });

    const hint = await skillsListingAfterBeforeRun(cap, makeStateLike('s', 'w'));
    expect(hint).toBeUndefined();
  });

  it('同一 Run 的后续召回返回 null 时保留当前结果', async () => {
    let phase = 'first';
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => {
        if (phase === 'first') return makeListing(ALL_SKILLS);
        return null;
      },
    });

    const hooks = cap.hooks()!;
    const state = {
      ...makeStateLike('s', 'w'),
      messages: [{ role: 'user', content: 'first query' }],
    } as EngineState;
    await hooks.beforeRun!(makeRunCtx(state));
    const firstCtx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(firstCtx);
    const firstHint = sectionContent(firstCtx.sections, SYSTEM_SECTION_NAMES.skills_listing);

    phase = 'second';
    state.messages.push({ role: 'user', content: 'second query' });
    await hooks.beforeIteration!(makeIterationCtx(state));
    const secondCtx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(secondCtx);
    const secondHint = sectionContent(secondCtx.sections, SYSTEM_SECTION_NAMES.skills_listing);
    expect(secondHint).toBe(firstHint);
  });

  it('旧式 string fetcher（formattedContent + 空 skills）直接渲染', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => 'legacy formatted skills text',
    });

    const hint = await skillsListingAfterBeforeRun(cap, makeStateLike('s', 'w'));
    expect(hint).toContain('legacy formatted skills text');
    expect(hint!.startsWith('<skills>')).toBe(true);
  });

  it('contextWindowTokens 影响截断预算（小预算 → 缩短）', async () => {
    const skillsTooMany: SkillMeta[] = Array.from({ length: 20 }, (_, i) => ({
      canonicalKey: `user:skill-${i}`,
      name: `Skill ${i}`,
      description: 'A'.repeat(500), // 每个 500 字符触发截断
    }));

    const capSmall = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => ({
        skills: skillsTooMany,
        formattedContent: '',
      }),
      contextWindowTokens: 8000, // 1% = 320 字符
    });
    const capLarge = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => ({
        skills: skillsTooMany,
        formattedContent: '',
      }),
      contextWindowTokens: 200_000, // 1% = 8000 字符
    });

    const stateSmall = makeStateLike('s', 'w');
    const stateLarge = makeStateLike('s', 'w');
    const hintSmall = await skillsListingAfterBeforeRun(capSmall, stateSmall);
    const hintLarge = await skillsListingAfterBeforeRun(capLarge, stateLarge);

    // small 预算的渲染长度应明显短于 large 预算
    expect(hintSmall!.length).toBeLessThan(hintLarge!.length);
  });
});

// ─── 6. clone ────────────────────────────────────────────────────────

describe('SkillsCap clone()', () => {
  it('clone 后 _session 重置为 null', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
    });
    await cap.bind(makeFakeSession('s1'));
    const cloned = cap.clone();
    // bind 新 session 不抛错（因为 _session 重置）
    await cloned.bind(makeFakeSession('s2'));
  });

  it('clone 后指纹缓存清零（避免 cross-session 复用旧指纹）', async () => {
    // 用 spy 数 fetchSkills 调用次数 + 通过返回不同 listing 但相同指纹验证：
    // 父实例第二次 beforeIteration 应命中指纹缓存（fetchSkills 调用了但
    // truncate 没重跑）；clone 实例第一次 beforeIteration 必须重跑
    // truncate（因为指纹缓存被 clone() 清零）—— 通过观察 clone 实例的
    // __skillsHint 是按"新 listing"渲染、不是"父实例的旧 listing 缓存"。
    let listingVersion: 'first' | 'second' = 'first';
    const fetchSkills = vi.fn(async () => {
      if (listingVersion === 'first') return makeListing([SKILL_A]);
      // 第二阶段：相同指纹但不同 formattedContent —— 关键测试点
      // 如果 clone 没清零指纹，会复用 first 阶段缓存的渲染结果（含 SKILL_A）；
      // 真清零了 → 重跑 truncate → 渲染结果按当前 listing 重算（含 SKILL_B）。
      return makeListing([SKILL_B]); // 不同 SKILL，必产生不同指纹
    });

    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills,
    });

    const hooks1 = cap.hooks!();
    const stateParent = { __spaceId: 's1', __organizationId: 'w' } as EngineState;
    const parentHint = await skillsListingAfterBeforeRun(cap, stateParent);
    expect(parentHint).toContain('user:code-style'); // SKILL_A

    // clone（模拟 W2.3 给新 Run 派生 cap 实例）
    const cloned = cap.clone();
    listingVersion = 'second';

    const stateChild = { __spaceId: 's2', __organizationId: 'w' } as EngineState;
    const childHint = await skillsListingAfterBeforeRun(cloned as SkillsCap, stateChild);

    // 关键断言：clone 后第一次渲染必须用 fetchSkills 当下的返回 (SKILL_B)，
    // 不复用父实例缓存的 SKILL_A 渲染结果。
    expect(childHint).toContain('platform:demo-table'); // SKILL_B
    expect(childHint).not.toContain('user:code-style'); // 不应保留父
    void hooks1;
  });

  it('clone 后 tools 仍然正常（回调仍可调）', () => {
    const cap = new SkillsCap({
      getSkill: (k) => ALL_SKILLS.find((s) => s.canonicalKey === k),
      search: () => ALL_SKILLS,
      fetchSkills: async () => makeListing(ALL_SKILLS),
    });
    const cloned = cap.clone() as SkillsCap;
    const tools = cloned.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(['skills_read', 'skills_search']);
  });
});

// ─── 两区结果：静态名称索引进 system + 动态相关块经 getRelevantBlock ──
describe('SkillsCap 两区（静态索引 system + 动态相关块经 getRelevantBlock，由 context-injector 复用 context_injection 注入）', () => {
  function stateWithUser(): EngineState {
    const messages: Message[] = [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
      { role: 'user', content: '当前问题：导出表格' },
    ];
    return { __spaceId: 's', __organizationId: 'w', messages } as EngineState;
  }

  it('staticIndex → beforeModel skills_index（<skills>），dynamicTopK → getRelevantBlock（<relevant_skills>），不进 system 动态段、不注入消息', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => ({
        staticIndex: '## platform\n- platform:files/generation',
        dynamicTopK: '- user:sheets — 导出表格',
      }),
    });
    const state = stateWithUser();
    const before = state.messages.length;
    const hooks = cap.hooks!()!;
    await hooks.beforeRun!(makeRunCtx(state));
    const ctx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx);

    const staticIdx = sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.skills_index);
    expect(staticIdx).toContain('<skills>');
    expect(staticIdx).toContain('platform:files/generation');
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.skills_listing)).toBeUndefined();
    expect(cap.getRelevantBlock()).toContain('<relevant_skills>');
    expect(cap.getRelevantBlock()).toContain('user:sheets');
    // SkillsCap 不再直接注入消息（交给 context-injector 拼进 <context>）
    expect(state.messages.length).toBe(before);
  });

  it('无信号（dynamicTopK=null）→ getRelevantBlock 为 undefined', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async () => ({
        staticIndex: '## user\n- user:foo',
        dynamicTopK: null,
      }),
    });
    const state = stateWithUser();
    const staticIdx = await skillsStaticIndexAfterBeforeRun(cap, state);
    expect(cap.getRelevantBlock()).toBeUndefined();
    expect(staticIdx).toContain('user:foo');
  });

  it('新 Run 拉取不可用时不沿用上一 Run 的 Prompt Skill 块', async () => {
    const fetchSkills = vi.fn()
      .mockResolvedValueOnce({
        staticIndex: '## app\n- app:first',
        dynamicTopK: '- app:first — first',
      })
      .mockResolvedValueOnce(null);
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills,
    });
    const hooks = cap.hooks()!;
    const firstState = stateWithUser();
    await hooks.beforeRun!(makeRunCtx(firstState, 'run-first'));
    expect(cap.getRelevantBlock(firstState)).toContain('app:first');

    const unavailableState = stateWithUser();
    await hooks.beforeRun!(makeRunCtx(unavailableState, 'run-unavailable'));
    const ctx = makeBeforeModelCtx(unavailableState);
    await hooks.beforeModel!(ctx);

    expect(cap.getRelevantBlock(unavailableState)).toBeUndefined();
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.skills_index)).toBeUndefined();
  });

  it('并发父子 Run 各自读取自己的 Prompt Skill 块', async () => {
    const cap = new SkillsCap({
      getSkill: () => undefined,
      search: () => [],
      fetchSkills: async ({ query }) => ({
        staticIndex: `## app\n- app:${query}`,
        dynamicTopK: `- app:${query} — ${query}`,
      }),
    });
    const hooks = cap.hooks()!;
    const parentState = {
      messages: [{ role: 'user', content: 'parent' }],
    } as EngineState;
    const childState = {
      messages: [{ role: 'user', content: 'child' }],
    } as EngineState;

    await hooks.beforeRun!(makeRunCtx(parentState));
    await hooks.beforeRun!(makeRunCtx(childState));

    expect(cap.getRelevantBlock(parentState)).toContain('app:parent');
    expect(cap.getRelevantBlock(parentState)).not.toContain('app:child');
    expect(cap.getRelevantBlock(childState)).toContain('app:child');
  });
});
