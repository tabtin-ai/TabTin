import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../builder.js';
import {
  buildAppsSection,
  buildPrincipleSection,
  buildSubagentCatalogSection,
  buildWorktreeRoutingSection,
} from '../sections.js';
import {
  SECTION_EXECUTION,
  SECTION_SAFETY,
  SECTION_PLANNING,
  SECTION_SUBAGENT_ORCHESTRATION,
} from '../generated-content.js';

const MOCK_TOOLS = [
  { name: 'run_terminal_command', description: 'Execute shell commands' },
  { name: 'todo_write', description: 'Track multi-step tasks' },
  { name: 'web_search', description: 'Search the web' },
];

describe('buildSystemPrompt', () => {
  it('SSoT — anti-repeat / retry rules live in shared sections, not duplicated per mode (Lane K 归位)', () => {
    // Lane K mode-prompt 归位（2026-05-10）：mode prompt 不再重复 ask 规则与重试规则；
    // 它们的 SSoT 是 execution.md，builder.ts 把它们拼到所有 mode 的 system prompt。
    // 2026-05-21 阶段 6.7 议题 1：原 ask_user_tools 段已删，"不要再问同一个问题" /
    // "一次回复最多调一次面向用户的工具" 这两个 Agent 协作节奏约束搬到 execution。
    expect(SECTION_EXECUTION).toMatch(/不要再问同一个问题/);
    expect(SECTION_EXECUTION).toContain('每次回复最多发起一次需要用户即时作答的交互');
    expect(SECTION_EXECUTION).toContain('不要以相同输入重复失败的动作');
    expect(SECTION_EXECUTION).toContain('UI 不会暴露原始错误');
  });

  it('produces identical output for same config regardless of host', () => {
    const config = {
      customRules: 'Always be polite.',
      workspaceRoot: '/home/user/project',
      spaceId: 'space-123',
      agentMode: 'agent' as const,
      tools: MOCK_TOOLS,
      cliReference: '- `tabtin space list`: List spaces',
    };

    const result1 = buildSystemPrompt(config);
    const result2 = buildSystemPrompt(config);

    expect(result1).toBe(result2);
  });

  it('includes all mandatory sections in agent mode', () => {
    const result = buildSystemPrompt({
      tools: MOCK_TOOLS,
      agentMode: 'agent',
    });

    expect(result).toContain('<principle>');
    expect(result).toContain('</principle>');
    expect(result).toContain('## 每轮操作循环');
    expect(result).not.toContain('<operating_loop>');
    expect(result).toContain('<execution>');
    expect(result).toContain('</execution>');
    // 2026-05-21 阶段 6.7 议题 1：原 <ask_user_tools_usage> / <skills_usage> 已删。
    // ：<skills_user_voice> 已删，内容并入静态 <skills> index。
    expect(result).toContain('<safety>');
    expect(result).toContain('</safety>');
    expect(result).not.toContain('<skills_user_voice>');
    expect(result).not.toContain('<tools_reference>');
    expect(result).toContain('<planning>');
    expect(result).toContain('</planning>');
  });

  it('skips execution section in plan mode', () => {
    const result = buildSystemPrompt({
      tools: MOCK_TOOLS,
      agentMode: 'plan',
    });

    expect(result).not.toContain('<execution>');
    expect(result).toContain('<agent_mode>');
  });

  it('principle section has no hardcoded TabTin AI Agent persona line', () => {
    // ：具体 Agent 身份走 agent-profile；principle 只保留默认原则。
    const result = buildSystemPrompt({ tools: [] });
    expect(result).toContain('<principle>');
    expect(result).not.toContain('你是 TabTin AI Agent');
    expect(result).not.toContain('## 平台岗位');
    expect(result).not.toMatch(/<principle>[\s\S]*## 术语[\s\S]*<\/principle>/);
    expect(result).toMatch(/<environment>[\s\S]*## 术语[\s\S]*<\/environment>/);
    expect(result).toContain('## 每轮操作循环');
    expect(result).toContain('## 行为规则');
  });

  it('environment section carries platform terms', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).toContain('<environment>');
    expect(result).toContain('## 术语');
    expect(result).toContain('Organization');
    expect(result).toContain('Agent');
  });

  it('includes custom_rules section when provided', () => {
    const result = buildSystemPrompt({
      customRules: 'Always respond in JSON.',
      tools: [],
    });
    expect(result).toContain('<custom_rules>');
    expect(result).toContain('Always respond in JSON.');
  });

  it('omits custom_rules section when empty', () => {
    const result = buildSystemPrompt({
      customRules: '',
      tools: [],
    });
    expect(result).not.toContain('<custom_rules>');
  });

  it('renders space id and TABTIN_WORKSPACE contract in <environment> without leaking path ', () => {
    // 2026-05-14 拆段后：spaceId 在 <environment>；#7810 起工作目录绝对路径
    // 不再贴在 prompt，只通过环境变量名和 shell 语法约定暴露。
    const result = buildSystemPrompt({
      tools: [],
      runtimeIdentity: {
        organizationId: 'wt-1',
        spaceId: 'space-abc',
        threadId: 'sess',
        workspaceRoot: '/home/user/project',
        archiveDir: '/a',
        toolLogsDir: '/t',
      },
      shellInfo: { kind: 'zsh', shell: '/bin/zsh' },
    });
    const environmentSlice = result.slice(result.indexOf('<environment>'), result.indexOf('</environment>'));
    expect(result).toContain('<environment>');
    expect(result).toContain('工作空间：  space-abc');
    expect(environmentSlice).toContain('## 环境变量');
    expect(environmentSlice).toContain('- `TABTIN_WORKSPACE`');
    expect(result).not.toContain('工作目录：   /home/user/project');
    expect(result).not.toContain('/home/user/project');
    expect(result).toContain('$TABTIN_WORKSPACE');
    expect(result).toContain('禁止');
    expect(result).toContain('workspace/');
    // principle 段不再泄露这些路径 / space id
    const principleSlice = result.slice(result.indexOf('<principle>'), result.indexOf('</principle>'));
    expect(principleSlice).not.toContain('/home/user/project');
    expect(principleSlice).not.toContain('space-abc');
  });

  it('includes cli_capabilities when provided', () => {
    const result = buildSystemPrompt({
      tools: [],
      cliReference: '- `tabtin table info`: Show table info',
    });
    expect(result).toContain('<cli_capabilities>');
    expect(result).toContain('tabtin table info');
  });

  it('keeps concrete tool names out of system sections other than cli_capabilities ', () => {
    const concreteCapabilityNames = [
      'run_terminal_command',
      'read_platform_data',
      'ask_user',
      'ask_form',
      'web_search',
      'skills_search',
      'skills_read',
      'read_file',
      'grep_search',
      'mcp_call_tool',
      'todo_write',
      'plan_create',
      'plan_update_todos',
      'show_widget',
      'present_to_user',
      'delete_file',
    ];
    for (const agentMode of ['agent', 'plan', 'ask', 'study', 'group'] as const) {
      const result = buildSystemPrompt({
        tools: MOCK_TOOLS,
        agentMode,
        cliReference: '- `tabtin table info`: Show table info',
        runtimeIdentity: {
          organizationId: 'org-1',
          spaceId: 'space-1',
          threadId: 'thread-1',
          workspaceRoot: '/workspace',
        },
        enabledApps: [
          { key: 'tabweb', cliKey: 'browser', displayName: '浏览器', capability: '网页浏览' },
        ],
      });
      const withoutCliCapabilities = result.replace(
        /<cli_capabilities>[\s\S]*?<\/cli_capabilities>/,
        '',
      );
      for (const name of concreteCapabilityNames) {
        expect(withoutCliCapabilities).not.toContain(name);
      }
    }
  });

  it('subagent catalog exposes role facts without duplicating dispatch parameters ', () => {
    const section = buildSubagentCatalogSection([
      {
        name: '代码审阅者',
        description: '检查代码质量',
        subagentType: 'reviewer',
        templateId: 'template-1',
      },
    ]);
    expect(section).toContain('模板标识：template-1');
    expect(section).not.toMatch(/\b(?:task|role|template_id)\b/);
  });

  it('omits cli_capabilities when not provided', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).not.toContain('<cli_capabilities>');
  });

  it('omits tools_reference even when tools are provided ', () => {
    const result = buildSystemPrompt({ tools: MOCK_TOOLS });
    expect(result).not.toContain('<tools_reference>');
    expect(result).not.toContain('## 工具分类（按用途）');
  });

  it('handles empty tools list gracefully', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).not.toContain('<tools_reference>');
  });

  it('section order: principle before safety before common rules, mode sections, and environment tail', () => {
    const result = buildSystemPrompt({
      customRules: 'Be nice',
      userPortrait: SAMPLE_PORTRAIT_MD,
      tools: MOCK_TOOLS,
      agentMode: 'agent',
    });

    const principleIdx = result.indexOf('<principle>');
    const environmentIdx = result.indexOf('<environment>');
    const customRulesIdx = result.indexOf('<custom_rules>');
    const executionIdx = result.indexOf('<execution>');
    const safetyIdx = result.indexOf('<safety>');
    const planningIdx = result.indexOf('<planning>');
    const portraitIdx = result.indexOf('<user_portrait>');
    const subagentIdx = result.indexOf('<subagent_orchestration>');

    expect(principleIdx).toBeLessThan(safetyIdx);
    expect(safetyIdx).toBeLessThan(customRulesIdx);
    expect(customRulesIdx).toBeLessThan(planningIdx);
    expect(planningIdx).toBeLessThan(portraitIdx);
    expect(portraitIdx).toBeLessThan(executionIdx);
    expect(executionIdx).toBeLessThan(subagentIdx);
    expect(environmentIdx).toBeGreaterThan(subagentIdx);
  });

  it('uses static sections from generated content', () => {
    // 2026-05-21 阶段 6.7 议题 1：SECTION_ASK_USER_TOOLS / SECTION_SKILLS_USAGE 已删。
    // ：SECTION_SKILLS_USER_VOICE 已删。
    const result = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    expect(result).toContain(SECTION_EXECUTION);
    expect(result).toContain(SECTION_SAFETY);
    expect(result).toContain(SECTION_PLANNING);
    expect(result).not.toContain('<skills_user_voice>');
  });

  // ── : planning 段注入多任务上下文消歧（短修正句修饰最近未完成任务）──
  it('planning section carries  short-followup disambiguation hint', () => {
    const result = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    expect(result).toContain('短修正句');
    expect(result).toContain('最近一个尚未完成的任务');
    // 消歧优先级锚点：用户显式目标 > 任务清单当前进行项
    expect(result).toContain('任务清单里最近的进行项');
    expect(result).not.toContain('present_task_episode');
    expect(result).not.toContain('in_progress');
    // 拿不准时确认，不要默认往老任务靠
    expect(result).toContain('拿不准时简短确认一句');
    // planning 段在所有 mode 都注入，plan mode 也应带消歧提示
    const planResult = buildSystemPrompt({ tools: [], agentMode: 'plan' });
    expect(planResult).toContain('短修正句');
  });

  it('requires conflicting todos to be replaced before following a changed goal', () => {
    const result = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    expect(result).toContain('调用任何后续工具前，先更新任务清单');
    expect(result).toContain('关闭、替换或改写与新目标冲突的未完成项');
    expect(result).toContain('不得继续驱动能力召回或执行路径');
  });

  it('execution section uses canonical tool names only', () => {
    // 真正已退役的工具名（仅作 alias 提示，LLM 误用时会被纠正，不应在 system prompt 里写出）
    const retiredToolNames = /`(?:bash|web_fetch|skills\.search)`/;
    expect(SECTION_EXECUTION).not.toContain('skills.search');
    expect(SECTION_EXECUTION).not.toMatch(retiredToolNames);
  });

  it('execution section carries repetition + ask-answer + retry rules (议题 1 合并)', () => {
    // 2026-05-21 阶段 6.7 议题 1：原 ask_user_tools 段已删，Agent 协作节奏约束
    // ("一次回复最多调一次"/"不要再问同一个问题"/"答案能上下文推断时直接做") 全部
    // 搬到 execution。execution 现在是 Agent 整体行为约束的单一 SSoT。
    expect(SECTION_EXECUTION).toContain('不要以相同输入重复失败的动作');
    expect(SECTION_EXECUTION).toContain('每次回复最多发起一次需要用户即时作答的交互');
    expect(SECTION_EXECUTION).toMatch(/不要再问同一个问题/);
    expect(SECTION_EXECUTION).not.toContain('tool-logs/');
  });

  it('execution section defines truthful, low-noise progress updates ', () => {
    expect(SECTION_EXECUTION).toContain('## 进度同步');
    expect(SECTION_EXECUTION).toContain('进度同步不是最终交付');
    expect(SECTION_EXECUTION).toContain('不要让用户长时间看不到进展');
    expect(SECTION_EXECUTION).toContain('已经发生的事实、得到的关键证据和紧接着要做的事');
    expect(SECTION_EXECUTION).toContain('不要把预计结果说成已完成');
    expect(SECTION_EXECUTION).not.toContain('每次工具调用');
  });

  it('merges the documented operating loop into principle ', () => {
    const principle = buildPrincipleSection();
    expect(principle).toContain('<principle>');
    expect(principle).toContain('## 每轮操作循环');
    expect(principle).toContain('平台安全与权限边界');
    expect(principle).toContain('当前实际可用的能力');
    expect(principle).toContain('先理解它的职责、周边上下文、既有约定和可复用能力');
    expect(principle).toContain('确认没有形成平行体系');
    expect(principle).toContain('不得虚构能力或执行结果');
    expect(principle).toContain('验证强度与失败成本相称');
    expect(principle).toContain('任务才算完成');
    expect(principle).not.toContain('<operating_loop>');
    expect(principle).not.toMatch(/\b(?:App|MCP|CLI)\b|tabtin|浏览器|本地文件/);
    expect(SECTION_EXECUTION).not.toContain('## 每轮操作循环');
  });

  it('execution section requires user-facing times in device timezone ', () => {
    expect(SECTION_EXECUTION).toContain('## 面向用户写时间');
    expect(SECTION_EXECUTION).toContain('current_datetime');
    expect(SECTION_EXECUTION).toContain('禁止');
    expect(SECTION_EXECUTION).toMatch(/裸 UTC|ISO/);
  });

  it('execution section stays capability-neutral instead of restoring a tool encyclopedia', () => {
    // ：具体路由留给动态 apps / tools，不复制具体命令、参数和 description。
    expect(SECTION_EXECUTION).not.toContain('## 工具路由决策');
    expect(SECTION_EXECUTION).not.toContain('TabTin 业务能力 vs FC 边界');
    expect(SECTION_EXECUTION).not.toContain('tabtin mcp list-servers');
    expect(SECTION_EXECUTION).not.toContain('tabtin file create');
    expect(SECTION_EXECUTION).not.toContain('tabtin fetch <url>');
    expect(SECTION_EXECUTION).not.toContain('web_search');
    expect(buildSystemPrompt({ tools: [], agentMode: 'agent' })).not.toContain('## 工具路由决策');
  });

  it('execution section stays free of detailed skill / CLI / App business knowledge ', () => {
    // 具体业务知识仍归工具 description、skills index 和 cli_capabilities。
    expect(SECTION_EXECUTION).not.toContain('## 用 Skills 不要重新发明');
    expect(SECTION_EXECUTION).not.toContain('## 浏览器 CLI 结果契约');
    expect(SECTION_EXECUTION).not.toContain('先选 App，再选 skill');
    expect(SECTION_EXECUTION).not.toContain('skill_invoke');
    expect(SECTION_EXECUTION).not.toContain('skills_read');
    expect(SECTION_EXECUTION).not.toContain('skills_search');
    expect(SECTION_EXECUTION).not.toContain('CLI 操作手册');
    expect(SECTION_EXECUTION).not.toMatch(/\btabtin\b/);
    expect(SECTION_EXECUTION).not.toContain('observed_elements');
    expect(SECTION_EXECUTION).not.toContain('browser print');
    expect(SECTION_EXECUTION).not.toContain('browser open');
    expect(SECTION_EXECUTION).not.toContain('full_output_path');
  });

  it('apps section does not hardcode stale app CLI examples', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      agentMode: 'agent',
      enabledApps: [
        {
          key: 'tabweb',
          cliKey: 'browser',
          displayName: '浏览器',
          capability: '网页浏览与采集',
        },
      ],
    });

    expect(prompt).toContain('<apps>');
    expect(prompt).toContain('tabtin <cliKey> --help');
    expect(prompt).toContain('tabtin commands');
    expect(prompt).not.toContain('## 用 CLI 操作 App');
    expect(prompt).not.toContain('## App 没装怎么办');
    expect(prompt).not.toContain('## 关于 "App 首页"');
    expect(prompt).not.toContain('### 子命令与参数怎么填');
    expect(prompt).not.toContain('示例：');
    expect(prompt).not.toContain('tabtin browser open --url https://example.com');
    expect(prompt).not.toContain('tabtin browser open <url>');
    expect(prompt).not.toContain('tabtin ppt');
  });

  it('CLI parameter guidance lives in cli_capabilities, not apps ', () => {
    const appsSection = buildAppsSection([
      { key: 'tabweb', cliKey: 'browser', displayName: '浏览器', capability: '网页浏览与采集' },
    ]);
    expect(appsSection).toContain('`<cli_capabilities>`');
    expect(appsSection).toContain('tabweb');
    expect(appsSection).toContain('`browser`');
    expect(appsSection).not.toContain('大段文本 / JSON / Markdown');
    expect(appsSection).not.toContain('error.message');
    expect(appsSection).not.toContain('通用全局参数');
  });

  it('apps section is the App routing entrypoint without skill workflow guidance', () => {
    const section = buildAppsSection([
      { key: 'tabdoc', cliKey: 'doc', displayName: '文档', capability: '长文档' },
    ]);

    expect(section).toContain('选择把用户需求落到哪个 App');
    expect(section).not.toContain('skill description 只判断');
    expect(section).not.toContain('先选 App，再按意图选 skill 入口');
    expect(section).not.toContain('## App 选型矩阵');
  });

  it('#3844：apps 段显式写清「未列出的 App 不要硬试 CLI」', () => {
    const section = buildAppsSection([
      { key: 'tabdoc', cliKey: 'doc', displayName: '文档', capability: '长文档' },
    ]);
    expect(section).toContain('**不要**硬试');
    expect(section).toContain('not installed');
    expect(section).toContain('不要静默换通道');
  });

  it('offload guidance lives in its own tail section, only shipped to main agent ', () => {
    // ：卸载编排指引从 <execution> 抽成独立 <subagent_orchestration> 段，
    // 后移到 mode-specific tail，只对非 worker 注入。目的是让主 Agent 与 worker 子 Agent 的
    // execution 及其后所有静态段逐字一致，最大化隐式前缀缓存的共享前缀。
    expect(SECTION_SUBAGENT_ORCHESTRATION).toContain('## 用子 Agent 卸载上下文');
    expect(SECTION_SUBAGENT_ORCHESTRATION).toContain('resume_agent_id');
    expect(SECTION_SUBAGENT_ORCHESTRATION).not.toContain('wait_agent_ids');
    // execution 段已不含卸载编排指引，主 / 子共用同一份。
    expect(SECTION_EXECUTION).not.toContain('## 用子 Agent 卸载上下文');
    expect(SECTION_EXECUTION).not.toContain('resume_agent_id');
    // markdown 注释标记不允许泄漏进任何段（LLM 可见文本必须干净）。
    expect(SECTION_EXECUTION).not.toContain('context-offload');
    expect(SECTION_SUBAGENT_ORCHESTRATION).not.toContain('context-offload');

    const main = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    const worker = buildSystemPrompt({ tools: [], agentMode: 'agent', subagentWorker: true });
    expect(main).toContain('## 用子 Agent 卸载上下文');
    expect(worker).not.toContain('## 用子 Agent 卸载上下文');
    // 卸载编排段必须位于 planning 之后，并保持 agent/worker 差异落在尾部。
    expect(main.indexOf('<subagent_orchestration>')).toBeGreaterThan(main.indexOf('<planning>'));
  });

  it('main and worker agent prompts differ only by orchestration while environment remains the tail ', () => {
    //  / release/260812：<environment> 含会话变量，必须继续留在尾部以保护
    // 稳定前缀缓存；主 Agent 额外携带的 <subagent_orchestration> 因此位于
    // execution 与 environment 之间。差异内容仍只有 orchestration 段。
    const main = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    const worker = buildSystemPrompt({ tools: [], agentMode: 'agent', subagentWorker: true });
    const orchestration = `\n\n${SECTION_SUBAGENT_ORCHESTRATION}`;
    expect(main.replace(orchestration, '')).toBe(worker);
    expect(main.indexOf('<subagent_orchestration>')).toBeGreaterThan(main.indexOf('<execution>'));
    expect(main.indexOf('<environment>')).toBeGreaterThan(main.indexOf('<subagent_orchestration>'));
  });

  it('subagent orchestration injection matrix: agent/group only, never worker or plan', () => {
    const agent = buildSystemPrompt({ tools: [], agentMode: 'agent' });
    const group = buildSystemPrompt({ tools: [], agentMode: 'group' });
    const plan = buildSystemPrompt({ tools: [], agentMode: 'plan' });
    const worker = buildSystemPrompt({ tools: [], agentMode: 'agent', subagentWorker: true });

    expect(agent).toContain('<subagent_orchestration>');
    expect(group).toContain('<subagent_orchestration>');
    expect(plan).not.toContain('<subagent_orchestration>');
    expect(worker).not.toContain('<subagent_orchestration>');
  });

  it('apps section renders app list as a Markdown table without duplicating CLI subcommands', () => {
    const section = buildAppsSection([
      {
        key: 'tabdoc',
        cliKey: 'doc',
        displayName: '文档',
        capability: '富文本协作文档',
        aliases: ['doc'],
      },
      { key: 'tabweb', cliKey: 'browser', displayName: '浏览器', capability: '网页浏览' },
    ]);
    expect(section).toContain('| App | Key | CLI | 能力 | 别名 |');
    expect(section).toContain('| --- | --- | --- | --- | --- |');
    expect(section).toContain('| 文档 | `tabdoc` | `doc` | 富文本协作文档 | doc |');
    expect(section).toContain('| 浏览器 | `tabweb` | `browser` | 网页浏览 | — |');
    expect(section).not.toContain('常用子命令');
    expect(section).not.toContain('list / create / read');
  });

  it('safety section grades URL provenance and forbids guessing deep paths', () => {
    expect(SECTION_SAFETY).toContain('不要猜 URL');
    expect(SECTION_SAFETY).toContain('先搜索确认官方来源');
    // 搜索不可用时的分级兜底：允许知名站点域名首页 + 页内真实链接导航。
    expect(SECTION_SAFETY).toContain('域名首页');
    expect(SECTION_SAFETY).toContain('不得自行拼接或猜测子路径');
    expect(SECTION_SAFETY).toContain('让用户提供完整 URL');
  });

  it('keeps todo lifecycle protocol out of the planning strategy section ', () => {
    expect(SECTION_PLANNING).toContain('只在预期会产生长上下文的任务上建清单');
    expect(SECTION_PLANNING).toContain('列表未关闭前不得结束回复');
    expect(SECTION_PLANNING).not.toContain('add` / `update` / `remove');
    expect(SECTION_PLANNING).not.toContain('completed/cancelled 后自动关闭');
    expect(SECTION_PLANNING).not.toContain('新计划必须先关闭');
  });

  it('no longer ships skills_user_voice system section ', () => {
    expect(buildSystemPrompt({ tools: [], agentMode: 'agent' })).not.toContain(
      '<skills_user_voice>',
    );
    expect(SECTION_EXECUTION).not.toContain('先选 App，再选 skill');
  });

  it('never includes agent_memory_capability', () => {
    const result = buildSystemPrompt({ tools: [], memoryCapability: true });
    expect(result).not.toContain('<agent_memory_capability>');
  });

  // ── work_mode section (code/doc/mixed default execution strategy) ────

  it('omits work_mode by default (no workingDirType)', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).not.toContain('<work_mode');
  });

  it('includes code work_mode with code-project execution defaults', () => {
    const result = buildSystemPrompt({ tools: [], workingDirType: 'code' });
    expect(result).toContain('<work_mode type="code">');
    expect(result).toContain('</work_mode>');
    expect(result).toContain('代码项目');
    // 关键行为默认：构建/测试收尾 + 慎对 git/不可逆
    expect(result).toContain('git');
  });

  it('renders the host-owned worktree routing section', () => {
    const result = buildWorktreeRoutingSection();

    expect(result).toContain('`tabtin code worktree create`');
    expect(result).toContain('`tabtin code worktree switch`');
    expect(result).toContain('不得直接执行 `git worktree` 或仓库脚本');
    expect(result).toContain('Skill');
    expect(result).toContain('转换为上述 TabTin CLI');
    expect(result).toContain('用户未指定路径时不要添加 `--path`');
    expect(result).toContain('必须在前台等待命令完成');
  });

  it.each([undefined, 'code', 'mixed', 'doc'] as const)(
    'leaves worktree routing out of the host-neutral base prompt (%s)',
    (workingDirType) => {
      const result = buildSystemPrompt({ tools: [], workingDirType });
      expect(result).not.toContain('<worktree_routing>');
    },
  );

  it('includes doc work_mode with document-project execution defaults', () => {
    const result = buildSystemPrompt({ tools: [], workingDirType: 'doc' });
    expect(result).toContain('<work_mode type="doc">');
    expect(result).toContain('文档');
    expect(result).toContain('保护原始材料');
  });

  it('includes mixed work_mode with adaptive execution defaults', () => {
    const result = buildSystemPrompt({ tools: [], workingDirType: 'mixed' });
    expect(result).toContain('<work_mode type="mixed">');
    expect(result).toContain('混合');
  });

  it('work_mode does not relax enforced security (no permission grants in prompt)', () => {
    // 校准三：work_mode 只设行为默认，绝不放权。三档都不应出现"放开权限/无需确认/
    // 完全自主"这类放松强制安全的措辞。
    for (const t of ['code', 'doc', 'mixed'] as const) {
      const result = buildSystemPrompt({ tools: [], workingDirType: t });
      expect(result).not.toMatch(/无需确认|放开权限|完全自主|超级权限/);
    }
  });

  it('work_mode is positioned after custom_rules', () => {
    const result = buildSystemPrompt({
      customRules: 'Be polite',
      workingDirType: 'code',
      tools: MOCK_TOOLS,
    });
    const customIdx = result.indexOf('<custom_rules>');
    const workModeIdx = result.indexOf('<work_mode');
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(workModeIdx).toBeGreaterThan(customIdx);
  });

  it('work_mode works in plan mode (present even without execution section)', () => {
    const result = buildSystemPrompt({
      tools: [],
      workingDirType: 'code',
      agentMode: 'plan',
    });
    expect(result).toContain('<work_mode type="code">');
    expect(result).not.toContain('<execution>');
  });

  // ── M1.4: user_portrait section ─────────────────────────────────────

  const SAMPLE_PORTRAIT_MD = `## 工作背景\nUncle 是 Tabtin 创始人。\n\n## 个人背景\nUncle 即将 30 岁。\n\n## 最近在想\nUncle 在思考记忆系统。\n\n## 近期历史\nUncle 最近完成 PRD。\n\n## 长期背景\nUncle 对 AI Agent 架构有长期兴趣。`;

  it('omits user_portrait by default', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).not.toContain('<user_portrait>');
  });

  it('omits user_portrait when userPortrait is empty string', () => {
    const result = buildSystemPrompt({ tools: [], userPortrait: '' });
    expect(result).not.toContain('<user_portrait>');
  });

  it('omits user_portrait when userPortrait is whitespace only', () => {
    const result = buildSystemPrompt({ tools: [], userPortrait: '   \n\t  ' });
    expect(result).not.toContain('<user_portrait>');
  });

  it('includes user_portrait when content provided', () => {
    const result = buildSystemPrompt({
      tools: [],
      userPortrait: SAMPLE_PORTRAIT_MD,
    });
    expect(result).toContain('<user_portrait>');
    expect(result).toContain('</user_portrait>');
    expect(result).toContain('Uncle 是 Tabtin 创始人');
    expect(result).toContain('Uncle 在思考记忆系统');
  });

  it('user_portrait section contains anti-leak system note', () => {
    const result = buildSystemPrompt({
      tools: [],
      userPortrait: SAMPLE_PORTRAIT_MD,
    });
    // 防泄露语：避免 LLM 说"我从你的档案里看到..."
    expect(result).toContain('不要**明说');
    // 冲突时优先用户当前消息
    expect(result).toContain('以用户当前消息为准');
  });

  it('user_portrait is positioned after common sections and before mode-specific sections', () => {
    const result = buildSystemPrompt({
      customRules: 'Be polite',
      userPortrait: SAMPLE_PORTRAIT_MD,
      tools: MOCK_TOOLS,
    });
    const environmentIdx = result.indexOf('<environment>');
    const customRulesIdx = result.indexOf('<custom_rules>');
    const planningIdx = result.indexOf('<planning>');
    const executionIdx = result.indexOf('<execution>');
    const subagentIdx = result.indexOf('<subagent_orchestration>');
    const portraitIdx = result.indexOf('<user_portrait>');
    expect(environmentIdx).toBeGreaterThanOrEqual(0);
    expect(portraitIdx).toBeGreaterThan(customRulesIdx);
    expect(portraitIdx).toBeGreaterThan(planningIdx);
    expect(executionIdx).toBeGreaterThan(portraitIdx);
    expect(subagentIdx).toBeGreaterThan(executionIdx);
  });

  it('user_portrait remains present when memory capability is enabled', () => {
    const result = buildSystemPrompt({
      tools: [],
      userPortrait: SAMPLE_PORTRAIT_MD,
      memoryCapability: true,
    });
    expect(result).toContain('<user_portrait>');
    expect(result).not.toContain('<agent_memory_capability>');
  });

  it('user_portrait works in plan mode', () => {
    const result = buildSystemPrompt({
      tools: [],
      userPortrait: SAMPLE_PORTRAIT_MD,
      agentMode: 'plan',
    });
    expect(result).toContain('<user_portrait>');
    expect(result).toContain('<agent_mode>');
    expect(result.indexOf('<agent_mode>')).toBeGreaterThan(result.indexOf('<user_portrait>'));
    expect(result).not.toContain('<execution>');  // plan mode 跳过 execution
  });

  it('includes environment terms but omits shell_runtime / platform_data by default (no runtimeIdentity)', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).toMatch(/^<environment>/m);
    expect(result).toContain('## 术语');
    expect(result).not.toMatch(/^<shell_runtime>/m);
    expect(result).not.toMatch(/^<platform_data>/m);
    // 旧段名也不应再泄露
    expect(result).not.toContain('<runtime_identity>');
    // 等价的语义检查：runtime identity 字段不出现
    expect(result).not.toContain('组织：');
  });

  it('includes environment / shell_runtime / platform_data when host supplies runtimeIdentity', () => {
    const result = buildSystemPrompt({
      tools: [],
      runtimeIdentity: {
        organizationId: 'wt-789',
        spaceId: 'space-abc',
        threadId: 'sess-xyz',
        workspaceRoot: '/sandbox/agent-spaces/wt-789/space-abc',
        archiveDir: '/conversations/wt-789/space-abc/sessions',
        toolLogsDir: '/conversations/wt-789/space-abc/tool-logs',
      },
    });
    // <environment>：组织 / 工作空间 / 会话；#7810 起不再贴工作目录绝对路径
    // 2026-05-20 P3 audit 抓出英文 label → 中文化（组织/会话）
    expect(result).toContain('<environment>');
    expect(result).toContain('组织：       wt-789');
    expect(result).toContain('工作空间：  space-abc');
    expect(result).toContain('会话：       sess-xyz');
    expect(result).toContain('## 环境变量');
    expect(result).toContain('- `TABTIN_WORKSPACE`');
    expect(result).not.toContain('工作目录：   /sandbox/agent-spaces/wt-789/space-abc');
    expect(result).not.toContain('/sandbox/agent-spaces/wt-789/space-abc');
    // <shell_runtime>：无 shellInfo 时为 shell 中性 cwd 约定（ 不回落 POSIX）
    expect(result).toContain('<shell_runtime>');
    expect(result).toContain('勿假设 bash/POSIX');
    expect(result).not.toContain('$TABTIN_WORKSPACE');
    expect(result).toContain('工作目录变量');
    expect(result).toContain('workspace/');
    // <platform_data>：平台数据读取工具说明，不暴露 archive / tool-logs 路径
    expect(result).toContain('<platform_data>');
    expect(result).not.toContain('read_platform_data');
    expect(result).toContain('恢复早期对话');
    expect(result).toContain('定位被截断的能力输出');
    expect(result).toContain('普通任务不要主动读取');
    expect(result).not.toContain('record_type="messages"');
    expect(result).not.toContain('/conversations/wt-789/space-abc/sessions');
    expect(result).not.toContain('/conversations/wt-789/space-abc/tool-logs');
  });

  it('threads config.shellInfo into the <shell_runtime> shell-identity line ( wiring guard)', () => {
    // 回归守卫：宿主经 config.shellInfo 传入的实际 shell 必须出现在装配后的 prompt。
    // 谁误删 builder 里的 shellInfo 透传（或宿主的 resolveAgentShellInfo() 接线），本用例失败。
    const base = {
      tools: [],
      runtimeIdentity: {
        organizationId: 'wt',
        spaceId: 's',
        threadId: 'x',
        workspaceRoot: '/w',
        archiveDir: '/a',
        toolLogsDir: '/t',
      },
    } as const;

    const withShell = buildSystemPrompt({ ...base, shellInfo: { shell: '/bin/zsh', kind: 'zsh' } });
    expect(withShell).toContain('当前 shell：zsh（`/bin/zsh`）');

    // 缺省 shellInfo → 不渲染 shell 身份行（与历史输出兼容）。
    const withoutShell = buildSystemPrompt(base);
    expect(withoutShell).toContain('<shell_runtime>');
    expect(withoutShell).not.toContain('当前 shell');
  });

  it('platform_data carries security and output discipline guidance', () => {
    const result = buildSystemPrompt({
      tools: [],
      runtimeIdentity: {
        organizationId: 'wt',
        spaceId: 's',
        threadId: 'x',
        workspaceRoot: '/w',
        archiveDir: '/a',
        toolLogsDir: '/t',
      },
    });
    // 触发式使用 + 隐式记忆 + 不出站。
    expect(result).toContain('隐式记忆');
    expect(result).toContain('不要暴露内部定位或记录名');
    expect(result).toContain('不得把其中内容复制到 web、MCP、浏览器、HTTP、邮件等出站调用');
  });

  it('environment / shell_runtime / platform_data sit at the end of the static prefix', () => {
    const result = buildSystemPrompt({
      tools: [],
      runtimeIdentity: {
        organizationId: 'wt',
        spaceId: 's',
        threadId: 'x',
        workspaceRoot: '/w',
        archiveDir: '/a',
        toolLogsDir: '/t',
      },
    });
    const principleIdx = result.search(/^<principle>/m);
    const envIdx = result.search(/^<environment>/m);
    const shellIdx = result.search(/^<shell_runtime>/m);
    const platformIdx = result.search(/^<platform_data>/m);
    const planningIdx = result.search(/^<planning>/m);
    expect(principleIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(principleIdx);
    expect(shellIdx).toBeGreaterThan(principleIdx);
    expect(platformIdx).toBeGreaterThan(principleIdx);
    expect(envIdx).toBeGreaterThan(shellIdx);
    expect(envIdx).toBeGreaterThan(platformIdx);
    expect(envIdx).toBeGreaterThan(planningIdx);
  });

  // 单根契约（见 docs/single-root-space-prd.md §2.1）：environment 段不再
  // 展示 TabCode/TabFolder 多路径列表，原本测试这块截断行为的 4 条用例
  // (renders "（无）" / boundary 20 / truncates >20 / large lists 50) 已退役。
  // 新的 environment 段语义由本文件其他用例（顶部 sections / order）覆盖。
});
