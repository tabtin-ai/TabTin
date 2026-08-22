/**
 * P1-P7 Audit Test —— 阶段 1.6 + 2.3 实装
 *
 * 防止 prompt 治理过程中再次出现 review 反复抓到的几类问题：
 *   - PresenceInProduction sentinel 错用（-1 / active+0 / cold+非 0）
 *   - 段实际语言与 descriptor.language 不一致
 *   - high-risk 工具 description 缺硬契约关键词
 *   - cacheBreak=true 但缺 reason
 *   - prompts/ 下塞进死 export / 死 builder / 死 marker
 *
 * 当前覆盖：
 *   - P1 注册表完整性 + sentinel 不变量 ✓ 完整
 *   - P2 字符上限 ✓ agent-prompt 包内可渲染段
 *   - P3 语言纪律 ✓ agent-prompt 包内可渲染段
 *   - P4 cache 纪律 ✓ 全集（仅 descriptor 字段校验，不需渲染）
 *   - P5 双路径对称 □ 占位（阶段 4 Daemon 对齐时实做）
 *   - P6 死代码扫描 ✓ prompts/ 下所有 export 必须在白名单 + 有 caller / 同文件 internal 使用
 *   - P7 工具硬契约 ✓ 参数名防漂移；description 完整校验在 agent-runtime audit
 *
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  REGISTRY_ENTRIES,
  SECTION_REGISTRY,
  checkPresenceInvariants,
  checkCacheDiscipline,
  checkSectionCharBudget,
  checkLanguageDiscipline,
  checkNoDeprecatedTerms,
} from '@tabtin/prompt-contract';
import type { SectionDescriptor } from '@tabtin/prompt-contract';
import {
  buildPrincipleSection,
  buildEnvironmentSection,
  buildShellRuntimeSection,
  buildPlatformDataSection,
  buildAppsSection,
  buildUserPortraitSection,
  buildCustomRulesSection,
  buildCliCapabilitiesSection,
  buildToolsReferenceSection,
} from '../sections.js';
import {
  SECTION_EXECUTION,
  SECTION_SAFETY,
  SECTION_PLANNING,
} from '../generated-content.js';
import { AGENT_MODE_PROMPT_SECTIONS } from '@tabtin/agent-modes';

// ─── Fixtures ─────────────────────────────────────────────────────────

const FIXED_RUNTIME_IDENTITY = {
  spaceId: 'space-audit-test',
  organizationId: 'organization-audit-test',
  threadId: 'session-audit-test',
  spaceName: '审计测试空间',
  organizationName: '审计测试团队',
  workspaceRoot: '/Users/audit/workspace',
  archiveDir: '/Users/audit/data/archive',
  toolLogsDir: '/Users/audit/data/tool-logs',
};

const FIXED_APPS = [
  {
    key: 'tabdata',
    cliKey: 'table',
    displayName: '多维表',
    capability: '结构化数据表格',
  },
];

/**
 * Tools fixture for audit（`tools_reference_section` 已于  从注册表删除）。
 */
const MINIMAL_TOOLS = [
  { name: 'run_terminal_command', description: '执行 shell 命令' },
  { name: 'read_file', description: '读文件' },
  { name: 'edit_file', description: '编辑文件' },
  { name: 'ask_user', description: '向用户提多选问题' },
  { name: 'web_search', description: '搜索网络' },
  { name: 'todo_write', description: '维护 todo 列表' },
  { name: 'skills_search', description: '搜索本地 skill' },
  { name: 'skills_read', description: '读取本地 skill' },
];

/**
 * id → renderer：agent-prompt 包内能实际渲染的段。
 * 不在此 map 的段（hook / capability / tool / compact 等）由 agent-runtime
 * 的 audit 测试覆盖（暂未实装）。
 *
 * 新增 agent-prompt 段时必须同步更新 RENDERERS + EXPECTED_RENDERABLE_IDS，
 * P2 第一个 test 会拦"加段没接 audit"的回归。
 */
const RENDERERS: Partial<Record<string, () => string>> = {
  principle_section: () => buildPrincipleSection(),
  environment_section: () => buildEnvironmentSection(FIXED_RUNTIME_IDENTITY),
  shell_runtime_section: () => buildShellRuntimeSection(FIXED_RUNTIME_IDENTITY),
  platform_data_section: () => buildPlatformDataSection(FIXED_RUNTIME_IDENTITY),
  apps_section: () => buildAppsSection(FIXED_APPS),
  user_portrait_section: () =>
    buildUserPortraitSection('## 工作背景\n后端工程师。\n\n## 个人背景\n喜欢简洁工具。'),
  // 注：custom_rules 段内容由用户提供，audit 只校验包装模板的语言。fixture 用纯中文反映"模板部分中文 + 用户内容也中文"的典型场景。
  custom_rules_section: () =>
  buildCustomRulesSection(
      '始终用中文回复，提交信息要写明背景和原因。文件命名遵循蛇形小写约定。回答前先查询数据，不要凭印象作答。',
    ),
  cli_capabilities_section: () =>
    buildCliCapabilitiesSection('- `tabtin table list`：列出当前工作空间所有表'),
  execution_section: () => SECTION_EXECUTION,
  safety_section: () => SECTION_SAFETY,
  planning_section: () => SECTION_PLANNING,
  agent_mode_plan_section: () => AGENT_MODE_PROMPT_SECTIONS.plan ?? '',
  agent_mode_ask_section: () => AGENT_MODE_PROMPT_SECTIONS.ask ?? '',
  agent_mode_study_section: () => AGENT_MODE_PROMPT_SECTIONS.study ?? '',
  agent_mode_group_section: () => AGENT_MODE_PROMPT_SECTIONS.group ?? '',
};

/**
 * agent-prompt 包内当前应该被 audit 的段全集。
 * 新增 agent-prompt 段时必须更新这里 + RENDERERS——P2 集合校验会拦
 * "加段没接 audit"的回归（譬如 review #1 抓出来 tools_reference_section 漏过的场景）。
 */
const EXPECTED_RENDERABLE_IDS = new Set<string>([
  'principle_section',
  'environment_section',
  'shell_runtime_section',
  'platform_data_section',
  'apps_section',
  'user_portrait_section',
  'custom_rules_section',
  'cli_capabilities_section',
  'execution_section',
  'safety_section',
  'planning_section',
  'agent_mode_plan_section',
  'agent_mode_ask_section',
  'agent_mode_study_section',
  'agent_mode_group_section',
]);

// ─── P1: 注册表完整性 + sentinel 不变量 ──────────────────────────────

