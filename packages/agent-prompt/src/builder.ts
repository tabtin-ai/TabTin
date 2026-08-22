import { getAgentModePromptSection } from '@tabtin/agent-modes';

import {
  SECTION_EXECUTION,
  SECTION_SAFETY,
  SECTION_PLANNING,
  SECTION_SUBAGENT_ORCHESTRATION,
} from './generated-content.js';
import {
  buildPrincipleSection,
  buildEnvironmentSection,
  buildShellRuntimeSection,
  buildPlatformDataSection,
  buildAppsSection,
  buildCustomRulesBlock,
  buildWorkModeSection,
  buildCliCapabilitiesSection,
  buildUserPortraitSection,
  buildSubagentCatalogSection,
} from './sections.js';
import { buildExecutionBoundaryPrompt } from './execution-boundary.js';
import type { ExecutionBoundaryInput } from './execution-boundary.js';
import type { SystemPromptConfig } from './types.js';

/**
 * Unified system prompt builder — single source of truth for all agent hosts
 * (Electron / Daemon / future Cloud Sandbox).
 *
 * Section order:
 *   principle → safety → [execution_boundary] →
 *   [shell_runtime] → [platform_data] → [apps] →
 *   custom_rules → [work_mode] →
 *   [cli_capabilities] → planning → [user_portrait] →
 *   [agent_mode] → [subagent_catalog] → [execution] → [subagent_orchestration] →
 *   [environment]
 *
 * subagent_orchestration 段只对 agent-mode 的非 worker（编排者）
 * 注入。它承载原 <execution> 内「用子 Agent 卸载上下文」编排指引；作为
 * mode-specific tail，放在 user_portrait 之后并保持 agent/worker 差异位于末尾。
 *
 * `<tools_reference>` 已于  下线。具体 FC 工具契约由各工具 description
 * 承载；CLI 能力继续由专门的 `<cli_capabilities>` 段承载。
 *
 * environment / shell_runtime / platform_data 三段是 2026-05-14 从原
 * `<runtime_identity>` 拆出来的：
 *   - environment   = "我现在在哪"（Organization / 工作空间 / Session；不贴工作目录绝对路径）
 *   - shell_runtime = "shell 工具默认 cwd + 工作目录路径环境变量约定"
 *   - platform_data = "archive / tool-logs 路径 + silent memory 用法 + 安全"
 *
 * user_portrait 段（M1.4）是"关于用户"的背景事实。它位于公共平台 / 规则段
 * 之后、mode-specific 段之前，避免把具体模式约束和长期用户画像混在一起。
 *
 * custom_rules 段保留 personal rules 的默认 system 语义。#6674 起，仅
 * Electron 显式 opt-in 后由 agent-profile hook 把 personal + Agent 自由文本
 * 统一放进当前真实 user 前；未 opt-in 的宿主继续在 system 携带 personal。
 * custom rules 则由  始终走 agent-profile，不应回到 system。
 *
 * **阶段 6.7 议题 1 治理（2026-05-21）—— 删 2 段 + 加 1 段**：
 *   - 删 `<ask_user_tools_usage>` 段（原 1693 字）—— 内容拆到 ask_user / ask_form /
 *     request_approval 三个工具 description（tier 升 medium），Agent 节奏约束搬
 *     `<execution>` 段。消除"3 处描述出入"造成的 Agent 决策混淆。
 *   - 删 `<skills_usage>` 段（原 3110 字）—— 工具用法拆到 4 个 skills 工具 description
 *     （`skill_create` tier 升 medium）。
 *   - 删 `<skills_user_voice>`—— 用户措辞 / description 边界 / relevant_skills
 *     说明并入静态 `<skills>` index header（agent-runtime `renderSkillNames`）。
 */
