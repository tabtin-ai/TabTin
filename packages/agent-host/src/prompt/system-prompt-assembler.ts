/**
 * 系统提示词装配的**权威真相源**（ /  Stage 2）。
 *
 * 段落顺序的 SSoT 一直在 `@tabtin/agent-prompt` 的 `buildSystemPrompt`；但
 * 「host 烘焙输入 → `SystemPromptConfig` 入参」这一步过去由每个 host 各自手抄：
 * Electron 抄 4 处（主 prompt / setSubagentSystemPrompt / mode 热切换闭包 /
 * 软切换），Daemon 抄 2 处。每加一个新段落，这些字面量都要同步补一遍，漏一处
 * 就缺一块——正是  记录的痛点。
 *
 * 本模块把宿主定为该步骤的唯一权威：host 只装配一次「创建期烘焙输入」
 * （`BakedSystemPromptInputs`），随后主 prompt、子 Agent 重烘焙、mode 热切换全部
 * 走 `assembleSystemPrompt`。「按变体（mode / tools）派生 config」的逻辑——包括
 * group-only 的 `subagentCatalog` 门控——只在这里出现一次。
 *
 * 加新段落时只需：在 `@tabtin/agent-prompt` 的 `SystemPromptConfig` 加字段 + 在
 * `buildSystemPrompt` 接顺序，然后各 host 在自己的 `BakedSystemPromptInputs` 里
 * 填一次数据源即可，不再有「一个字段抄 N 处」。
 */

import {
  buildSystemPrompt,
  type SystemPromptConfig,
  type ToolLike,
} from '@tabtin/agent-prompt';
import type { AgentModeName } from '@tabtin/agent-modes';

/**
 * 创建期「烘焙输入」——`SystemPromptConfig` 去掉每次构建才变的变体字段
 * （`agentMode` / `tools`）。host 在创建 runtime（或软切换 / 热切换）时组装一次，
 * 之后同一 session 内主 prompt / 子 Agent / mode 切换全部复用同一份。
 *
 * `subagentCatalog` 保留在烘焙输入里（原样携带），是否注入由
 * `assembleSystemPrompt` 按变体 mode 统一门控——host 不再自行判 `=== 'group'`。
 */
export type BakedSystemPromptInputs = Omit<SystemPromptConfig, 'agentMode' | 'tools'> & {
  /**
   * ：仅当宿主已把 personal rules 接入当前 user 前的动态 context 时设置。
   * 缺省保持原 system `<custom_rules>` 语义，避免未迁移宿主静默丢规则。
   */
  personalRulesPlacement?: 'pre-user-context';
};

/**
 * 权威装配：`烘焙输入 + 变体` → `SystemPromptConfig` → system prompt 字符串。
 *
 * 返回 `buildConfig` 供 host 交给 `toolProvider.setSubagentSystemPrompt`——子
 * Agent（readonly / ask）重烘焙时以它为基（见 `subagent-readonly.ts`）。
 * `customRules` 始终从 system 清除（，改走 agent-profile）。
 * `personalRules` 默认保留原 system 语义；只有宿主显式声明
 * `personalRulesPlacement: 'pre-user-context'` 时才清除。placement 不进入
 * `buildConfig`，但其结果会固化为 `buildConfig.personalRules`，因此 mode
 * switch / 子 Agent re-bake 与主 prompt 保持一致。
 *
 * **group-only 门控唯一落点**：只有 `variant.agentMode === 'group'` 时才把烘焙的
 * `subagentCatalog` 注入 config；其余 mode 一律置 `undefined`（`buildSystemPrompt`
 * 本身也只在 group 段注入，这里做前置门控让 config 语义自洽、且 host 不再重复该判断）。
 */
export function assembleSystemPrompt(
  baked: BakedSystemPromptInputs,
  variant: { agentMode: AgentModeName; tools: ToolLike[] },
): { systemPrompt: string; buildConfig: SystemPromptConfig } {
  const {
    personalRulesPlacement,
    ...promptInputs
  } = baked;
  const buildConfig: SystemPromptConfig = {
    ...promptInputs,
    personalRules: personalRulesPlacement === 'pre-user-context'
      ? undefined
      : baked.personalRules,
    // ：Agent custom rules 始终由动态 agent-profile 注入，不能在
    // soft reconfigure / mode switch / 子 Agent re-bake 时回到 system。
    customRules: undefined,
    agentMode: variant.agentMode,
    tools: variant.tools,
    subagentCatalog: variant.agentMode === 'group' ? baked.subagentCatalog : undefined,
  };
  return { systemPrompt: buildSystemPrompt(buildConfig), buildConfig };
}
