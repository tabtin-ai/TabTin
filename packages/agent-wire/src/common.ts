/**
 * Shared enums, types and Zod schemas used across multiple event categories.
 */

import { z } from 'zod';

// ─── Permission ──────────────────────────────────────────────────────

export const PermissionDecisionSchema = z.enum([
  'approved',
  'approved_for_session',
  'denied',
  'abort',
]);

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

// ─── Turn Lifecycle ──────────────────────────────────────────────────

export const TurnEndStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
]);

export type TurnEndStatus = z.infer<typeof TurnEndStatusSchema>;

// ─── Usage / Token Reporting ─────────────────────────────────────────
//
// P2（2026-04-22）：此前本文件曾有一份重复 UsageReportSchema（含 11 字段）但
// 从未被 ./index.ts 导出（孤儿）；wire 层实际导出的 UsageReport 来自
// `@tabtin/contracts/agent`。当前已将 contracts 那份扩围到 11 字段，删除本
// 处孤儿，确保 schema 单一来源。详见

// ─── Plan Entry ──────────────────────────────────────────────────────

export const PlanEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

export type PlanEntry = z.infer<typeof PlanEntrySchema>;

// ─── Risk Assessment ─────────────────────────────────────────────────

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);

export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ─── Authorization Preset ──────────────────────────────────────────
// PD-1（W6 M5）：v3 不再使用预设。wire 字段已退场，唯一安全开关是 yolo_mode。
// Schema 保留供 legacy 消费者编译通过，待 getPresetPolicy 全面清零后删除。

/** @deprecated v3 不再使用预设，用 yolo_mode boolean 替代 */
export const AuthorizationPresetSchema = z.enum([
  'cautious',
  'collaborative',
  'full_auto',
  'server_auto',
]);

/** @deprecated */
export type AuthorizationPreset = z.infer<typeof AuthorizationPresetSchema>;

// ─── Source Metadata ─────────────────────────────────────────────────
// Attached to adapted stream payloads to identify the source.
// `source: 'runtime'` 标识事件来自远端 (Daemon / Electron) 上的 agent runtime，
// 区别于 Django 内部 LLM stream 等本地事件源。

export const SourceMetaSchema = z.object({
  source: z.literal('runtime'),
  backend_type: z.string(),
  task_id: z.string(),
});

export type SourceMeta = z.infer<typeof SourceMetaSchema>;

// ─── Agent Backend Config ────────────────────────────────────────────

export const AgentBackendConfigSchema = z.object({
  type: z.string(),
  disabled_apps: z.array(z.string()).optional(),
  disabled_tool_prefixes: z.array(z.string()).optional(),
});

export type AgentBackendConfig = z.infer<typeof AgentBackendConfigSchema>;

// ─── Disabled-App Tool Enforcement ──────────────────────────────────

/**
 * Apps whose tool_domains differ from their app_id.
 * Maintained in sync with Django app_registry.py CORE_APPS.
 * When Django sends `disabled_tool_prefixes` explicitly, this map is not used.
 */
const KNOWN_APP_EXTRA_TOOL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  tabdata: ['sql'],
};

/**
 * Resolve effective tool prefixes from disabled app IDs.
 * Prefers explicit `disabled_tool_prefixes` when provided by Django;
 * otherwise derives prefixes from app IDs + known extra domains.
 */
export function resolveDisabledToolPrefixes(
  disabledApps?: string[],
  explicitPrefixes?: string[],
): string[] {
  if (explicitPrefixes && explicitPrefixes.length > 0) {
    return explicitPrefixes;
  }
  if (!disabledApps || disabledApps.length === 0) {
    return [];
  }
  const prefixes = new Set<string>();
  for (const appId of disabledApps) {
    prefixes.add(appId);
    const extras = KNOWN_APP_EXTRA_TOOL_DOMAINS[appId];
    if (extras) {
      for (const e of extras) prefixes.add(e);
    }
  }
  return [...prefixes];
}

/**
 * Check whether a tool name belongs to a disabled app.
 * Returns the matched prefix if blocked, or null if allowed.
 *
 * Matching rule: toolName equals a prefix, starts with `prefix_`, or contains
 * the prefix as an underscore-delimited token. The token case covers legacy
 * names such as `execute_in_terminal` for the `terminal` domain.
 */
export function matchDisabledToolPrefix(
  toolName: string,
  disabledPrefixes: string[],
): string | null {
  if (disabledPrefixes.length === 0) return null;
  const lower = toolName.toLowerCase();
  for (const prefix of disabledPrefixes) {
    const lp = prefix.toLowerCase();
    if (
      lower === lp
      || lower.startsWith(lp + '_')
      || lower.endsWith('_' + lp)
      || lower.includes('_' + lp + '_')
    ) {
      return prefix;
    }
  }
  return null;
}

