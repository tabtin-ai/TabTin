/**
 * Fork Query — spawn a child agent query from a parent context.
 *
 * Mirrors Django's fork_context.py fork pattern:
 *   1. buildForkedMessages: deep-copy parent messages, replace tool_result
 *      content with a uniform placeholder (maximise prompt cache hits),
 *      append a directive user message with fork boilerplate.
 *   2. filterIncompleteToolCalls: strip assistant tool_use blocks that
 *      lack a matching tool_result to satisfy the Anthropic API invariant.
 *   3. forkQuery: wire up a child runtime and run an independent query()
 *      loop, yielding StreamEvents and returning the final text summary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  StreamEvent,
  DoneEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
} from '../engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../engine/contracts/conversation.js';
import type {
  ModelCapabilities,
  LLMProvider,
} from '../engine/contracts/model-llm.js';
import type {
  ToolProvider,
} from '../engine/contracts/tools.js';
import type {
  EnginePermissionHandler,
} from '../engine/contracts/hitl.js';
import type {
  SessionConfig,
} from '../engine/contracts/context-capability.js';
import type {
  EngineConfig,
  EngineHooks,
} from '../engine/contracts/kernel.js';
import { ContentBlockEvents, StreamEvents } from '../engine/contracts/stream-events.js';
import type { InheritMode, SubAgentPolicyDto } from '../engine/contracts/wire-payloads.js';
import type { BudgetTracker } from '../engine/guards/budget-tracker.js';
import type { ToolResultStorage } from '../engine/tooling/tool-result-storage.js';
import { createRuntime } from '../runtime-assembly.js';
import { SessionStorage } from '../session/storage.js';
import { SnapshotStorage } from '../session/snapshot-storage.js';
import { EventStorage } from '../session/event-storage.js';
import { SubagentIndexWriter } from '../session/subagent-index.js';
import { createSubagentUserInteractiveChannel } from '../permissions/subagent-hitl.js';
import { composeHooks } from '../engine/core/hooks-compose.js';
import {
  buildParentMidflightInjectorHook,
  PARENT_MIDFLIGHT_TRIGGERED_BY,
} from './parent-midflight-injector.js';

// ─── Constants ───────────────────────────────────────────────────────

export const FORK_PLACEHOLDER_RESULT = 'Fork 已启动——正在后台处理';

/**
 * `buildForkedMessages` 的内部默认 inheritMode（决策 1 /  方案 C，2026-06-26）。
 *
 * 子 Agent 只接受父 Agent 派送的 task prompt，不继承父对话历史。根因：filtered
 * 继承会把父原文（"调N个agent做X"）灌进子 Agent 上下文，弱模型被父原文带跑、
 * 思考被污染（dogfood  补充证据：子 Agent thinking 里纠结父原文 vs 自己
 * 的 <active-directive>）。none 模式从源头掐断父原文泄漏，三级嵌套
 * （MAX_SUBAGENT_DEPTH=2）在此保护下可安全保留。生产路径 `agent-tool.ts::execute`
 * 也显式传 'none'，本常量是函数内部 fallback 的单点定义，避免直接调用方
 * （测试 / 极端 caller）不传值时各处硬编码漂移。
 *
 * 如需测 'filtered' / 'full' 行为请显式传 `inheritMode`。
 */
export const DEFAULT_INHERIT_MODE: InheritMode = 'none';

/**
 * 子 Agent 工作纪律——注入**子 Agent 的 system prompt**（不再作为 user 消息塞进
 * 对话历史）。
 *
 * 决策（2026-07-04）：子 Agent 的消息体只保留「主 Agent 派的 task」，worker 纪律
 * （你是 fork 子进程、一次性汇报、别再派子、静默执行、范围内工作）全部移进 system
 * prompt——这样子 Agent 的输入 = system prompt + 父给的 task，不掺任何父会话背景、
 * 也不再有 `<fork-boilerplate>` / `<active-directive>` 包裹噪音。
 *
 * **设计原则：绝不硬编码回报格式。** 子 Agent 服务所有场景（写代码 / 做表 / 剪视频
 * / 查资料…），回报什么、什么格式完全由主 Agent 的 task 决定（由主 Agent task 决定；Task
 * 工具：不规定输出模板）。
 *
 * ：段内容 SSoT 已迁 `prompts/subagent_worker.md`（经 prebuild 生成），
 * 此处 re-export 保持既有导入路径不变。
 */
export { SUBAGENT_WORKER_SYSTEM_SECTION } from './generated-worker-section.js';

/**
 * **W2 resume（2026-05-30）**：续跑（resume）时放在被读回的子历史**最前面**的
 * 框定声明。
 *
 * 与 spawn 的 `INHERITED_CONTEXT_NOTICE` 不同——resume 读回的是子 Agent **自己**
 * 上一轮的产出（assistant 推理 + 工具调用 + 工具结果 + 最终回复），不是父会话背景。
 * 所以这里用「你自己之前的工作记录」框定。
 *
 * **W2.1（2026-05-30）后**：子工具调用的 tool_result 已随 assistant 一起通过
 * `persist_message` 权威事件持久化，restore 读回的就是**真实工具结果**。
 * 仅在极少数历史损坏 / 旧版本数据边界才会看到 `query.ts::ensureToolResultPairing` 合成的
 * `[Tool result missing due to internal error]` 占位——所以保留一句轻量说明：碰到
 * 占位符不代表工具真的失败了，需要的话重跑即可。不解释会让子 Agent 误以为「我之前
 * 的工具全报错了」而脑补错误结论。
 *
 * 同时这条 user 框定也保证 `initialMessages` 首条是 user（满足 provider 对首条
 * 角色的预期）——restore 回来的子历史首条恒为 assistant。
 */
const RESUMED_CONTEXT_NOTICE = `以下是你（这个子 Agent）在之前轮次里已经产出的工作记录（含工具调用与其结果），供你接续。其中绝大多数工具结果都已保真存盘、直接可读；只有极少数会显示成形如 "[Tool result missing due to internal error]" 的占位符——那只是个别结果没来得及存盘，并不代表当时的工具真的失败了，如果接续任务需要这些结果请重新调用相应工具获取。请只依据末尾最新的任务消息继续工作。`;

// ─── Message Construction ───────────────────────────────────────────

const INTERNAL_MARKERS = Object.values(INTERNAL_MESSAGE_MARKERS);

function copyInternalMarkers(source: Message, target: Message): Message {
  for (const marker of INTERNAL_MARKERS) {
    if (hasInternalMarker(source, marker)) {
      setInternalMarker(target, marker);
    }
  }
  return target;
}

/**
 * Clone a single message for the fork context.
 * - tool_result content blocks are replaced with FORK_PLACEHOLDER_RESULT
 * - Other messages are deep-copied to prevent shared-reference mutation
 */
