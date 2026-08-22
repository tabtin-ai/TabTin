/**
 * Capability 装配工具 —— 对应 M1 §3.5。
 *
 * 提供 2 个纯函数让宿主层（ElectronAgentHost / DaemonAgentHost）在
 * createSession 时把 N 个 Capability 装配进 EngineConfig：
 *
 *   1. `composeCapabilityHooks(caps)` —— 合并 hooks() 为单个 EngineHooks
 *   2. `prepareAgentTools(caps)` —— 收集 tools + name 冲突校验 + schema cache
 *
 * **历史**：曾有 `prepareAgentInstructions` / `prepareAgentSampling` 两个函数，
 * 阶段 2.3 / 2.4（2026-05-20）双双下线 —— Electron / Daemon 两条 host 路径均
 * 0 production caller。详见本文件 line 50 附近"阶段 2 清理"注释。
 *
 * **设计原则**：
 *   - **纯函数**：不持有状态，每次调用独立处理传入参数
 *   - **fail-fast**：所有校验失败立即抛错，不静默降级
 *   - **顺序敏感**：所有合并按 caps 列表顺序，"后者覆盖前者"是合并语义
 *
 * **零侵入 query.ts**：query.ts 完全感知不到 Capability 概念 —— 它
 * 看到的仍然是 EngineConfig.hooks 单一 EngineHooks、tools.getTools()
 * 返回合并后的 Tool[]、systemPrompt 是拼好的字符串。
 */

import type {
  ToolParam,
} from '../engine/contracts/conversation.js';
import type {
  Tool,
} from '../engine/contracts/tools.js';
import type {
  EngineHooks,
} from '../engine/contracts/kernel.js';
// W2.2.3 解耦：composeHooks SSoT 在 capability/hooks-compose.ts，原 middleware
// 路径只是 re-export 透传。Capability 子系统直接 import 单源版本，避免循环
// 依赖 + 让 W2.3 删 middleware 整目录时本文件零修改。
import { composeHooks } from '../engine/core/hooks-compose.js';
import type { Capability } from './capability.js';
import {
  CapabilityToolNameError,
  CapabilityToolsConflictError,
} from './errors.js';

// ─── 1. composeCapabilityHooks ──────────────────────────────────────

/**
 * 把 N 个 Capability 的 hooks() 结果合并成单个 EngineHooks。
 *
 * **复用现有 composeHooks**：它已经在生产中验证了"按顺序串行执行
 * 同名钩子"语义（SSoT 在 capability/hooks-compose.ts，W2.3 删 middleware
 * 整目录后此处直接 import 单源），M1 不重写。
 *
 * **顺序保证**（Charter DoD）：两个 Capability 的 `beforeIteration`
 * 按 caps 列表顺序执行 —— 第 1 个 Capability 的钩子在第 2 个之前。
 *
 * **空数组**：返回空 EngineHooks（所有字段都是空 async 函数），不抛错
 * —— 让宿主装配代码能用 `composeHooks(capHooks, ...legacyMiddlewares)`
 * 统一处理 0 / N 个 Capability 的情况。
 *
 * **null / undefined hooks() 返回值**：过滤掉，不进合并链。
 */
export function composeCapabilityHooks(caps: Capability[]): EngineHooks {
  const hooksList = caps
    .map((c) => c.hooks?.())
    .filter((h): h is EngineHooks => h != null);
  return composeHooks(...hooksList);
}

// ─── 2. prepareAgentTools ───────────────────────────────────────────

/**
 * Anthropic API 硬约束：tool name 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`。
 *
 * 对齐 packages/agent-runtime/src/engine/tool-system.ts 的现有校验。
 * 在装配期就拦下来，避免"装配通过但 LLM 调用 400"的诡异错误。
 */
const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * `prepareAgentTools` 的返回值。
 */
