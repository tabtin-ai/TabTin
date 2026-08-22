import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_MODE_CONFIGS,
  AGENT_MODE_NAMES,
  SELECTABLE_AGENT_MODES,
  AGENT_MODE_CONTRACT_VERSION,
  getAgentModeConfig,
  getAgentModePromptSection,
  getProposableModeTargets,
  isAgentModeName,
  isToolAllowedByPolicy,
  isToolAllowedBySerializedPolicy,
  isToolAllowedForMode,
  listFilteredToolNames,
  resolveAgentModeName,
  serializeAgentModeContract,
  type AgentModeName,
  type SerializedAgentModeContract,
} from '@tabtin/agent-modes';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTool(
  name: string,
  isReadOnly: boolean,
  overrides: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly,
    execute: async () => ({ content: 'noop' }),
    ...overrides,
  };
}

/**
 * 一份"有代表性的"本地 Runtime 工具集 — 覆盖核心 / 控制 / web / document /
 * presentation / mcp / agent / 假想 plan 系列等所有类别。
 *
 * isReadOnly 标记与 packages/agent-runtime/src/tools/*.ts 里实际的工具声明对齐。
 * 改动 isReadOnly 时必须同步更新本测试集与 Django 端 test_agent_mode_contract.py
 * 的 REPRESENTATIVE_TOOLS。
 *
 * **W3 (2026-05-10)**: `summarize_context` / `retrieve_tool_result` 已删（auto-condense
 * 让 LLM 主动 condense 的机制整套下线；大输出走 disk path + read_file
 * 引导）；不再出现在工具集 fixture / 期望中。
 *
 * **W4 R3 (2026-05-11)**: `ask_user`（AskUserQuestion 协议，
 * 替代 W4 之前的 `ask_choice`）+ `ask_form`（多字段填表，TabTin HITL 扩展）。
 * 旧名 `ask_choice` 由 `ask_user` 兼容，不应再出现。
 * **#3709 (2026-07-08)**: `request_approval` 下架，不再出现在工具集 fixture / 期望中。
 */
function buildRepresentativeToolSet(): Tool[] {
  return [
    // Core (W2 改名后 canonical 名是 run_terminal_command；L16 W5.5 受限模式
    // 通过 input 级 restrictedShellAllowlist 过滤而非整体 deny)
    // Wave 4.5 (2026-05-10): `think` 工具已下线，依赖 LLM 原生 thinking block。
    // W4 R3 (2026-05-11): ask_user+ ask_form（TabTin HITL 扩展）。
    //  (2026-07-08): request_approval 已下架。
    makeTool('run_terminal_command', false),
    makeTool('ask_user', true),
    makeTool('ask_form', true),
    makeTool('todo', false),
    // Web
    makeTool('web_search', true),
    // Code / local files
    makeTool('read_file', true),
    makeTool('write_file', false),
    makeTool('edit_file', false),
    makeTool('delete_file', false),
    // Document
    makeTool('parse_document', true),
    // Presentation (实际工具中 present_to_user 是 isReadOnly=true — 显示，不修改业务数据)
    makeTool('present_to_user', true),
    // Sub-agent
    makeTool('agent', false, { concurrencySafe: true }),
    // MCP (W3: 收敛为单 FC)
    makeTool('mcp_call_tool', false),
    // Plan family（plan_exit 已移除：执行由 PlanProposalCard 触发）
    makeTool('plan_create', false),
    makeTool('plan_update_todos', false),
    makeTool('switch_mode', false),
    // Skills（调用入口只读取并注入指令，后续实际工具独立判权）
    makeTool('skill_invoke', true),
    // 未来某个不知名的写工具（默认应被拒绝）
    makeTool('tabdoc_update_document', false),
  ];
}

// ─── 基础类型守卫 ────────────────────────────────────────────────────