function cloneMessageForFork(msg: Message): Message {
  if (typeof msg.content === 'string') {
    return copyInternalMarkers(msg, { role: msg.role, content: msg.content });
  }

  const clonedBlocks: ContentBlock[] = (msg.content as ContentBlock[]).map((block) => {
    if (block.type === 'tool_result') {
      return {
        ...block,
        content: FORK_PLACEHOLDER_RESULT,
      } as ToolResultBlock;
    }
    return structuredClone(block);
  });

  return copyInternalMarkers(msg, { role: msg.role, content: clonedBlocks });
}

// ─── Inherit Mode Helpers ─────────────────────────────────────────

export interface BuildForkedMessagesOptions {
  inheritMode?: InheritMode;
  policy?: SubAgentPolicyDto;
}

/**
 * Strip tool_use / tool_result blocks from messages, keeping only text.
 * After stripping, merge consecutive same-role messages to satisfy the
 * Anthropic API strict user↔assistant alternation requirement.
 * Used by `filtered` inherit mode.
 */
function filterToolBlocks(messages: Message[]): Message[] {
  const stripped = messages
    .map((msg): Message | null => {
      if (typeof msg.content === 'string') {
        return copyInternalMarkers(msg, { role: msg.role, content: msg.content });
      }
      const blocks = (msg.content as ContentBlock[]).filter(
        (b) => b.type !== 'tool_use' && b.type !== 'tool_result',
      );
      if (blocks.length === 0) return null;
      return copyInternalMarkers(msg, { role: msg.role, content: blocks });
    })
    .filter((m): m is Message => m !== null);

  return mergeConsecutiveSameRole(stripped);
}

/**
 * Merge consecutive messages with the same role into a single message.
 * Handles both string and ContentBlock[] content.
 */
function mergeConsecutiveSameRole(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;

  const result: Message[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (curr.role === prev.role) {
      const merged: Message = {
        ...prev,
        content: mergeContent(prev.content, curr.content),
      };
      copyInternalMarkers(prev, merged);
      result[result.length - 1] = merged;
    } else {
      result.push(curr);
    }
  }
  return result;
}

function mergeContent(
  a: string | ContentBlock[],
  b: string | ContentBlock[],
): string | ContentBlock[] {
  const blocksA = typeof a === 'string' ? [{ type: 'text' as const, text: a }] : a;
  const blocksB = typeof b === 'string' ? [{ type: 'text' as const, text: b }] : b;
  return [...blocksA, ...blocksB];
}

/**
 * Compress parent messages into a single summary text block.
 * Simple extraction — no LLM call; truncates at ~4000 chars.
 */
function summarizeMessages(messages: Message[]): string {
  const MAX_SUMMARY_CHARS = 4000;
  const parts: string[] = [];
  for (const msg of messages) {
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else {
      const textBlocks = (msg.content as ContentBlock[]).filter(
        (b): b is TextBlock => b.type === 'text',
      );
      text = textBlocks.map((b) => b.text).join('\n');
    }
    if (text.trim()) {
      parts.push(`[${msg.role}]: ${text.trim()}`);
    }
  }
  const combined = parts.join('\n');
  if (combined.length <= MAX_SUMMARY_CHARS) return combined;
  return combined.slice(0, MAX_SUMMARY_CHARS) + '\n…(truncated)';
}

/**
 * Apply policy-based redaction to messages.
 * Tool results whose tool_name is not in whitelist (when non-empty)
 * or is in blacklist are replaced with a redaction placeholder.
 */
export function policyFilter(messages: Message[], policy: SubAgentPolicyDto): Message[] {
  const whitelist = policy.tool_whitelist?.length ? new Set(policy.tool_whitelist) : null;
  const blacklist = policy.tool_blacklist?.length ? new Set(policy.tool_blacklist) : null;
  if (!whitelist && !blacklist) return messages;

  const toolUseNames = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use') {
        const tu = block as ToolUseBlock;
        toolUseNames.set(tu.id, tu.name);
      }
    }
  }

  return messages.map((msg): Message => {
    if (typeof msg.content === 'string') return msg;
    const blocks = (msg.content as ContentBlock[]).map((block): ContentBlock => {
      if (block.type !== 'tool_result') return block;
      const tr = block as ToolResultBlock;
      const toolName = toolUseNames.get(tr.tool_use_id) ?? 'unknown';
      const blocked =
        toolName === 'unknown' ||
        (whitelist && !whitelist.has(toolName)) ||
        (blacklist && blacklist.has(toolName));
      if (!blocked) return block;
      const redactReason = toolName === 'unknown'
        ? '[已隐去：工具结果不可用（源已被压缩移除）]'
        : `[已隐去：${toolName} 超出子 Agent 范围]`;
      return {
        ...tr,
        content: redactReason,
      } as ToolResultBlock;
    });
    return { role: msg.role, content: blocks };
  });
}

/**
 * Build the forked message list from parent context.
 *
 * Strategy (aligned with Django fork_context.py):
 * 1. Clone all parent messages up to current point
 * 2. Replace every tool_result content with uniform placeholder
 * 3. Append fork-boilerplate + directive as final user message
 *
 * All fork children share the same prefix bytes, maximising prompt cache.
 *
 * When `options.inheritMode` is specified:
 * - `full`  : existing behavior (deep-copy + placeholder tool results)
 * - `filtered`: strip tool_use/tool_result blocks, keep only text
 * - `summary` : compress parent history into a summary paragraph
 * - `none`    : empty history, task prompt only
 *
 * 默认 `'none'`（决策 1 /  方案 C）—— 见 `DEFAULT_INHERIT_MODE` 注释。
 * 直接调用方（譬如测试）想测 'filtered' / 'full' 行为必须显式传 `inheritMode`。
 */
export function buildForkedMessages(
  parentMessages: Message[],
  taskPrompt: string,
  options?: BuildForkedMessagesOptions,
): Message[] {
  const mode: InheritMode = options?.inheritMode ?? DEFAULT_INHERIT_MODE;

  let forked: Message[];

  switch (mode) {
    case 'none':
      forked = [];
      break;
    case 'summary': {
      const summaryText = summarizeMessages(parentMessages);
      forked = [
        {
          role: 'user',
          content: `<conversation-summary>\n${summaryText}\n</conversation-summary>`,
        },
      ];
      break;
    }
    case 'filtered':
      forked = filterToolBlocks(parentMessages.map(cloneMessageForFork));
      break;
    case 'full':
    default:
      forked = parentMessages.map(cloneMessageForFork);
      break;
  }

  if (options?.policy) {
    forked = policyFilter(forked, options.policy);
  }

  // 决策（2026-07-04）：子 Agent 不掺父会话背景——生产路径恒 `'none'`（forked 为空），
  // 子 Agent 消息只保留末尾这条「主 Agent 派的 task」。worker 纪律已移进 system prompt
  // （见 SUBAGENT_WORKER_SYSTEM_SECTION），不再往对话里塞 <inherited-context> /
  // <fork-boilerplate> 包裹。非 'none' 分支仅测试用；也不再加继承框定声明。
  forked.push(buildActiveDirectiveMessage(taskPrompt));

  return filterIncompleteToolCalls(forked);
}