export function buildSystemPrompt(config: SystemPromptConfig & { executionBoundary?: ExecutionBoundaryInput }): string {
  const agentMode = config.agentMode ?? 'agent';
  const sections: string[] = [];

  sections.push(buildPrincipleSection());

  // 安全边界紧跟 principle，先建立平台硬约束，再进入环境、App、CLI 等能力上下文。
  sections.push(SECTION_SAFETY);

  if (config.executionBoundary) {
    sections.push(buildExecutionBoundaryPrompt(config.executionBoundary));
  }

  // 运行时上下文：environment 始终注入平台位置与术语；shell_runtime /
  // platform_data 需要 RuntimeIdentity。environment 含每个会话都变化的
  // threadId，后移到静态规则末尾，避免过早截断自动 prompt cache 的稳定前缀。
  const environmentSection = buildEnvironmentSection(config.runtimeIdentity);
  const shellRuntimeSection = buildShellRuntimeSection(config.runtimeIdentity, config.shellInfo);
  if (shellRuntimeSection) sections.push(shellRuntimeSection);
  const platformDataSection = buildPlatformDataSection(config.runtimeIdentity);
  if (platformDataSection) sections.push(platformDataSection);

  // <apps> 段：当前工作空间启用的 App 能力图谱。装配方未传 enabledApps 时跳过
  // ——保持对未升级 host 的 100% 兼容（但 Agent 答"你能做什么"时只能列工具
  // 而不能列 App）。
  const appsSection = buildAppsSection(config.enabledApps);
  if (appsSection) sections.push(appsSection);

  // 兼容 / 默认路径：直接调用 builder 时仍可渲染 personal/custom。host 的
  // assembleSystemPrompt 始终清 custom；仅显式 opt-in 的宿主再清 personal。
  const customRules = buildCustomRulesBlock({
    personalRules: config.personalRules,
    customRules: config.customRules,
  });
  if (customRules) sections.push(customRules);

  // <work_mode> 段：按 Agent 工作类型（code/doc/mixed）给默认执行策略指引。
  // 放在 custom_rules 之后——「用户硬规则 → 这是个什么项目、默认
  // 怎么干」紧邻成一组行为上下文。缺省 workingDirType 时返回空串自动跳过。
  const workModeSection = buildWorkModeSection(config.workingDirType);
  if (workModeSection) sections.push(workModeSection);

  // Tracker 意图识别 prompt 段（旧 SECTION_TRACKER_INTENT）已于 2026-05-10
  // Lane L 物理下线：W6 退役 Python BaseTool 后 create_tracked_task 不在
  // LLM 工具列表中，引导段无对应工具。Tracker 接通 CLI（tabtin tracker
  // create）时同步恢复 prompts/tracker_intent.md + 注入点。
  // ：原 SECTION_SKILLS_USER_VOICE 已删；skill 用户措辞 / description 边界 /
  // relevant_skills 说明并入静态 `<skills>` index header。

  const cliSection = buildCliCapabilitiesSection(config.cliReference);
  if (cliSection) sections.push(cliSection);

  sections.push(SECTION_PLANNING);

  // M1.4: USER 画像段（"你是什么样的用户"）。放在公共平台 / 规则段之后、
  // mode-specific 段之前，使长期用户背景和具体运行模式各自成组。
  const userPortraitSection = buildUserPortraitSection(config.userPortrait);
  if (userPortraitSection) sections.push(userPortraitSection);

  const agentModeSection = getAgentModePromptSection(agentMode);
  if (agentModeSection) sections.push(agentModeSection);

  // group 模式：在 agent_mode 段之后注入当前工作空间可复用的子 Agent 角色库，
  // 让主 Agent 组队时优先选用现成角色。非 group / 空 catalog 自动跳过。
  if (agentMode === 'group') {
    const catalogSection = buildSubagentCatalogSection(config.subagentCatalog);
    if (catalogSection) sections.push(catalogSection);
  }

  if (agentMode === 'agent') {
    // execution 段主 / 子 Agent 共用同一份——「用子 Agent 卸载上下文」编排指引已
    // 抽成独立 <subagent_orchestration> 段（下方）。mode-specific 段整体放在
    // user_portrait 之后；主 / 子差异仍全部后移到尾部。
    sections.push(SECTION_EXECUTION);
  }

  // <subagent_orchestration> 段：「用子 Agent 卸载上下文」编排指引，从 <execution>
  // 抽出后置于 mode-specific tail。对**非 worker**（编排者）的 agent / group 模式注入——
  // group（PMO）恰是最依赖派发的模式，同样需要批量取证优先、责任域不重叠、
  // 工具面勿过度收窄等派发效率规则。
  // 后移动机：worker 子 Agent 与主 Agent 的唯一静态段差异就是这一段，放到
  // 末尾后，两者前面所有段逐字一致，隐式前缀缓存可共享到尾部。worker 子
  // Agent 的「不要再生成子 Agent」纪律由 fork-query 的 SUBAGENT_WORKER_SYSTEM_SECTION
  // 承载，不依赖此段的缺席。
  if ((agentMode === 'agent' || agentMode === 'group') && !config.subagentWorker) {
    sections.push(SECTION_SUBAGENT_ORCHESTRATION);
  }

  if (environmentSection) sections.push(environmentSection);

  return sections.filter(Boolean).join('\n\n');
}