describe('P1 · 注册表完整性 + PresenceInProduction sentinel 不变量', () => {
  it('REGISTRY_ENTRIES 与 SECTION_REGISTRY 1:1 对齐', () => {
    const registryIds = new Set(Object.keys(SECTION_REGISTRY));
    const entryIds = new Set(REGISTRY_ENTRIES.map((e) => e.id));
    expect(entryIds.size).toBe(REGISTRY_ENTRIES.length); // 无重复 id
    expect(registryIds).toEqual(entryIds);
  });

  it('注册表条目数与当前 A + B 类治理清单一致（93 条）', () => {
    // M3 阶段 3（2026-05-21）新增 `memory_recall_section`（hook_injection 类）
    // → 99 条。
    // 阶段 6.7 议题 1（2026-05-21）删 `ask_user_tools_usage_section` +
    // `skills_usage_section`，加 `skills_user_voice` → -2 + 1 = 98 条。
    // 阶段 5（2026-05-21）全中文化删 `subagent_fork_boilerplate_en` → -1 = 97 条。
    // 2026-05-23 push 通知重构：删 `kill_background_task_tool` +
    // `await_background_task_tool` → -2 = 95 条。
    // ：删 `tools_reference_section` → 94 条。
    // [#2109] 隐藏 platform data 本地路径新增 1 条工具注册条目 → 95 条。
    // ：删除静态 agent_memory_capability 段；条目总数仍为 95。
    // ：删 `skills_user_voice_section`（并入 skills index）→ 94 条。
    //  新增的 operating loop 已并入 principle_section，独立条目删除 → 93 条。
    expect(REGISTRY_ENTRIES).toHaveLength(93);
  });

  it('注册表条目按 category 分布合理', () => {
    const byCategory = REGISTRY_ENTRIES.reduce(
      (acc, e) => {
        acc[e.category] = (acc[e.category] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    // operating loop 并入 principle_section → base_prompt_section 15。
    expect(byCategory).toMatchInlineSnapshot(`
      {
        "assistant_ack": 3,
        "base_prompt_section": 15,
        "hook_injection": 14,
        "sideloop_llm_prompt": 14,
        "tool_description": 32,
        "tool_result_wrap": 7,
        "user_wrapper": 8,
      }
    `);
  });

  // 核心：所有 97 条都必须通过 sentinel 不变量。这是 review 反复要求固化的护栏。
  it.each(REGISTRY_ENTRIES.map((e) => [e.id, e] as const))(
    'PresenceInProduction 不变量 - %s',
    (_id, descriptor: SectionDescriptor) => {
      const r = checkPresenceInvariants(descriptor);
      expect(r.issues).toEqual([]);
      expect(r.ok).toBe(true);
    },
  );

  it('全集 sentinel 守护：无任何 -1 / 负数 hitSessions', () => {
    const violators = REGISTRY_ENTRIES.filter(
      (e) =>
        e.presenceInProduction.hitSessions !== undefined &&
        (typeof e.presenceInProduction.hitSessions !== 'number' ||
          !Number.isInteger(e.presenceInProduction.hitSessions) ||
          e.presenceInProduction.hitSessions < 0),
    );
    expect(violators).toEqual([]);
  });

  it('active 类条目：observed=true 强制', () => {
    const violators = REGISTRY_ENTRIES.filter(
      (e) =>
        e.presenceInProduction.category === 'active' && e.presenceInProduction.observed !== true,
    );
    expect(violators).toEqual([]);
  });

  it('production-cold 类条目：observed=false 且 hitSessions=0 强制', () => {
    const violators = REGISTRY_ENTRIES.filter((e) => {
      if (e.presenceInProduction.category !== 'production-cold') return false;
      return e.presenceInProduction.observed !== false || e.presenceInProduction.hitSessions !== 0;
    });
    expect(violators).toEqual([]);
  });

  it('renderCondition 字段完整：每条都有 modes (非空) + hosts.electron/daemon (bool)', () => {
    const violators: string[] = [];
    for (const e of REGISTRY_ENTRIES) {
      const rc = e.renderCondition;
      if (!rc || !Array.isArray(rc.modes) || rc.modes.length === 0) {
        violators.push(`${e.id}: missing or empty renderCondition.modes`);
        continue;
      }
      if (
        typeof rc.hosts?.electron !== 'boolean' ||
        typeof rc.hosts?.daemon !== 'boolean'
      ) {
        violators.push(`${e.id}: renderCondition.hosts must have electron+daemon bool`);
      }
    }
    expect(violators).toEqual([]);
  });
});

// ─── P2: 字符上限（agent-prompt 包内可渲染段）─────────────────────────

describe('P2 · 段实际渲染长度 ≤ charBudget（仅 agent-prompt 包内）', () => {
  const renderable = REGISTRY_ENTRIES.filter((e) => RENDERERS[e.id]);

  it('renderable 集合 = EXPECTED_RENDERABLE_IDS（防 agent-prompt 段加了但忘记 audit）', () => {
    const actualIds = new Set(renderable.map((e) => e.id));
    // 比集合相等更精确：分别报"少哪些 / 多哪些"
    const missing = [...EXPECTED_RENDERABLE_IDS].filter((id) => !actualIds.has(id));
    const extra = [...actualIds].filter((id) => !EXPECTED_RENDERABLE_IDS.has(id));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(renderable.map((e) => [e.id, e] as const))(
    '%s: rendered 长度 ≤ charBudget',
    (_id, descriptor: SectionDescriptor) => {
      const renderFn = RENDERERS[descriptor.id]!;
      const text = renderFn();
      const r = checkSectionCharBudget(descriptor, text);
      if (!r.ok) {
        throw new Error(
          `${descriptor.id}: actual ${r.actual} > budget ${r.budget}` +
            `\n— 如果是真的需要更长，请同步更新 0_active_renderers.md 的 proposed_char_budget` +
            ` + 跑 extract_renderers.py 重新生成`,
        );
      }
      expect(r.ok).toBe(true);
    },
  );
});

// ─── P3: 语言纪律（agent-prompt 包内可渲染段）─────────────────────────

describe('P3 · 段实际语言与 descriptor.language 一致（仅 agent-prompt 包内）', () => {
  const renderable = REGISTRY_ENTRIES.filter((e) => RENDERERS[e.id]);

  it.each(renderable.map((e) => [e.id, e] as const))(
    '%s: detectLanguage 与 descriptor.language 一致',
    (_id, descriptor: SectionDescriptor) => {
      const renderFn = RENDERERS[descriptor.id]!;
      const text = renderFn();
      const r = checkLanguageDiscipline(descriptor, text);
      if (!r.ok) {
        throw new Error(
          `${descriptor.id}: declared=${r.declared} but detected=${r.detected}` +
            (r.hasException ? ' (有 languageExceptionReason)' : ' (无 exception reason)') +
            `\n— 如果是预期的语言变更，请同步更新 0_active_renderers.md 的 language 字段` +
            ` + 跑 extract_renderers.py 重新生成`,
        );
      }
      expect(r.ok).toBe(true);
    },
  );
});

// ─── P7-γ: agent-prompt 渲染段禁含废弃参数名（防漂移反向 audit） ──────
//
// 2026-05-21 review 第四轮补：agent-runtime 包的 P7-γ 只扫工具 description
// 与 inputSchema field description，但 agent-prompt 渲染的 `<tools_reference>`
// / `<ask_user_tools_usage>` / `<execution>` 等 system prompt 段同样是
// LLM 可见字符串，未来如果有人在 sections.ts CROSS_TOOL_DECISIONS 写回
// `background_task_id` / `run_in_background`，agent-runtime audit 抓不到——
// 必须在 agent-prompt 这边对所有 RENDERERS 跑一遍同款 checkNoDeprecatedTerms。
//
// 跟 P7-γ runtime 版完全同款语义（OR substring 命中），共享治理基线
// `DEPRECATED_PARAM_TERMS`。

describe('P7-γ · agent-prompt 渲染段禁含废弃参数名（防漂移反向 audit）', () => {
  const renderable = REGISTRY_ENTRIES.filter((e) => RENDERERS[e.id]);

  it.each(renderable.map((e) => [e.id, e] as const))(
    '%s: 渲染文本不含 LLM-facing 废弃参数名',
    (_id, descriptor: SectionDescriptor) => {
      const renderFn = RENDERERS[descriptor.id]!;
      const text = renderFn();
      const r = checkNoDeprecatedTerms(text);
      if (!r.ok) {
        const fmt = r.hits
          .map(
            (h) =>
              `      · "${h.oldTerm}" (offset ${h.index}) → 应改用 "${h.newTerm}" — ${h.reason}`,
          )
          .join('\n');
        throw new Error(
          `P7-γ 渲染段含废弃参数名：\n` +
            `  段：${descriptor.id} (${descriptor.xmlTag ? '<' + descriptor.xmlTag + '>' : ''})\n` +
            `  命中：\n${fmt}\n` +
            `\n— 治理动作：sections.ts / generated-content.ts 把废弃参数名全换成现行参数名。` +
            `LLM 每次 system prompt 都会看这段，写错会直接污染工具调用决策。`,
        );
      }
      expect(r.hits).toEqual([]);
    },
  );
});

describe('Browser-to-Table strategy guidance', () => {
  it('tools reference teaches the tab list → open → network/eval → TabData workflow', () => {
    const text = buildToolsReferenceSection(MINIMAL_TOOLS);

    expect(text).toContain('`tab list`（复用已打开页，保登录态）→ `open` → `network` / `eval`');
    expect(text).toContain('表名由你根据用户意图、页面标题/域名和字段语义判断并显式传入');
    // 已下线的高层命令不应再出现在提示词里。
    expect(text).not.toContain('collect table');
  });
});

// ─── P4: cache 纪律（全集，仅描述符校验）─────────────────────────────

describe('P4 · cacheBreak=true 必须给 reason（全集）', () => {
  it.each(REGISTRY_ENTRIES.map((e) => [e.id, e] as const))(
    '%s',
    (_id, descriptor: SectionDescriptor) => {
      const r = checkCacheDiscipline(descriptor);
      expect(r.issues).toEqual([]);
    },
  );
});

// ─── M3 阶段 3：memory_recall_section 专项 audit ────────────────────
//
// `memory_recall_section` 是 hook_injection 类，渲染逻辑在 agent-prompt
// （`buildMemoryRecallSection`），注入 timing / role / 触发条件由 runtime
// hook 控制（`packages/agent-runtime/src/engine/hooks/memory-injector.ts`）。
//
// 渲染器在 RENDERERS 里没注册（hook_injection 段不在 EXPECTED_RENDERABLE_IDS
// 集合里——它们由 runtime 装配），所以本块单独做 descriptor 校验。

describe('memory_recall_section · M3 阶段 3 专项断言', () => {
  const entry = REGISTRY_ENTRIES.find((e) => e.id === 'memory_recall_section');

  it('P1：注册表中存在且 1:1 对齐 SECTION_REGISTRY', () => {
    expect(entry).toBeDefined();
    expect(SECTION_REGISTRY['memory_recall_section']).toBe(entry);
  });

  it('P2：charBudget = 800（spec 拍板预算）', () => {
    expect(entry!.charBudget).toBe(800);
  });

  it('P3：language=zh（无 exception reason）', () => {
    expect(entry!.language).toBe('zh');
    expect(entry!.languageExceptionReason).toBeUndefined();
  });

  it('P4：cacheBreak=true 且 reason 含"每轮"或"memo"语义', () => {
    expect(entry!.cacheBreak).toBe(true);
    expect(entry!.cacheBreakReason).toBeDefined();
    // 理由必须解释清楚"为什么必须每轮变"——含 "memo" 或 "每轮" 这类词。
    expect(entry!.cacheBreakReason).toMatch(/memo|每轮/);
  });

  it('结构：category=hook_injection / xmlTag=context (阶段 6 议题 2 升级为 SSoT) / role=user / position=head', () => {
    expect(entry!.category).toBe('hook_injection');
    // 阶段 6 议题 2：旧形态 `<memory_recall>...</memory_recall>` 已退场，外壳统一
    // 走 user-context-wrapper SSoT `<context type="memory-recall">...</context>`。
    expect(entry!.xmlTag).toBe('context');
    expect(entry!.role).toBe('user');
    expect(entry!.position).toBe('head');
    expect(entry!.injectionTiming).toBe('every-turn');
  });

  it('renderCondition：requiresHostConfig 含 memory.enabled + auto_inject 两个开关', () => {
    const required = entry!.renderCondition.requiresHostConfig ?? [];
    expect(required).toContain('agentConfig.memory.enabled');
    expect(required).toContain('agentConfig.memory.injection.auto_inject');
  });

  it('presenceInProduction：尚未上线（M3 完成前）— observed=false, hitSessions=0, category=production-cold', () => {
    expect(entry!.presenceInProduction.observed).toBe(false);
    expect(entry!.presenceInProduction.hitSessions).toBe(0);
    expect(entry!.presenceInProduction.category).toBe('production-cold');
  });
});

// ─── P5 / P6 / P7 占位 ───────────────────────────────────────────────

// ─── P5: 双路径对称（Electron vs Daemon）─────────────────────────────
//
// 阶段 4 Daemon 路径对齐（治理 07 §F.1-F.5 / 99 §阶段 4）实做。
//
// 防止 Daemon 路径再悄悄漂移回去：之前 Daemon ``<apps>`` 段恒空 /
// ``<environment>`` 只显 UUID / ``<cli_capabilities>`` 段缺失 / LSP 诊断不回灌
// / RunObservation 空实现 —— 全部因为两 host 装配不等价但没人盯。
//
//   1. （ 退役）``buildSystemPrompt`` 入参字段对称 —— 装配已收敛成
//      agent-runtime 唯一 ``assembleSystemPrompt``，字段清单只有一处，字段漂移
//      结构上不可能；见上方 P5 describe 内注释。
//   2. hooks 装配集合：两 host 必须等价，差异必须显式登记到 ``RECONCILED_HOOK_DIFFERENCES``；
//   3. 模拟 Daemon 入参实测 ``buildSystemPrompt``：必须含 ``<environment>`` /
//      ``<apps>`` / ``<cli_capabilities>`` 关键段 + 段内含人类可读名（而非裸 UUID）。
//
// 实现风格：用 ``readFileSync`` + regex 扫源文件抓字段名集合，不 import host
// 实现（``agent-prompt`` 包不该反向依赖 ``apps/``）。Regex 抓不到的边界
// （譬如条件构造 ``...(cond ? { foo } : {})``）目前不出现在 host 代码里——
// 出现时 audit 应当 fail 并要求改成无条件字面量 + 缺省 undefined。

// 直接用 ``import.meta.url`` 派生（ESM 下 ``__dirname`` 不存在；与本文件
// 第 916 行 ``PROMPT_CONTRACT_TEST_DIR`` 同款写法）。
const __P5_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__P5_TEST_DIR, '../../../../');
const ELECTRON_HOST_PATH = path.resolve(
  REPO_ROOT,
  'apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts',
);
const DAEMON_HOST_PATH = path.resolve(
  REPO_ROOT,
  'apps/tabtin-daemon/src/agent/DaemonAgentHost.ts',
);

/**
 * 从 host 源文件中抓 ``composeHooks(...)`` 调用的 hook builder 函数名集合。
 *
 * Daemon / Electron 两 host 的 ``composeHooks(capHooks, buildXxx(...), ...)``
 * 形态完全一致 —— 抓出每个 ``buildXxx(`` 名字 + ``capHooks`` 字面量。``afterIteration``
 * 这种 inline object 不参与等价比较（两 host 都有 inline assistant 持久化）；
 * audit 关心的是显式 hook builder。
 */
function extractComposeHooks(filePath: string): Set<string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  // 只剥行首 ``//`` 注释，避免贪婪式块注释 strip 因源码字面量内 ``/*`` 字符
  // 配对失败把代码大段吞掉。
  const stripped = content.replace(/(?:^|\n)\s*\/\/[^\n]*/g, '\n');

  // 末尾必须是 ``\n      )``（6 空格缩进 + ``)``，与 ``hooks:`` 在对象里
  // 的缩进对齐）—— 单纯非贪婪 ``\s*\)`` 会被 hook builder 内嵌的 ``)`` 误命中
  // 截断（譬如 ``buildContextInjectorHook({ getAppContext: async () => ...})``
  // 里的 ``)``）。两 host 都用 6 空格 + ``)`` 结尾。
  const match = stripped.match(
    /hooks\s*:\s*composeHooks\s*\(([\s\S]*?)\n {6}\)/,
  );
  if (!match) {
    throw new Error(
      `P5: 在 ${path.relative(REPO_ROOT, filePath)} 中找不到 composeHooks(...) 调用 —— ` +
        `两 host 都应使用 \`hooks: composeHooks(capHooks, buildXxx(...), ...)\` 形态。`,
    );
  }
  const body = match[1]!;
  const hooks = new Set<string>();
  if (/\bcapHooks\b/.test(body)) hooks.add('capHooks');
  for (const m of body.matchAll(/\b(build[A-Z][A-Za-z0-9]*)\s*\(/g)) {
    hooks.add(m[1]!);
  }
  return hooks;
}

/**
 * 抓 ``getRecentRunObservations`` 接线点。返回值：
 *   - 'inline_empty' = ``async () => []`` 内联空实现（治理 07 §F.5 反例）
 *   - 'noop_handle'  = 走显式 NoOp injector handle —— 该 handle 由
 *     ``createDaemonRunObservationInjector()`` 工厂创建（Stage 4 把 inline 改成 handle）
 *   - 'real'         = 真实实现（``xxxHandle.injector``，但 handle 不来自 NoOp 工厂）
 *   - 'missing'      = 完全没接（不该发生 —— 引擎入参 optional 但两 host 都该接）
 *
 * **review P0 修**：不再硬编码变量名 ``daemonRunObservationInjector``——改成
 * "接线引用的 handle 变量是否由 ``createDaemonRunObservationInjector()`` 工厂赋值"。
 * 这样 Daemon 内部把变量改名（譬如 ``daemonRunObsHandle``）仍能正确识别为 NoOp，
 * 不会误判成 'real' 让"显式降级"治理意图悄悄失效。
 */
function classifyGetRecentRunObservations(
  filePath: string,
): 'inline_empty' | 'noop_handle' | 'real' | 'missing' {
  const content = fs.readFileSync(filePath, 'utf-8');
  // 只剥行首 ``//`` 注释，避免贪婪块注释 strip 把代码吞掉。
  const stripped = content.replace(/(?:^|\n)\s*\/\/[^\n]*/g, '\n');
  const match = stripped.match(/getRecentRunObservations\s*:\s*([^,\n]+)/);
  if (!match) return 'missing';
  const expr = match[1]!.trim();
  if (/^async\s*\(\s*\)\s*=>\s*\[\s*\]/.test(expr)) return 'inline_empty';

  // 接线形态 ``<handleVar>.injector`` —— 抽出 handle 变量名
  const handleMatch = expr.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.injector\b/);
  if (handleMatch) {
    const handleVar = handleMatch[1]!;
    // 该 handle 变量是否由 NoOp 工厂创建？扫源文件 `const <var> = createDaemonRunObservationInjector(`
    const noopFactoryAssign = new RegExp(
      String.raw`\b(?:const|let|var)\s+${handleVar}\s*=\s*createDaemonRunObservationInjector\s*\(`,
    );
    if (noopFactoryAssign.test(stripped)) return 'noop_handle';
    return 'real';
  }
  return 'missing';
}

/**
 * 显式登记的两 host hook 装配差异 + 原因。
 *
 * **当前状态（Stage 4 实施后）**：两 host 装配的 hook builder 集合**完全等价** ——
 * ``capHooks`` + ``buildContextInjectorHook`` + ``buildMemoryInjectorHook`` +
 * ``buildLspDiagnosticInjectorHook``。
 *
 * Daemon 唯一的"实质性"降级是 ``getRecentRunObservations`` 走 NoOp injector
 * （治理 07 §F.5：Daemon 无 host-side observation 源），由
 * ``classifyGetRecentRunObservations`` 单独断言。
 */
const RECONCILED_HOOK_DIFFERENCES = {
  electronOnly: new Map<string, string>([
    // 当前无差异。
  ]),
  daemonOnly: new Map<string, string>([
    // 当前无差异。
  ]),
};

describe('P5 · 双路径对称（Electron vs Daemon）', () => {
  // ：原「buildSystemPrompt 入参字段 Electron 与 Daemon 等价」测试已退役。
  //
  // 该测试靠正则扫两 host 源里的 `const systemPrompt = buildSystemPrompt({...字面量...})`
  // 抓字段集合做对称比对，用来防 Daemon 悄悄漏段漂移。#2626 把「烘焙输入 →
  // SystemPromptConfig → prompt」的装配收敛成 agent-runtime 的**唯一**
  // `assembleSystemPrompt`（两 host 都调它，字段清单只有一处），字段漂移在结构上
  // 已不可能发生——SSoT 本身即护栏，无需再用字面量对称正则兜底。段落顺序 / 关键段
  // 存在性仍由下方「Daemon 模拟入参」语义测试 + builder snapshot 覆盖。

  it('两 host 装配的 hook 列表等价（除显式登记差异外）', () => {
    const electron = extractComposeHooks(ELECTRON_HOST_PATH);
    const daemon = extractComposeHooks(DAEMON_HOST_PATH);

    const electronOnly = [...electron].filter((k) => !daemon.has(k)).sort();
    const daemonOnly = [...daemon].filter((k) => !electron.has(k)).sort();

    const undocumentedElectronOnly = electronOnly.filter(
      (k) => !RECONCILED_HOOK_DIFFERENCES.electronOnly.has(k),
    );
    const undocumentedDaemonOnly = daemonOnly.filter(
      (k) => !RECONCILED_HOOK_DIFFERENCES.daemonOnly.has(k),
    );

    if (undocumentedElectronOnly.length > 0 || undocumentedDaemonOnly.length > 0) {
      const hint: string[] = [];
      if (undocumentedElectronOnly.length > 0) {
        hint.push(
          `Electron 独有未登记 hook（Daemon 也应该装）：${undocumentedElectronOnly.join(', ')}\n` +
            `  → 改 ${path.relative(REPO_ROOT, DAEMON_HOST_PATH)} 的 composeHooks(...) 装上；` +
            `或在 RECONCILED_HOOK_DIFFERENCES.electronOnly 登记原因。`,
        );
      }
      if (undocumentedDaemonOnly.length > 0) {
        hint.push(
          `Daemon 独有未登记 hook（Electron 也应该装）：${undocumentedDaemonOnly.join(', ')}\n` +
            `  → 改 ${path.relative(REPO_ROOT, ELECTRON_HOST_PATH)} 的 composeHooks(...) 装上；` +
            `或在 RECONCILED_HOOK_DIFFERENCES.daemonOnly 登记原因。`,
        );
      }
      throw new Error(`P5 hook 对称 fail：\n${hint.join('\n')}`);
    }

    // 关键 hook 必须都在 Daemon 装配（防 Daemon 偷偷退化）
    expect(daemon.has('buildContextInjectorHook')).toBe(true);
    expect(daemon.has('buildLspDiagnosticInjectorHook')).toBe(true);
    expect(daemon.has('buildMemoryInjectorHook')).toBe(true);
    expect(daemon.has('capHooks')).toBe(true);
  });

  it('Daemon getRecentRunObservations 必须走显式 NoOp handle（不是 inline async () => []）', () => {
    const electronKind = classifyGetRecentRunObservations(ELECTRON_HOST_PATH);
    const daemonKind = classifyGetRecentRunObservations(DAEMON_HOST_PATH);

    // Electron 必须接真实 injector
    expect(electronKind, 'Electron 应该走真实的 runObservationInjectorHandle.injector').toBe('real');

    // Daemon 必须走显式 NoOp handle（治理 07 §F.5 / 99 §阶段 4 登记的降级）
    if (daemonKind === 'inline_empty') {
      throw new Error(
        `P5 fail：Daemon ``getRecentRunObservations`` 是 inline ``async () => []`` —— ` +
          `请改成 ``daemonRunObservationInjector.injector``（来自 ``createDaemonRunObservationInjector``），` +
          `让 audit 能区分"主动降级"和"漏接"。详见 ` +
          `${path.relative(REPO_ROOT, path.resolve(REPO_ROOT, 'apps/tabtin-daemon/src/agent/run-observation-injector.ts'))}。`,
      );
    }
    expect(daemonKind, 'Daemon 应走显式 NoOp handle 或真实实现').toMatch(/^(noop_handle|real)$/);
  });

  it('Daemon 模拟入参时，buildSystemPrompt 输出含 environment / apps / cli_capabilities 关键段', async () => {
    // 直接调 buildSystemPrompt 模拟 Daemon 装配链路：Django 透传 enabled_apps /
    // space_name / organization_name / cli_reference 都填满 → 关键段必须出现。
    const { buildSystemPrompt } = await import('../builder.js');
    const prompt = buildSystemPrompt({
      customRules: undefined,
      agentMode: 'agent',
      tools: MINIMAL_TOOLS,
      cliReference: '- `tabtin table list`：列出当前工作空间所有表',
      memoryCapability: true,
      userPortrait: undefined,
      runtimeIdentity: FIXED_RUNTIME_IDENTITY,
      enabledApps: FIXED_APPS,
    });

    // <environment> 段应显示人类可读名而不是裸 UUID（治理 07 §F.1 修复）
    expect(prompt).toContain('<environment>');
    expect(prompt).toContain(FIXED_RUNTIME_IDENTITY.spaceName);
    expect(prompt).toContain(FIXED_RUNTIME_IDENTITY.organizationName);

    // <apps> 段应存在且含 displayName / capability（治理 07 §F.7 修复）
    expect(prompt).toContain('<apps>');
    expect(prompt).toContain(FIXED_APPS[0]!.displayName);
    expect(prompt).toContain(FIXED_APPS[0]!.capability);

    expect(prompt).toContain('<cli_capabilities>');
    expect(prompt).toContain('tabtin table list');
  });
});

// ─── P5-Django: Django 侧 app_context / enabled_apps 透传防回归 ──────────
//
// review P0：原 P5 只扫 TS host 源（buildSystemPrompt 入参 + hooks），**不校验
// Django 一侧**。任何人改坏 prompt_forward_service.py（删形参 / 删 payload 写入
// / 删 dispatcher 透传），TS 侧 P5 全绿，但 Daemon 路径上 app_context / enabled_apps
// / space_name / organization_name 恒缺失——悄悄退回治理前（07 §F.1 / F.3 / F.7）。
//
// 本节用 readFileSync + 特征标记串校验 Django 三个文件的接线没断。这是"轻量
// grep 级"防回归（不解析 Python AST），标记串选得足够特征化避免误判。Django
// 字段语义 / 类型由 `scripts/check-agent-wire-sync.py` + Django 单测兜底；本节
// 只防"接线被整段删掉"这类回归。
const DJANGO_PROMPT_FORWARD_PATH = path.resolve(
  REPO_ROOT,
  'apps/tabtin_django/apps/services/agent_engine/services/prompt_forward_service.py',
);
const DJANGO_DISPATCHER_PATH = path.resolve(
  REPO_ROOT,
  'apps/tabtin_django/apps/services/agent_engine/engine/agent_dispatcher.py',
);
const DJANGO_FORWARD_RUNNER_PATH = path.resolve(
  REPO_ROOT,
  'apps/tabtin_django/apps/services/remote_agent/forward_runner.py',
);

describe('P5-Django · Django app_context / enabled_apps 透传防回归', () => {
  it('forward_prompt 接收 4 个 Daemon 对齐字段形参', () => {
    const src = fs.readFileSync(DJANGO_PROMPT_FORWARD_PATH, 'utf-8');
    for (const param of ['app_context', 'enabled_apps', 'space_name', 'organization_name']) {
      expect(src, `forward_prompt 应有 ${param} 形参`).toMatch(
        new RegExp(`${param}\\s*:\\s*Optional`),
      );
    }
  });

  it('forward_prompt 把投影后的 app_context + enabled_apps + 人名写入 payload', () => {
    const src = fs.readFileSync(DJANGO_PROMPT_FORWARD_PATH, 'utf-8');
    // 投影函数 + payload 写入都必须在 —— 缺任一即"接线被删"。
    expect(src).toContain('_project_app_context_for_wire');
    expect(src).toContain('payload["app_context"]');
    expect(src).toContain('payload["enabled_apps"]');
    expect(src).toContain('payload["space_name"]');
    expect(src).toContain('payload["organization_name"]');
  });

  it('derive helper 存在（enabled_apps + human-readable names + app_context 投影）', () => {
    const src = fs.readFileSync(DJANGO_PROMPT_FORWARD_PATH, 'utf-8');
    expect(src).toContain('def derive_enabled_apps_for_forward');
    expect(src).toContain('def derive_human_readable_names_for_forward');
    expect(src).toContain('def _project_app_context_for_wire');
  });

  it('dispatcher 与 forward_runner 都派生 + 透传 app_context / enabled_apps 给 forward_prompt', () => {
    for (const p of [DJANGO_DISPATCHER_PATH, DJANGO_FORWARD_RUNNER_PATH]) {
      const src = fs.readFileSync(p, 'utf-8');
      const base = path.basename(p);
      expect(src, `${base} 应调 derive_enabled_apps_for_forward`).toContain(
        'derive_enabled_apps_for_forward',
      );
      expect(src, `${base} 应调 derive_human_readable_names_for_forward`).toContain(
        'derive_human_readable_names_for_forward',
      );
      expect(src, `${base} 应透传 app_context=app_context`).toMatch(
        /app_context\s*=\s*app_context/,
      );
      expect(src, `${base} 应透传 enabled_apps=`).toMatch(/enabled_apps\s*=/);
    }
  });
});

// ─── P6: 死代码扫描（prompts/ 下 export ↔ caller / 白名单） ───────────
//
// 设计要点（阶段 2.3 实做）：
//   - 把"prompts/ 下每个 .ts 文件的 export"作为治理对象——SSoT 在源码本身；
//   - 维护一份显式 `KNOWN_LIVE_EXPORTS` 白名单，注明每条 export 的 file +
//     真实 caller 文件（相对 packages/agent-runtime/src/）；
//   - 三个 it 协同：
//       1. 源码 export 集合 = 白名单 keys 集合（防新增没注册 / 删除没移）
//       2. barrel re-export 子集 ⊆ 白名单 keys（防 barrel 暴露死 name）
//       3. 白名单声明的 caller 必须真实存在且 import 该 name（防 caller 失效）
//   - **internal-only**：少数 export 只被同文件其他活 export 内部消费
//     （譬如 INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE 被 builder .replace
//     使用），caller 字段填 `[]` + 在 note 里说明。
//
// 为什么不直接对比 SECTION_REGISTRY id：
//   - registry id 用 snake_case section id（譬如 `incremental_compact_system_prompt`），
//     prompts/ 下 export 用 SCREAMING_CASE 常量名 / camelCase builder——两者
//     根本不对齐；
//   - 同一 registry 条目常常对应"模板常量 + builder 函数"两个 export
//     （见 `incremental_compact_system_prompt` 的 writerLocations 同时指模板和 builder）；
//   - 显式白名单 + caller 校验比"自动映射"更稳，治理流程也更清晰：加新
//     prompt → 必须改 audit 白名单 → 必须 review caller 路径。

type LiveExportSpec = {
  /** 相对 prompts/ 的源文件路径。 */
  file: string;
  /**
   * 外部 caller 文件（相对 packages/agent-runtime/src/）。每个 caller 必须
   * 真实 import 本 export。空数组 = internal-only，需要在 note 里说明。
   */
  callers: string[];
  /** 备注：internal-only / 已知特殊路径 / barrel re-export 链路等。 */
  note?: string;
};

/**
 * prompts/ 下所有"已知活"的 export 全集 + 真实 caller。
 *
 * 新增 prompts/ 下任意 export 时必须同步更新本表：
 *   - 加 entry → 注明 file + caller（caller 必须真实存在并 import）；
 *   - 删 entry → 同步删源码 export；
 *   - 改 caller 路径 → 同步改 callers 字段；
 *   - 仅被同文件其他 export 内部消费 → callers `[]` + 写 note 解释。
 *
 * 三个 it 协同护栏：
 *   - 漏改 → it #1 / it #3 失败 + 给出"加哪个 entry / 删哪个 entry"提示。
 */
const KNOWN_LIVE_EXPORTS: Record<string, LiveExportSpec> = {
  // engine/ ─────────────────────────────────────────────────────────
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: {
    file: 'engine/dynamic-boundary.ts',
    callers: ['engine/types.ts'],
    note: 'types.ts 同时 re-export 给 query.ts / proxy-provider.ts 通过 engine/types 路径取用',
  },
  buildBudgetWarnNoticeContent: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },
  buildBudgetWarnSystemInjection: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },
  buildBudgetGraceNoticeContent: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },
  buildBudgetGraceSystemInjection: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },
  buildBudgetTerminateNoticeContent: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },
  buildBudgetGraceToolBlockedNoticeContent: {
    file: 'engine/budget-notices.ts',
    callers: ['engine/iteration-budget.ts'],
  },

  // compact/ ────────────────────────────────────────────────────────
  COMPACT_SYSTEM_PROMPT: {
    file: 'compact/system.ts',
    callers: ['compact/compact.ts'],
  },
  COMPACT_USER_PROMPT: {
    file: 'compact/user.ts',
    callers: ['compact/compact.ts'],
  },
  INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE: {
    file: 'compact/incremental-system.ts',
    callers: [],
    note: 'internal-only：被同文件 buildIncrementalCompactSystemPrompt() .replace() 消费；保留 export 是为了 snapshot test 锁定模板字面值 + barrel re-export 兼容历史 import 路径',
  },
  buildIncrementalCompactSystemPrompt: {
    file: 'compact/incremental-system.ts',
    callers: ['compact/compact.ts'],
    note: 'compact/incremental-prompt.ts 也 re-export 同名（保留旧 import 路径兼容）',
  },
  INCREMENTAL_COMPACT_USER_INSTRUCTION: {
    file: 'compact/incremental-user.ts',
    callers: ['compact/compact.ts'],
    note: 'compact/incremental-prompt.ts 也 re-export 同名',
  },
  JUDGE_SYSTEM_PROMPT: {
    file: 'compact/judge-system.ts',
    callers: ['compact/summary-judge.ts'],
  },
  buildJudgeUserPrompt: {
    file: 'compact/judge-user.ts',
    callers: ['compact/summary-judge.ts'],
  },
  CONTINUING_ACK: {
    file: 'compact/inline-acks.ts',
    callers: ['compact/compact.ts'],
  },
  UNDERSTOOD_ACK: {
    file: 'compact/inline-acks.ts',
    callers: ['compact/compact.ts'],
  },
  RECENT_CONVERSATION_MARKER: {
    file: 'compact/wrapper.ts',
    callers: ['compact/compact.ts'],
  },
  SUMMARY_HEADER_MARKER: {
    file: 'compact/wrapper.ts',
    callers: ['compact/compact.ts'],
  },
  buildCompactedSummaryWrapper: {
    file: 'compact/wrapper.ts',
    callers: ['compact/compact.ts'],
  },
  buildCompactFocusInstruction: {
    file: 'compact/focus.ts',
    callers: ['compact/compact.ts'],
  },
  CHUNK_TOO_LARGE_MARKER: {
    file: 'compact/fallbacks.ts',
    callers: ['compact/compact.ts'],
  },
  // 阶段 5.2 资源化：layered-prune / auto-compact 的内联兜底文案搬入 fallbacks.ts
  buildPrunePlaceholder: {
    file: 'compact/fallbacks.ts',
    callers: ['compact/layered-prune.ts'],
  },
  buildEmergencyLayeredPruneSummary: {
    file: 'compact/fallbacks.ts',
    callers: ['compact/auto-compact.ts'],
  },
  EMERGENCY_HARD_TRIM_FALLBACK: {
    file: 'compact/fallbacks.ts',
    callers: ['compact/auto-compact.ts'],
  },
  SOFT_TRIM_FALLBACK: {
    file: 'compact/fallbacks.ts',
    callers: ['compact/auto-compact.ts'],
  },
  buildRestoredFileContext: {
    file: 'compact/file-restore.ts',
    callers: ['compact/compact.ts'],
  },
  RestoredFileEntry: {
    file: 'compact/file-restore.ts',
    callers: ['compact/compact.ts'],
    note: 'type-only export（interface），caller import 形态为 `type RestoredFileEntry`',
  },
  CONTEXT_TRUNCATED_PLACEHOLDER: {
    file: 'compact/truncation-placeholder.ts',
    callers: ['compact/compact.ts'],
  },
  TIME_BASED_MC_CLEARED_MESSAGE: {
    file: 'compact/time-based-cleared.ts',
    callers: ['compact/time-based-microcompact.ts'],
  },

  // capability/ ─────────────────────────────────────────────────────
  CONVERGENCE_HINT_WARNING: {
    file: 'capability/convergence-hints.ts',
    callers: ['capability/governance/cost.ts'],
  },
  CONVERGENCE_HINT_ERROR: {
    file: 'capability/convergence-hints.ts',
    callers: ['capability/governance/cost.ts'],
  },
};

