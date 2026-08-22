/**
 * Plan Proposal 事件契约
 *
 * `plan_create` 工具完成后会通过 `context.emitStreamEvent` 发出
 * `agent.stream.plan_proposal` 事件，让渲染端在 chat 流里插入 / 更新一张 inline 卡片。
 *
 * 设计取向：
 *   - LLM 不再持有 `plan_exit` 工具。「执行 / 不执行」是产品级 UI 交互，
 *     由用户点击 PlanProposalCard 的「执行」按钮触发；卡片不再做模态阻断。
 *   - **PlanStore adapter 化**：plan 可能落在两种载体——本地运行时的
 *     working_dir `.md` 文件（`plan_ref.kind = 'file'`），或云端运行时的
 *     TabDoc 文档（`plan_ref.kind = 'document'`）。`plan_ref` 是统一指针，
 *     客户端据其类型决定「打开 / 重读」走哪条通道。
 *   - **过渡期双写**：`plan_ref` 为新 SSoT；同时保留 `plan_document_id`
 *     （旧客户端仍读它——document 载体填真实 id，file 载体填文件相对路径），
 *     让新旧客户端在过渡期任意组合都不炸。新客户端优先读 `plan_ref`，
 *     回退 `plan_document_id`。
 *   - `revision` 单调递增：`plan_update_todos` 会重发本事件，客户端按
 *     `plan_ref` upsert 既有卡片，用 `revision` 判定新旧、避免旧事件覆盖新状态。
 *   - 字段使用 snake_case 与其它 stream event payload 风格保持一致。
 */

import { z } from 'zod';

const PlanProposalTodoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.string(),
});

/**
 * Plan 统一指针（discriminated union）。
 *
 * - `file`：本地运行时。`path` 为相对 working_dir 的路径（如 `plans/2026-07-04-foo.plan.md`）。
 * - `document`：云端运行时。`document_id` 为 TabDoc Document.id（UUID）。
 */
export const PlanRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('document'), document_id: z.string().min(1) }),
]);

export type PlanRef = z.infer<typeof PlanRefSchema>;

export const PlanProposalEventPayloadSchema = z
  .object({
    /**
     * 过渡期兼容字段（旧客户端唯一读的字段）。
     * - document 载体：TabDoc Document.id；
     * - file 载体：plan 文件相对路径（客户端无 UUID 格式校验，可安全承载 path）。
     * 新客户端应优先读 `plan_ref`，仅在其缺失时回退本字段。
     */
    plan_document_id: z.string(),
    /** 新 SSoT：plan 统一指针。过渡期后 `plan_document_id` 可下线。 */
    plan_ref: PlanRefSchema.optional(),
    /** 单调递增版本号；plan_update_todos 重发事件时 +1，客户端据此 upsert。 */
    revision: z.number().int().nonnegative().optional(),
    /** 当前 chat session id；renderer 据此把 system 消息写入对应 session */
    session_id: z.string().optional(),
    /** Plan 名称（同 Document.title / 文件 frontmatter plan_name） */
    plan_name: z.string(),
    /** 概述 */
    overview: z.string(),
    /** 当前 todos 快照 */
    todos: z.array(PlanProposalTodoSchema),
    /** 当前正文 markdown 快照 */
    description_markdown: z.string(),
  })
  .passthrough();

export type PlanProposalEventPayload = z.infer<typeof PlanProposalEventPayloadSchema>;

export type PlanProposalTodo = z.infer<typeof PlanProposalTodoSchema>;

// ── PlanRef 辅助工具（tracker / 卡片 upsert / 继续消息共用）──────────────

/**
 * 把 PlanRef 归一化为稳定字符串 key（用于 Map 去重、卡片 upsert 键、相等比较）。
 * - file → `file:<path>`
 * - document → `document:<id>`
 */
export function planRefKey(ref: PlanRef): string {
  return ref.kind === 'file' ? `file:${ref.path}` : `document:${ref.document_id}`;
}

/** 两个 PlanRef 是否指向同一 plan。 */
export function planRefEquals(a: PlanRef | null | undefined, b: PlanRef | null | undefined): boolean {
  if (!a || !b) return false;
  return planRefKey(a) === planRefKey(b);
}

/**
 * 把 {@link planRefKey} 产出的字符串还原为 PlanRef。
 * - `file:<path>` → file 载体
 * - `document:<id>` → document 载体
 * - 其它（无前缀）→ 视为 legacy document id（兼容旧 plan_document_id 直传）
 * 空串返回 null。
 */
export function parsePlanRefKey(key: string | null | undefined): PlanRef | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file:')) {
    const p = trimmed.slice('file:'.length);
    return p ? { kind: 'file', path: p } : null;
  }
  if (trimmed.startsWith('document:')) {
    const id = trimmed.slice('document:'.length);
    return id ? { kind: 'document', document_id: id } : null;
  }
  return { kind: 'document', document_id: trimmed };
}

/**
 * 过渡期兼容读取：优先 `plan_ref`，回退 `plan_document_id`。
 * 老 payload 只有 `plan_document_id` 时，无法判定载体类型，按 document 处理
 * （老 runtime 只产 TabDoc plan，这是安全默认）。
 */
export function resolvePlanRef(payload: {
  plan_ref?: PlanRef;
  plan_document_id?: string;
}): PlanRef | null {
  if (payload.plan_ref) return payload.plan_ref;
  if (payload.plan_document_id) {
    return { kind: 'document', document_id: payload.plan_document_id };
  }
  return null;
}

/**
 * 反向：为过渡期 payload 生成 `plan_document_id` 兼容值。
 * - document → 真实 id
 * - file → 相对路径（旧客户端会当作不透明字符串，不会因非 UUID 崩溃）
 */
export function planRefToLegacyId(ref: PlanRef): string {
  return ref.kind === 'file' ? ref.path : ref.document_id;
}
