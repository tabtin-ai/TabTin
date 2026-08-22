/**
 * Runtime-owned wire payload shapes（ Stage 5a）。
 *
 * 字段名 / 字面量与 `@tabtin/agent-wire` Zod infer 对齐；runtime 不再
 * type-import agent-wire。常量表见 stream-events.ts（Stage 5b）；Zod 校验
 * 仍在 wire / host（Stage 5c）。
 */

import {
  PROTOCOL_VERSION_V2,
  type StreamEventType,
} from './stream-events.js';

export type { StreamEventType };

// ─── Usage / Plan entry（原 contracts/agent 经 wire 转发）──────────────

export interface PerModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  compact_input_tokens?: number;
  compact_output_tokens?: number;
  credits?: number;
}

export interface UsageReport {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  model?: string;
  cost_usd?: number;
  charge_status?: string;
  compact_input_tokens?: number;
  compact_output_tokens?: number;
  by_model?: Record<string, PerModelUsage>;
  last_input_tokens?: number;
  last_cache_read_input_tokens?: number;
  last_cache_creation_input_tokens?: number;
}


// ─── Lifecycle / step / done / compaction ───────────────────────────
// ：StreamPlan / StreamMode / PlanEntry（仅服务 agent.stream.plan|mode）已删。

export type LifecyclePhase =
  | 'start'
  | 'end'
  | 'error'
  | 'turn_start'
  | 'turn_end'
  | 'permission_timeout'
  | 'permission_timeout_warning'
  | 'permission_timeout_pause'
  | 'idle_timeout'
  | 'terminated'
  | 'heartbeat'
  | 'session_resume_failed'
  | 'retrying'
  | 'session_interrupted';

export interface StreamLifecycle {
  phase: LifecyclePhase;
  status?: string;
  detail?: string | null;
  error_message?: string;
  run_id?: string;
  trace_id?: string;
  turn_id?: string;
  iteration?: number;
  started_at?: number;
  ended_at?: number;
  duration_ms?: number;
  tool_call_count?: number;
  tool_duration_ms?: number;
  tool_durations?: Array<{
    tool_name: string;
    tool_call_id: string;
    duration_ms: number;
    status: 'completed' | 'failed';
  }>;
  reason?: string;
  request_id?: string;
  tool_name?: string;
  active_tool_calls?: number;
  uptime_seconds?: number;
  source?: 'runtime';
  backend_type?: string;
  task_id?: string;
}

export type StepStatus = 'running' | 'done' | 'error';

export interface StreamStep {
  step_type: string;
  title: string;
  status: StepStatus;
  step_id?: string;
  run_id?: string;
  detail?: string | null;
  source?: 'runtime';
  backend_type?: string;
  task_id?: string;
}

export interface StreamDone {
  content?: string;
  error?: boolean;
  error_message?: string;
  error_class?: string;
  suggested_action?: string;
  trace_id?: string;
  agent_type?: string;
  usage?: UsageReport;
  metadata?: Record<string, unknown>;
  source?: 'runtime';
  backend_type?: string;
  task_id?: string;
}

export interface CompactionStats {
  messages_before?: number;
  messages_after?: number;
  tokens_before?: number;
  tokens_after?: number;
  tokens_freed?: number;
  tool_uses_retained?: number;
  summary_length?: number;
  [key: string]: unknown;
}

// ─── Content-block envelope（6 件套）─────────────────────────────────

export interface StreamEnvelopeBase {
  protocol_version: typeof PROTOCOL_VERSION_V2 | string;
  min_compatible_version: typeof PROTOCOL_VERSION_V2 | string;
  trace_id: string;
  _seq: number;
  thread_id: string;
  arrival_seq?: number;
  event_id?: string;
  subagent_run_id?: string;
}

export type MessageKind =
  | 'llm'
  | 'tool_artifact'
  | 'error_envelope'
  | 'environment_context'
  | 'agent_profile_context'
  | 'system_prompt_context';