/**
 * Known tool-name namespace aliases for app/tool domains.
 *
 * This is the protocol-side metadata stopgap while app manifests grow first-class
 * tool-domain declarations. Keeping it here avoids each runtime surface inventing
 * its own alias map and drifting on disabled-app enforcement.
 */
export const KNOWN_TOOL_DOMAIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  terminal: [
    'bash',
    'execute_in_terminal',
    'read_terminal_output',
    'write_to_terminal',
    'list_terminal_sessions',
  ],
  sql: ['tabtin_sql'],
  tabdata: [
    'tabtin_table',
    'tabtin_field',
    'tabtin_view',
    'tabtin_record',
    'tabtin_sql',
  ],
  tabdoc: ['document', 'tabtin_doc'],
  tabmemo: ['memory', 'tabtin_memo'],
  tabsite: ['tabtin_site'],
};

/**
 * Check whether a tool is disabled by domain prefixes or their known aliases.
 * Returns the disabled domain/prefix (not the alias) so callers can explain
 * which Space-level app policy blocked the tool.
 */
export function matchDisabledToolDomain(
  toolName: string,
  disabledPrefixes: string[],
  aliases: Readonly<Record<string, readonly string[]>> = KNOWN_TOOL_DOMAIN_ALIASES,
): string | null {
  const direct = matchDisabledToolPrefix(toolName, disabledPrefixes);
  if (direct) return direct;

  for (const prefix of disabledPrefixes) {
    const aliasPrefixes = aliases[prefix.toLowerCase()];
    if (!aliasPrefixes || aliasPrefixes.length === 0) continue;
    if (matchDisabledToolPrefix(toolName, [...aliasPrefixes])) {
      return prefix;
    }
  }
  return null;
}

// ─── Permission Mode（deprecated） ───────────────────────────────────

/**
 * @deprecated  Phase 2：legacy 四档自动批准机制已下线，runtime 不再读写。
 * schema 仅为 wire `permission_mode` optional 字段向后兼容保留（发送端不发、
 * Django 静默丢弃）。禁止新增消费方；现行档位是 ApprovalMode 三档。
 */
export const PermissionModeSchema = z.enum([
  'default',
  'auto-approve-reads',
  'auto-approve-edits',
  'full-auto',
]);

/** @deprecated 见 PermissionModeSchema。 */
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

// ─── Permission Timeouts (single source of truth) ───────────────────

const INTERACTIVE_HITL_MS = 30 * 60 * 1000;

export const PERMISSION_TIMEOUTS = {
  WARNING_MS: 60_000,
  PAUSE_MS: 90_000,
  /** Interactive HITL business timeout — aligned with agent-runtime inferTimeoutByRuntimeMode('interactive'). */
  FINAL_MS: INTERACTIVE_HITL_MS,
  /** Grace above FINAL_MS for upstream safety-net timers (action-bridge fallback, IPC). */
  FALLBACK_GRACE_MS: 30_000,
  FALLBACK_MS: INTERACTIVE_HITL_MS + 30_000,
  /** ApprovalDialog countdown seconds — must match FINAL_MS . */
  COUNTDOWN_THRESHOLD_S: INTERACTIVE_HITL_MS / 1000,
} as const;

// ─── Base Stream Event (PRD 06 §5.3.4) ──────────────────────────────
//
// 所有 Wire stream 事件的公共形状。`speaker_id` 标注"这条事件是谁产出的"，
// 让前端 MessageBubble 能区分主 Agent / 子 Agent / 用户。
// 一期为 optional——现有事件不含此字段，逐步在各事件产出侧补齐。

/**
 * 所有 stream 事件的基类形状。
 *
 * 现有具体 event schema（StreamLifecycle / StreamAssistant 等）暂不 extends
 * 此接口——它们是 Zod object，类型层面已兼容。本接口用于跨事件的泛型消费
 * （如 relay handler、前端 event router）。
 */
export interface BaseStreamEvent {
  type: string;
  /** 产出此事件的 speaker ID（主 Agent / 子 Agent / 用户）。 */
  speaker_id?: string;
}

/**
 * 需要特定宿主平台才能响应的 stream 事件（PRD 06 §5.3.5）。
 *
 * 典型场景：子 Agent HITL 审批一期只有 Electron 桌面端能处理；
 * iOS / Android 收到 `requires_host_platform='electron'` 的事件后
 * 将消息灰化 + 显示"请在桌面端处理"。
 */
export interface ActionableEvent extends BaseStreamEvent {
  requires_host_platform?: 'electron' | 'daemon' | 'any';
}
