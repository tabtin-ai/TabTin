/**
 * 云端 document 载体 PlanStore —— 宿主侧业务实现。
 *
 * agent-runtime 只保留中性的 `PlanStore` 接口 + 本地文件实现（LocalFilePlanStore）；
 * 打远端 `/api/plan/*` 落云文档的实现属于 TabTin 宿主业务，故落在 `@tabtin/agent-host`。
 * 本类实现 runtime 的 `PlanStore` 接口（`kind='document'`），由宿主装配 plan 工具时
 * 显式注入 `createPlanTools({ planStore })`（云端运行时使用）。
 *
 * 与 LocalFilePlanStore 共享 runtime 侧的 todos 归一化 / 校验（{@link normalizePlanTodos}）
 * 与错误翻译（{@link translateBackendError}），保证两种载体错误质量一致。
 */

import type { PlanRef } from '@tabtin/agent-wire';
import type {
  PlanContentInput,
  PlanSnapshot,
  PlanStore,
  ToolContext,
} from '@tabtin/agent-runtime'
import type {
  AgentModeName,
} from '@tabtin/agent-modes'
import { normalizePlanTodos } from '@tabtin/agent-runtime';
import type {
  NormalizedPlanTodo,
  PlanStoreResult,
  PlanTodoInput,
  PlanTodoStatus,
} from '@tabtin/agent-runtime';
import {
  joinApiPath,
  jsonError,
  RUNTIME_MISCONFIG,
  toJsonErrorMetadata,
  translateBackendError,
  UPSTREAM_ERROR,
} from '@tabtin/agent-runtime/tools';

// ── 本地私有 helper（随本实现一起，不回落 runtime 内部符号） ──────────

const PLAN_TODO_STATUSES: ReadonlySet<PlanTodoStatus> = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

function planStoreError(message: string, metadata: Record<string, unknown>): PlanStoreResult<never> {
  return { ok: false, result: jsonError(message, metadata) };
}

function invalidTodoResult(
  error: { message: string; field: string },
  hint?: string,
): PlanStoreResult<never> {
  return planStoreError(error.message, {
    error_kind: 'invalid_param_format',
    field: error.field,
    ...(hint ? { hint } : {}),
  });
}

function extractTodos(snap: Record<string, unknown> | null): NormalizedPlanTodo[] | null {
  if (!snap) return null;
  const raw = snap.todos;
  if (!Array.isArray(raw)) return null;
  return raw.map((t, idx) => {
    const item = (t ?? {}) as Record<string, unknown>;
    const status =
      typeof item.status === 'string' && PLAN_TODO_STATUSES.has(item.status as PlanTodoStatus)
        ? (item.status as PlanTodoStatus)
        : 'pending';
    return {
      id: typeof item.id === 'string' && item.id ? item.id : `todo-${idx}`,
      content: typeof item.content === 'string' ? item.content : '',
      status,
    };
  });
}

// ── TabDocPlanStore（云端运行时，包装现有 /api/plan/*） ────────────────

