/**
 * P7 工具硬契约 + P2 字符上限审计 —— 阶段 6 实做（2026-05-21）
 *
 * **职责**：把 agent-runtime 包内所有工厂吐出来的工具收齐，对每个工具的
 * `description` 字段做两道校验：
 *
 *   - P2 字符上限：`description.length` ≤ `SECTION_REGISTRY[id].charBudget`
 *     —— 防"教学型内容回潮"，让阶段 6 治理的瘦身能锁住。
 *   - P7 硬契约关键词：high-risk 工具必须按 `HARD_CONTRACT_KEYWORDS` 中
 *     登记的主题分组覆盖（每个 topic 至少命中 1 个同义词）。
 *
 * **为什么放在 agent-runtime 包**：
 *   - 工具实现都在 `@tabtin/agent-runtime`，P7 必须 import 工厂取 description。
 *   - `@tabtin/agent-prompt::audit.test.ts` 的 P7 留作占位（agent-prompt
 *     不能 build 工具）。两包 audit 形成"基线段 + 工具段"双护栏。
 *
 * **不覆盖什么**：
 *   - `mcp_call_tool`（host-side，住在 apps/tabtin-electron 里，runtime 不出
 *     这个工具的实例）—— 由 host 侧后续 audit 覆盖，本测试只校验它在注册表
 *     里登记齐全。
 *   - `read_diagnostics` / `kill_terminal_session` 等已下线工具 —— 不在注册表
 *     登记，工厂也不导出，audit 不参与。
 *
 * **失败时的错误信息**：
 *   每个 it.each 报错都明示 "工具名 + 当前长度 + 预算 + 缺哪条硬契约"，
 *   遵循 99 阶段 6 "测试错误信息要能指出哪个 tool、当前长度、预算、缺哪个关键契约"
 *   的硬要求。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  REGISTRY_ENTRIES,
  HARD_CONTRACT_KEYWORDS,
  DEPRECATED_PARAM_TERMS,
  checkToolHardContract,
  checkSectionCharBudget,
  checkLanguageDiscipline,
  checkNoDeprecatedTerms,
  collectInputSchemaFieldDescriptions,
  checkFieldCharBudget,
  checkFieldLanguageDiscipline,
} from '@tabtin/prompt-contract';
import type { SectionDescriptor } from '@tabtin/prompt-contract';
import { unimplementedPtyManagerBridge } from '@tabtin/terminal-core';

import type {
  Tool,
} from '../../engine/contracts/tools.js';
import { loadCreateTabCodeTools } from '../../../tests/fixtures/load-tabcode-tools.js';
// ：data-tools / document-tools 已迁宿主业务工具包，其描述审计随之迁到宿主侧。
import { createWebTools } from '../web-tools.js';
import { createPresentationTools } from '../presentation-tools.js';
import { createCoreTools } from '../core-tools.js';
import { createSkillsTools } from '../skills-tools.js';
import { createSkillCreateTool } from '../skill-create-tool.js';
import { createPlanTools } from '../plan-tools.js';
import { createSystemTools } from '../system-tools.js';
import { ShellCap } from '../../capability/core/shell.js';
import { RawRefCap } from '../../capability/core/raw-ref.js';
import { PlatformDataCap } from '../../capability/core/platform-data.js';
import { createAgentTool } from '../../subagent/agent-tool.js';
import type { AgentToolConfig } from '../../subagent/agent-tool.js';
import { allowAllHardlineChecker } from '../../../tests/helpers/hardline-checker.js';

// ─── 工具收集（仿照宿主装配路径，给每个工厂尽量轻的 mock deps）─────────

const fakeApiDeps = {
  apiBaseUrl: 'http://audit-fixture',
  apiAuthToken: 'audit-token',
  organizationId: 'organization-audit',
  spaceId: 'space-audit',
  sessionId: 'session-audit',
};

// SkillsToolsDeps 实际接口只有 getSkill / search（review B6：删 `list` 假字段）
const fakeSkillsDeps = {
  getSkill: () => undefined,
  search: () => [],
};

/**
 * 把所有 agent-runtime 包内的工厂吐出来的工具收齐。
 *
 * 顺序对齐 ElectronAgentHost / DaemonAgentHost 装配顺序，让 audit 与生产
 * 装配 1:1 对照。
 *
 * **lazy 求值（review B1 修复）**：原 module-load 期立刻调；任一工厂在 import
 * 期改成 throw（譬如未来加 `if (!deps.X) throw`）就会让整个 test 文件 load fail，
 * 错误信息淹没真正问题。现在装配挪到 beforeAll 内，单个工厂报错 vitest 给清晰
 * "beforeAll hook failed in"。
 */