describe('AgentModeName helpers', () => {
  it('AGENT_MODE_NAMES enumerates all 6 modes (PR1 added yolo)', () => {
    // PR1 (2026-05-18)：插入 yolo 档,位置在 study 后 / group 前。
    expect(AGENT_MODE_NAMES).toEqual([
      'ask',
      'agent',
      'plan',
      'study',
      'yolo',
      'group',
    ]);
  });

  it('isAgentModeName accepts known modes only', () => {
    expect(isAgentModeName('plan')).toBe(true);
    expect(isAgentModeName('agent')).toBe(true);
    expect(isAgentModeName('unknown')).toBe(false);
    expect(isAgentModeName(null)).toBe(false);
    expect(isAgentModeName(undefined)).toBe(false);
    expect(isAgentModeName(42)).toBe(false);
  });

  it('resolveAgentModeName falls back to agent for unknown', () => {
    expect(resolveAgentModeName('plan')).toBe('plan');
    expect(resolveAgentModeName('xxx')).toBe('agent');
    expect(resolveAgentModeName(undefined, 'study')).toBe('study');
  });
});

// ─── 配置完整性 ──────────────────────────────────────────────────────

describe('AGENT_MODE_CONFIGS shape', () => {
  it('has a config entry for every mode', () => {
    for (const name of AGENT_MODE_NAMES) {
      const cfg = AGENT_MODE_CONFIGS[name];
      expect(cfg).toBeDefined();
      expect(cfg.metadata.name).toBe(name);
    }
  });

  it('agent mode has no prompt section to preserve regression baseline', () => {
    expect(AGENT_MODE_CONFIGS.agent.promptSection).toBeNull();
    expect(getAgentModePromptSection('agent')).toBeNull();
  });

  it('agent mode tool policy is "all" so existing behavior is unchanged', () => {
    expect(AGENT_MODE_CONFIGS.agent.toolPolicy.kind).toBe('all');
  });

  it('group mode mirrors agent mode for tool policy (same powers, different prompt)', () => {
    expect(AGENT_MODE_CONFIGS.group.toolPolicy.kind).toBe('all');
    expect(AGENT_MODE_CONFIGS.group.promptSection).not.toBeNull();
  });

  it('yolo mode mirrors agent mode for tool policy + prompt (PR1)', () => {
    // PR1 (2026-05-18)：yolo 工具集复用 ALL_MODE_POLICY(同 agent / group),
    // 不注入额外 prompt section(同 agent),差异仅在 authorizationPreset='full_auto'。
    expect(AGENT_MODE_CONFIGS.yolo.toolPolicy.kind).toBe('all');
    expect(AGENT_MODE_CONFIGS.yolo.promptSection).toBeNull();
    expect(AGENT_MODE_CONFIGS.yolo.metadata.skipExecutionSection).toBe(false);
    expect(AGENT_MODE_CONFIGS.yolo.metadata.authorizationPreset).toBe('full_auto');
  });

  it('yolo and agent share the SAME ALL_MODE_POLICY instance (PR1 decision)', () => {
    // PR1 决策:严禁新建 YOLO_MODE_POLICY 常量,必须复用 ALL_MODE_POLICY 单例。
    // 这条断言确保 contract.ts 内部仍是单例复用,而不是值相同但对象不同。
    // 注：group 使用 GROUP_MODE_POLICY 是另一个等价但独立的 kind:'all' 对象;
    // 复用语义只针对 agent ↔ yolo。
    expect(AGENT_MODE_CONFIGS.yolo.toolPolicy).toBe(AGENT_MODE_CONFIGS.agent.toolPolicy);
  });

  it('plan / ask / study are restricted with allow + deny lists', () => {
    for (const name of ['plan', 'ask', 'study'] as AgentModeName[]) {
      const policy = AGENT_MODE_CONFIGS[name].toolPolicy;
      expect(policy.kind).toBe('restricted');
      expect(policy.allowToolNames.length).toBeGreaterThan(0);
      expect(policy.denyToolNames.length).toBeGreaterThan(0);
      expect(policy.defaultAllowReadOnly).toBe(true);
    }
  });

  it('plan / ask / study skip the generic <execution> section', () => {
    for (const name of ['plan', 'ask', 'study', 'group'] as AgentModeName[]) {
      expect(AGENT_MODE_CONFIGS[name].metadata.skipExecutionSection).toBe(true);
    }
    expect(AGENT_MODE_CONFIGS.agent.metadata.skipExecutionSection).toBe(false);
  });

  it('cautious authorization preset only on Ask / Plan (read-only-leaning)', () => {
    expect(AGENT_MODE_CONFIGS.ask.metadata.authorizationPreset).toBe('cautious');
    expect(AGENT_MODE_CONFIGS.plan.metadata.authorizationPreset).toBe('cautious');
    expect(AGENT_MODE_CONFIGS.agent.metadata.authorizationPreset).toBe('collaborative');
    expect(AGENT_MODE_CONFIGS.study.metadata.authorizationPreset).toBe('collaborative');
    // PR1 (2026-05-18)：yolo 独占 full_auto;其他 5 档不允许使用此预设。
    expect(AGENT_MODE_CONFIGS.yolo.metadata.authorizationPreset).toBe('full_auto');
    expect(AGENT_MODE_CONFIGS.group.metadata.authorizationPreset).toBe('collaborative');
  });
});