/**
 * 构造子 Agent 的任务 user message。
 *
 * 决策（2026-07-04）：**只放主 Agent 派的 raw task**，不再包 `<fork-boilerplate>` /
 * `<active-directive>`——worker 纪律已移进 system prompt（SUBAGENT_WORKER_SYSTEM_SECTION）。
 * spawn（`buildForkedMessages` 末尾）与 W2 resume（续跑指令）共用此格式。
 */
function buildActiveDirectiveMessage(taskPrompt: string): Message {
  return {
    role: 'user',
    content: taskPrompt,
  };
}

// ─── W2 resume：子 session 定位 + 存在性校验 ─────────────────────────

/**
 * 子 Agent 旧 transcript 文件的绝对路径（路径拼装 SSoT）。
 *
 * 与 `forkQuery` 内部的 sidechainDir / childThreadId 拼法保持一致：
 * `{sessionDir}/{parentThreadId}/subagents/agent-{childId}/messages.jsonl`。
 * 新写入以 message-blocks.jsonl 为权威；本路径保留给旧 sidechain / backfill。
 */
export function getSubagentMessagesPath(
  parentSessionConfig: SessionConfig,
  childId: string,
): string {
  const sidechainDir = path.join(
    parentSessionConfig.sessionDir,
    parentSessionConfig.threadId,
    'subagents',
  );
  return path.join(sidechainDir, `agent-${childId}`, 'messages.jsonl');
}

/**
 * 子 Agent message-blocks.jsonl 的绝对路径。新 sidechain 持久化权威文件。
 */
export function getSubagentMessageBlocksPath(
  parentSessionConfig: SessionConfig,
  childId: string,
): string {
  const sidechainDir = path.join(
    parentSessionConfig.sessionDir,
    parentSessionConfig.threadId,
    'subagents',
  );
  return path.join(sidechainDir, `agent-${childId}`, 'message-blocks.jsonl');
}

/**
 * **W2 resume（2026-05-30）**：判断某 childId 的子 session 是否真实存在且非空。
 *
 * 失败语义前置闸：resume 一个不存在 / 已失效的 childId（子目录或 sidechain 历史
 * 文件不存在、或文件为空）时，调用方应**显式报错**而不是静默跑空——见
 * `agent-tool.ts::executeChildAgent` 的 resume 早检。
 */
export function subagentSessionExists(
  parentSessionConfig: SessionConfig,
  childId: string,
): boolean {
  for (const filePath of [
    getSubagentMessageBlocksPath(parentSessionConfig, childId),
    getSubagentMessagesPath(parentSessionConfig, childId),
  ]) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > 0) return true;
    } catch {
      /* try next history source */
    }
  }
  return false;
}

/** resume 续跑一个不存在 / 空 session 时抛出的类型化错误（defense-in-depth）。 */
export class SubagentResumeNotFoundError extends Error {
  constructor(childId: string) {
    super(`子 Agent 会话不存在或已失效（childId=${childId}）`);
    this.name = 'SubagentResumeNotFoundError';
  }
}