async function collectAllRuntimeTools(): Promise<Tool[]> {
  const cap = new ShellCap({
      checkHardlineCommand: allowAllHardlineChecker, ptyManagerBridge: unimplementedPtyManagerBridge });
  // read_raw_ref 住在 capability 层（RawRefCap.tools()），不是 createXxxTools
  // 工厂——audit fixture 须显式实例化 RawRefCap 注册其工具，否则 P7-α 双向
  // 对齐会报"read_raw_ref 在 collectAllRuntimeTools 未吐出"（ 子问题 2）。
  // config 给 fake 值即可——audit 全程不调 execute，只读 name/description/inputSchema。
  const rawRefCap = new RawRefCap({
    toolLogsDir: '/tmp/tabtin-audit-fake-tool-logs',
    sessionId: 'tabtin-audit-fake-session',
  });
  const platformDataCap = new PlatformDataCap({
    archiveDir: '/tmp/tabtin-audit-fake-sessions',
    toolLogsDir: '/tmp/tabtin-audit-fake-tool-logs',
    archiveSessionId: 'tabtin-audit-fake-session',
    toolLogsSessionId: 'tabtin-audit-fake-session',
  });
  const createTabCodeTools = await loadCreateTabCodeTools();
  return [
    ...cap.tools(),
    ...platformDataCap.tools(),
    ...rawRefCap.tools(),
    ...createTabCodeTools({}),
    ...createCoreTools({}),
    ...createWebTools(fakeApiDeps),
    ...createPresentationTools({
      supportedResourceTypes: new Set(['table', 'doc', 'slide', 'video', 'site', 'tracker']),
      autoOpenPolicy: (t) => t !== 'slide',
    }),
    ...createSkillsTools(fakeSkillsDeps),
    createSkillCreateTool({ writeSkill: async () => 'fake' }),
    // ：planStore 必填注入（HTTP TabDocPlanStore 已迁宿主）；
    // audit 只读 name/description/schema，用最小 mock 即可。
    ...createPlanTools({
      planStore: {
        kind: 'file',
        create: async () => ({ ok: false as const, result: { content: '', isError: true } }),
        updateTodos: async () => ({ ok: false as const, result: { content: '', isError: true } }),
      },
      threadId: fakeApiDeps.sessionId,
    }),
    ...createSystemTools({ relaunchApp: async () => undefined }),
    // agent_tool 工厂签名重，只读 name + description 字段时用 cast 桩
    // 注入；audit 全程不会调 execute。
    createAgentTool({
      provider: null,
      tools: null,
      permissionHandler: null,
      sessionConfig: null,
      model: 'audit-fixture',
    } as unknown as AgentToolConfig),
  ];
}

// lazy holders —— beforeAll 在 P1 测试块前装配
let ALL_RUNTIME_TOOLS: Tool[] = [];
let TOOL_BY_NAME: Map<string, Tool> = new Map();

beforeAll(async () => {
  ALL_RUNTIME_TOOLS = await collectAllRuntimeTools();
  TOOL_BY_NAME = new Map(ALL_RUNTIME_TOOLS.map((t) => [t.name, t]));
});

/** 注册表里所有 tool_description 类 entry。 */
const TOOL_REGISTRY_ENTRIES = REGISTRY_ENTRIES.filter(
  (e) => e.category === 'tool_description',
);

/**
 * Host-side 工具（住在 apps/，runtime 不出实例）—— audit 跳过 description 校验。
 *
 * **B3 review 修**：用 SectionDescriptor.source 字段派生（已有 SSoT），
 * 不再硬编码 ['mcp_call_tool_tool']。新增 host-side 工具时只要在
 * 0_active_renderers.md 把 source 设为 `host`，audit 自动豁免。
 */
const HOST_SIDE_TOOL_IDS = new Set(
  TOOL_REGISTRY_ENTRIES.filter((e) => e.source === 'host').map((e) => e.id),
);

// ─── P7-α: 注册表↔工厂双向对齐 ─────────────────────────────────────────