export interface TabDocPlanStoreDeps {
  apiBaseUrl: string;
  apiAuthToken?: string;
  organizationId: string;
  threadId?: string;
  agentId?: string;
  agentMode?: AgentModeName;
  fetchImpl?: typeof fetch;
  onLog?: (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => void;
}

interface PlanHttpEnvelope {
  success?: boolean;
  code?: string | number;
  message?: string;
  data?: Record<string, unknown>;
}

type PlanApiEndpoint = 'create' | 'update_todos';

function planApiToolName(endpoint: PlanApiEndpoint): 'plan_create' | 'plan_update_todos' {
  return endpoint === 'create' ? 'plan_create' : 'plan_update_todos';
}

function planApiFailure(args: {
  endpoint: PlanApiEndpoint;
  status?: number;
  body?: unknown;
  error?: unknown;
  fallbackMessage: string;
  metadata?: Record<string, unknown>;
}): PlanStoreResult<never> {
  const translated = translateBackendError({
    status: args.status,
    body: args.body,
    error: args.error,
    toolName: planApiToolName(args.endpoint),
    operation: `plan ${args.endpoint}`,
    fallbackMessage: args.fallbackMessage,
  });
  return planStoreError(translated.message, toJsonErrorMetadata(translated, {
    endpoint: args.endpoint,
    ...args.metadata,
  }));
}

function isPlanApiSuccess(payload: PlanHttpEnvelope): boolean {
  return (
    payload.success === true ||
    payload.code === 0 ||
    payload.code === '0' ||
    payload.code === 'OK' ||
    payload.code === 'SUCCESS'
  );
}

function buildPlanCreateBody(
  input: PlanContentInput,
  todos: NormalizedPlanTodo[],
  deps: TabDocPlanStoreDeps,
): Record<string, unknown> {
  // ：Plan 文档只挂 Organization，body 永不带 space_id
  const body: Record<string, unknown> = {
    organization_id: deps.organizationId,
    name: input.name.trim(),
    overview: input.overview ?? '',
    plan: input.planMarkdown ?? '',
    todos,
    is_project: Boolean(input.isProject),
  };
  if (Array.isArray(input.phases)) body.phases = input.phases;
  if (Array.isArray(input.allowedPrompts)) body.allowed_prompts = input.allowedPrompts;
  if (deps.threadId) body.session_id = deps.threadId;
  if (deps.agentId) body.agent_id = deps.agentId;
  if (deps.agentMode) body.agent_mode_at_create = deps.agentMode;
  return body;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value != null && value !== '') ?? '';
}

function tabDocPlanSnapshot(args: {
  ref: PlanRef;
  apiData: Record<string, unknown>;
  input: PlanContentInput;
  todos: NormalizedPlanTodo[];
}): PlanSnapshot {
  const { ref, apiData, input, todos } = args;
  const planSnap = (apiData.plan ?? null) as Record<string, unknown> | null;
  const docPayload = (apiData.document ?? null) as Record<string, unknown> | null;
  const overview = firstNonEmpty(stringField(planSnap, 'overview'), input.overview);
  const planName = firstNonEmpty(
    stringField(planSnap, 'name'),
    stringField(docPayload, 'title'),
    input.name.trim(),
  );
  const markdown = firstNonEmpty(
    stringField(docPayload, 'description_markdown'),
    input.planMarkdown,
  );
  return {
    ref,
    name: planName,
    overview,
    todos: extractTodos(planSnap) ?? todos,
    markdown,
    revision: 0,
    collectionId: (apiData.collection_id as string | null | undefined) ?? null,
  };
}

/**
 * 云端 plan 存储：直接复用 Django `/api/plan/{create,update_todos}`。
 * revision 由客户端侧按事件到达顺序维护（后端无 revision 语义），
 * 这里统一返回 0 —— 云端路径的卡片 upsert 仍可用 plan_ref 去重；
 * 若后续需要严格 revision，可在 Django 侧补 updated_at 序号。
 */
export class TabDocPlanStore implements PlanStore {
  readonly kind = 'document' as const;

  constructor(private readonly deps: TabDocPlanStoreDeps) {}

  private async call(
    endpoint: PlanApiEndpoint,
    body: Record<string, unknown>,
    context: ToolContext,
  ): Promise<PlanStoreResult<Record<string, unknown>>> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = joinApiPath(this.deps.apiBaseUrl, `/plan/${endpoint}`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.deps.apiAuthToken) headers['Authorization'] = `Bearer ${this.deps.apiAuthToken}`;
    if (this.deps.organizationId) headers['X-TabTin-Organization-Id'] = this.deps.organizationId;

