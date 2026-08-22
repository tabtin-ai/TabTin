import { PlanProposalEvent } from '../event/events/proposal-events.js';
import { planRefKey, parsePlanRefKey, planRefToLegacyId } from '../engine/contracts/plan-ref.js';
import type { PlanRef } from '../engine/contracts/wire-payloads.js';
import {
  getActivePlanRef,
  markActivePlan,
} from '../state/active-plan-tracker.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { jsonError } from '../capability/core/_utils.js';
import { MISSING_REQUIRED_PARAM, RUNTIME_MISCONFIG } from '../engine/errors/error-kinds.js';
import {
  type PlanContentInput,
  type PlanSnapshot,
  type PlanStore,
  type PlanTodoInput,
  snapshotTodosForProposal,
} from './plan-store.js';

/**
 * Plan 二件套工具：plan_create / plan_update_todos
 *
 * PlanStore adapter 化后，本文件是**薄工具层**：只做参数归一 + 调
 * `deps.planStore`（本地运行时 = LocalFilePlanStore 写 working_dir `.md`；云端运行时
 * = 宿主注入的 document 载体 PlanStore 落远端计划文档）+ 发 `plan_proposal` stream event。
 *
 * 产品决策（无 plan_exit）：LLM 在 plan/study 模式只负责**起草 / 修订**，通过
 * `plan_proposal` 事件让渲染端插入 / 更新卡片。「是否执行」由用户点击卡片按钮决定。
 *
 * **命名约束**：工具名必须满足 `^[a-zA-Z0-9_-]{1,64}$`（OpenAI / Anthropic 硬约束）。
 */

// ── 类型 ───────────────────────────────────────────────────────────

export type { PlanTodoInput, PlanPhaseInput } from './plan-store.js';

export interface PlanCreateToolInput {
  name: string;
  overview?: string;
  plan?: string;
  todos?: PlanTodoInput[];
  is_project?: boolean;
  phases?: Array<{ id?: string; name: string; summary?: string; todo_ids?: string[] }>;
  allowed_prompts?: string[];
}

export interface PlanUpdateTodosToolInput {
  /** plan_create 返回的 plan_ref 字符串（如 `file:plans/...` / `document:<id>`）。 */
  plan_ref?: string;
  /** 过渡兼容：旧字段，直传 document id 或 ref key。 */
  plan_document_id?: string;
  todos: PlanTodoInput[];
  merge?: boolean;
}

export interface PlanToolsDeps {
  /**
   * plan 存储实现，由 host 装配时**必填**注入：
   *   - 本地运行时（Electron / Daemon）→ LocalFilePlanStore（写 working_dir `.md`）；
   *   - 云端运行时 → 宿主注入的 document 载体 PlanStore（落远端计划文档）。
   */
  planStore: PlanStore;
  /** 业务对话 thread id：active-plan-tracker 记账 + plan_proposal 事件 sessionId。 */
  threadId?: string;
  onLog?: (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => void;
}

// ── Schemas ────────────────────────────────────────────────────────

const planCreateInputSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Plan 名称。1-200 字符。',
    },
    overview: {
      type: 'string',
      description: '一段话概述本 Plan 的目标 / 范围 / 取舍。建议 ≤4000 字符。',
    },
    plan: {
      type: 'string',
      description:
        'Plan 正文 Markdown（背景、现状、推荐方案、风险、验证方式）。作为 plan 载体的正文内容。',
    },
    todos: {
      type: 'array',
      description:
        'Plan 内的初始 todo 列表（执行期 todo 不会回写本字段；保持 Plan/Todo 严格分工）。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '可选；不传时自动生成。' },
          content: { type: 'string', description: 'todo 描述文本。1-2000 字符。' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: '初始状态，默认 pending。',
          },
        },
        required: ['content'],
      },
    },
    is_project: {
      type: 'boolean',
      description: '是否项目型 Plan（多阶段、长周期）。True 时建议提供 phases。',
    },
    phases: {
      type: 'array',
      description: '阶段划分（可选，is_project=True 时通常使用）。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          summary: { type: 'string' },
          todo_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
    },
    allowed_prompts: {
      type: 'array',
      items: { type: 'string' },
      description: 'P1 预留：执行后允许追加的快捷指令；本期接收但不处理。',
    },
  },
  required: ['name'],
} as unknown as Tool['inputSchema'];

const planUpdateTodosInputSchema = {
  type: 'object',
  properties: {
    plan_ref: {
      type: 'string',
      description:
        '要更新的 Plan 指针（来自 plan_create 返回的 `plan_ref` 字段，原样回传）。不要编造。',
    },
    todos: {
      type: 'array',
      description: '本次要更新的 todo 列表。merge=true 时按 id 合并；缺省 id 视为新增。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'merge 模式按此匹配。' },
          content: { type: 'string', description: '1-2000 字符。' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          },
        },
        required: ['content'],
      },
      minItems: 1,
    },
    merge: {
      type: 'boolean',
      description: '`true` = 按 `id` 合并新增；`false` = 整段替换。默认 `true`。',
    },
  },
  required: ['plan_ref', 'todos'],
} as unknown as Tool['inputSchema'];

