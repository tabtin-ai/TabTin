/**
 * persist 事件族（AgentEvent 子类）—— 消息级持久化落库的 transcript 事件
 * （事件系统深度重构 · 第 2 层）。
 *
 * 三类都发 `agent.stream.persist_message`（落库唯一权威，见 relay_message_writer /
 * message-block-storage），区别只在 `message_kind` 与 payload：
 *   - `PersistMessageEvent`：主 LLM / 压缩摘要 / 子代理正文（message_kind 由调用方给）；
 *   - `HitlInteractionEvent`：审批 / 追问交互事实（message_kind='hitl_interaction'，
 *     message_id=uuid5(kind,request_key) 与 Django 逐字节一致）；
 *   - `ToolArtifactEvent`：工具产物气泡（message_kind='tool_artifact'）。
 *
 * `arrival_seq` 在此显式携带（消息的对话时间，非 egress 兜底）；`event_id` 仍由
 * `EventEmitter` egress 盖。wire 形状不变（`{type, payload}`）。
 *
 * `agent_run_id`：与 lifecycle `run_id` / ToolContext.agentRunId 同源，
 * 由本事件**领域 payload 显式携带**（字段名即 ChatMessage 列契约）；禁止依赖
 * Django 把 envelope `run_id` 改名映射。双路径漂移背景见 。
 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import { AgentEvent, type InheritedIdentity } from '../agent-event.js';
import { nextArrivalSeq } from '../event-emitter.js';
import type { ContentBlock } from '../../engine/contracts/conversation.js';
import { v5 as uuidv5 } from 'uuid';

/** 落库块：引擎 ContentBlock + 可选块级对话时序（仅 persist 边界，不进 LLM 契约）。 */
type PersistedContentBlock = ContentBlock & { arrival_seq?: number };

/**
 * 落库单点盖章：每个 content block 带上块级 `arrival_seq`。
 *
 * - 已有有限数字 → 原样保留（幂等，不重盖）
 * - 缺失 → `messageArrivalSeq + index`（与消息级对话时间同族、块内单调）
 * - 消息级也缺 → 先 `nextArrivalSeq()` 定 base，再 + index
 *
 * Django relay 禁止服务端补块级 seq；冷加载 / reconcile 要靠这里一次带齐。
 */
export function stampBlocksArrival(
  blocks: readonly ContentBlock[],
  messageArrivalSeq?: number,
): { blocks: PersistedContentBlock[]; arrivalSeq: number } {
  const base =
    typeof messageArrivalSeq === 'number' && Number.isFinite(messageArrivalSeq)
      ? messageArrivalSeq
      : nextArrivalSeq();
  const stamped = blocks.map((block, index): PersistedContentBlock => {
    const existing = (block as PersistedContentBlock).arrival_seq;
    if (typeof existing === 'number' && Number.isFinite(existing)) {
      return block as PersistedContentBlock;
    }
    return { ...block, arrival_seq: base + index };
  });
  return { blocks: stamped, arrivalSeq: base };
}

/** HITL namespace —— 必须与 Django `HITL_MESSAGE_NAMESPACE` 完全一致。 */
const HITL_MESSAGE_NAMESPACE = '7b1f4d2e-9c3a-4f6b-8d5e-2a0c1b3f4e5d';

/** HITL 交互状态（与 Django PendingInteraction.status 同枚举）。 */
export type HitlStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';

/** HITL 交互种类（与 Django kind + 前端 reconcile 同口径）。 */
export type HitlKind = 'tool_approval' | 'ask_choice' | 'ask_form' | 'permission_request';

/** name-based uuid v5（SHA-1）——与 Python `uuid.uuid5(namespace, name)` 同算法。 */
function uuid5(namespace: string, name: string): string {
  return uuidv5(name, namespace);
}

/** HITL transcript 消息稳定 id：与 Django `hitl_message_client_event_id(kind, request_key)` 一致。 */
export function hitlMessageId(kind: HitlKind, requestKey: string): string {
  return uuid5(HITL_MESSAGE_NAMESPACE, `hitl:${kind}:${requestKey}`);
}

export interface PersistMessageArgs {
  messageId: string;
  role: 'assistant' | 'user';
  blocks: ContentBlock[];
  /**
   * Per-turn 归因锚点，与 `ToolContext.agentRunId` / lifecycle `run_id` 同源。
   * 以字段名 `agent_run_id` 写入 wire → ChatMessage（不在 Django 做 run_id 改名映射）。
   */
  agentRunId: string;
  /** 消息对话时间（arrival_seq）。缺省时由 EventEmitter egress 盖一个全局单调值（语义等价）。 */
  arrivalSeq?: number;
  subagentRunId?: string;
  messageKind?: string;
  stopReason?: string;
  partial?: boolean;
  metadata?: Record<string, unknown>;
  /** 终态错误结构化真相；与 ChatMessage.error_info_json 同名同形。 */
  errorInfoJson?: Record<string, unknown>;
  /**
   * 本轮实际执行模型 id（`EngineState.model`）。
   * Codex 为本机字面量（如 `gpt-5.6-sol`）；平台 / BYOK 多为 catalog UUID。
   * Django 仅在合法 UUID 时写入 ChatMessage.model_id FK。
   */
  modelId?: string;
  /**
   * 写盘瞬间展示名；缺省时可与 `modelId` 同值，由 AdminDash / Django 再解析
   * Codex 表或 LLMModel.display_name。
   */
  modelName?: string;
}

