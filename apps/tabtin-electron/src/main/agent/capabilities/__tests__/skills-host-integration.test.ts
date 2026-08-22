/**
 * 本地 Skill 模块 Wave B · M6 端到端集成测试
 *
 * ── 测什么 ───────────────────────────────────────────────────────────
 *
 * ElectronAgentHost 在 createSession 路径里把 `LocalSkillRegistry` 绑到
 * `SkillsCap`（W2.3 取代 createSkillsAndNotes 的旧 middleware 路径）。
 * 这条"接线"链路：
 *
 *   真实 SKILL.md 文件（tmpdir）
 *     → LocalSkillRegistry 扫描 + 解析
 *     → fetchSkills(ctx) = registry.render(ctx)
 *     → SkillsCap.hooks().beforeIteration
 *     → state.__skillsHint
 *     → query.ts 合并到 effectiveSystemPrompt
 *     → LLM request.system 真实收到 `<skills>` 段
 *
 * 以及同时：
 *
 *   真实 SKILL.md 文件
 *     → SkillsCap.tools()（内部复用 createSkillsTools 的 schema + handler）
 *     → skills_read(key) → 返回完整 SKILL.md body
 *     → skills_search(q) → 返回匹配列表（canonical key 与 system 段里一致）
 *
 * ── 为什么需要这条独立测试 ───────────────────────────────────────────
 *
 * Harness 在 Wave A 花了 4 轮 Review 才修好"middleware 注入真的进 LLM"——
 * middleware 层 / registry 层 / host 层各自单测都绿但拼起来仍可能断链。
 *
 * 本文件**同时**启动三层：
 *   - Layer 1：真实文件 + LocalSkillRegistry
 *   - Layer 2：真实 SkillsCap.hooks() + createRuntime 跑一次完整 query
 *   - Layer 3：真实 SkillsCap.tools() 工具执行 skills_read
 *
 * 所有 assertion 都从**最终观察口**（LLM.request.system / tool result）断言，
 * 而不是靠 spy intermediate state —— 这样即便实现细节换了，只要用户可见
 * 行为对，测试就能继续过。
 *
 * ── W2.3 迁移说明 ─────────────────────────────────────────────────────
 *
 * 原 W1.x 实现走 `createSkillsAndNotes` middleware + `createSkillsTools`
 * 双拼路径；W2.3 改造后由 `SkillsCap` 一站式提供：
 *   - `SkillsCap.hooks()` 写 state.__skillsHint（取代 middleware
 *     beforeIteration）
 *   - `SkillsCap.tools()` 暴露 skills_read / skills_search（内部仍复用
 *     `createSkillsTools` 的 schema + handler）
 *
 * 测试本身不验证 middleware 路径，只验证"宿主装配端到端契约稳定"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
//  批次 13：engine barrel 收敛——createRuntime / getFocusedAppKey / AppContext
// 等非 engine 符号改从包入口 import，engine 契约类型留 engine 子路径。
import { createRuntime } from '@tabtin/agent-runtime';
import { getFocusedAppKey, type AppContext } from '@tabtin/agent-host/hooks';
import type { LocalSkill } from '@tabtin/agent-runtime/skills';
import type {
  EngineConfig,
  EngineHooks,
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
  StreamEvent,
  Tool,
  ToolProvider,
  EnginePermissionHandler,
} from '@tabtin/agent-runtime/engine';
import { SkillsCap } from '@tabtin/agent-host/capabilities';
import { createLexicalSkillRecall } from '@tabtin/agent-runtime/skills';
import { LocalSkillRegistry, type ScannerEnv } from '@tabtin/agent-host/skills';
import { resolveOrganizationSkillsDir } from '@tabtin/terminal-core';

// ─── helpers ────────────────────────────────────────────────────────

/**
 * 捕获 LLM request 的 mock provider —— 和 middleware-skills-and-notes.test.ts
 * 同模式（WA-ε 真实集成测试参考）。每次 createStream 都把 request 塞进数组。
 */
function createCapturingProvider(captured: LLMRequest[]): LLMProvider {
  return {
    async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
      captured.push(request);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
  };
}

/**
 * 最小 ToolProvider —— skills-integration 场景：registered tools 只包含
 * skills_read / skills_search（通过 SkillsCap.tools() 取出注入）。
 */