// ── Factory ────────────────────────────────────────────────────────

export function createPlanTools(deps: PlanToolsDeps): Tool[] {
  const store: PlanStore = deps.planStore;
  return [createPlanCreateTool(deps, store), createPlanUpdateTodosTool(deps, store)];
}

// ── plan_proposal 事件（双写 plan_document_id + plan_ref + revision） ──────

/**
 * ：plan 卡片作为**持久化 content block**（`tabtin_rich_content` kind='plan'）落进
 * content_blocks_json，随消息落库、重启后从历史恢复。payload 只存 **plan_ref 指针 +
 * 轻量展示字段**（name/overview/todos/revision），**不存正文 markdown**——正文由卡片
 * 「打开/执行」时按 plan_ref 懒读 file/TabDoc。
 */
function emitPlanProposal(
  deps: PlanToolsDeps,
  context: ToolContext,
  snapshot: PlanSnapshot,
): void {
  // (1) 持久化 block —— 桌面端渲染 + 重启后从历史恢复。payload 只存指针 + 轻量字段。
  try {
    context.emitRichContentBlock?.({
      kind: 'plan',
      summary: snapshot.name || 'Plan',
      payload: {
        plan_ref: snapshot.ref,
        // 过渡兼容：旧读取路径 / deep link 可能仍读 plan_document_id
        plan_document_id: planRefToLegacyId(snapshot.ref),
        revision: snapshot.revision,
        plan_name: snapshot.name,
        overview: snapshot.overview,
        todos: snapshotTodosForProposal(snapshot),
        executed: false,
        // 故意不含 description_markdown（正文懒读）
      },
    });
  } catch (err) {
    // 桌面端主渲染 + 重启恢复都依赖这个持久化 block；失败比流事件失败严重（会出现
    // 「移动端有卡、桌面端无卡」的单向故障），升到 error 级确保可诊断。plan 文件/文档
    // 已写成功，此处不硬失败（否则会让 LLM 误以为 plan 创建失败而重复创建）。
    deps.onLog?.('error', 'plan block emit failed — 桌面端卡片不会落库/重启恢复', err);
  }

  // (2) 过渡期兼容流事件 —— 移动端（iOS/Android）仍从 plan_proposal 流事件渲染卡片。
  // 桌面端已改走持久化 block、不再消费本事件（不会双卡）。移动端采纳 block 渲染后
  // 可删除本段。流事件不落库，可带正文快照供移动端即时展示。
  try {
    context.emitStreamEvent?.(new PlanProposalEvent({
      planDocumentId: planRefToLegacyId(snapshot.ref),
      planRef: snapshot.ref,
      revision: snapshot.revision,
      sessionId: deps.threadId,
      planName: snapshot.name,
      overview: snapshot.overview,
      todos: snapshotTodosForProposal(snapshot),
      descriptionMarkdown: snapshot.markdown,
    }).toStreamEvent());
  } catch (err) {
    deps.onLog?.('warn', 'plan_proposal stream emit failed (non-fatal)', err);
  }
}

// ── 工具实现 ────────────────────────────────────────────────────────