/** 通用消息级持久化事件（主 LLM / 压缩 / 子代理正文）。 */
export class PersistMessageEvent extends AgentEvent {
  readonly type = StreamEvents.PERSIST_MESSAGE;
  constructor(private readonly args: PersistMessageArgs) {
    super();
  }
  protected data(): Record<string, unknown> {
    const a = this.args;
    const { blocks, arrivalSeq } = stampBlocksArrival(a.blocks, a.arrivalSeq);
    return {
      message_id: a.messageId,
      client_event_id: a.messageId,
      role: a.role,
      blocks_json: blocks as unknown as Record<string, unknown>[],
      agent_run_id: a.agentRunId,
      arrival_seq: arrivalSeq,
      message_kind: a.messageKind ?? 'llm',
      ...(a.subagentRunId ? { subagent_run_id: a.subagentRunId } : {}),
      ...(a.stopReason ? { stop_reason: a.stopReason } : {}),
      ...(a.partial ? { partial: true } : {}),
      ...(a.metadata ? { metadata: a.metadata } : {}),
      ...(a.errorInfoJson ? { error_info_json: a.errorInfoJson } : {}),
      ...(a.modelId ? { model_id: a.modelId } : {}),
      ...(a.modelName ? { model_name: a.modelName } : {}),
    };
  }
}

export interface HitlInteractionArgs {
  kind: HitlKind;
  /** 幂等键：审批用 batch_id，追问用 request_id。 */
  requestKey: string;
  status: HitlStatus;
  /** 交互原始 payload；team-space 脱敏在 Django 出站边界做。 */
  payload: Record<string, unknown>;
  /** 与本轮 ToolContext.agentRunId 同源（写入 ChatMessage.agent_run_id）。 */
  agentRunId: string;
  expiresAtMs?: number | null;
  result?: Record<string, unknown>;
  resolvedAtMs?: number | null;
  /**
   * ：与卡片事件同源时显式传入（一次计算、多处复用）。
   * 缺省仍按 `hitlMessageId(kind, requestKey)` 派生，保持旧调用兼容。
   */
  messageId?: string;
}

/** HITL（审批/追问）交互事实事件——纯 metadata（空 blocks，面板由 metadata.hitl 驱动；arrival_seq 由 egress 盖）。 */
export class HitlInteractionEvent extends PersistMessageEvent {
  constructor(args: HitlInteractionArgs) {
    super({
      messageId: args.messageId ?? hitlMessageId(args.kind, args.requestKey),
      role: 'assistant',
      blocks: [],
      agentRunId: args.agentRunId,
      messageKind: 'hitl_interaction',
      metadata: {
        hitl: {
          kind: args.kind,
          request_key: args.requestKey,
          status: args.status,
          payload: args.payload ?? {},
          result: args.result ?? {},
          expires_at: args.expiresAtMs ?? null,
          resolved_at: args.resolvedAtMs ?? null,
        },
      },
    });
  }
}

/** 工具产物气泡事件（widget / 搜索卡 / CLI 卡 / 生成图 等 rich content；arrival_seq 由 egress 盖）。 */
export class ToolArtifactEvent extends PersistMessageEvent {
  constructor(args: {
    messageId: string;
    blocks: ContentBlock[];
    agentRunId: string;
    role?: 'assistant' | 'user';
    subagentRunId?: string;
  }) {
    super({
      messageId: args.messageId,
      role: args.role ?? 'assistant',
      blocks: args.blocks,
      agentRunId: args.agentRunId,
      messageKind: 'tool_artifact',
      ...(args.subagentRunId ? { subagentRunId: args.subagentRunId } : {}),
    });
  }
}

/** Django relay ACK 后回传的消息身份收敛事件（Host 合成、只发客户端）。 */
export class MessagePersistedEvent extends AgentEvent {
  readonly type = StreamEvents.MESSAGE_PERSISTED;
  constructor(
    private readonly messageIds: unknown[],
    eventId: string,
  ) {
    super();
    this.inherited = { event_id: eventId } satisfies InheritedIdentity;
  }
  override readonly inherited: InheritedIdentity;
  protected data(): Record<string, unknown> {
    return { message_ids: this.messageIds };
  }
}