    const internalTimeoutSignal = AbortSignal.timeout(30_000);
    const signal = context.abortSignal
      ? AbortSignal.any([internalTimeoutSignal, context.abortSignal])
      : internalTimeoutSignal;

    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      this.deps.onLog?.('error', `Plan API ${endpoint} 网络请求失败`, err);
      if (context.abortSignal?.aborted) {
        return planStoreError('Plan API 请求被取消（用户停止）。', {
          error_kind: 'aborted_by_user',
          hint: 'Stop this plan operation because the user cancelled the current run.',
        });
      }
      return planApiFailure({
        endpoint,
        error: err,
        fallbackMessage: 'The plan service could not complete the request.',
      });
    }

    let payload: PlanHttpEnvelope = {};
    try {
      payload = (await resp.json()) as PlanHttpEnvelope;
    } catch (parseErr) {
      this.deps.onLog?.('error', `Plan API ${endpoint} 返回非 JSON (status=${resp.status})`, parseErr);
      return planApiFailure({
        endpoint,
        status: resp.status,
        body: null,
        fallbackMessage: 'The plan service returned an invalid response.',
        metadata: { http_status: resp.status },
      });
    }

    if (!resp.ok) {
      return planApiFailure({
        endpoint,
        status: resp.status,
        body: payload,
        fallbackMessage: 'The plan service could not complete the request.',
        metadata: { http_status: resp.status },
      });
    }

    const data = (payload.data as Record<string, unknown> | undefined) ?? {};
    if (!isPlanApiSuccess(payload) && Object.keys(data).length === 0) {
      return planApiFailure({
        endpoint,
        status: resp.status,
        body: payload,
        fallbackMessage: 'The plan service could not complete the request.',
      });
    }

    return { ok: true, value: data };
  }

  async create(
    input: PlanContentInput,
    context: ToolContext,
  ): Promise<PlanStoreResult<PlanSnapshot>> {
    if (!this.deps.organizationId) {
      return planStoreError('Plan 工具未正确初始化：organization_id 缺失。', {
        error_kind: RUNTIME_MISCONFIG,
      });
    }
    const normalized = normalizePlanTodos(input.todos);
    if (!normalized.ok) {
      return invalidTodoResult(normalized.error);
    }

    const body = buildPlanCreateBody(input, normalized.todos, this.deps);

    const r = await this.call('create', body, context);
    if (!r.ok) return r;

    const documentId = typeof r.value.document_id === 'string' ? r.value.document_id : undefined;
    if (!documentId) {
      return planStoreError('Plan API 创建成功但未返回有效 document_id。', {
        error_kind: UPSTREAM_ERROR,
        hint: 'Stop updating this plan because no document_id was returned; report the service response issue to the user.',
      });
    }

    const ref: PlanRef = { kind: 'document', document_id: documentId };
    return {
      ok: true,
      value: tabDocPlanSnapshot({
        ref,
        apiData: r.value,
        input,
        todos: normalized.todos,
      }),
    };
  }

  async updateTodos(
    ref: PlanRef,
    todos: PlanTodoInput[],
    merge: boolean,
    context: ToolContext,
  ): Promise<PlanStoreResult<PlanSnapshot>> {
    if (ref.kind !== 'document') {
      return {
        ok: false,
        result: jsonError('document 载体 PlanStore 只能更新 document 类型的 plan。', {
          error_kind: RUNTIME_MISCONFIG,
        }),
      };
    }
    const incoming = normalizePlanTodos(todos);
    if (!incoming.ok) {
      return {
        ok: false,
        result: jsonError(incoming.error.message, {
          error_kind: 'invalid_param_format',
          field: incoming.error.field,
        }),
      };
    }
    const body: Record<string, unknown> = {
      plan_document_id: ref.document_id,
      todos: incoming.todos,
      merge,
    };
    const r = await this.call('update_todos', body, context);
    if (!r.ok) return r;

    const after = extractTodos({ todos: r.value.todos_after_update }) ?? incoming.todos;
    return {
      ok: true,
      value: {
        ref,
        name: typeof r.value.name === 'string' ? (r.value.name as string) : '',
        overview: '',
        todos: after,
        markdown: '',
        revision: 0,
        collectionId: null,
      },
    };
  }
}