/**
 * Remove assistant messages that contain tool_use blocks without
 * a subsequent matching tool_result. The Anthropic API requires
 * every tool_use to be paired with a tool_result.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  const answeredToolIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        answeredToolIds.add((block as ToolResultBlock).tool_use_id);
      }
    }
  }

  return messages.map((msg) => {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return msg;

    const blocks = msg.content as ContentBlock[];
    const hasToolUse = blocks.some((b) => b.type === 'tool_use');
    if (!hasToolUse) return msg;

    const filteredBlocks = blocks.filter((block) => {
      if (block.type !== 'tool_use') return true;
      return answeredToolIds.has((block as ToolUseBlock).id);
    });

    if (filteredBlocks.length === 0) {
      return { role: msg.role, content: '' };
    }

    return { role: msg.role, content: filteredBlocks };
  }).filter((msg) => {
    if (typeof msg.content === 'string') return msg.content.length > 0;
    return (msg.content as ContentBlock[]).length > 0;
  });
}

// ─── Fork Query Execution ───────────────────────────────────────────

export interface ForkQueryConfig {
  parentMessages: Message[];
  taskPrompt: string;
  systemPrompt: string;
  provider: LLMProvider;
  tools: ToolProvider;
  permissionHandler: EnginePermissionHandler;
  budgetTracker?: BudgetTracker;
  model: string;
  maxTurns?: number;
  signal?: AbortSignal;
  sessionConfig: SessionConfig;
  /** 父任务派生的子 Agent 专属计费作用域。 */
  billingIdempotencyScope?: string;
  emitStreamEvent?: (event: StreamEvent) => void;
  waitForUserInput?: (requestId: string) => Promise<unknown>;
  runtimeMode?: EngineConfig['runtimeMode'];
  hooks?: EngineConfig['hooks'];
  contextWindowTokens?: number;
  /** W1b fix: 父 EngineConfig.maxOutputTokens 继承到子 EngineConfig。 */
  maxOutputTokens?: number;
  /** W1b fix: 父 EngineConfig.modelCapabilities 继承到子 EngineConfig。 */
  modelCapabilities?: ModelCapabilities;
  resolveContextWindow?: (model: string) => number;
  /**
   * 本次 fork 出来的子 runtime 的嵌套深度（主 Agent = 0，子 = 1，孙 = 2…）。
   *
   * 由 `agent-tool.ts.executeChildAgent` 按 `(context.subagentDepth ?? 0) + 1`
   * 计算后传入；写进 `childEngineConfig.subagentDepth`，让子 runtime 的
   * ToolContext 拿到正确深度，实现"父子孙三级"封顶。缺省 1（直接调 forkQuery
   * 的非 agent-tool 路径 / 老测试视为第一层 fork）。
   */
  subagentDepth?: number;
  /**
   * 父业务对话 thread id。写入子 `EngineConfig.businessThreadId`，供
   * ToolContext.threadId / TABTIN_THREAD_ID 使用；子 storage 仍走
   * `agent-{childId}`。缺省回落 `sessionConfig.threadId`。
   */
  businessThreadId?: string;
  /** Externally supplied child ID — used to align step events with sidechain path. */
  childId?: string;
  /**
   * 阶段 8 Review fix：父 messages.jsonl 上 `agent` 工具 tool_use 块的 id。
   *
   * 透传链路：`agent-tool.ts.executeChildAgent` 收到 `params.parentToolCallId`
   * → 这里 → `SubagentIndexWriter.recordStart({ parentToolCallId })`。让消费方
   * 能从父 messages 上某条 tool_use 反查到对应子 session（双向跳转）。
   * 父级直接调 forkQuery（譬如测试）不带 tool 调用时字段可缺省。
   */
  parentToolCallId?: string;
  /**
   * Group/Mission：主 Agent 经 `agent` 工具 `role` 参数指定的子 Agent 角色名
   * （派发的「主语」——谁来做，如「科普撰稿人」）。
   *
   * 透传链路：`agent-tool.ts` 收到 `params.role` → 这里 → `recordStart({ role })`
   * **落进 subagents.jsonl**，让重启 / 切走再回 / 刷新后从归档重建 run 时仍能
   * 恢复角色名（否则 UI chip 只能回落「子 Agent · 短id」）。缺省时消费端回落。
   */
  role?: string;
  /**
   * agent 工具 `description` → 子 Agent 卡片标题（label）；透传到
   * `recordStart({ label })` 落 subagents.jsonl，重启 / 刷新后历史回放恢复标题
   * （否则归档重建的 run 无 label，UI 回落「子 Agent · 短id」）。
   */
  label?: string;
  /**
   * ：命中 Space 模板时的 template_id / 版本 / 显示名。
   *
   * 透传链路：`agent-tool.ts.executeChildAgent` → 这里 → `recordStart`，落进
   * subagents.jsonl，让重启 / 刷新后从归档重建 run 时仍能恢复「源自模板」标注。
   * 非模板派发时缺省（undefined），消费端不展示 badge。
   */
  templateId?: string;
  templateVersion?: number;
  templateName?: string;
  /**
   * Workspace root forwarded to child queries so sub-agents' run_terminal_command / action
   * tools operate in the same cwd as the parent. Inherits parent
   * `EngineConfig.workspaceRoot` when the agent tool is wired in the host.
   */
  workspaceRoot?: string;
  /**
   * FR-01: forward the host's DoomLoop policy so subagents inherit the
   * same warn/pause/terminate behavior as the parent.
   */
  doomLoopPolicy?: 'soft' | 'strict';
  /**
   * FR-04: forward the host's per-message budget so a parent
   * configured with `strict` / custom `maxMessageChars` does not
   * silently fork children back to defaults.
   */
  maxMessageChars?: number;
  /**
   * W1-A: Forward the parent's `EngineConfig.agentMode` so child runtime
   * carries the same mode in its `EngineConfig.agentMode`. Avoids a
   * silent父子 mode 脱钩 — 子 Agent 继承同一受限模式后，judge() step 0 的
   * SSoT 软拒对父子一致生效（防"父禁子放"）。#2627 后受限模式拦截只依赖
   * `agentMode`，不再透传 legacy guard 实例。
   */
  agentMode?: string;
  /**
   * FR-15 (H3-A Review P1)：父级 IterationBudget 配置透传到子 Agent。
   *
   * 不透传的话子 Agent 走 `normalizeIterationBudgetConfig(undefined)` 默认值
   * （iteration 70/90/100 + token 85/95/100），与父会话脱锚——宿主自定义
   * 阈值（如灰度调研期的 80/90/95）对子 Agent 完全失效。
   *
   * 与 `BudgetTracker` 的关系：fork 子 Agent 共享同一个 `budgetTracker`（并发
   * 调度 / 会话硬墙），但 IterationBudget token 分子按 `budgetScope=childId`
   * 读 per-scope 累计，与 CostCap / syncStateFromTracker 对齐——子
   * 执行上限单独核算，不被父/兄弟全树用量误杀。
   *
   * 与 `doomLoopPolicy` / `maxMessageChars` 同模式；缺省时回 Runtime 默认。
   */
  iterationBudget?: EngineConfig['iterationBudget'];
  /**
   *  Stage 2c：子 Agent end_turn 待办收尾文案端口。
   */
  todoCompletionNudgeProvider?: EngineConfig['todoCompletionNudgeProvider'];
  /**
   * W3：父级 stall detector 配置透传到子 Agent，避免父 dogfood 调阈值时
   * 子 Agent 仍走默认值。tracker buffer 本身不共享（子 Agent 有独立判定），
   * 只透传 thresholds + enabled。
   */
  toolFailureTracker?: EngineConfig['toolFailureTracker'];
  /**
   * FR-16 H3-B：父级 reuse 总开关 + 5 个细粒度 judge 配置透传到子 Agent。
   *
   * H3-B Review fix #7：原来不透传会让"父开发者关掉 reuse 做 A/B、子仍开启" 的
   * 行为脱钩，污染 A/B 数据；测试若注入 mock judgeFn，子也拿不到桩。与
   * `doomLoopPolicy` / `iterationBudget` 等"父子配置一致"模式对齐。
   */
  enableSummaryReuse?: EngineConfig['enableSummaryReuse'];
  summaryReuseJudgeSampleRate?: EngineConfig['summaryReuseJudgeSampleRate'];
  summaryReuseJudgeWindowSize?: EngineConfig['summaryReuseJudgeWindowSize'];
  summaryReuseJudgeThreshold?: EngineConfig['summaryReuseJudgeThreshold'];
  summaryReuseMaxAgeMs?: EngineConfig['summaryReuseMaxAgeMs'];
  summaryReuseMinAddedMessages?: EngineConfig['summaryReuseMinAddedMessages'];
  summaryReuseJudgeFn?: EngineConfig['summaryReuseJudgeFn'];
  /**
   * FR-16 / ：父级 time-based microCompact 配置透传到子 Agent（与
   * `enableSummaryReuse` 同模式）。缺省时不触发 time-based 清理。
   */
  timeBasedMicroCompact?: EngineConfig['timeBasedMicroCompact'];
  /**
   * ：父级压力分档阈值 / 上下文预算透传到子 Agent（与
   * `timeBasedMicroCompact` 同模式）——否则宿主定制阈值后父子压缩
   * 触发线不一致。缺省走 runtime 默认。
   */
  pressureThresholds?: EngineConfig['pressureThresholds'];
  contextBudget?: EngineConfig['contextBudget'];
  /**
   * T-P1-4: forward parent's ToolResultStorage so child agents persist
   * oversized tool results to the same disk-backed store, surviving the
   * parent↔child boundary. Without this, child results fall back to
   * in-memory-only storage and are lost on process restart.
   */
  toolResultStorage?: ToolResultStorage;
  /**
   * PRD 08 W1 + PRD 06 §7.1：父 Agent 的 readFileState。
   *
   * forkQuery 启动子 runtime 时会 shallow clone（`new Map(parent)`），
   * 子继承"父已读过的文件"信号但后续 read/write 不污染父级。
   */
  readFileState?: EngineConfig['readFileState'];
  /**
   * **W2（2026-05-13）**：父 Agent 的 image / localDoc dedup 状态。
   *
   * 与 readFileState 同款 fork 语义——shallow clone 让子继承"父已 read
   * 过哪些图 / 文档"的判等签名，子第一次 read 同款文件直接命中 stub 不
   * 重复塞 base64；子的后续 read 不污染父级（多 sub-agent 并发 image
   * dedup 不会因 microtask 交错错位）。
   */
  imageReadFileState?: EngineConfig['imageReadFileState'];
  localDocReadFileState?: EngineConfig['localDocReadFileState'];
  /**
   * per-file 回退引擎（替代 shadow git）。
   *
   * **与 readFileState / dedup state 不同：子 runtime 共享父的同一实例（不 clone）**
   * —— 同一 thread 的回退账本只有一份，父子在同一 anchorId（agentRunId）下记录
   * before-backup，子 Agent 改的文件回退时一并还原。父未注入则子 undefined。
   */
  fileHistory?: EngineConfig['fileHistory'];
  /**
   * **本轮顶层对话锚点**（§3.9 规则 2）：把父轮 anchorId 一路透传给所有后代子
   * agent。子 runtime 的 `query.ts` 用它作 `beginSnapshot` / `trackEdit` 的 anchorId，
   * 子 Agent 改的文件归到**父轮** anchor，回退父轮一并恢复（子不另建自己的 anchor）。
   *
   * 由 `agent-tool.ts::executeChildAgent` 用父 `ToolContext.fileHistoryAnchorId ??
   * agentRunId`（= 父 config.fileHistoryAnchorId ?? 父 runId）填入；写进
   * `childEngineConfig.fileHistoryAnchorId`。缺省时子 query 回落自己的 runId（与
   * 顶层 / 老测试行为一致）。
   */
  fileHistoryAnchorId?: EngineConfig['fileHistoryAnchorId'];
  /**
   * Hilt v3 / Stage 3：父子同构走 ToolRiskPolicyPort。
   * readonly 子经 `forReadonlyChild()` 取得独立端口包装；否则共享父端口。
   * 包装不降级父级文件目录授权，readonly 约束由 agentMode 与工具集表达。
   */
  toolRiskPolicy?: EngineConfig['toolRiskPolicy'];
  judgeHomeDir?: EngineConfig['judgeHomeDir'];
  /**  Stage 4：子 config 按自身 agentMode 绑定 ToolGate。 */
  bindToolGate?: EngineConfig['bindToolGate'];
  annotateReadonlyChildTools?: EngineConfig['annotateReadonlyChildTools'];
  systemPromptProvider?: EngineConfig['systemPromptProvider'];
  /**
   * D-1 Wave 6：父级 OS 错误黑名单实例。子 Agent 必须继承同一个引用，
   * 否则同 Organization 内父/子对系统权限错误的短路与 clear 会脱钩。
   */
  osErrorBlacklist?: EngineConfig['osErrorBlacklist'];
  /**
   * FR-09 / 中性化：父 Agent 的「shell 命令是否返回外部不可信字节」谓词。
   * 子 Agent 继承同一谓词以保持 `run_terminal_command` fence 的父子安全等价；
   * 缺省时子 Agent 不 fence（中性默认）。
   */
  isUntrustedShellCommand?: EngineConfig['isUntrustedShellCommand'];
  /**
   * W3：HITL 审批通道。子 Agent 必须继承父级 channel —— 否则父级 enforce
   * 时子 runtime 拿不到 channel，所有 ask 决策都会落 fail-closed deny + 文案
   * 「no UserInteractiveChannel is wired」，造成父对话能弹审批、子任务工具
   * 全自动拒绝的不一致体验（W3 三视角 Review P0）。
   */
  userInteractiveChannel?: EngineConfig['userInteractiveChannel'];
  /**
   * PRD 06 Wave 1a: inherit mode for buildForkedMessages.
   * Controls how much parent context flows into the child.
   */
  inheritMode?: InheritMode;
  /**
   * PRD 06 Wave 1a: tool policy for policyFilter.
   * Redacts tool results outside the child's scope before injection.
   */
  subagentPolicy?: SubAgentPolicyDto;
  /**
   * **readonly opt-in 收紧**（YOLO PRD v3 §5.5.3 / DR-9 2026-05-26 重修订）：
   *
   * 父 Agent 在 fork 时显式 `true` → 子 Agent 强制 ask 模式
   * （即使父是 yolo / full_access）。缺省 / `false` → 子继承父运行模式。
   *
   * 对应 Task tool 的 `readonly` 参数（其 SDK 文档字面称为 "Ask mode"）。
   * 父 Agent 知道子任务高风险（譬如调外部 API、写陌生路径）时主动 opt-in；
   * `agent` 工具 input schema 暴露同名字段 `readonly` 给 LLM。
   *
   * 防越权的关键安全设施仍由 hardline（judge step 1 fail-closed deny）兜底，
   * 不依赖此字段。详见上方 toolRiskPolicy / forReadonlyChild 注释。
   */
  readonlySubagent?: boolean;
  /**
   *  Phase 1（readonly 子 Agent 注入 DI）：readonly 子 Agent 需要在
   * 消息里加一块「ask 模式」sparse reminder。原来 fork-query 直接硬编码
   * 一个「ask 模式」mode-reminder 注入——但该注入已迁到宿主内容包，引擎不能
   * 反向依赖宿主内容包。
   *
   * 改由宿主装配 `agent` 工具时注入这个工厂：`readonlySubagent === true` 时，
   * `buildChildHooks` 调 `buildReadonlySubagentHooks?.()` 取得该 hook 并排在最前
   * （与原硬编码顺序一致）。缺省 / 返回 undefined → 不加 readonly hook（引擎默认
   * 行为，无内容注入）。
   */
  buildReadonlySubagentHooks?: () => EngineHooks;
  /**
   * **W2 resume / 续跑（2026-05-30）**：`true` 时走 resume 分支而非首次 spawn。
   *
   * 必须配合 `childId`（= 之前某子 Agent 返回的 [子 Agent ID]）一起传——resume
   * 复用同一个 childId 定位到已有子 session：
   *   ① **跳过 `buildForkedMessages`**（不从父快照重建上下文）；
   *   ② `SessionStorage(childSessionConfig).restoreMessages()` 读回子自己上一轮
   *      的产出历史；
   *   ③ 把 `<active-directive>`（新指令）append 到读回历史末尾，经 `initialMessages`
   *      通道喂入子 runtime（`query.ts` 的 `ensureToolResultPairing` 自动兜底末尾
   *      未配对 tool_use）；
   *   ④ 索引 `recordStart` 带 `runSeq`/`resumedFrom`，让同 subSessionId 的多组
   *      started/ended 能按 run 折叠（见 `subagent-index.ts::foldSubagentRuns`）。
   *
   * **失败语义**：resume 一个不存在 / 空的子 session（`restoreMessages` 读回空）
   * → 抛 `SubagentResumeNotFoundError`。生产链路上 `agent-tool.ts::executeChildAgent`
   * 已在 trySubmit 之前用 `subagentSessionExists` 做了早检并返回干净 isError 文案，
   * 这里是 defense-in-depth（覆盖早检与 fork 之间文件被删的竞态）。
   *
   * 缺省 / `false` → 首次 spawn 走原 `buildForkedMessages` 路径，行为完全不变。
   */
  resume?: boolean;
  /**
   *  Wave2：主 Agent mid-flight 插话 drain 闭包。
   * prepareForkRuntime 据此挂载 parent-midflight beforeModel hook。
   */
  drainParentMidflightMessages?: () => string[];
  /**
   * 子 Agent 自己的后台通知 drain 闭包。
   *
   * 顶层 runtime 按业务 thread drain；fork 出来的子 runtime 没有 host session，
   * 需要按自身 run_id drain 被路由过来的孙 Agent 完成通知。
   */
  drainThreadNotifications?: () => Promise<string | null>;
}