export interface PreparedTools {
  /**
   * 合并后的 Tool[]，按 caps 列表顺序保留 —— 顺序对 Anthropic prompt
   * cache 友好（同样的 caps 顺序产出同样的 tools 顺序）。
   */
  tools: Tool[];
  /**
   * Session-stable schema cache —— key = `${capType}:${toolName}`。
   *
   * 供宿主 / ToolRegistry 在本 session 内跳过重复 JSON Schema 渲染。
   * **谁负责消费**：
   *   - **Capability 实现者通常无需读** —— Capability tools handler 不接
   *     触 ToolParam 序列化，写 Tool 即可。
   *   - **宿主层负责消费**：ElectronAgentHost / DaemonAgentHost 在构造
   *     ToolProvider 时把这个 cache 与现有 ToolRegistry / `getStableToolParams`
   *     等入口对接（W2 实施工作），让 LLMRequest.tools 序列化在本
   *     session 内 idempotent + cache-friendly。
   *
   * key 形如 `'filesystem:list_directory'` —— 便于未来按 cap 维度做 invalidate
   * （例：某个 cap 被 reconfigure 后只清掉它的 schema）。
   */
  schemaCache: Map<string, ToolParam>;
}

/**
 * 收集 Capability 贡献的所有 tools + 三重校验。
 *
 * **三重校验**（fail-fast）：
 *   1. Tool name 格式 `^[a-zA-Z0-9_-]{1,64}$` → CapabilityToolNameError
 *   2. 跨 Capability name 冲突 → CapabilityToolsConflictError
 *   3. 同 Capability 内重复 name → 同上（fistCapType === secondCapType）
 *
 * **前置条件**：每个 Capability 的 `bind(session)` 已经调用过 ——
 * 否则 tools handler 内部访问 session 会 NPE。这是 Capability 契约，
 * 不在本函数校验。
 *
 * **顺序保留**：tools 数组按 caps 列表顺序拼接，每个 Capability 内
 * 部按其 tools() 返回顺序。
 */
export function prepareAgentTools(caps: Capability[]): PreparedTools {
  const tools: Tool[] = [];
  const schemaCache = new Map<string, ToolParam>();
  /** tool name → 贡献它的 cap.type，用于冲突检测时给出双方位置 */
  const nameToSource = new Map<string, string>();

  for (const cap of caps) {
    const contributed = cap.tools?.() ?? [];
    for (const tool of contributed) {
      if (!TOOL_NAME_REGEX.test(tool.name)) {
        throw new CapabilityToolNameError(tool.name, cap.type);
      }
      const prev = nameToSource.get(tool.name);
      if (prev !== undefined) {
        throw new CapabilityToolsConflictError(tool.name, prev, cap.type);
      }
      nameToSource.set(tool.name, cap.type);
      tools.push(tool);

      const cacheKey = `${cap.type}:${tool.name}`;
      schemaCache.set(cacheKey, {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }
  }

  return { tools, schemaCache };
}

// 阶段 2 清理（2026-05-20）：删除 `prepareAgentInstructions` + `prepareAgentSampling`
// 两套装配函数（含函数 / 常量 / 类型 / 私有 helper / 相关测试）。
//
// **删除理由**（统一）：Electron / Daemon 两条 host 路径均 0 production caller
// （grep 全仓 `apps/` 0 命中）。两者属于 M1 时期 hook 抽象，现已无调用方。
// W2.3 实施后 Capability 只走 `composeCapabilityHooks` +
// `prepareAgentTools` 两件套即可装配进 EngineConfig。
//
// **后续若要恢复"cap 文案 → system prompt"机制**：走 `@tabtin/agent-prompt` 的
// `buildSystemPrompt` + `@tabtin/prompt-contract` 的注册表声明，而**不要**恢复
// 本文件曾经的 prepareAgentInstructions —— 避免又一层与 SECTION_REGISTRY 平行
// 的隐形 SSoT。同理 sampling_params 若要恢复，应走 EngineConfig 显式 sampling
// 字段而非 cap-by-cap deep merge 的隐式覆盖语义。