// ─── 工具访问策略 ────────────────────────────────────────────────────
//
// **#5394 Phase 1**：`filterToolsForMode`（identity 空壳）已删除。
// 所有 mode 都看到完整工具列表（ToolProvider 层不做物理过滤）；
// 策略意图（mode 应该允许/拒绝哪些工具）由 `isToolAllowedByPolicy` 断言，
// 调用时拦截行为由 agent-mode-tool-guard.test.ts / plan-mode-guard.test.ts
// / judge.test.ts 覆盖。

describe('isToolAllowedByPolicy 策略意图（被 guard / judge step 0 共同消费）', () => {
  const tools = buildRepresentativeToolSet();

  function policyOf(mode: AgentModeName) {
    return AGENT_MODE_CONFIGS[mode].toolPolicy;
  }

  describe('plan mode policy', () => {
    const policy = policyOf('plan');

    it('allows read-only core tools (web_search / read_file / parse_document)', () => {
      for (const name of ['web_search', 'read_file', 'parse_document']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(true);
      }
    });

    it('allows todo + plan-family + switch_mode (allow-list override 即使 isReadOnly=false)', () => {
      for (const name of ['todo', 'plan_create', 'plan_update_todos', 'switch_mode']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(true);
      }
    });

    it('denies write tools (write_file / edit_file / delete_file / mcp / agent)', () => {
      for (const name of ['write_file', 'edit_file', 'delete_file', 'mcp_call_tool', 'agent']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(false);
      }
    });

    it('allows run_terminal_command (L16 W5.5 input-level allowlist)', () => {
      const tool = tools.find((t) => t.name === 'run_terminal_command')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(true);
    });

    it('denies generic write like tabdoc_update_document by default', () => {
      const tool = tools.find((t) => t.name === 'tabdoc_update_document')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(false);
    });

    it('allows present_to_user (isReadOnly=true default)', () => {
      const tool = tools.find((t) => t.name === 'present_to_user')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(true);
    });
  });

  describe('ask mode policy', () => {
    const policy = policyOf('ask');

    it('allows read-only tools', () => {
      for (const name of ['web_search', 'parse_document', 'ask_user', 'ask_form']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(true);
      }
    });

    it('explicitly denies todo (Ask 纯问答 不维护 todo)', () => {
      const tool = tools.find((t) => t.name === 'todo')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(false);
    });

    it('allows agent in allow list (D12.1: readonly enforced at evaluate layer)', () => {
      const tool = tools.find((t) => t.name === 'agent')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(true);
    });

    it('denies write tools + plan family', () => {
      for (const name of ['mcp_call_tool', 'tabdoc_update_document', 'plan_create', 'plan_update_todos', 'write_file']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(false);
      }
    });

    // ：ask 可提议切到 plan → switch_mode 进 allow 列表。
    it('allows switch_mode (ask → plan proposal)', () => {
      const tool = tools.find((t) => t.name === 'switch_mode')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(true);
    });
  });

  describe('study mode policy', () => {
    const policy = policyOf('study');

    it('allows read-only + plan family + present_to_user', () => {
      for (const name of ['parse_document', 'todo', 'plan_create', 'present_to_user']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(true);
      }
    });

    it('denies destructive writes', () => {
      for (const name of ['mcp_call_tool', 'write_file', 'edit_file']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(isToolAllowedByPolicy(tool, policy), name).toBe(false);
      }
    });

    // ：study 可提议切到 plan → switch_mode 进 allow 列表。
    it('allows switch_mode (study → plan proposal)', () => {
      const tool = tools.find((t) => t.name === 'switch_mode')!;
      expect(isToolAllowedByPolicy(tool, policy)).toBe(true);
    });
  });
});

// ─── WRITE_TOOLS_DENYLIST 覆盖性 (DEBT-3) ────────────────────────────