/**
 * Fork a child query: build forked messages → create child runtime →
 * run to completion → collect final assistant text.
 *
 * Yields every StreamEvent from the child so the host can relay them
 * to the UI (e.g. for showing sub-agent progress).
 *
 * Returns the child's final assistant text as a summary string.
 */
/**
 * **W2.1 Review 2 fix-10**：image / localDoc dedup state 是否应该 fork
 * 透传给子 Agent。
 *
 * dedup stub 的语义是"refer to that image/text in the earlier tool_result"——
 * 只有当子 history **真带了**父级的 ImageBlock / 解析全文时才有意义。
 *
 *   - `full` / `filtered` / undefined → 子 history 保留父级 ImageBlock
 *     / tool_result，dedup stub 文案的"earlier tool_result"对子是真实可访问的
 *     → **透传 dedup state**
 *     （生产链路：`agent-tool.ts::execute` 显式传 'filtered'，W0-5 / D12 改动
 *     后已是 `buildForkedMessages` 内部 fallback `DEFAULT_INHERIT_MODE` 同款，
 *     PRD 06 §六对齐。）
 *   - `summary` → 父 history 被压成 text summary，ImageBlock 被丢；dedup state
 *     透传后子第一次 read 同图命中 stub，但子 history 找不到"earlier
 *     ImageBlock"→ 子 LLM 困惑或死循环 → **不透传 dedup state**（让子真 read 一次）
 *   - `none` → 子 history 完全空白；同上不透传
 *
 * 注：readFileState（文本 dedup）继续无条件透传，因为 W1 文本 dedup 本身就有
 * `hasVisiblePriorReadResult` 检查兜底（fork-query.ts 文本 dedup 在 fork 子
 * Agent 看不到父 history 时会自动 bail），不会出现"dedup state 命中但 history
 * 没引用"的矛盾。binary dedup 没有同款 visible check（设计上靠 mtime+size+sha256
 * 物理判等够稳，无需扫 history），所以这里靠 inheritMode 显式 gate。
 */