/**
 * 解析 packages/agent-runtime 包的根目录（相对本测试文件）。
 *
 * 走文件系统而非 dynamic import：audit 只读源代码，不需要 build artifact，
 * 这样在 prompts/ 还没 build 出 .js 的状态下也能跑。
 */
const PROMPT_CONTRACT_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_RUNTIME_SRC = path.resolve(
  PROMPT_CONTRACT_TEST_DIR,
  '../../../agent-runtime/src',
);
const PROMPTS_DIR = path.join(AGENT_RUNTIME_SRC, 'prompts');

/** 递归列 dir 下所有 .ts 文件，过滤 __tests__ 和 .d.ts，返回相对 baseDir 的路径。 */
function listTsFiles(dir: string, baseDir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listTsFiles(full, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path.relative(baseDir, full));
    }
  }
  return out;
}

/**
 * 抽 .ts 源文件里的"值/类型 export name"（不含 barrel re-export）。
 *
 * 匹配形态：
 *   - `export const NAME = ...`
 *   - `export function NAME(...`
 *   - `export interface NAME ...`
 *   - `export type NAME = ...`
 *   - `export let|var|class|enum NAME ...`
 *
 * **不**匹配 `export { ... } from ...`（barrel re-export 由单独 it 校验）。
 *
 * 用 regex 而非 ts-morph：保持本测试零额外依赖；prompts/ 文件 export
 * 形态简单（无 namespace / default export），regex 已够用。
 */