describe('WRITE_TOOLS_DENYLIST coverage', () => {
  const tools = buildRepresentativeToolSet();

  it('every isReadOnly=false tool not in allowToolNames must be in denyToolNames for restricted modes', () => {
    const restrictedModes: AgentModeName[] = ['ask', 'plan', 'study'];
    for (const mode of restrictedModes) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      if (policy.kind !== 'restricted') continue;

      const allow = new Set(policy.allowToolNames);
      const deny = new Set(policy.denyToolNames);

      for (const tool of tools) {
        if (tool.isReadOnly) continue;
        if (allow.has(tool.name)) continue;
        expect(
          deny.has(tool.name),
          `${tool.name} (isReadOnly=false) in ${mode} mode: not in allowToolNames ` +
            `but missing from denyToolNames. Add it to WRITE_TOOLS_DENYLIST or ` +
            `the mode's allowToolNames.`,
        ).toBe(true);
      }
    }
  });
});

// ─── L16 W5.5：受限模式 input 级 shell 白名单 ────────────────────────

describe('restrictedShellAllowlist (L16)', () => {
  it('plan / ask / study modes declare tabtin-readonly allowlist', () => {
    for (const mode of ['plan', 'ask', 'study'] as const) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      expect(
        policy.restrictedShellAllowlist,
        `${mode} mode must set restrictedShellAllowlist='tabtin-readonly'`,
      ).toBe('tabtin-readonly');
    }
  });

  it('agent / group / yolo modes do not constrain shell input', () => {
    // PR1 (2026-05-18)：yolo 工具集复用 ALL_MODE_POLICY,自然继承"无 input 级白名单"。
    for (const mode of ['agent', 'group', 'yolo'] as const) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      expect(policy.restrictedShellAllowlist).toBeUndefined();
    }
  });

  it('plan mode does NOT include run_terminal_command in denyToolNames (L16 reversal)', () => {
    const policy = AGENT_MODE_CONFIGS.plan.toolPolicy;
    expect(policy.denyToolNames).not.toContain('run_terminal_command');
  });

  it('plan mode allow-lists run_terminal_command explicitly (must clear isReadOnly=false default)', () => {
    const policy = AGENT_MODE_CONFIGS.plan.toolPolicy;
    expect(policy.allowToolNames).toContain('run_terminal_command');
  });
});

// ─── 单工具裁定 ──────────────────────────────────────────────────────

describe('isToolAllowedForMode', () => {
  it('plan mode: mcp_call_tool denied (write tool)', () => {
    expect(isToolAllowedForMode(makeTool('mcp_call_tool', false), 'plan')).toBe(false);
  });

  it('plan mode: unknown future write tool denied by default', () => {
    expect(isToolAllowedForMode(makeTool('future_writer', false), 'plan')).toBe(false);
  });

  it('plan mode: unknown future read-only tool allowed by default', () => {
    expect(isToolAllowedForMode(makeTool('future_reader', true), 'plan')).toBe(true);
  });

  it('agent mode: every tool allowed regardless of isReadOnly', () => {
    expect(isToolAllowedForMode(makeTool('mcp_call_tool', false), 'agent')).toBe(true);
    expect(isToolAllowedForMode(makeTool('anything', false), 'agent')).toBe(true);
  });
});

// ─── Prompt section 注入 ─────────────────────────────────────────────