describe('P7-α · 注册表↔工厂双向对齐（runtime 工具）', () => {
  it('注册表中所有 tool_description (除 host-side) 都能在 runtime 工厂找到', () => {
    const missing: string[] = [];
    for (const entry of TOOL_REGISTRY_ENTRIES) {
      if (HOST_SIDE_TOOL_IDS.has(entry.id)) continue;
      const toolName = entry.id.endsWith('_tool')
        ? entry.id.slice(0, -'_tool'.length)
        : entry.id;
      if (!TOOL_BY_NAME.has(toolName)) {
        missing.push(`${entry.id} (期望工厂吐出 name='${toolName}')`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `P7-α 注册表↔工厂不对齐——下列 entry 注册表登记但工厂不吐出：\n  ${missing.join('\n  ')}\n` +
          `\n— 治理流程：要么删注册表 entry（工具已下线），要么补回工厂导出，` +
          `要么把它加进 HOST_SIDE_TOOL_IDS（住在 apps/ 而非 agent-runtime）。`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('工厂吐出的所有工具都在注册表登记（防新增工具不走治理）', () => {
    const registryToolNames = new Set(
      TOOL_REGISTRY_ENTRIES.map((e) =>
        e.id.endsWith('_tool') ? e.id.slice(0, -'_tool'.length) : e.id,
      ),
    );
    const orphans: string[] = [];
    for (const t of ALL_RUNTIME_TOOLS) {
      if (!registryToolNames.has(t.name)) {
        orphans.push(t.name);
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        `P7-α 工厂↔注册表不对齐——下列工具工厂吐出但注册表无 entry：\n  ${orphans.join(', ')}\n` +
          `\n— 治理流程：每个新工具必须在 ` +
          `0_active_renderers.md TASK_C_TOOLS_START 块下登记，然后跑 ` +
          `extract_renderers.py 重新生成 registry-entries.generated.ts。`,
      );
    }
    expect(orphans).toEqual([]);
  });
});

// ─── P7-α2: 退役名单 ↔ 在役 registry 防漂移─────────────
//
// proxy-provider 出口净化 / select-recent-history 入口净化的「退役工具名」
// 名单命中即把历史 tool_call name 改写（退役名 → unknown_tool）。若名单误含
// 在役工具名，模型每轮都会看到「自己调了 unknown_tool 却成功了」的假历史，
// 陷入纠错死循环（ 实测：write_file 同 input 11 连发，烧 13 分钟直到
// 用户手动 abort）。这里断言两份名单与全量在役工厂工具名交集为空。

describe('P7-α2 · 退役工具名名单不得含在役工具名（ 防漂移）', () => {
  it('proxy-provider RETIRED_MESSAGE_TOOL_NAMES ∩ 在役工具 = ∅', async () => {
    const { RETIRED_MESSAGE_TOOL_NAMES } = await import(
      '../../providers/proxy-provider.js'
    );
    const live = [...RETIRED_MESSAGE_TOOL_NAMES].filter((n) => TOOL_BY_NAME.has(n));
    if (live.length > 0) {
      throw new Error(
        `RETIRED_MESSAGE_TOOL_NAMES 含在役工具名：${live.join(', ')}\n` +
          `— 出口净化会把这些工具的历史调用改写成 unknown_tool，模型会陷入` +
          `纠错死循环。工具复活时必须同步从退役名单移除。`,
      );
    }
    expect(live).toEqual([]);
  });

  it('select-recent-history RETIRED_CURRENT_TOOL_NAMES ∩ 在役工具 = ∅', async () => {
    const { RETIRED_CURRENT_TOOL_NAMES } = await import(
      '../../history/select-recent-history.js'
    );
    const live = [...RETIRED_CURRENT_TOOL_NAMES].filter((n) => TOOL_BY_NAME.has(n));
    if (live.length > 0) {
      throw new Error(
        `RETIRED_CURRENT_TOOL_NAMES 含在役工具名：${live.join(', ')}\n` +
          `— 入口净化会把这些工具的历史 ToolUseBlock.name 改写成 unknown_tool，` +
          `模型会陷入纠错死循环。工具复活时必须同步从退役名单移除。`,
      );
    }
    expect(live).toEqual([]);
  });
});

// ─── P7-β: 高风险工具必须在 HARD_CONTRACT_KEYWORDS 登记 ──────────────

describe('P7-β · high-risk 工具必须在 HARD_CONTRACT_KEYWORDS 登记硬契约 topics', () => {
  it('每个 tier=high-risk 的注册表 entry 都在 HARD_CONTRACT_KEYWORDS 中（host-side 除外）', () => {
    const missing: string[] = [];
    const hostSideSkipped: string[] = [];
    for (const entry of TOOL_REGISTRY_ENTRIES) {
      if (entry.tier !== 'high-risk') continue;
      // host-side 工具（mcp_call_tool 等）description 住在 apps/ 仓库，
      // runtime audit 拿不到工厂实例 —— 不要求登记 topics；交 host audit 后续接入。
      if (HOST_SIDE_TOOL_IDS.has(entry.id)) {
        hostSideSkipped.push(entry.id);
        continue;
      }
      if (!HARD_CONTRACT_KEYWORDS[entry.id]) {
        missing.push(entry.id);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `P7-β 高风险工具未登记硬契约——下列 entry tier=high-risk 但 ` +
          `HARD_CONTRACT_KEYWORDS 中无对应 topics：\n  ${missing.join('\n  ')}\n` +
          `（已豁免 host-side：${hostSideSkipped.join(', ') || '(none)'}）\n` +
          `\n— 治理流程：在 packages/prompt-contract/src/audit-helpers.ts 的 ` +
          `HARD_CONTRACT_KEYWORDS 里加 entry，按主题（譬如"参数 / 失败处理 / ` +
          `禁交互" 等）登记同义词组，让 LLM 即使不读 skill 也能拿到底线行为约束。`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('host-side 工具不应登记 HARD_CONTRACT topics（review A2：避免登记了但 audit 不查的最差状态）', () => {
    const orphans: string[] = [];
    for (const id of HOST_SIDE_TOOL_IDS) {
      if (HARD_CONTRACT_KEYWORDS[id]) {
        orphans.push(id);
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        `P7-β host-side 工具不应登记 HARD_CONTRACT_KEYWORDS topics：\n  ${orphans.join('\n  ')}\n` +
          `\n— host-side 工具（source='host'）住在 apps/ 仓库，runtime P7 主校验拿不到工厂实例。` +
          `登记了 topics 但 P7 跳过 = 让维护者误以为有保护，实际治理黑洞。` +
          `\n— 治理动作：删 audit-helpers.ts::HARD_CONTRACT_KEYWORDS 中对应 entry；` +
          `host audit 后续接入时再独立登记 host-side 版本。`,
      );
    }
    expect(orphans).toEqual([]);
  });
});

// ─── P2 + P3 + P7 主校验：对每个非 host-side 工具单独跑 ────────────────
//
// **lazy 友好（review B1 修）**：AUDITABLE_ENTRIES 不再 filter TOOL_BY_NAME，
// 因为 TOOL_BY_NAME 在 beforeAll 才装配；module load 期 filter 会让 it.each
// 拿到空数组，vitest 报 "No test found in suite"。改成：所有非 host-side
// 注册表 entry 都进 case 集合；P2/P7 case 执行时如果工厂缺工具，throw
// 清晰错误（与 P7-α 的"双向对齐"互为兜底护栏）。

const AUDITABLE_ENTRIES: ReadonlyArray<readonly [string, SectionDescriptor]> =
  TOOL_REGISTRY_ENTRIES
    .filter((e) => !HOST_SIDE_TOOL_IDS.has(e.id))
    .map((e) => [e.id, e] as const);

/** 取工具名 + 工厂实例的统一 helper。工厂缺 throw 清晰错误。 */
function resolveTool(descriptor: SectionDescriptor): { toolName: string; tool: Tool } {
  const toolName = descriptor.id.endsWith('_tool')
    ? descriptor.id.slice(0, -'_tool'.length)
    : descriptor.id;
  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) {
    throw new Error(
      `工具 ${toolName} 在 collectAllRuntimeTools 未吐出 —— 详见 P7-α 双向对齐失败信息。`,
    );
  }
  return { toolName, tool };
}

describe('P2 · 工具 description 实际长度 ≤ charBudget', () => {
  it.each(AUDITABLE_ENTRIES)(
    '%s: 长度 ≤ charBudget',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const desc = tool.description ?? '';
      const r = checkSectionCharBudget(descriptor, desc);
      if (!r.ok) {
        throw new Error(
          `P2 字符上限超标：\n` +
            `  工具：${toolName} (${descriptor.id}, tier=${descriptor.tier})\n` +
            `  当前长度：${r.actual} 字符\n` +
            `  预算：${r.budget} 字符（${descriptor.tier === 'high-risk' ? 'high-risk ≤1500' : descriptor.tier === 'medium' ? 'medium ≤1200' : 'low-risk ≤500'}）\n` +
            `  超出：${r.actual - r.budget} 字符\n` +
            `\n— 治理动作：把教学型内容（参数细节展开 / 性能调优 / 边角案例）` +
            `搬到 skill，description 只留硬契约。详见 99 阶段 6.1 三层分工表。`,
        );
      }
      expect(r.ok).toBe(true);
    },
  );
});

describe('P2-uniqueness · 系统策略不在工具描述中重复或改写', () => {
  it('web_search 不自行定义猜测官网的安全降级策略', () => {
    const desc = TOOL_BY_NAME.get('web_search')?.description ?? '';
    expect(desc).toContain('用 offset 翻页');
    expect(desc).toContain('加 site: 限定');
    expect(desc).not.toMatch(/直接猜|猜.*官网域名/);
  });

  it('web_search 工具描述承载高级查询操作符表格', () => {
    const desc = TOOL_BY_NAME.get('web_search')?.description ?? '';
    expect(desc).toContain('高级语法仅限下表');
    expect(desc).toContain('运行时不解析');
    expect(desc).toContain('提供方可能透传或截断');
    expect(desc).toContain('| 写法 | 用途 | 示例 |');
    expect(desc).toContain('|---|---|---|');
    for (const example of [
      '"connection refused"', '苹果 -手机 -电脑', 'React OR Vue',
      'site:github.com electron ipc', '大模型安全 filetype:pdf',
      'intitle:"system design" cache', 'inurl:docs websocket',
      'OpenAI before:2024-01-01', 'React after:2025-01-01',
      '机械键盘 500..1000 元', '"the * of software design"',
    ]) {
      expect(desc).toContain(example);
    }
  });

  it('web_search 的 search_term 描述限定高级查询操作符且声明提供方边界', () => {
    const schema = TOOL_BY_NAME.get('web_search')?.inputSchema as {
      properties?: { search_term?: { description?: string } };
    } | undefined;
    const description = schema?.properties?.search_term?.description ?? '';
    expect(description).toContain('高级语法仅限');
    expect(description).toContain('site:/filetype:/intitle:/inurl:');
    expect(description).toContain('运行时不解析');
    expect(description).toContain('提供方可能透传或截断');
    expect(description).toContain('各提供方支持不一');
    expect(description).toContain('勿扩展或承诺精确生效');
    expect(description).not.toContain('| 写法 | 用途 | 示例 |');
  });

  it('ask_user 不重复系统提示词中的协作节奏', () => {
    const desc = TOOL_BY_NAME.get('ask_user')?.description ?? '';
    expect(desc).toContain('2-4 个具体选项');
    expect(desc).not.toContain('答案能从上下文合理推断时');
    expect(desc).not.toContain('简单 yes/no 用自然语言问');
  });

  it('todo 只保留生命周期协议，不重复任务复杂度策略', () => {
    const desc = TOOL_BY_NAME.get('todo')?.description ?? '';
    expect(desc).toContain('action=open/add/update/remove/close');
    expect(desc).toContain('open 带 items[]');
    expect(desc).toContain('参数：action；items；id；content；status');
    expect(desc).not.toContain('简单单步或闲聊不要用');
    expect(desc).not.toContain('completed 项不可再改');
    expect(desc).not.toContain('新计划必须先 close 再 open');
  });

  it('agent 只描述上下文隔离和调用协议，不重复 fork 决策策略', () => {
    const desc = TOOL_BY_NAME.get('agent')?.description ?? '';
    expect(desc).toContain('子 Agent 看不到父对话历史');
    expect(desc).toContain('resume_agent_id');
    expect(desc).not.toContain('何时 fork');
    expect(desc).not.toContain('何时不 fork');
  });

  it('run_terminal_command 不重复子 Agent 编排策略', () => {
    const desc = TOOL_BY_NAME.get('run_terminal_command')?.description ?? '';
    expect(desc).toContain('full_output_path');
    expect(desc).not.toContain('可派子 Agent');
  });

  it('read_file 不重复子 Agent 编排策略', () => {
    const desc = TOOL_BY_NAME.get('read_file')?.description ?? '';
    expect(desc).toContain('完整读取两信号');
    expect(desc).not.toContain('可派子 Agent');
  });

  it('delete_file 不教授绕过单文件边界的递归删除命令', () => {
    const desc = TOOL_BY_NAME.get('delete_file')?.description ?? '';
    expect(desc).toContain('目录路径会被拒绝');
    expect(desc).not.toContain('rm -rf');
  });
});

// ─── P3 · 语言纪律（runtime 工具 description）─────────────────────────
//
// review G7 修：工具 description 之前只在 agent-prompt 包内做 P3 校验，
// agent-runtime 包内的工具 description 没覆盖。如果 run_terminal_command
// description 被改成大段英文（语种声明 zh 但实写 en），audit 不抓。

describe('P3 · 工具 description 实际语言与 descriptor.language 一致', () => {
  it.each(AUDITABLE_ENTRIES)(
    '%s: detectLanguage 与 descriptor.language 一致',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const desc = tool.description ?? '';
      const r = checkLanguageDiscipline(descriptor, desc);
      if (!r.ok) {
        throw new Error(
          `P3 语言纪律违规：\n` +
            `  工具：${toolName} (${descriptor.id})\n` +
            `  declared=${r.declared}，detected=${r.detected}\n` +
            (r.hasException
              ? `  有 languageExceptionReason\n`
              : `  无 languageExceptionReason\n`) +
            `\n— 治理动作：${
              r.declared === 'en' && !r.hasException
                ? 'descriptor.language="en" 必须填 languageExceptionReason 给模型对比测试报告路径'
                : '把 description 调整为符合声明语言；或在 0_active_renderers.md 改 language + reason 后跑 extract_renderers.py'
            }`,
        );
      }
      expect(r.ok).toBe(true);
    },
  );
});

describe('P7 · high-risk 工具 description 必须覆盖所有硬契约 topics', () => {
  const highRiskEntries = AUDITABLE_ENTRIES.filter(
    ([, d]) => d.tier === 'high-risk',
  );

  it.each(highRiskEntries)(
    '%s: 硬契约 topics 全覆盖',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const desc = tool.description ?? '';
      const r = checkToolHardContract(descriptor, desc);

      if (!r.applicable) {
        // 高风险但未登记 topics —— 已被 P7-β 抓住，这里跳过
        return;
      }
      if (!r.ok) {
        const missingFmt = r.missingTopics
          .map(
            (t) =>
              `      · ${t.name}：缺关键词组 [${t.keywords.map((k) => `"${k}"`).join(' | ')}]`,
          )
          .join('\n');
        throw new Error(
          `P7 硬契约缺失：\n` +
            `  工具：${toolName} (${descriptor.id}, tier=high-risk)\n` +
            `  当前长度：${r.actualLength} 字符 / 预算 ${r.budget}\n` +
            `  缺失的硬契约 topics（每条至少要命中一个同义词）：\n${missingFmt}\n` +
            `\n— 治理动作：把缺失的硬契约用同义词写回 description；` +
            `如果觉得某 topic 不该是硬契约，在 packages/prompt-contract/src/` +
            `audit-helpers.ts 的 HARD_CONTRACT_KEYWORDS 删除对应 topic 并给理由` +
            `（通常需要 PM / 设计师确认）。`,
        );
      }
      expect(r.missingTopics).toEqual([]);
    },
  );
});

// ─── P7-γ · 反向 audit：LLM 可见字符串禁含废弃参数名 ─────────────────
//
// 2026-05-21 review 第三轮抓的真生产 bug：tool description 改了，但 envelope
// hint / inputSchema field description / 跨工具决策段（sections.ts）等其他
// LLM 可见字符串还在用 2026-05-18 重构前的 `run_in_background` /
// `background_task_id`。LLM 看到 hint 会照着传废弃参数，被 schema 静默忽略
// 走默认行为。
//
// 本 audit 扫两层（注释 / 测试 / TS 类型不算 LLM 可见，**不**豁免代码内 hint）：
//   1. tool.description 字段（与 P2/P7 同 fixture，覆盖每个工厂工具）
//   2. inputSchema.properties.<field>.description（递归扫描所有 string 类型
//      的 description 字段）
//
// 运行时 envelope hint（jsonError 第二参数 hint 字段）由 shell.test.ts 反向
// 断言覆盖（per-trigger，譬如 sleep block / unknown session）—— 这里不直接
// trigger 错误路径，避免 audit 跟动态行为耦合。
//
// 字段 description 路径化抽取由 prompt-contract 的
// `collectInputSchemaFieldDescriptions` 提供（与本文件历史上的本地版语义等价
// 但带字段路径，便于 P2-field / P3-field audit 报错定位）。

// ─── P2-aggregate · tools[] 真实 description 合计上限 ───────────────────
//
// **2026-05-21 阶段 6 议题 3 第二次过渡阈值调整 —— 口径修正**：
//
// 之前 P2-aggregate 只数工具自身 `tool.description` 字段（≈11622 chars），给
// 维护者"还差 1622 chars 就达治理目标"的错误"接近达标"信号。
//
// 真相：LLM 调用工具时**还看 inputSchema.properties.<field>.description**
// （136 个字段合计 ≈10767 chars，与工具自身合计同量级）。LLM 真实视野是
// **工具 desc + 字段 desc ≈ 22389 chars**，距离治理目标 ≤10000 还差 12389
// chars，不是 1622。
//
// 修法（阶段 6 议题 3）：
//   - P2-aggregate 计算口径改为 `tool.description.length + 所有字段 desc.length`
//   - 治理目标 ≤10000 → ≤15000（按"LLM 真实视野"重算）
//   - 过渡阈值 12000 → 22500（按当前实测 ≈22389 + 5% 余量）
//   - 99 §1056 同步记录"第二次过渡阈值调整"原因 + 路径
//
// **绝不允许调高阈值让测试过** —— AGGREGATE_MAX_CHARS_TRANSITION 是治理过程
// 值，只许往下调（每次工具描述治理 / 字段瘦身后下调）。
//
// dump-prompt --format=registry-summary 是 fixture 跨工具相对参考，不是合规
// 依据；本断言用 collectAllRuntimeTools 拿真实工厂数据求和。

/**
 * 当前可达的过渡阈值。**治理过程值，不是目标值**。
 *
 * 历史路径：
 *   - 2026-05-21 阶段 6 议题 3 第二次过渡阈值调整：从 12000（仅工具 desc）→
 *     22500（口径含字段 desc 合计）。口径修正同时把字段瘦身做了，实测
 *     descOnly=11622 + fieldsOnly=5656 = total 17278。
 *   - 2026-05-21 阶段 6 议题 3 收口：字段瘦身收益记在过渡阈值里 → 22500 → 17500。
 *   - 2026-05-21 阶段 6 议题 1 治理调整（第三次）：从 17500 → 21000。
 *     **不是放松治理纪律**——议题 1 删 `<ask_user_tools_usage>` (1693 字) +
 *     `<skills_usage>` (3110 字) 两段（共 4803 字），把内容下沉到 ask 三件套 +
 *     skills 4 个工具说明书（消除"段一份 + 工具一份"两份出入造成的 Agent 决策
 *     混淆，跟 6.1 / 6.2 "硬契约必须留在 description" 同方向）。
 *     P2-aggregate 视角看是 tools[] 涨 ~2700（17278 → 20209），但 system 总长
 *     视角看是节省 ~2100（段省了 4803，工具涨了 2700）。这是消除重复带来的
 *     净改善，不是治理失败。详见 99 §6.7。
 *
 * 升级路径：每次字段 / 工具描述瘦身后**把这个数字往下调**（带 PR commit
 * 证据 + 99 文档 evidence 行号同步），治理到 15000 时切换为目标硬断言。
 * **绝不允许调高让测试过** —— 由 audit case "AGGREGATE_MAX_CHARS_TRANSITION
 * 不允许调高让测试过（治理纪律线）" 守门；只在**显式产品取舍**（如议题 1 的
 * 消除重复）+ **99 文档同步说明** 时方可上调。
 */
const AGGREGATE_MAX_CHARS_TRANSITION = 21_000;
const AGGREGATE_TARGET_CHARS = 15_000;

/**
 * 计算单个工具对 LLM 视野的字符消耗：`tool.description + 所有 inputSchema 字段 description` 合计。
 *
 * **不去重 / 不裁空白** —— 与 LLM 实际看到的 token 一致；空白也是 token。
 * 单字符花费每次 LLM 调用都付，aggregate 与 LLM 视野 1:1 对应。
 */
function totalToolVisibleChars(t: import('../../engine/contracts/tools.js').Tool): number {
  const descChars = (t.description ?? '').length;
  const fieldChars = collectInputSchemaFieldDescriptions(t.inputSchema).reduce(
    (acc, f) => acc + f.text.length,
    0,
  );
  return descChars + fieldChars;
}

describe('P2-aggregate · tools[] 真实 description + 字段 description 合计 ≤ 过渡阈值（治理目标 ≤15000）', () => {
  it('合计字符 ≤ 过渡阈值（含 tool.description + inputSchema 字段 desc）', () => {
    let totalChars = 0;
    const items: { name: string; descChars: number; fieldChars: number; total: number }[] = [];
    for (const t of ALL_RUNTIME_TOOLS) {
      const descChars = (t.description ?? '').length;
      const fieldChars = collectInputSchemaFieldDescriptions(t.inputSchema).reduce(
        (acc, f) => acc + f.text.length,
        0,
      );
      const total = descChars + fieldChars;
      totalChars += total;
      items.push({ name: t.name, descChars, fieldChars, total });
    }
    items.sort((a, b) => b.total - a.total);

    if (totalChars > AGGREGATE_MAX_CHARS_TRANSITION) {
      const top10 = items
        .slice(0, 10)
        .map(
          (i) =>
            `      ${i.name.padEnd(28)} total=${i.total} (desc=${i.descChars} + fields=${i.fieldChars})`,
        )
        .join('\n');
      throw new Error(
        `P2-aggregate tools[] 合计（含字段 desc）超过过渡阈值：\n` +
          `  当前合计：${totalChars} chars（${ALL_RUNTIME_TOOLS.length} 工具，含 inputSchema 字段 desc）\n` +
          `  当前过渡阈值：${AGGREGATE_MAX_CHARS_TRANSITION}（应逐步降至 ≤${AGGREGATE_TARGET_CHARS} 目标）\n` +
          `  超出：${totalChars - AGGREGATE_MAX_CHARS_TRANSITION} chars\n` +
          `  消耗 top-10 工具（含 tool desc + 字段 desc）：\n${top10}\n` +
          `\n— 治理动作：单字段瘦身（譬如 wait_ms / pattern / hard_timeout_ms / clear_os_error_blacklist.path）/ ask 三件套指针化 / 教学型内容搬 envelope hint。\n` +
          `  **禁止"调高过渡阈值"让测试过** —— AGGREGATE_MAX_CHARS_TRANSITION 是治理过程值，只许往下调。`,
      );
    }
    expect(totalChars).toBeLessThanOrEqual(AGGREGATE_MAX_CHARS_TRANSITION);
  });

  it('过渡阈值与目标差距 < 10000（防过渡阈值脱钩太远忘记治理）', () => {
    expect(AGGREGATE_MAX_CHARS_TRANSITION - AGGREGATE_TARGET_CHARS).toBeLessThan(10_000);
  });

  it('AGGREGATE_MAX_CHARS_TRANSITION 不允许调高让测试过（治理纪律线）', () => {
    // 提醒未来维护者：要调高这个常量必须在 99 文档新增一条"第 N 次过渡阈值调整"
    // 说明 + 给出量化依据。
    // 阶段 6 议题 3 收口后锁定 17500；议题 1 收口（消除 2 段重复，内容下沉到工具
    // 说明书）显式上调到 21000——是产品取舍换治理纪律，不是放松。后续工具描述
    // 瘦身只许往下。
    expect(AGGREGATE_MAX_CHARS_TRANSITION).toBeLessThanOrEqual(21_000);
  });

  it('totalToolVisibleChars helper 与 collectAllRuntimeTools 加总一致（防漂移）', () => {
    // 重复算一次但走 helper 路径，确保 helper 与 in-test 加总语义一致
    const viaHelper = ALL_RUNTIME_TOOLS.reduce(
      (acc, t) => acc + totalToolVisibleChars(t),
      0,
    );
    const viaLocal = ALL_RUNTIME_TOOLS.reduce((acc, t) => {
      const descChars = (t.description ?? '').length;
      const fieldChars = collectInputSchemaFieldDescriptions(t.inputSchema).reduce(
        (a, f) => a + f.text.length,
        0,
      );
      return acc + descChars + fieldChars;
    }, 0);
    expect(viaHelper).toBe(viaLocal);
  });
});

// ─── P2-field · 单字段 description 长度上限（tier-aware）─────────────
//
// 2026-05-21 阶段 6 议题 3 收口：tool.description 已治理过，字段 description
// 还没。LLM 调工具时 schema 字段 description 也强制读，必须同步治理。
//
// 政策（hard-coded in audit-helpers.ts::getFieldBudget）：
//   - high-risk 工具关键字段（命中 HARD_CONTRACT 关键词）≤ 300
//   - high-risk 工具其他字段 ≤ 200
//   - medium / low-risk 工具任一字段 ≤ 150
//
// **不允许"调高 budget 让测试过"** —— 把教学性内容搬到 envelope hint
// （shell.ts:870-895 jsonError hint 机制）或 skill；L1 字段 description 只
// 留必读硬契约。

describe('P2-field · inputSchema 单字段 description ≤ tier-aware budget', () => {
  it.each(AUDITABLE_ENTRIES)(
    '%s: 每个字段长度 ≤ tier 对应 budget',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const fields = collectInputSchemaFieldDescriptions(tool.inputSchema);
      const tier = (descriptor.tier ?? 'low-risk') as
        | 'high-risk'
        | 'medium'
        | 'low-risk';

      const violations: {
        path: string;
        actual: number;
        budget: number;
        isKey: boolean;
        preview: string;
      }[] = [];
      for (const f of fields) {
        const r = checkFieldCharBudget(descriptor.id, tier, f.path, f.text);
        if (!r.ok) {
          violations.push({
            path: f.path,
            actual: r.actual,
            budget: r.budget,
            isKey: r.isKeyField,
            preview: f.text.slice(0, 80).replace(/\s+/g, ' '),
          });
        }
      }
      if (violations.length > 0) {
        const fmt = violations
          .map(
            (v) =>
              `      · ${v.path} (${v.actual} > ${v.budget}${v.isKey ? ', 关键字段' : ''}): "${v.preview}..."`,
          )
          .join('\n');
        throw new Error(
          `P2-field 字段超 budget：\n` +
            `  工具：${toolName} (${descriptor.id}, tier=${tier})\n` +
            `  超 budget 字段：\n${fmt}\n` +
            `\n— 治理动作：\n` +
            `    · 教学性内容（示例 / 性能调优 / 边角案例）搬到 jsonError envelope hint (shell.ts:870-895 jsonError hint 机制可参考)\n` +
            `    · 跨工具决策搬到 tools_reference 段或独立 skill\n` +
            `    · L1 字段 description 只留必读硬契约（参数语义 / 取值范围 / 关键约束）\n` +
            `  **禁止"调高 budget 让测试过"** —— budget 在 audit-helpers.ts::getFieldBudget 锁定。`,
        );
      }
      expect(violations).toEqual([]);
    },
  );
});

// ─── P2-fields-aggregate · 所有字段合计 ≤ 过渡阈值 ─────────────────────

// 阶段 6 议题 3 收口实测 fieldsOnly = 5656，过渡阈值锁 6000（治理纪律线）。
// 目标 5000（比当前 5656 再 -10%，后续可通过 ask 三件套指针化、教学搬 envelope 继续压缩）。
const FIELDS_AGGREGATE_MAX_CHARS_TRANSITION = 6_000;
const FIELDS_AGGREGATE_TARGET_CHARS = 5_000;

describe('P2-fields-aggregate · 所有工具 inputSchema 字段 description 合计 ≤ 过渡阈值（治理目标 ≤7000）', () => {
  it('全字段合计 ≤ 过渡阈值', () => {
    let totalChars = 0;
    const items: { name: string; fieldCount: number; chars: number }[] = [];
    for (const t of ALL_RUNTIME_TOOLS) {
      const fields = collectInputSchemaFieldDescriptions(t.inputSchema);
      const chars = fields.reduce((acc, f) => acc + f.text.length, 0);
      totalChars += chars;
      if (chars > 0) items.push({ name: t.name, fieldCount: fields.length, chars });
    }
    items.sort((a, b) => b.chars - a.chars);

    if (totalChars > FIELDS_AGGREGATE_MAX_CHARS_TRANSITION) {
      const top10 = items
        .slice(0, 10)
        .map(
          (i) => `      ${i.name.padEnd(28)} ${i.chars} chars (${i.fieldCount} fields)`,
        )
        .join('\n');
      throw new Error(
        `P2-fields-aggregate 全字段合计超过过渡阈值：\n` +
          `  当前合计：${totalChars} chars（${ALL_RUNTIME_TOOLS.length} 工具的 inputSchema 字段 desc 合计）\n` +
          `  当前过渡阈值：${FIELDS_AGGREGATE_MAX_CHARS_TRANSITION}（应逐步降至 ≤${FIELDS_AGGREGATE_TARGET_CHARS} 目标）\n` +
          `  超出：${totalChars - FIELDS_AGGREGATE_MAX_CHARS_TRANSITION} chars\n` +
          `  消耗 top-10 工具：\n${top10}\n` +
          `\n— 治理动作：同 P2-field 单字段瘦身指引。\n` +
          `  **禁止"调高过渡阈值"让测试过**。`,
      );
    }
    expect(totalChars).toBeLessThanOrEqual(FIELDS_AGGREGATE_MAX_CHARS_TRANSITION);
  });

  it('过渡阈值与目标差距 < 5000（防过渡阈值脱钩太远忘记治理）', () => {
    expect(
      FIELDS_AGGREGATE_MAX_CHARS_TRANSITION - FIELDS_AGGREGATE_TARGET_CHARS,
    ).toBeLessThan(5_000);
  });
});

// ─── P3-field · 字段 description 与工具 descriptor.language 一致 ───────
//
// 2026-05-21 阶段 6 议题 3 收口：97 个字段是英文 / 20 个混杂 / 19 个中文
// （68% 字段是英文）。Agent 是中文 Agent / 工具说明书是中文 → 字段 description
// 必须跟上。
//
// 翻译原则（写进 99 §6.1 三层分工）：
//   - 工具名 / 函数名 / 变量名保留英文（snake_case 字段名 / `ask_user` 等）
//   - XML tag / 字段名引用保留英文（`<context>` 等）
//   - 自然语言部分翻译成中文
//   - 缩写（OAuth / API / JSON / URL 等）保留英文
//   - 字段保留英文需要 descriptor.language='en' + languageExceptionReason

describe('P3-field · inputSchema 字段 description 语言与工具 descriptor.language 一致', () => {
  it.each(AUDITABLE_ENTRIES)(
    '%s: 每个字段语言与 descriptor.language 一致',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const fields = collectInputSchemaFieldDescriptions(tool.inputSchema);
      const declared = descriptor.language;
      const hasException = Boolean(descriptor.languageExceptionReason);

      const violations: { path: string; detected: string; preview: string }[] = [];
      for (const f of fields) {
        const r = checkFieldLanguageDiscipline(declared, f.text, hasException);
        if (!r.ok) {
          violations.push({
            path: f.path,
            detected: r.detected,
            preview: f.text.slice(0, 60).replace(/\s+/g, ' '),
          });
        }
      }
      if (violations.length > 0) {
        const fmt = violations
          .map(
            (v) => `      · ${v.path} (detected=${v.detected}): "${v.preview}..."`,
          )
          .join('\n');
        throw new Error(
          `P3-field 字段语言不符（declared=${declared}）：\n` +
            `  工具：${toolName} (${descriptor.id})\n` +
            `  违规字段：\n${fmt}\n` +
            `\n— 治理动作：\n` +
            `    · 把字段 description 翻译成 ${declared === 'zh' ? '中文' : '英文'}（保留 snake_case 标识符 / XML tag / 缩写）\n` +
            `    · 若该字段确需保留英文（譬如需保留英文原文），把工具 descriptor.language 改 'en' + 填 languageExceptionReason\n` +
            `  P3-field 与 P3 工具 description 同套规则——LLM 看的是工具说明 + 字段说明的合体，混语义会让模型困惑。`,
        );
      }
      expect(violations).toEqual([]);
    },
  );
});

describe('P7-γ · LLM 可见字符串禁含废弃参数名（防漂移反向 audit）', () => {
  it('DEPRECATED_PARAM_TERMS 治理基线含 run_in_background + background_task_id', () => {
    const olds = DEPRECATED_PARAM_TERMS.map((t) => t.oldTerm);
    expect(olds).toContain('run_in_background');
    expect(olds).toContain('background_task_id');
  });

  it.each(AUDITABLE_ENTRIES)(
    '%s: tool.description 不含废弃参数名',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const desc = tool.description ?? '';
      const r = checkNoDeprecatedTerms(desc);
      if (!r.ok) {
        const fmt = r.hits
          .map((h) => `      · "${h.oldTerm}" → 应改用 "${h.newTerm}" — ${h.reason}`)
          .join('\n');
        throw new Error(
          `P7-γ tool.description 含废弃参数名：\n` +
            `  工具：${toolName} (${descriptor.id})\n` +
            `  命中：\n${fmt}\n` +
            `\n— 治理动作：source 文件里把废弃参数名全部换成现行参数名。` +
            `description 是 LLM 决策第一来源，绝不能停留在历史重构前的术语。`,
        );
      }
      expect(r.hits).toEqual([]);
    },
  );

  it.each(AUDITABLE_ENTRIES)(
    '%s: inputSchema field descriptions 不含废弃参数名',
    (_id, descriptor: SectionDescriptor) => {
      const { toolName, tool } = resolveTool(descriptor);
      const fields = collectInputSchemaFieldDescriptions(tool.inputSchema);
      const violations: { fieldDesc: string; hits: ReturnType<typeof checkNoDeprecatedTerms>['hits'] }[] = [];
      for (const f of fields) {
        const r = checkNoDeprecatedTerms(f.text);
        if (!r.ok) violations.push({ fieldDesc: f.text, hits: r.hits });
      }
      if (violations.length > 0) {
        const fmt = violations
          .map(
            (v) =>
              `  · 字段 description: ${JSON.stringify(v.fieldDesc.slice(0, 100))}...\n` +
              v.hits.map((h) => `      → "${h.oldTerm}" 应改 "${h.newTerm}"`).join('\n'),
          )
          .join('\n');
        throw new Error(
          `P7-γ inputSchema field descriptions 含废弃参数名：\n` +
            `  工具：${toolName} (${descriptor.id})\n${fmt}\n` +
            `\n— 治理动作：把 inputSchema.properties.<field>.description 里的废弃术语替换。` +
            `LLM 调用前会看 schema 字段说明决定怎么填参数。`,
        );
      }
      expect(violations).toEqual([]);
    },
  );
});