function createSkillsOnlyToolProvider(skillsCap: SkillsCap): ToolProvider {
  const tools = skillsCap.tools();
  return {
    getTools: () => tools,
  };
}

/**
 * 最小 EnginePermissionHandler —— skills_read / skills_search 都是 isReadOnly，
 * 无需真实授权，always-allow 即可。
 */
function createPermissiveHandler(): EnginePermissionHandler {
  return {
    requestPermissionsBatch: async (request) =>
      request.requests.map(({ toolCallId }) => ({
        toolCallId: toolCallId ?? 'mock-tool-use',
        decision: 'allow',
      })),
  };
}

async function drain(gen: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}

function writeSkillMd(opts: {
  dir: string;
  slug: string;
  name: string;
  description: string;
  whenToUse?: string;
  body?: string;
}): Promise<void> {
  const { dir, slug, name, description, whenToUse, body } = opts;
  const lines = [
    '---',
    `slug: ${slug}`,
    `name: ${name}`,
    `description: ${description}`,
    ...(whenToUse ? [`when_to_use: ${whenToUse}`] : []),
    '---',
    '',
    body ?? `# ${name}\n\n步骤见下：\n\n1. 步骤一\n2. 步骤二`,
  ];
  return fsp.writeFile(path.join(dir, slug, 'SKILL.md'), lines.join('\n'));
}

/**
 * （硬切）：老 `<platformDataRoot>/<organizationId>/spaces/<spaceId>/skills/`
 * 布局已彻底移除，本文件统一走新布局
 *   `<dataRoot>/users/<userId>/organizations/<organizationId>/skills/<slug>/SKILL.md`
 *
 * canonicalKey 仍是 `user:<slug>`（buildCanonicalKey 对 scope='organization'
 * 同样不前缀 organizationId）。
 *
 * 默认 spaceId='sp-1' 以匹配 E2E 测试常用的 query.spaceId——新布局下 spaceId
 * 只是 render/query 的透传上下文字段，不参与扫描根/过滤（scope='organization'
 * 的 skill 对组织内任意 spaceId 均可见）。
 */
const DEFAULT_TEST_ORGANIZATION_ID = 'wt-1';
const DEFAULT_TEST_USER_ID = 'user-1';

function mkDataRoot(tmpHome: string): string {
  return path.join(tmpHome, 'data-root');
}

async function seedSpaceSkill(
  tmpHome: string,
  slug: string,
  opts: {
    name: string;
    description: string;
    whenToUse?: string;
    body?: string;
    userId?: string;
    organizationId?: string;
  },
): Promise<void> {
  const userId = opts.userId ?? DEFAULT_TEST_USER_ID;
  const organizationId = opts.organizationId ?? DEFAULT_TEST_ORGANIZATION_ID;
  const dir = resolveOrganizationSkillsDir(mkDataRoot(tmpHome), userId, organizationId);
  await fsp.mkdir(path.join(dir, slug), { recursive: true });
  await writeSkillMd({ dir, slug, ...opts });
}

/** 兼容别名 —— 测试代码原本写 seedUserSkill，语义保留：写到默认组织 skills 目录。 */
const seedUserSkill = seedSpaceSkill;

/** 新布局 ScannerEnv：`dataRoot` + `userId`（ 硬切，不再有 platformDataRoot）。 */
function mkEnv(tmpHome: string): ScannerEnv {
  return {
    dataRoot: mkDataRoot(tmpHome),
    userId: DEFAULT_TEST_USER_ID,
  };
}

// ─── fixtures ───────────────────────────────────────────────────────

/**
 * 用固定 budgetChars 让渲染结果可重复——LocalSkillRegistry.render 默认
 * 8000 字符，本地测试用几个小 skill 不会触发降级，结果稳定。
 */
const RENDER_BUDGET_CHARS = 8_000;

function carryAll(skills: readonly LocalSkill[]): Record<string, boolean> {
  return Object.fromEntries(skills.map((skill) => [skill.canonicalKey, true]));
}

// ─── 测试 ────────────────────────────────────────────────────────────