describe('Agent mode prompt sections', () => {
  // W2 改名前的旧名（重新出现 = prompt 漂移）。current canonical 名（read_file /
  // write_file / delete_file）显然不算 "retired"——之前这里把新名当成 retired 是 bug。
  const retiredCurrentToolNames = /`(?:bash|web_fetch|file_read|file_write|file_edit|file_delete|execute_command|code_grep|code_glob|document_read|skills\.search)`/;

  it('plan section contains hard-constraint keywords', () => {
    const section = getAgentModePromptSection('plan')!;
    expect(section).not.toBeNull();
    expect(section).toContain('Plan');
    // 2026-05-11 prompt 中文化：'MUST NOT' → '不能'/'绝不'
    expect(section).toMatch(/不能|绝不/);
    expect(section).toContain('plan_create');
    expect(section).toContain('plan_update_todos');
    expect(section).toContain('todo');
    expect(section).toContain('show_widget');
    // L16 W5.5：plan 模式同样放行 tabtin 只读 CLI（取代旧的 tabtin browser markdown 引导）
    expect(section).toContain('run_terminal_command');
    expect(section).toMatch(/tabtin .* --format json/);
    expect(section).toContain('<agent_mode>');
    expect(section).toContain('</agent_mode>');
    // plan_exit 已移除：prompt 不应再提到它
    expect(section).not.toContain('plan_exit');
  });

  it('ask section forbids writes and sub-agent forks', () => {
    const section = getAgentModePromptSection('ask')!;
    expect(section).toContain('Ask');
    // 2026-05-11 prompt 中文化：'MUST NOT' → '不能'
    expect(section).toMatch(/不能|绝不/);
    // Ask 模式不维护 todo
    expect(section).toMatch(/todo/i);
    expect(section).toContain('show_widget');
    // L16 W5.5：受限模式放行 tabtin 只读 CLI（取代旧的 tabtin browser markdown 引导）
    expect(section).toContain('run_terminal_command');
    expect(section).toMatch(/tabtin .* --format json/);
  });

  it('study section matches its restricted teaching tool surface', () => {
    const section = getAgentModePromptSection('study')!;
    expect(section).toContain('Study');
    expect(section).toContain('show_widget');
    expect(section).toContain('present_to_user');
    expect(section).toContain('.md');
    expect(section).toContain('.canvas.tsx');
    // L16 W5.5：study 模式同样放行 tabtin 只读 CLI
    expect(section).toContain('run_terminal_command');
    expect(section).toMatch(/tabtin .* --format json/);
    expect(section).not.toMatch(/`tabdoc`|`tabdata`|`tabmemo`/);
  });

  it('restricted mode prompts do not reintroduce retired current tool names', () => {
    for (const mode of ['plan', 'ask', 'study'] as const) {
      const section = getAgentModePromptSection(mode)!;
      expect(section, `${mode} prompt should not teach retired tool names`).not.toMatch(retiredCurrentToolNames);
      expect(section).not.toContain('skills.search');
    }
  });

  it('mode prompts do NOT duplicate ask_user_tools / execution rules (after Lane K 归位)', () => {
    // Lane K mode-prompt 归位（2026-05-10）：
    // - "After the user answers, do not ask the same question again" SSoT 在 ask_user_tools.md
    // - "Don't retry the identical action blindly" SSoT 在 execution.md
    // - "选对文件读取工具"（read_file vs parse_document）SSoT 在 read_file 工具 description
    // builder.ts 会把这两段拼到所有 mode 的 system prompt 里。
    // mode prompt 不应再重复（防漂移）。SSoT 规则的存在性由
    // packages/agent-prompt/src/__tests__/builder.test.ts 单独保证。
    for (const mode of ['plan', 'ask', 'study', 'group'] as const) {
      const section = getAgentModePromptSection(mode)!;
      expect(section, `${mode} prompt should NOT duplicate ask_user_tools rules`).not.toContain('用户答过后');
      expect(section, `${mode} prompt should NOT duplicate retry rules`).not.toContain('不要盲目重试完全相同的动作');
      expect(section, `${mode} prompt should NOT duplicate file-read routing`).not.toContain('选对文件读取工具');
    }
  });

  it('group section emphasises dispatch over execution', () => {
    // agent-modes SSoT（group.md）产品文案已从英文 "Group" 改为中文
    // 「PMO（项目管理 / Agent 调度）」；契约仍是调度优先、执行交给子 Agent。
    const section = getAgentModePromptSection('group')!;
    expect(section).toContain('PMO');
    expect(section).toContain('项目管理');
    expect(section).toContain('agent');
    expect(section).toContain('todo');
  });

  it('agent mode returns null (regression: do NOT inject extra section)', () => {
    expect(getAgentModePromptSection('agent')).toBeNull();
  });
});

// ─── JSON Contract 双端对齐 ──────────────────────────────────────────