function shouldInheritBinaryDedupState(mode: InheritMode | undefined): boolean {
  return mode == null || mode === 'full' || mode === 'filtered';
}

interface ForkRuntimePaths {
  childId: string;
  parentThreadId: string;
  sidechainDir: string;
  childThreadId: string;
  childSessionConfig: SessionConfig;
  parentSessionAbsDir: string;
  childMessagesPath: string;
  childMessageBlocksPath: string;
}

interface ForkRuntimeState {
  config: ForkQueryConfig;
  paths: ForkRuntimePaths;
  forkedMessages: Message[];
  childStorage: SessionStorage;
  childSnapshotStorage: SnapshotStorage;
  childEventStorage: EventStorage;
  subagentIndex: SubagentIndexWriter;
  startedAt: number;
  runSeq: number;
  childHooks: EngineHooks;
}

interface ForkStreamState {
  finalText: string;
  activeMessageId: string | null;
  pendingTextByMessageId: Map<string, string>;
  endStatus: 'completed' | 'failed' | 'cancelled';
  endError?: string;
  abortedDoneError: { errorClass?: string; message?: string } | null;
  sawSuccessfulDone: boolean;
}

function buildForkRuntimePaths(config: ForkQueryConfig): ForkRuntimePaths {
  const childId = config.childId ?? crypto.randomUUID();
  const parentThreadId = config.sessionConfig.threadId;
  const sidechainDir = path.join(config.sessionConfig.sessionDir, parentThreadId, 'subagents');
  const childThreadId = `agent-${childId}`;
  const childSessionConfig: SessionConfig = {
    sessionDir: sidechainDir,
    threadId: childThreadId,
  };
  const parentSessionAbsDir = path.join(config.sessionConfig.sessionDir, parentThreadId);
  return {
    childId,
    parentThreadId,
    sidechainDir,
    childThreadId,
    childSessionConfig,
    parentSessionAbsDir,
    childMessagesPath: path.join(sidechainDir, childThreadId, 'messages.jsonl'),
    childMessageBlocksPath: path.join(sidechainDir, childThreadId, 'message-blocks.jsonl'),
  };
}

async function buildForkedRuntimeMessages(
  config: ForkQueryConfig,
  childStorage: SessionStorage,
  childId: string,
): Promise<Message[]> {
  if (!config.resume) {
    return buildForkedMessages(config.parentMessages, config.taskPrompt, {
      inheritMode: config.inheritMode,
      policy: config.subagentPolicy,
    });
  }
  const restored = await childStorage.restoreMessages();
  if (restored.length === 0) {
    throw new SubagentResumeNotFoundError(childId);
  }
  return [
    {
      role: 'user',
      content: `<resumed-context readonly="true">\n${RESUMED_CONTEXT_NOTICE}\n</resumed-context>`,
    },
    ...restored,
    buildActiveDirectiveMessage(config.taskPrompt),
  ];
}

async function recordForkStart(runtime: ForkRuntimeState): Promise<void> {
  const { config, paths } = runtime;
  await runtime.subagentIndex.recordStart({
    subSessionId: paths.childThreadId,
    childId: paths.childId,
    shortId: paths.childId.slice(0, 4),
    parentToolCallId: config.parentToolCallId,
    runSeq: runtime.runSeq,
    resumedFrom: config.resume ? paths.childId : undefined,
    task: config.taskPrompt,
    role: config.role,
    label: config.label,
    templateId: config.templateId,
    templateVersion: config.templateVersion,
    templateName: config.templateName,
    model: config.model,
    createdAt: runtime.startedAt,
    paths: {
      sessionDir: path.relative(paths.parentSessionAbsDir, path.join(paths.sidechainDir, paths.childThreadId)),
      messagesPath: path.relative(paths.parentSessionAbsDir, paths.childMessagesPath),
      messageBlocksPath: path.relative(paths.parentSessionAbsDir, paths.childMessageBlocksPath),
      snapshotsPath: path.relative(paths.parentSessionAbsDir, runtime.childSnapshotStorage.filePath),
      eventsPath: path.relative(paths.parentSessionAbsDir, runtime.childEventStorage.filePath),
    },
  });
}