export interface MessageStart extends StreamEnvelopeBase {
  event_type: 'agent.stream.message_start';
  message_id: string;
  /** 本条消息实际执行 Agent；跨端展示不得从可变 session 指针反推。 */
  agent_id?: string;
  role: 'assistant' | 'user' | 'system';
  model_id: string;
  model_name: string;
  started_at: string;
  run_id: string;
  subagent_run_id?: string;
  message_kind: MessageKind;
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type MessageStopReason = string;

export interface MessageDelta extends StreamEnvelopeBase {
  event_type: 'agent.stream.message_delta';
  message_id: string;
  delta: {
    stop_reason?: MessageStopReason;
    stop_sequence?: string | null;
  };
  usage?: MessageUsage;
}

export type PartialReason = 'aborted' | 'stream_interrupted' | 'message_stop_fallback';

export interface ErrorInfo {
  error_class?: string;
  error_message?: string;
  suggested_action?: string;
  category?: 'aborted' | 'timeout' | 'protocol_error' | 'runtime_failed' | 'budget_exceeded';
  error_extras?: Record<string, unknown>;
  partial_reason?: PartialReason;
}

export interface MessageStop extends StreamEnvelopeBase {
  event_type: 'agent.stream.message_stop';
  message_id: string;
  persisted_id?: string;
  block_id_overrides?: Record<string, string>;
  error_info?: ErrorInfo;
}

export interface Citation {
  type: 'char_location';
  cited_text: string;
  document_index: number;
  document_title?: string | null;
  start_char_index: number;
  end_char_index: number;
}

export type ImageSource =
  | { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'url'; url: string }
  | { type: 'file_id'; file_id: string };

export type DocumentSource =
  | { type: 'base64'; media_type: 'application/pdf'; data: string }
  | { type: 'url'; url: string }
  | { type: 'file_id'; file_id: string };

export interface ToolExecutionMetadata {
  duration_ms?: number;
  exit_code?: number;
  truncated?: boolean;
  full_output_url?: string;
}

export interface CodeExecutionResultContent {
  type: 'code_execution_result';
  stdout: string;
  stderr: string;
  return_code: number;
  content?: unknown[];
}

export type ToolResultInlineBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | {
      type: 'search_result';
      source: string;
      title: string;
      content: Array<{ type: 'text'; text: string }>;
      citations?: { enabled: boolean };
    }
  | {
      type: 'document';
      source: DocumentSource;
      title?: string;
      context?: string;
      citations?: { enabled: boolean };
    };

export type TabTinSnapshot =
  | { kind: 'web'; url: string; title?: string; preview?: string; selected_text?: string }
  | { kind: 'doc'; doc_id: string; page?: number; bbox?: [number, number, number, number]; preview?: string }
  | { kind: 'table'; table_id: string; row_ids?: string[]; field_ids?: string[]; csv_preview?: string }
  | { kind: 'code'; file_path: string; start_line: number; end_line: number; code_excerpt: string; lang?: string }
  | { kind: 'memo'; memo_id: string; preview?: string };

/** Wire ContentBlock（与 agent-wire 22-case union 字段对齐）。 */
export type WireContentBlock =
  | { type: 'text'; text: string; citations?: Citation[] }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      input_parse_error?: { message: string; partial: string };
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | ToolResultInlineBlock[];
      is_error?: boolean;
      tabtin_metadata?: ToolExecutionMetadata;
    }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'image'; source: ImageSource }
  | {
      type: 'document';
      source: DocumentSource;
      title?: string;
      context?: string;
      citations?: { enabled: boolean };
    }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'web_search_tool_result';
      tool_use_id: string;
      content: Array<{
        type: 'web_search_result';
        url: string;
        title: string;
        encrypted_content?: string;
        page_age?: string;
      }>;
    }
  | { type: 'code_execution_tool_result'; tool_use_id: string; content: CodeExecutionResultContent }
  | { type: 'bash_code_execution_tool_result'; tool_use_id: string; content: CodeExecutionResultContent }
  | {
      type: 'text_editor_code_execution_tool_result';
      tool_use_id: string;
      content: CodeExecutionResultContent;
    }
  | { type: 'mcp_tool_use'; id: string; name: string; server_name: string; input: Record<string, unknown> }
  | {
      type: 'mcp_tool_result';
      tool_use_id: string;
      is_error?: boolean;
      content: string | ToolResultInlineBlock[];
    }
  | { type: 'container_upload'; file_id: string; container_id: string }
  | {
      type: 'search_result';
      source: string;
      title: string;
      content: Array<{ type: 'text'; text: string }>;
      citations?: { enabled: boolean };
    }
  | {
      type: 'tabtin_rich_content';
      kind:
        | 'image'
        | 'table_preview'
        | 'resource_ref'
        | 'file'
        | 'widget'
        | 'cli_output_table'
        | 'cli_output_record'
        | 'search_results'
        | 'memory_card'
        | 'document_excerpt'
        | 'task_episode'
        | 'plan';
      summary: string;
      group_id?: string;
      payload?: Record<string, unknown>;
    }
  | {
      type: 'tabtin_composer_preset';
      preset_id: string;
      params: Record<string, unknown>;
      source?: 'preset' | 'ask_user';
    }
  | { type: 'tabtin_ask_user_fields'; field_values: Record<string, unknown> }
  | {
      type: 'tabtin_skill_invocation';
      skill_id: string;
      skill_name: string;
      injected_text: string;
      injected_text_summary: string;
    }
  | {
      type: 'tabtin_source_ref';
      source_id: string;
      ref_kind: 'web' | 'doc' | 'table' | 'code' | 'memo';
      snapshot: TabTinSnapshot;
    }
  | {
      type: 'tabtin_approval_request';
      approval_id: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      expires_at?: string;
    };

export type ContentBlockDeltaPayload =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: Citation }
  | { type: 'connector_text_delta'; connector_text: string };