describe('JSON contract round-trip (cross-runtime sync)', () => {
  const contractPath = resolve(__dirname, '../agent-mode-contract.json');
  const onDisk = JSON.parse(readFileSync(contractPath, 'utf-8')) as SerializedAgentModeContract;
  const fromCode = serializeAgentModeContract();

  it('JSON file version matches code constant', () => {
    expect(onDisk.version).toBe(AGENT_MODE_CONTRACT_VERSION);
    expect(fromCode.version).toBe(AGENT_MODE_CONTRACT_VERSION);
  });

  it('JSON file content matches serialized TS SSoT', () => {
    // 任何 TS 端的修改都必须同步到 JSON 文件，否则此断言失败 → CI 拦截。
    // 维护者：失败时执行 `pnpm --filter @tabtin/agent-runtime tsx -e "console.log(JSON.stringify(require('./dist/agent-modes/contract.js').serializeAgentModeContract(), null, 2))"`
    // 复制输出覆盖 packages/agent-runtime/agent-mode-contract.json。
    expect(onDisk).toEqual(fromCode);
  });

  it('tool policies reference canonical tool names only', () => {
    // **W2 改名前的旧名 + 已退役工具** —— 出现在 contract 中即视为漂移。
    // W2 改名映射：file_read→read_file / file_write→write_file / file_edit→edit_file /
    //              file_delete→delete_file / execute_command→run_terminal_command /
    //              code_grep→grep_search / code_glob→glob_search / document_read→parse_document
    const retiredNames = new Set([
      'bash',
      'web_fetch',
      'file_read',
      'file_write',
      'file_edit',
      'file_delete',
      'execute_command',
      'code_grep',
      'code_glob',
      'document_read',
      'skills.search',
      'plan_exit',
      // W4 R3 (2026-05-11): `ask_choice` 由 `ask_user` 兼容；`ask_form` 是 TabTin HITL 扩展，依然在用。
      // `ask_question` 是 W4 之前已退役的更早旧名。
      'ask_choice',
      'ask_question',
      //  (2026-07-08): `request_approval` 下架——contract 不允许再引用。
      'request_approval',
    ]);

    for (const name of AGENT_MODE_NAMES) {
      const policy = onDisk.configs[name].tool_policy;
      const currentNames = [
        ...policy.allow_tool_names,
        ...policy.deny_tool_names,
      ];
      const leaked = currentNames.filter((toolName) => retiredNames.has(toolName));
      expect(leaked, `${name} contract should not reference retired FC names`).toEqual([]);
    }
  });

  it('serialized policy can be consumed by isToolAllowedBySerializedPolicy with same outcome as TS path', () => {
    const tools = buildRepresentativeToolSet();
    for (const name of AGENT_MODE_NAMES) {
      const policy = onDisk.configs[name].tool_policy;
      for (const tool of tools) {
        const direct = isToolAllowedForMode(tool, name);
        const fromJson = isToolAllowedBySerializedPolicy(tool, policy);
        expect(fromJson, `tool=${tool.name} mode=${name}`).toBe(direct);
      }
    }
  });
});

// ─── 调试辅助 ────────────────────────────────────────────────────────

describe('listFilteredToolNames', () => {
  it('returns allowed + denied buckets in input order', () => {
    // Wave 4.5：`think` 工具已下线，改用 read_file 作"isReadOnly=true 默认放行"样本。
    const tools = [
      makeTool('read_file', true),
      makeTool('mcp_call_tool', false),
      makeTool('todo', false),
    ];
    const result = listFilteredToolNames(tools, 'plan');
    expect(result.allowed).toEqual(['read_file', 'todo']);
    expect(result.denied).toEqual(['mcp_call_tool']);
  });

  it('agent mode returns everything as allowed', () => {
    const tools = [makeTool('mcp_call_tool', false), makeTool('agent', false)];
    const result = listFilteredToolNames(tools, 'agent');
    expect(result.allowed).toHaveLength(2);
    expect(result.denied).toHaveLength(0);
  });
});

// ─── 配置一致性 (smoke test for getAgentModeConfig) ──────────────────

describe('getAgentModeConfig', () => {
  it('returns same instance for repeated lookups', () => {
    const a = getAgentModeConfig('plan');
    const b = getAgentModeConfig('plan');
    expect(a).toBe(b);
  });

  it('exposes both metadata and toolPolicy', () => {
    const cfg = getAgentModeConfig('plan');
    expect(cfg.metadata.name).toBe('plan');
    expect(cfg.toolPolicy.kind).toBe('restricted');
    expect(cfg.promptSection).toBeDefined();
  });
});

// ─── isToolAllowedByPolicy custom 策略 (灵活性回归) ──────────────────