function extractDeclaredExports(source: string): string[] {
  const re = /^export\s+(?:const|function|interface|type|let|var|class|enum)\s+(\w+)/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.push(m[1]!);
  }
  return names;
}

/**
 * 抽 barrel 文件里的 re-export name 列表。
 *
 * 匹配形态：
 *   - `export { A, B, type C } from './x.js';`
 *   - `export {`（多行）+ `} from './x.js';`
 *
 * 不抽 `export {};`（空 barrel 占位）。
 */
function extractBarrelReexports(source: string): string[] {
  const names = new Set<string>();
  const re = /export\s*(?:type\s*)?\{([^}]+)\}\s*from\s+['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const inside = m[1]!.trim();
    if (inside.length === 0) continue;
    for (const raw of inside.split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').trim();
      if (name.length > 0) names.add(name);
    }
  }
  return [...names];
}

describe('P6 · 死代码扫描', () => {
  it('prompts/ 下所有 .ts 的 export 集合 = KNOWN_LIVE_EXPORTS 白名单 keys（防新增 export 不走治理）', () => {
    const sourceFiles = listTsFiles(PROMPTS_DIR, PROMPTS_DIR).filter(
      (rel) => !rel.endsWith('index.ts'),
    );
    const sourceExports = new Set<string>();
    for (const rel of sourceFiles) {
      const full = path.join(PROMPTS_DIR, rel);
      const text = fs.readFileSync(full, 'utf-8');
      for (const name of extractDeclaredExports(text)) {
        sourceExports.add(name);
      }
    }
    const whitelistKeys = new Set(Object.keys(KNOWN_LIVE_EXPORTS));

    const onlyInSource = [...sourceExports].filter((n) => !whitelistKeys.has(n));
    const onlyInWhitelist = [...whitelistKeys].filter((n) => !sourceExports.has(n));

    if (onlyInSource.length > 0 || onlyInWhitelist.length > 0) {
      throw new Error(
        `P6 export 集合与白名单不一致：\n` +
          `  prompts/ 源码里多出（需要加白名单或确认是死代码删掉）：\n` +
          (onlyInSource.length > 0 ? `    ${onlyInSource.join(', ')}\n` : '    (none)\n') +
          `  白名单里多出（源码已删，请同步删 KNOWN_LIVE_EXPORTS entry）：\n` +
          (onlyInWhitelist.length > 0 ? `    ${onlyInWhitelist.join(', ')}\n` : '    (none)\n') +
          `\n— 治理流程：加新 prompt 必须改本白名单 + 在 0_active_renderers.md 注册段`,
      );
    }
    expect({ onlyInSource, onlyInWhitelist }).toEqual({ onlyInSource: [], onlyInWhitelist: [] });
  });

  it('prompts/ 各 barrel (index.ts) re-export 的 name 必须在白名单中', () => {
    const barrelFiles = listTsFiles(PROMPTS_DIR, PROMPTS_DIR).filter((rel) =>
      rel.endsWith('index.ts'),
    );
    const whitelistKeys = new Set(Object.keys(KNOWN_LIVE_EXPORTS));
    const violations: string[] = [];

    for (const rel of barrelFiles) {
      const full = path.join(PROMPTS_DIR, rel);
      const text = fs.readFileSync(full, 'utf-8');
      for (const name of extractBarrelReexports(text)) {
        if (!whitelistKeys.has(name)) {
          violations.push(`${rel}: re-export "${name}" 不在白名单`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `P6 barrel re-export 含未授权 name：\n  ${violations.join('\n  ')}\n` +
          `— 治理流程：barrel 暴露的每个 name 都必须在 KNOWN_LIVE_EXPORTS 注册`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('白名单声明的每个 (export, file) 必须真实存在；每个 caller 必须 import 该 export', () => {
    const violations: string[] = [];

    for (const [name, spec] of Object.entries(KNOWN_LIVE_EXPORTS)) {
      const srcFull = path.join(PROMPTS_DIR, spec.file);
      if (!fs.existsSync(srcFull)) {
        violations.push(`${name}: 声明的源文件 prompts/${spec.file} 不存在`);
        continue;
      }
      const srcText = fs.readFileSync(srcFull, 'utf-8');
      const declared = extractDeclaredExports(srcText);
      if (!declared.includes(name)) {
        violations.push(
          `${name}: 声明源文件 prompts/${spec.file} 里没找到 \`export ... ${name}\``,
        );
      }

      // internal-only：跳过 caller 校验（spec.note 必须解释清楚）
      if (spec.callers.length === 0) {
        if (!spec.note || spec.note.trim().length === 0) {
          violations.push(
            `${name}: callers=[] 但没有 note 说明为什么是 internal-only`,
          );
        }
        continue;
      }

      for (const callerRel of spec.callers) {
        const callerFull = path.join(AGENT_RUNTIME_SRC, callerRel);
        if (!fs.existsSync(callerFull)) {
          violations.push(`${name}: caller ${callerRel} 不存在`);
          continue;
        }
        const rawText = fs.readFileSync(callerFull, 'utf-8');

        // 阶段 2 收口（review 反馈 P3 假阳性修复）：caller 校验必须匹配真实
        // import / re-export 语句，不能让"注释里提到 export 名"通过验证。
        // 这次刚清完一波"注释残留 + 活代码 import 已下线"的死代码，本规则
        // 抓的就是"以为还活但实际只剩注释"的假活路径。
        //
        // 算法：
        //   1. 剥掉所有 // 单行注释 / /* */ 块注释（避免注释里提名误判活）
        //   2. 在剥光的代码区，匹配 4 种真消费形态：
        //      a. `import { ... NAME ... } from '...'`
        //      b. `import type { ... NAME ... } from '...'`
        //      c. `export { ... NAME ... } from '...'`（re-export 算下游）
        //      d. `export type { ... NAME ... } from '...'`
        //   3. 都不命中 → 报 caller 失效
        const codeOnly = rawText
          .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
          .replace(/\/\/[^\n]*/g, ' ');       // 单行注释
        const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const importPatterns = [
          // 命中 import { foo, NAME, bar } from / import { NAME } from / 多行 import
          new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${nameEsc}\\b[^}]*\\}\\s*from`),
          // 命中 export { foo, NAME } from / export type { NAME } from（re-export）
          new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${nameEsc}\\b[^}]*\\}\\s*from`),
        ];
        const isReallyImported = importPatterns.some((re) => re.test(codeOnly));
        if (!isReallyImported) {
          violations.push(
            `${name}: caller ${callerRel} 找不到 import/re-export 真消费（仅注释提名不算 — 抓"注释残留但实际 import 已删"的假活路径）`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `P6 caller 校验失败：\n  ${violations.join('\n  ')}\n` +
          `— 治理流程：caller 失效请同步改 KNOWN_LIVE_EXPORTS.<name>.callers 字段`,
      );
    }
    expect(violations).toEqual([]);
  });
});