export interface ContentBlockStart extends StreamEnvelopeBase {
  event_type: 'agent.stream.content_block_start';
  message_id: string;
  index: number;
  block_id: string;
  block: WireContentBlock;
}

export interface ContentBlockDelta extends StreamEnvelopeBase {
  event_type: 'agent.stream.content_block_delta';
  message_id: string;
  index: number;
  delta: ContentBlockDeltaPayload;
}

export interface ContentBlockStop extends StreamEnvelopeBase {
  event_type: 'agent.stream.content_block_stop';
  message_id: string;
  index: number;
}

// ─── Risk / approval reason / plan / subagent domain ─────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalWireRiskLevel = 'low' | 'medium' | 'high';

export type PlanGuardDenyCode = 'plan_mode_write_forbidden' | 'plan_approval_pending';
export type ApprovalScope = 'once' | 'thread' | 'always';
export type MemoSpecificity = 'exact' | 'scoped' | 'wildcard';

/** Wire DecisionReason（与 agent-wire approval.ts 分支对齐）。 */
export type DecisionReason =
  | { type: 'plan_guard'; deny_code: PlanGuardDenyCode; details?: unknown }
  | { type: 'hardline_block'; pattern_name: string; matched_text: string }
  | { type: 'hardline_confirm'; pattern_name: string; matched_text: string }
  | { type: 'skill_not_approved'; skill_id: string }
  | { type: 'skill_trust_downgrade'; skill_id: string; from_preset: string; to_preset: string }
  | { type: 'operation_switch'; switch_key: string; switch_action: 'allow' | 'confirm' | 'block' }
  | { type: 'deny_read_path'; path: string; matched_pattern: string }
  | { type: 'deny_write_path'; path: string; matched_pattern: string }
  | { type: 'sandbox_readonly'; path: string; grant_path: string }
  | { type: 'bash_too_complex'; node: string }
  | { type: 'bash_parse_unavailable' }
  | { type: 'memoized_always'; previous_reason?: unknown }
  | { type: 'memoized_thread'; previous_reason?: unknown }
  | { type: 'classifier_low_confidence'; confidence: number }
  | { type: 'classifier_decided'; confidence: number; llm_reason: string }
  | { type: 'user_interactive'; scope: ApprovalScope; rejection_message?: string }
  | { type: 'unknown_tool' }
  | { type: 'fallback_preset'; preset: string }
  | {
      type: 'rule_high_risk_allowlist_miss';
      preset_name: string;
      risk_signal: 'allowlist_miss' | 'high_risk_category';
      matched_text?: string;
    }
  | { type: 'hardline_command'; pattern: string }
  | { type: 'hardline_path'; pattern: string }
  | { type: 'sensitive_out_deny'; path: string; category: string }
  | { type: 'sensitive_in_ask'; path: string; category: string }
  | {
      type: 'memo_allow';
      key: string;
      createdAt: string;
      specificity: MemoSpecificity;
      scope_description?: string;
    }
  | {
      type: 'memo_deny';
      key: string;
      createdAt: string;
      specificity: MemoSpecificity;
      scope_description?: string;
    }
  | { type: 'yolo_allow' }
  | { type: 'auto_allow' }
  | { type: 'full_access_allow' }
  | { type: 'policy_risk_ask'; pattern?: string; category?: string }
  | { type: 'workspace_in'; path: string; kind: 'path' | 'cwd' }
  | { type: 'workspace_out'; path: string; kind: 'path' | 'cwd' }
  | { type: 'platform_artifact_allow'; path: string }
  | { type: 'platform_gate_deferred'; surface: string }
  | { type: 'destructive_in_workspace_ask'; path: string }
  | { type: 'object_default_allow' }
  | { type: 'object_write_ask' }
  | { type: 'mcp_default_ask'; server?: string }
  | { type: 'device_default_ask'; device_action?: string }
  | { type: 'device_observe_allow' }
  | { type: 'plan_blocked'; mode: string }
  | { type: 'fallback_ask' };

export type PlanRef =
  | { kind: 'file'; path: string }
  | { kind: 'document'; document_id: string };

export interface PlanProposalTodo {
  id: string;
  content: string;
  status: string;
}

export type InheritMode = 'full' | 'filtered' | 'summary' | 'none';

export interface SubAgentPolicyDto {
  tool_whitelist: string[];
  tool_blacklist: string[];
  model_override?: string | null;
  thinking_config?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type SpeakerKind = 'user' | 'main_agent' | 'sub_agent' | 'peer_agent';

export interface SpeakerIdentity {
  speaker_id: string;
  kind: SpeakerKind;
  parent_session_id?: string;
  parent_thread_id?: string;
  source?: 'template' | 'inherit' | 'blank';
  template_id?: string;
  template_version?: number;
  template_name?: string;
  inherit_mode?: InheritMode;
  display_name: string;
  role?: string;
  display_color?: string;
  display_short_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  started_at: number;
  ended_at?: number;
  model?: string;
  tools?: string[];
  max_turns?: number;
}