describe('Skills host integration (Wave B · M6)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabtin-skills-integ-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  /**
   * 按 ElectronAgentHost `createSession` 的 W2.3 接线方式构造一套端到端的
   * SkillsCap + tools 组合。这里**原样复制宿主绑定规则**——测试挂的是同一套
   * 回调形状，就算宿主代码随未来重构改了，这段如果跑通说明"接线契约"稳定。
   */
  async function buildIntegration(
    registry: LocalSkillRegistry,
    captured: LLMRequest[],
  ): Promise<{
    config: EngineConfig;
    skillTools: Tool[];
  }> {
    // 和 ElectronAgentHost promptSkillsFetch 同模式：fetchSkills 闭包消费已经按
    // Agent 携带集冻结的 availableSkills，并把同一份 enabledMap 透给静态段渲染。
    const fetchSkills = async (ctx: {
      query?: string;
      focusedApp?: string | null;
    }): Promise<string | null> =>
      registry.renderAvailableSkills(registry.listAll(), {
        query: ctx.query,
        focusedApp: ctx.focusedApp,
        budgetChars: RENDER_BUDGET_CHARS,
        enabledMap: carryAll(registry.listAll()),
      });

    // 与 ElectronAgentHost.createSession W2.3 装配 SkillsCap 同形态：
    // 把 registry 的 getByKey / search 通过 SkillsCapInit 直接传入。
    const skillsCap = new SkillsCap({
      fetchSkills,
      getSkill: (key) => registry.getByKey(key),
      search: (q, opts) => registry.search(q, opts),
    });

    const toolProvider = createSkillsOnlyToolProvider(skillsCap);

    const config: EngineConfig = {
      provider: createCapturingProvider(captured),
      tools: toolProvider,
      permissionHandler: createPermissiveHandler(),
      sessionConfig: {
        sessionDir: path.join(tmpHome, '__session'),
        threadId: 'skills-integ',
      },
      model: 'test-model',
      systemPrompt: 'base prompt',
      // 挂 SkillsCap.hooks() —— W2.3 取代 createSkillsAndNotes middleware
      // 路径，行为 100% 等价：每轮 beforeIteration 调 fetchSkills 写
      // state.__skillsHint，由 query.ts Phase 2 合并到 effectiveSystemPrompt。
      hooks: skillsCap.hooks() ?? ({} as EngineHooks),
    };

    return { config, skillTools: toolProvider.getTools() };
  }

  it('E2E-1：真实 SKILL.md → registry → fetchSkills → middleware → LLM.request.system 含 <skills>', async () => {
    await seedUserSkill(tmpHome, 'code-style-check', {
      name: '代码风格检查',
      description: 'Check Python/JS code style via configured linters.',
      whenToUse: 'When the user wants to enforce project-wide coding style.',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();
    expect(registry.listAll().length).toBeGreaterThanOrEqual(1);

    const captured: LLMRequest[] = [];
    const { config } = await buildIntegration(registry, captured);

    const rt = createRuntime(config);
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi', spaceId: 'sp-1', organizationId: 'wt-1' }));

    // 最终观察口：LLM 实际收到的 system prompt。这是 Wave A ARCH-0 修复
    // 后才真正生效的注入路径（__skillsHint → effectiveSystemPrompt）。
    expect(captured).toHaveLength(1);
    const sys = captured[0].system as string;
    expect(typeof sys).toBe('string');
    expect(sys).toContain('<skills>');
    expect(sys).toContain('</skills>');
    expect(sys).toContain('user:code-style-check');
    // base prompt 仍然保留（middleware 不应该盖掉宿主 system prompt）
    expect(sys).toContain('base prompt');
  });

  it('E2E-1b：registry ready 但 run 快照未权威时仍注入最小 <skills> header', async () => {
    await seedUserSkill(tmpHome, 'hidden-until-snapshot', {
      name: '快照未就绪技能',
      description: 'Should not leak before the run carry snapshot is authoritative.',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const fetchSkills = async (ctx: {
      query?: string;
    }) =>
      registry.renderAvailableSkills([], {
        query: ctx.query,
        budgetChars: RENDER_BUDGET_CHARS,
      });

    const skillsCap = new SkillsCap({
      fetchSkills,
      getSkill: (key) => registry.getByKey(key),
      search: (q, opts) => registry.search(q, opts),
    });

    const captured: LLMRequest[] = [];
    const rt = createRuntime({
      provider: createCapturingProvider(captured),
      tools: createSkillsOnlyToolProvider(skillsCap),
      permissionHandler: createPermissiveHandler(),
      sessionConfig: {
        sessionDir: path.join(tmpHome, '__session'),
        threadId: 'skills-snapshot-not-ready',
      },
      model: 'test-model',
      systemPrompt: 'base prompt',
      hooks: skillsCap.hooks() ?? ({} as EngineHooks),
    });

    await drain(rt.query({ hostRunId: 'test-run', prompt: 'what skills do I have?' }));

    expect(captured).toHaveLength(1);
    const sys = captured[0].system as string;
    expect(sys).toContain('<skills>');
    expect(sys).toContain('以下列表是你所携带的技能');
    expect(sys).toContain('</skills>');
    expect(sys).not.toContain('user:hidden-until-snapshot');
    expect(sys).toContain('base prompt');
  });

  it('E2E-2：skills_read(canonical key) 通过 host injection 返回完整 SKILL.md 正文', async () => {
    await seedUserSkill(tmpHome, 'daily-report', {
      name: '日报生成',
      description: 'Generate daily standup summary from recent chats.',
      body: '# 日报生成\n\n## Steps\n1. 汇总今天\n2. 格式化输出',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const captured: LLMRequest[] = [];
    const { skillTools } = await buildIntegration(registry, captured);

    const readTool = skillTools.find((t) => t.name === 'skills_read');
    expect(readTool).toBeDefined();

    const result = await readTool!.execute(
      { key: 'user:daily-report' },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );

    expect(result.isError).toBeFalsy();
    const content = result.content as string;
    // 完整 SKILL.md 必须含 frontmatter + body 所有字段
    expect(content).toContain('slug: daily-report');
    expect(content).toContain('name: 日报生成');
    expect(content).toContain('# 日报生成');
    expect(content).toContain('## Steps');
    expect(content).toContain('2. 格式化输出');
  });

  it('E2E-3：skills_search(query) 通过 host injection 返回匹配的 canonical key', async () => {
    await seedUserSkill(tmpHome, 'code-style-check', {
      name: '代码风格检查',
      description: 'Check Python/JS code style via configured linters.',
    });
    await seedUserSkill(tmpHome, 'daily-report', {
      name: '日报生成',
      description: 'Generate daily standup summary from recent chats.',
    });
    await seedUserSkill(tmpHome, 'deploy-guide', {
      name: '部署指南',
      description: 'Step-by-step deployment runbook.',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const captured: LLMRequest[] = [];
    const { skillTools } = await buildIntegration(registry, captured);

    const searchTool = skillTools.find((t) => t.name === 'skills_search');
    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute(
      { query: 'python', limit: 5 },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.results).toHaveLength(1);
    // 找到的就是那条 description 含 'python' 的 skill，且 canonical key 与
    // `<skills>` 注入段里的 key 完全一致（LLM 可以直接把它传给 skills_read）。
    expect(parsed.results[0].key).toBe('user:code-style-check');
    expect(parsed.results[0].name).toBe('代码风格检查');
    // 搜索结果不暴露 SKILL.md 正文（保护 token 预算）
    expect(parsed.results[0].content).toBeUndefined();
  });

  it('E2E-4：新增文件后 registry.refreshSlug → fetchSkills 新一轮看到新 skill', async () => {
    // scanner 枚举 `<dataRoot>/users/<userId>/organizations/<organizationId>/skills/`。
    // 初始 ready 前先创建空的组织 skills 目录，让 ready() 把该 root 计入；
    // 否则 refreshSlug 拿不到 root。
    await fsp.mkdir(
      resolveOrganizationSkillsDir(
        mkDataRoot(tmpHome),
        DEFAULT_TEST_USER_ID,
        DEFAULT_TEST_ORGANIZATION_ID,
      ),
      { recursive: true },
    );

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();
    expect(registry.listAll()).toHaveLength(0);

    const captured: LLMRequest[] = [];
    const { config } = await buildIntegration(registry, captured);

    const rt = createRuntime(config);

    // 首轮：registry 为空 → fetchSkills 返回 null → 不注入 <skills>
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'round 1' }));
    expect(captured).toHaveLength(1);
    expect(captured[0].system as string).toContain('<skills>');
    expect(captured[0].system as string).not.toContain('user:newly-added');

    // 模拟 watcher 路径：用户/Agent 写文件 → refreshSlug 回灌
    await seedUserSkill(tmpHome, 'late-added', {
      name: '后补技能',
      description: 'Added after registry was already ready.',
    });
    const roots = registry.getScanRoots();
    const orgRoot = roots.find(
      (r) => r.kind === 'user/organization' && r.organizationId === DEFAULT_TEST_ORGANIZATION_ID,
    )!;
    expect(orgRoot).toBeDefined();
    await registry.refreshSlug(orgRoot, path.join(orgRoot.path, 'late-added'));
    expect(registry.getByKey('user:late-added')).toBeDefined();

    // 第二轮：registry 有新 skill → fetchSkills 渲染出来 → LLM 能看到
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'round 2' }));
    expect(captured).toHaveLength(2);
    const sys2 = captured[1].system as string;
    expect(sys2).toContain('<skills>');
    expect(sys2).toContain('user:late-added');

    // 对应北极星场景 A：用户在本轮让 Agent 写 skill 后，**下一轮** LLM
    // 看得到这个 skill。测试不跑真实 watcher（debounce + 文件系统异步会让
    // 单测脆弱），直接走 registry.refreshSlug 这个"watcher → registry"的
    // 下游等价调用——Wave A 对该函数已有独立单测覆盖文件-registry 同步。
  });

  it('E2E-5：skills_read(未安装 key) → 中文"未找到"错误（不是 LLM 可理解的崩溃）', async () => {
    await seedUserSkill(tmpHome, 'existing', {
      name: '存在的技能',
      description: 'Does exist.',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const captured: LLMRequest[] = [];
    const { skillTools } = await buildIntegration(registry, captured);
    const readTool = skillTools.find((t) => t.name === 'skills_read')!;

    const result = await readTool.execute(
      { key: 'user:does-not-exist' },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );

    expect(result.isError).toBe(true);
    // §5.X：'未找到技能 ...' + 引导 skills_search
    expect(result.content).toContain('未找到技能');
    expect(result.content).toContain('user:does-not-exist');
    expect(result.content).toContain('skills_search');
  });

  it('E2E-6：skills_read("ext:xxx") / "tin:xxx" 前缀 → §5.X 固定中文错误文案', async () => {
    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const captured: LLMRequest[] = [];
    const { skillTools } = await buildIntegration(registry, captured);
    const readTool = skillTools.find((t) => t.name === 'skills_read')!;

    const r1 = await readTool.execute(
      { key: 'ext:something' },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );
    const r2 = await readTool.execute(
      { key: 'tin:weather' },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );

    for (const r of [r1, r2]) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain('仅在在线模式下可用');
    }
  });

  it('E2E-7：渲染出的 canonical key 与 skills_read 能消费的 key 完全一致（key 口径对齐）', async () => {
    // PRD §5.4 / R7-fix：`<skills>` 段列的 key 就是 skills_read 的参数。
    // 这条测试确保 LocalSkillRegistry.render 生成的 key 格式**字符级相同**
    // 于 getByKey 的索引键——任何一边改格式都会让 LLM 拿到的 key 传不回来。
    await seedUserSkill(tmpHome, 'kebab-slug-skill', {
      name: 'Kebab 命名技能',
      description: 'Test canonical key alignment.',
    });

    const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(tmpHome) });
    await registry.ready();

    const captured: LLMRequest[] = [];
    const { config, skillTools } = await buildIntegration(registry, captured);
    const rt = createRuntime(config);
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    const sys = captured[0].system as string;
    // 正则抓 user:<slug> 这一行
    const match = sys.match(/user:[a-z][a-z0-9-]*/);
    expect(match).toBeTruthy();
    const keyFromSystem = match![0];
    expect(keyFromSystem).toBe('user:kebab-slug-skill');

    // 用 LLM 在 system 段看到的完全相同的 key 反向调用 skills_read
    const readTool = skillTools.find((t) => t.name === 'skills_read')!;
    const result = await readTool.execute(
      { key: keyFromSystem },
      {
        threadId: 't',
        runtimeId: 'r',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Kebab 命名技能');
  });

  it('E2E-9：registry 冷启动 5s 仍在 init → 首轮 LLM.request.system 仍含 <skills>（WA-B-fix P0-1）', async () => {
    // 背景：独立验证抓到的 P0-1——原 fetchSkills 超时 2s，冷启动期间用户
    // 立即发首条消息会 race 掉，首轮 LLM 完全看不到 `<skills>`。修法：超时
    // 放宽到 15s（ElectronAgentHost.ts fetchSkills 闭包内）。
    //
    // 本测试直接复用 ElectronAgentHost 的**同构 fetchSkills 形状**——包含
    // "skillsReady race + hostRef.skillsModule 惰性读"这两个 host 侧关键细节。
    // 不用启真 ElectronAgentHost（IPC / userData 路径在 vitest 里太重），但
    // fetchSkills 的超时行为测到了就等于宿主也测到了（这条链路只有超时一
    // 个变量）。

    // 模拟 host：skillsModule 一开始 null，skillsReady 5s 后才 settle。
    type HostRef = {
      skillsModule: { registry: LocalSkillRegistry } | null;
    };
    const hostRef: HostRef = { skillsModule: null };

    // 真实 registry 在"后台" init，这里用一个显式延迟代替磁盘 I/O 的真实耗时
    const seedPath = tmpHome;
    await seedUserSkill(seedPath, 'slow-starter', {
      name: '慢启动技能',
      description: 'Should appear even when registry took 5s to init.',
    });

    const INIT_DELAY_MS = 5_000;
    const skillsReady: Promise<void> = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, INIT_DELAY_MS));
      const registry = new LocalSkillRegistry({
      skillRecall: createLexicalSkillRecall(), env: mkEnv(seedPath) });
      await registry.ready();
      hostRef.skillsModule = { registry };
    })();

    // 同 ElectronAgentHost P0-1 修法：15s 超时。
    const fetchSkills = async (ctx: {
      spaceId?: string;
      organizationId?: string;
    }): Promise<string | null> => {
      try {
        await Promise.race([
          skillsReady,
          new Promise<void>((resolve) => setTimeout(() => resolve(), 15_000)),
        ]);
      } catch {
        // ready 失败分支——本场景不会走
      }
      const registry = hostRef.skillsModule?.registry;
      if (!registry) return null;
      return registry.render({
        spaceId: ctx.spaceId,
        organizationId: ctx.organizationId,
        budgetChars: RENDER_BUDGET_CHARS,
        enabledMap: carryAll(registry.listAll()),
      });
    };

    // SkillsCap 同样惰性读 hostRef.skillsModule（和宿主同模式）
    const skillsCap = new SkillsCap({
      fetchSkills,
      getSkill: (key) => hostRef.skillsModule?.registry.getByKey(key),
      search: (q, opts) => hostRef.skillsModule?.registry.search(q, opts) ?? [],
    });

    const toolProvider = createSkillsOnlyToolProvider(skillsCap);
    const captured: LLMRequest[] = [];
    const rt = createRuntime({
      provider: createCapturingProvider(captured),
      tools: toolProvider,
      permissionHandler: createPermissiveHandler(),
      sessionConfig: {
        sessionDir: path.join(tmpHome, '__session'),
        threadId: 'skills-cold-start',
      },
      model: 'test-model',
      systemPrompt: 'base prompt',
      hooks: skillsCap.hooks() ?? ({} as EngineHooks),
    });

    // 关键场景：用户**不等 init ready** 就立刻发消息——模拟"点开 Electron
    // 后立刻问'你有哪些 skill'"的最常见首轮交互。
    const t0 = Date.now();
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'what skills do I have?', spaceId: 'sp-1' }));
    const elapsed = Date.now() - t0;

    // init 延迟是 5s——首轮应该自然等到 ready 后再进 LLM（证明 15s 超时
    // 没被 race 掉；若仍是 2s 超时这条会超时静默 return null → 断言挂）。
    expect(elapsed).toBeGreaterThanOrEqual(INIT_DELAY_MS - 500);
    // 但不会等到 15s（超时只是 ceiling，不是 floor）
    expect(elapsed).toBeLessThan(INIT_DELAY_MS + 3_000);

    expect(captured).toHaveLength(1);
    const sys = captured[0].system as string;
    // 核心断言：首轮 LLM.request.system 真的含 `<skills>` 段
    //（P0-1 修复前这里永远空——单轮对话用户看不到 skill 的根因）
    expect(sys).toContain('<skills>');
    expect(sys).toContain('user:slow-starter');
    expect(sys).toContain('</skills>');
    expect(sys).toContain('base prompt');
  }, 20_000);

  it('E2E-10：registry 永不 ready → 15s 超时后首轮 LLM 仍能继续（降级为无 <skills>）（WA-B-fix P0-1 补充）', async () => {
    // 背景：E2E-9 证明"慢但最终成功"能正确等到；这条补"init 永远不 resolve"
    // 的极端降级——init 卡在文件系统异常 / 权限问题时，fetchSkills 必须在
    // 15s 后放过让 Agent 继续回复（`<skills>` 段缺失但 LLM 能用），而不是
    // 无限 pending 把整轮请求卡死。
    //
    // 为了不让测试本身跑 15s（CI 太慢），这里用 **timers mock** 控制时间流
    // 并主动验证 15s race 超时路径的行为——不真等 15s。

    const hostRef: { skillsModule: { registry: LocalSkillRegistry } | null } = {
      skillsModule: null,
    };

    // 永远 pending 的 Promise——模拟 init 挂死（文件系统 I/O 卡住、权限拒绝
    // 但 initSkillsModule.then 未触发等）
    const skillsReady: Promise<void> = new Promise(() => {
      // 故意永远不 resolve / reject
    });

    // 与 ElectronAgentHost fetchSkills 同构（含 clearTimeout 修复）
    const fetchSkills = async (ctx: {
      spaceId?: string;
      organizationId?: string;
    }): Promise<string | null> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          skillsReady.finally(() => {
            if (timer) clearTimeout(timer);
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => resolve(), 15_000);
          }),
        ]);
      } catch {
        if (timer) clearTimeout(timer);
      }
      const registry = hostRef.skillsModule?.registry;
      if (!registry) return null;
      return registry.render({
        spaceId: ctx.spaceId,
        organizationId: ctx.organizationId,
        budgetChars: RENDER_BUDGET_CHARS,
        enabledMap: undefined,
      });
    };

    const skillsCap = new SkillsCap({
      fetchSkills,
      getSkill: (key) => hostRef.skillsModule?.registry.getByKey(key),
      search: (q, opts) => hostRef.skillsModule?.registry.search(q, opts) ?? [],
    });

    const toolProvider = createSkillsOnlyToolProvider(skillsCap);
    const captured: LLMRequest[] = [];
    const rt = createRuntime({
      provider: createCapturingProvider(captured),
      tools: toolProvider,
      permissionHandler: createPermissiveHandler(),
      sessionConfig: {
        sessionDir: path.join(tmpHome, '__session'),
        threadId: 'skills-init-stuck',
      },
      model: 'test-model',
      systemPrompt: 'base prompt',
      hooks: skillsCap.hooks() ?? ({} as EngineHooks),
    });

    // 用 vitest fake timers 让 15s 在测试内 1ms 内流逝
    vi.useFakeTimers();
    try {
      const queryPromise = drain(rt.query({ hostRunId: 'test-run', prompt: 'stuck?' }));
      // 推进时间到 16s——超过 15s 超时阈值（留 1s buffer 保证 race 触发）
      await vi.advanceTimersByTimeAsync(16_000);
      await queryPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(captured).toHaveLength(1);
    const sys = captured[0].system as string;
    // 核心断言：init 永不 ready → 15s 超时降级 → LLM 仍收到 system（有
    // base prompt）但 `<skills>` 段缺失（registry null 返回 null）
    expect(sys).toContain('base prompt');
    expect(sys).not.toContain('<skills>');
    // 降级是可接受行为（PRD §5.X：未找到技能不崩溃，LLM 继续回答即可）
  }, 5_000);

  it('E2E-8：init 失败场景下 skills_read/search 以"未找到"降级，不崩溃（技术 Review P0-2）', async () => {
    // 场景：`initSkillsModule` rejected 但 `createSession` 已经
    // 提前用旧 closure 把 SkillsCap 注入 ToolProvider —— 此时工具已注册，
    // 但 `hostRef.skillsModule` 是 null。本测试模拟 ElectronAgentHost 的
    // closure 绑定（惰性读 skillsModule 的最新值），证明：
    //   1. 工具 execute 不会崩（try/catch 护住 getSkill / search 的任意异常）
    //   2. skills_read("user:foo") 以 §5.X "未找到技能" 错误降级
    //   3. skills_search 返回空结果集 + hints "未匹配到技能"（LLM 能自然转述）
    // 这条测试对齐「init 失败但旧 Runtime 还带着工具」的真实退化路径。

    // 直接模拟 hostRef.skillsModule 为 null 的状态——不需要真造 init 失败，
    // 因为失败后的行为就是 `hostRef.skillsModule = null`。SkillsCap 的回调
    // 同样惰性读 hostRef.skillsModule，注入空 stub 即等价 init 失败状态。
    const nullCap = new SkillsCap({
      getSkill: (_key) => undefined, // hostRef.skillsModule?.registry.getByKey = undefined
      search: (_q, _opts) => [], // hostRef.skillsModule?.registry.search ?? []
    });
    const skillTools = nullCap.tools();
    const readTool = skillTools.find((t) => t.name === 'skills_read')!;
    const searchTool = skillTools.find((t) => t.name === 'skills_search')!;

    const ctx = {
      threadId: 't',
      runtimeId: 'r',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
    };

    const readResult = await readTool.execute({ key: 'user:anything' }, ctx);
    expect(readResult.isError).toBe(true);
    expect(readResult.content).toContain('未找到技能');

    const searchResult = await searchTool.execute({ query: 'python' }, ctx);
    expect(searchResult.isError).toBeFalsy();
    const parsed = JSON.parse(searchResult.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.hints).toContain('未匹配到技能');
  });

  it('E2E-11：fetchSkills 闭包 focusedApp 回退契约——ctx.focusedApp 显式值优先，缺省时回退 session.appContext 派生值（宿主 fallback， Review 项 5）', async () => {
    // 复刻 ElectronAgentHost.ts / DaemonAgentHost.ts 的 fetchSkills 闭包同一行：
    //   focusedApp: ctx.focusedApp ?? getFocusedAppKey(session?.appContext ?? null)
    // 不构造完整 Host（IPC / sessions Map 太重），只钉死这条 fallback 表达式本身
    // 的行为契约：调用方显式传 focusedApp 时优先于宿主从 session 派生的值；
    // 调用方不传时才回退；两者都缺失时安全返回 null（不崩、不注入 focusedApp）。
    const resolveFocusedApp = (
      ctx: { focusedApp?: string | null },
      sessionAppContext: AppContext | null | undefined,
    ): string | null => ctx.focusedApp ?? getFocusedAppKey(sessionAppContext ?? null);

    // 1. 调用方（SkillsCap 相关性排序）显式传了 focusedApp → 优先于 session
    //    派生值，即便 session 当前聚焦的是另一个 App。
    const sessionOnTabdata: AppContext = { appType: 'tabdata' };
    expect(resolveFocusedApp({ focusedApp: 'tabdoc' }, sessionOnTabdata)).toBe('tabdoc');

    // 2. 调用方未传 focusedApp（ctx.focusedApp 为 undefined）→ 回退到宿主
    //    从当前 session.appContext 派生的聚焦 App。
    expect(resolveFocusedApp({}, sessionOnTabdata)).toBe('tabdata');

    // 3. ctx.focusedApp 显式传 null（而非未传 undefined）—— `??` 对 null / undefined
    //    一视同仁都算"未给值"，同样回退到 session 派生值（不是"null 覆盖成空"）。
    expect(resolveFocusedApp({ focusedApp: null }, sessionOnTabdata)).toBe('tabdata');

    // 4. 两者都缺失（未知 session / chat 面板）→ 安全返回 null，不崩溃。
    expect(resolveFocusedApp({}, null)).toBeNull();
    expect(resolveFocusedApp({}, { appType: 'chat' })).toBeNull();
  });
});