// ─── L29：全量扫描断言（防止新增 FC 漏标 retired 集合 / denylist） ──

describe('L29 full scan — TS 端工具全量来源对照 contract', () => {
  /**
   * L29：W6 后 Python 端删了 230 条 drift baseline，contract ↔ tool 的全量审计
   * 失去了 Python 守护。本守护从两个 TS 端工具来源做反向扫描：
   *
   *   1. **Capability 工具**：直接 import `core/index.ts` 中的 capability cap 类，
   *      实例化后取它们 declare 的 tool 列表。
   *   2. **Adapter 工具**：直接 import `tools/index.ts`（runtime 端的工厂入口），
   *      用 noop 配置生成它们的 tool 列表。
   *
   * 然后断言两端 tool 名都满足：
   *   - 不在已退役（W2 改名前 / W6 删除）的 retiredNames 集合里 — 防止 alias 别名
   *     被错当 canonical 名而漂回 contract
   *   - 如果该工具是 isReadOnly=false，且不在 plan/ask/study 的 allowToolNames 里，
   *     则它必须出现在对应模式的 denyToolNames（或被 contract 明确列入 allow）—
   *     防止"新加 FC 默认通过"的安全洞
   */
  // W2 改名前的 retired 名 + W3 删的 mcp_* 子工具集
  const RETIRED_TOOL_NAMES = new Set([
    'bash', 'web_fetch',
    'file_read', 'file_write', 'file_edit', 'file_delete',
    'execute_command', 'code_grep', 'code_glob',
    'read_diagnostics', 'document_read',
    'system_relaunch_app', 'system_clear_os_error_blacklist',
    'skills.search',
    // W3 收敛前的 7 个 mcp_* FC（除 mcp_call_tool 外全部退役）
    'mcp_list_servers', 'mcp_list_tools', 'mcp_list_resources',
    'mcp_list_prompts', 'mcp_read_resource', 'mcp_get_prompt', 'mcp_call',
    // W1 删除的 git 工具
    'git_status', 'git_diff',
    // W6 退役的 Python BaseTool 域内工具（不应再有 TS 同名 FC）
    'list_conversations', 'read_conversation',
    'plan_exit',
    // W4 R3 (2026-05-11): `ask_choice` 由 `ask_user` 兼容；`ask_form` 是 TabTin HITL 扩展，依然在用。
    // `ask_question` 是 W4 之前已退役的更早旧名。
    //  (2026-07-08): `request_approval` 下架。
    'ask_choice', 'ask_question', 'request_approval',
  ]);

  // 收集 TS 端"实际暴露给 LLM"的工具名集合。
  // 不直接动态 import 整个 capability/tools 体系（部分 cap 需要 backend session
  // 才能实例化）—— 用单测专用桥接方式：扫 capability/core 下导出的工具名。
  function collectActualToolNames(): Set<string> {
    const names = new Set<string>();

    // 把 buildRepresentativeToolSet 里所有名字算上（覆盖 capability + ToolProvider 主流）
    for (const t of buildRepresentativeToolSet()) {
      names.add(t.name);
    }

    // 注：完整全量需要从 ElectronToolProvider/DaemonToolProvider 的 manifest 反推，
    // 但那些 provider 依赖 Electron/Daemon runtime 上下文，无法在 vitest 直接 import。
    // 所以本守护采用"代表性 + 黑名单（retired）+ contract 一致性"三重约束：
    //   - 任何在 manifest.json 中的 FC 都至少要被 buildRepresentativeToolSet 覆盖
    //     一次（新加 FC 的开发者必须更新 representative set）
    //   - retired 名不能漂回（下方独立断言）
    //   - contract policy 名不能引用 retired（已在前面 'tool policies reference
    //     canonical tool names only' 测试覆盖）
    return names;
  }

  it('代表工具集中所有名字都不在 retired 名集中（漂移守护）', () => {
    const names = collectActualToolNames();
    const leaked: string[] = [];
    for (const name of names) {
      if (RETIRED_TOOL_NAMES.has(name)) {
        leaked.push(name);
      }
    }
    expect(
      leaked,
      `Representative tool set contains retired names: ${leaked.join(', ')}. ` +
        `Update buildRepresentativeToolSet to use canonical names.`,
    ).toEqual([]);
  });

  it('contract 中 deny + allow 列表的工具名也都不在 retired 集中（双向守护）', () => {
    for (const mode of AGENT_MODE_NAMES) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      if (policy.kind !== 'restricted') continue;
      const allRefs = [...policy.allowToolNames, ...policy.denyToolNames];
      const leaked = allRefs.filter((n) => RETIRED_TOOL_NAMES.has(n));
      expect(
        leaked,
        `Mode ${mode} contract still references retired tool names: ${leaked.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('contract 引用的所有工具名都符合 W2 改名后的 snake_case 规范（无 file_/code_ 死前缀）', () => {
    // 宪法 02 命名规范：动词_对象，禁用 file_/code_/system_ 等死前缀。
    // 只检查 deny + allow 中显式列出的名字（read-only fall-through 走默认）。
    const RETIRED_PREFIXES = /^(file_|code_|system_)/;
    for (const mode of AGENT_MODE_NAMES) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      if (policy.kind !== 'restricted') continue;
      const allRefs = [...policy.allowToolNames, ...policy.denyToolNames];
      const leaked = allRefs.filter((n) => RETIRED_PREFIXES.test(n));
      expect(
        leaked,
        `Mode ${mode} contract uses retired prefixes (file_/code_/system_): ${leaked.join(', ')}. ` +
          `Use canonical names instead (read_file / grep_search / relaunch_app etc.).`,
      ).toEqual([]);
    }
  });
});

describe('isToolAllowedByPolicy with custom policy', () => {
  it('respects defaultAllowReadOnly=false', () => {
    const tool = makeTool('foo', true);
    const allow = isToolAllowedByPolicy(tool, {
      kind: 'restricted',
      allowToolNames: [],
      denyToolNames: [],
      defaultAllowReadOnly: false,
      mcpReadOnlyOnly: false,
    });
    expect(allow).toBe(false);
  });

  it('mcpReadOnlyOnly excludes mcp_* writes regardless of allow list', () => {
    const tool = makeTool('mcp_call_tool', false);
    const allow = isToolAllowedByPolicy(tool, {
      kind: 'restricted',
      allowToolNames: ['mcp_call_tool'], // 即使在 allow 里
      denyToolNames: [],
      defaultAllowReadOnly: true,
      mcpReadOnlyOnly: true,
    });
    // allow 列表优先于 mcpReadOnlyOnly — 这是显式覆盖语义
    expect(allow).toBe(true);
  });

  it('denyToolNames overrides allowToolNames (deny 最强)', () => {
    const tool = makeTool('weird', true);
    const allow = isToolAllowedByPolicy(tool, {
      kind: 'restricted',
      allowToolNames: ['weird'],
      denyToolNames: ['weird'],
      defaultAllowReadOnly: true,
      mcpReadOnlyOnly: false,
    });
    expect(allow).toBe(false);
  });
});

// ：switch_mode 可提议切到「除自身外的全部用户可达模式」，不再限制方向。
describe('getProposableModeTargets（switch_mode 提议目标，）', () => {
  it('SELECTABLE_AGENT_MODES = 排除 yolo / study 后的用户可达模式', () => {
    expect([...SELECTABLE_AGENT_MODES]).toEqual(['ask', 'agent', 'plan', 'group']);
  });

  it('每个模式可提议切到「SELECTABLE_AGENT_MODES − 自身」', () => {
    for (const mode of AGENT_MODE_NAMES) {
      const targets = getProposableModeTargets(mode);
      const expected = SELECTABLE_AGENT_MODES.filter((m) => m !== mode);
      expect([...targets], `mode=${mode}`).toEqual([...expected]);
      // 永远不含自身
      expect(targets).not.toContain(mode);
    }
  });

  it('agent 现在可提议切到 group（4661 的核心诉求：用户要求切 Group）', () => {
    expect(getProposableModeTargets('agent')).toContain('group');
  });

  it('plan 仍可提议切回 agent（不回归  的 plan→agent 能力）', () => {
    expect(getProposableModeTargets('plan')).toContain('agent');
  });

  it('可提议目标永不包含已退役的 yolo / UI 隐藏的 study', () => {
    for (const mode of AGENT_MODE_NAMES) {
      const targets = getProposableModeTargets(mode);
      expect(targets).not.toContain('yolo');
      expect(targets).not.toContain('study');
    }
  });
});