function buildChildHooks(config: ForkQueryConfig): EngineHooks {
  const parentHooks: EngineHooks = config.hooks ?? {};
  //  Phase 1：readonly 子 Agent 的 mode-reminder 现由宿主经
  // `buildReadonlySubagentHooks` 注入（原硬编码 buildModeReminderInjectorHook 已迁走）。
  // 顺序保持不变：readonly hook 排最前，父 hooks 居中。
  const readonlySubagentHook = config.readonlySubagent
    ? config.buildReadonlySubagentHooks?.()
    : undefined;
  if (readonlySubagentHook) {
    return composeHooks(readonlySubagentHook, parentHooks);
  }
  return parentHooks;
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

function cloneMapIfPresent<K, V>(value: Map<K, V> | undefined): Map<K, V> | undefined {
  return value ? new Map(value) : undefined;
}

function cloneBinaryDedupState<T>(
  inheritMode: InheritMode | undefined,
  value: Map<string, T> | undefined,
): Map<string, T> | undefined {
  return shouldInheritBinaryDedupState(inheritMode) ? cloneMapIfPresent(value) : undefined;
}

function resolveChildToolRiskPolicy(config: ForkQueryConfig): EngineConfig['toolRiskPolicy'] {
  if (!config.toolRiskPolicy) return undefined;
  const workspaceBoundPolicy = config.workspaceRoot
    ? config.toolRiskPolicy.forWorkspaceRoot(config.workspaceRoot)
    : config.toolRiskPolicy;
  return config.readonlySubagent
    ? workspaceBoundPolicy.forReadonlyChild()
    : workspaceBoundPolicy;
}

function buildChildEngineConfig(runtime: ForkRuntimeState): EngineConfig {
  const { config, paths, childHooks } = runtime;
  return {
    provider: config.provider,
    tools: config.tools,
    permissionHandler: config.permissionHandler,
    sessionConfig: paths.childSessionConfig,
    model: config.model,
    systemPrompt: config.systemPrompt,
    subagentDepth: withDefault(config.subagentDepth, 1),
    subagentRunId: paths.childId,
    businessThreadId: config.businessThreadId ?? paths.parentThreadId,
    maxTurns: config.maxTurns,
    budgetTracker: config.budgetTracker,
    budgetScope: paths.childId,
    toolResultStorage: config.toolResultStorage,
    hooks: childHooks,
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens,
    modelCapabilities: config.modelCapabilities,
    resolveContextWindow: config.resolveContextWindow,
    emitStreamEvent: config.emitStreamEvent,
    waitForUserInput: config.waitForUserInput,
    runtimeMode: config.runtimeMode,
    workspaceRoot: config.workspaceRoot,
    doomLoopPolicy: config.doomLoopPolicy,
    maxMessageChars: config.maxMessageChars,
    iterationBudget: config.iterationBudget,
    todoCompletionNudgeProvider: config.todoCompletionNudgeProvider,
    toolFailureTracker: config.toolFailureTracker,
    enableSummaryReuse: config.enableSummaryReuse,
    summaryReuseJudgeSampleRate: config.summaryReuseJudgeSampleRate,
    summaryReuseJudgeWindowSize: config.summaryReuseJudgeWindowSize,
    summaryReuseJudgeThreshold: config.summaryReuseJudgeThreshold,
    summaryReuseMaxAgeMs: config.summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages: config.summaryReuseMinAddedMessages,
    summaryReuseJudgeFn: config.summaryReuseJudgeFn,
    timeBasedMicroCompact: config.timeBasedMicroCompact,
    pressureThresholds: config.pressureThresholds,
    contextBudget: config.contextBudget,
    agentMode: config.readonlySubagent ? 'ask' : 'agent',
    readFileState: cloneMapIfPresent(config.readFileState),
    imageReadFileState: cloneBinaryDedupState(config.inheritMode, config.imageReadFileState),
    localDocReadFileState: cloneBinaryDedupState(config.inheritMode, config.localDocReadFileState),
    fileHistory: config.fileHistory,
    fileHistoryAnchorId: config.fileHistoryAnchorId,
    toolRiskPolicy: resolveChildToolRiskPolicy(config),
    judgeHomeDir: config.judgeHomeDir,
    bindToolGate: config.bindToolGate,
    annotateReadonlyChildTools: config.annotateReadonlyChildTools,
    systemPromptProvider: config.systemPromptProvider,
    osErrorBlacklist: config.osErrorBlacklist,
    isUntrustedShellCommand: config.isUntrustedShellCommand,
    userInteractiveChannel: createSubagentUserInteractiveChannel(
      config.userInteractiveChannel,
      { subagentDepth: 1 },
    ),
    drainThreadNotifications: config.drainThreadNotifications,
    querySource: '_sub_agent',
  };
}

async function prepareForkRuntime(config: ForkQueryConfig): Promise<ForkRuntimeState> {
  const paths = buildForkRuntimePaths(config);
  const childStorage = new SessionStorage(paths.childSessionConfig);
  await childStorage.ensureBlockBackfillFromTranscript();
  const forkedMessages = await buildForkedRuntimeMessages(config, childStorage, paths.childId);
  const childSnapshotStorage = new SnapshotStorage(paths.sidechainDir, paths.childThreadId);
  const childEventStorage = new EventStorage(paths.sidechainDir, paths.childThreadId);
  const subagentIndex = new SubagentIndexWriter(config.sessionConfig.sessionDir, paths.parentThreadId);
  const runSeq = config.resume ? await subagentIndex.getNextRunSeq(paths.childThreadId) : 1;
  const midflightHook = config.drainParentMidflightMessages
    ? buildParentMidflightInjectorHook({
        drainMessages: config.drainParentMidflightMessages,
        onInjected: async (_wrapped, message, messageId) => {
          await childStorage.recordUserMessage(message, {
            messageId,
            triggeredBy: PARENT_MIDFLIGHT_TRIGGERED_BY,
          });
          await childStorage.appendUserBlockRecord(message, {
            messageId,
            triggeredBy: PARENT_MIDFLIGHT_TRIGGERED_BY,
            role: 'user',
          });
        },
      })
    : undefined;
  const runtime: ForkRuntimeState = {
    config,
    paths,
    forkedMessages,
    childStorage,
    childSnapshotStorage,
    childEventStorage,
    subagentIndex,
    startedAt: Date.now(),
    runSeq,
    childHooks: {},
  };
  runtime.childHooks = midflightHook
    ? composeHooks(midflightHook, buildChildHooks(config))
    : buildChildHooks(config);
  await recordForkStart(runtime);
  return runtime;
}

async function persistChildRuntimeEvent(runtime: ForkRuntimeState, event: StreamEvent): Promise<void> {
  if (event.type !== StreamEvents.PERSIST_MESSAGE) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  // subagent_run_id is correct for the parent thread projection, where subagent
  // messages must not re-enter the parent LLM history. In the child sidechain
  // the same persisted assistant turn is local history, so store it without
  // the parent-thread exclusion marker.
  const { subagent_run_id: _parentSubagentRunId, ...childPayload } = payload;
  try {
    await runtime.childStorage.appendStreamEvent({
      ...event,
      payload: childPayload,
    });
  } catch {
    // 子 sidechain 是 resume 的本地历史副本；写入失败不应阻断父线程主事件流。
  }
}

function createForkStreamState(): ForkStreamState {
  return {
    finalText: '',
    activeMessageId: null,
    pendingTextByMessageId: new Map<string, string>(),
    endStatus: 'completed',
    abortedDoneError: null,
    sawSuccessfulDone: false,
  };
}

function appendForkObservability(runtime: ForkRuntimeState, event: StreamEvent): void {
  if (event.type === StreamEvents.LLM_REQUEST || event.type === StreamEvents.LLM_SNAPSHOT) {
    runtime.childSnapshotStorage
      .append(event.payload as Record<string, unknown>)
      .catch(() => undefined);
  }
  runtime.childEventStorage
    .append({ type: event.type, payload: event.payload, timestamp: Date.now() })
    .catch(() => undefined);
}

function handleForkMessageStart(state: ForkStreamState, event: StreamEvent): void {
  const payload = event.payload as Record<string, unknown>;
  const mid = typeof payload.message_id === 'string' ? payload.message_id : null;
  if (!mid) return;
  // ：mid-flight / tool_result 等 role=user 信封不参与 finalText 汇总。
  if (!shouldAccumulateForkFinalText(payload.role)) return;
  state.activeMessageId = mid;
  state.pendingTextByMessageId.set(mid, '');
}

/**
 * ：仅 assistant（或缺省 role）信封参与子 Agent finalText 汇总。
 * mid-flight / tool_result 的 role=user 信封必须跳过，否则会覆盖助手终稿。
 */
export function shouldAccumulateForkFinalText(role: unknown): boolean {
  return role !== 'user' && role !== 'system';
}

function handleForkTextDelta(state: ForkStreamState, event: StreamEvent): void {
  if (!state.activeMessageId) return;
  const payload = event.payload as Record<string, unknown>;
  const delta = payload.delta as { type?: string; text?: string } | undefined;
  if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return;
  const prev = state.pendingTextByMessageId.get(state.activeMessageId) ?? '';
  state.pendingTextByMessageId.set(state.activeMessageId, prev + delta.text);
}

function handleForkMessageStop(state: ForkStreamState): void {
  if (!state.activeMessageId) return;
  const text = state.pendingTextByMessageId.get(state.activeMessageId) ?? '';
  if (text.length > 0) state.finalText = text;
  state.pendingTextByMessageId.delete(state.activeMessageId);
  state.activeMessageId = null;
}

function handleForkDone(state: ForkStreamState, event: StreamEvent): void {
  const payload = event.payload as DoneEvent['payload'] & {
    error?: boolean;
    error_class?: string;
    error_message?: string;
    content?: string;
  };
  if (!state.finalText) state.finalText = payload.content ?? '';
  if (payload.error) {
    state.abortedDoneError = {
      errorClass: typeof payload.error_class === 'string' ? payload.error_class : undefined,
      message: typeof payload.error_message === 'string' ? payload.error_message : undefined,
    };
    return;
  }
  state.sawSuccessfulDone = true;
}

function handleForkStreamEvent(state: ForkStreamState, event: StreamEvent): void {
  if (event.type === ContentBlockEvents.MESSAGE_START) {
    handleForkMessageStart(state, event);
    return;
  }
  if (event.type === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
    handleForkTextDelta(state, event);
    return;
  }
  if (event.type === ContentBlockEvents.MESSAGE_STOP) {
    handleForkMessageStop(state);
    return;
  }
  if (event.type === StreamEvents.DONE) {
    handleForkDone(state, event);
  }
}

function assertForkCompleted(config: ForkQueryConfig, state: ForkStreamState): void {
  if (state.abortedDoneError) {
    throw new Error(
      state.abortedDoneError.message || `child run ended with ${state.abortedDoneError.errorClass ?? 'error'}`,
    );
  }
  if (!state.sawSuccessfulDone && config.signal?.aborted) {
    throw new Error('child run aborted before completion');
  }
}

async function finalizeForkRuntime(runtime: ForkRuntimeState, state: ForkStreamState): Promise<void> {
  const endedAt = Date.now();
  await Promise.allSettled([
    runtime.childStorage.dispose(),
    runtime.childSnapshotStorage.dispose(),
    runtime.childEventStorage.dispose(),
  ]);
  await runtime.subagentIndex.recordEnd({
    subSessionId: runtime.paths.childThreadId,
    childId: runtime.paths.childId,
    runSeq: runtime.runSeq,
    status: state.endStatus,
    endedAt,
    finalTextLength: state.finalText.length,
    durationMs: endedAt - runtime.startedAt,
    errorMessage: state.endError,
  });
}

async function* streamForkRuntime(runtime: ForkRuntimeState): AsyncGenerator<StreamEvent, string> {
  const state = createForkStreamState();
  const childRuntime = createRuntime(buildChildEngineConfig(runtime));
  try {
    for await (const event of childRuntime.query({
      hostRunId: runtime.paths.childId,
      prompt: runtime.config.taskPrompt,
      initialMessages: runtime.forkedMessages,
      signal: runtime.config.signal,
      maxTurns: runtime.config.maxTurns,
      systemPrompt: runtime.config.systemPrompt,
      billingIdempotencyScope: runtime.config.billingIdempotencyScope,
    })) {
      await persistChildRuntimeEvent(runtime, event);
      appendForkObservability(runtime, event);
      handleForkStreamEvent(state, event);
      yield event;
    }
    assertForkCompleted(runtime.config, state);
  } catch (err) {
    state.endStatus = runtime.config.signal?.aborted ? 'cancelled' : 'failed';
    state.endError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await finalizeForkRuntime(runtime, state);
  }
  return state.finalText || '(child agent produced no output)';
}

export async function* forkQuery(
  config: ForkQueryConfig,
): AsyncGenerator<StreamEvent, string> {
  const runtime = await prepareForkRuntime(config);
  return yield* streamForkRuntime(runtime);
}