function createPlanCreateTool(deps: PlanToolsDeps, store: PlanStore): Tool {
  return {
    name: 'plan_create',
    policyActionKind: 'object_write',
    // ：Plan 是 Agent 自身任务状态（方案卡片，执行与否由用户点「执行」
    // 决定），创建动作本身无损失面——riskLevel='safe' 让 judge 放行不弹审批。
    riskLevel: 'safe',
    description:
      '创建一份新的正式 Plan（本地运行时落 working_dir 下的 plan 文件；云端运行时落远端计划文档）。' +
      '返回 `plan_ref`（后续 plan_update_todos 必须原样回传，不要编造）。' +
      '用户会看到方案以内联卡片形式出现在 chat 里，带「执行」按钮——是否执行**用户决定，你不决定**。' +
      '调完本工具后用纯文本简短总结方案，然后**结束本轮**，让用户审查并点「执行」。',
    inputSchema: planCreateInputSchema,
    isReadOnly: false,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = (input ?? {}) as PlanCreateToolInput;
      if (!params.name || typeof params.name !== 'string' || !params.name.trim()) {
        return jsonError('plan name 必填，且不能为空字符串。', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'name',
          hint: 'Provide a concise plan name before calling plan_create.',
        });
      }

      const content: PlanContentInput = {
        name: params.name.trim(),
        overview: params.overview ?? '',
        planMarkdown: params.plan ?? '',
        todos: Array.isArray(params.todos) ? params.todos : [],
        isProject: Boolean(params.is_project),
        phases: Array.isArray(params.phases) ? params.phases : undefined,
        allowedPrompts: Array.isArray(params.allowed_prompts) ? params.allowed_prompts : undefined,
      };

      const r = await store.create(content, context);
      if (!r.ok) return r.result;
      const snapshot = r.value;

      // active-plan-tracker：写入统一 ref。无 threadId 时跳过。
      let messageHint =
        'Plan 草稿已创建并展示给用户（chat 流里的卡片）。如需修订继续调 plan_update_todos；' +
        '执行与否由用户点击卡片上的「执行」按钮决定，你只需用文字简短总结后结束本轮。';
      if (deps.threadId) {
        const previousActive = getActivePlanRef(deps.threadId);
        markActivePlan(deps.threadId, snapshot.ref);
        if (previousActive && planRefKey(previousActive) !== planRefKey(snapshot.ref)) {
          messageHint =
            `已覆盖之前未结算的 plan 草稿；旧卡片仍在 chat 历史里独立可见。\n` + messageHint;
        }
      }

      emitPlanProposal(deps, context, snapshot);

      return {
        content: JSON.stringify({
          success: true,
          plan_ref: planRefKey(snapshot.ref),
          // 过渡兼容字段（旧调用方 / 提示可能仍读 document_id）
          document_id: planRefToLegacyId(snapshot.ref),
          collection_id: snapshot.collectionId ?? null,
          plan: {
            name: snapshot.name,
            overview: snapshot.overview,
            todos: snapshot.todos,
          },
          message: messageHint,
        }),
      };
    },
  };
}

function resolveUpdateRef(
  params: PlanUpdateTodosToolInput,
  threadId: string | undefined,
): PlanRef | null {
  const fromKey = parsePlanRefKey(params.plan_ref ?? params.plan_document_id);
  if (fromKey) return fromKey;
  if (threadId) return getActivePlanRef(threadId);
  return null;
}

function createPlanUpdateTodosTool(deps: PlanToolsDeps, store: PlanStore): Tool {
  return {
    name: 'plan_update_todos',
    policyActionKind: 'object_write',
    // ：同 plan_create——todo 状态翻转是纯进度更新，不弹审批。
    riskLevel: 'safe',
    description:
      '更新已有 Plan 的 todos。`merge=true`（默认）按 todo id upsert；`merge=false` 整体替换。' +
      '本地运行时会同时刷新 chat 里的卡片（用户看到最新 todos）。简短告诉用户你改了什么。',
    inputSchema: planUpdateTodosInputSchema,
    isReadOnly: false,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = (input ?? {}) as PlanUpdateTodosToolInput;
      const ref = resolveUpdateRef(params, deps.threadId);
      if (!ref) {
        return jsonError(
          'plan_ref 必填（来自最近一次 plan_create 返回值）。' +
            '当前会话也没有进行中的 Plan 草稿，请先 plan_create 起草。',
          {
            error_kind: MISSING_REQUIRED_PARAM,
            field: 'plan_ref',
            hint: 'Use the plan_ref returned by plan_create, or call plan_create first when no active draft exists.',
          },
        );
      }
      if (!Array.isArray(params.todos) || params.todos.length === 0) {
        return jsonError('todos 必填且不能为空数组（至少传一条 todo）。', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'todos',
          hint: 'Pass at least one todo object with content and status before calling plan_update_todos.',
        });
      }
      // ref 与 store 载体不匹配（如本地 store 收到 document ref）→ 明确报错，不静默。
      if (ref.kind !== store.kind) {
        return jsonError(
          `plan_ref 类型（${ref.kind}）与当前运行时的 plan 存储（${store.kind}）不匹配。` +
            '请用本会话 plan_create 返回的 plan_ref。',
          { error_kind: RUNTIME_MISCONFIG, field: 'plan_ref' },
        );
      }

      const r = await store.updateTodos(ref, params.todos, params.merge !== false, context);
      if (!r.ok) return r.result;
      const snapshot = r.value;

      // 重发 plan_proposal，让客户端按 revision upsert 卡片。
      // 仅在快照带完整正文时重发（file 载体总是完整；document 载体的 update 响应
      // 不含 markdown/overview，重发会抹掉卡片正文——云端路径保持不重发，
      // 靠继续消息前的重读兜新鲜度）。
      if (store.kind === 'file') {
        emitPlanProposal(deps, context, snapshot);
      }

      return {
        content: JSON.stringify({
          success: true,
          plan_ref: planRefKey(snapshot.ref),
          todos_after_update: snapshot.todos,
          message: 'Plan todos 已更新。继续修订或用文字简短告知用户改动后结束本轮，让用户决定何时执行。',
        }),
      };
    },
  };
}
