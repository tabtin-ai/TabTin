/**
 * PlanStore adapter —— plan 存储的统一抽象层
 *
 * plan-tools 工具层只面向 `PlanStore` 接口，不关心 plan「存在哪」。存储介质由
 * 运行时 host 装配时选定（运行期不切换）：
 *
 *   - **本地运行时**（Electron / Daemon）→ {@link LocalFilePlanStore}：把 plan 落成
 *     `working_dir/plans/<date>-<slug>.plan.md` 本地文件（frontmatter 存元数据 + todos
 *     结构化 SSoT，正文存 plan markdown）。文件即 SSoT，进 checkpoint / file-history 回滚。
 *   - **云端运行时** → document 载体 PlanStore（由宿主注入，落远端计划文档；云端没有
 *     用户可见的本机磁盘，远端文档就是它的「本地文件」）。该实现属于宿主业务，不在本包内。
 *
 * 统一指针 {@link PlanRef}（来自 `@tabtin/agent-wire`）贯穿卡片 / tracker / 继续消息。
 *
 * 设计约束：
 *   - 校验（todos 去重、字段规则）统一在 TS 侧（{@link normalizePlanTodos}），
 *     两种 store 共享，远端校验退化为 document 路径的兜底。
 *   - LocalFilePlanStore 内部写文件**不经过 guard / write_file 工具链**，因此自行做：
 *     (a) 路径 canonicalize + 限制在 `context.workspaceRoot` 内；
 *     (b) 写盘前调 `context.fileHistory.trackEdit` 登记回退锚点。
 *   - store 方法返回 `PlanStoreResult`（ok 判别式），失败时携带已翻译好的 ToolResult，
 *     由 plan-tools 直接透传，保持既有错误质量。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import jsYaml from 'js-yaml';

import type { PlanRef, PlanProposalTodo } from '../engine/contracts/wire-payloads.js';
import type {
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { jsonError } from '../capability/core/_utils.js';
import { RUNTIME_MISCONFIG, UPSTREAM_ERROR } from '../engine/errors/error-kinds.js';

// ── 公共类型 ────────────────────────────────────────────────────────

export type PlanTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface PlanTodoInput {
  id?: string;
  content: string;
  status?: PlanTodoStatus;
}

export interface PlanPhaseInput {
  id?: string;
  name: string;
  summary?: string;
  todo_ids?: string[];
}

/** plan 内容入参（与存储介质无关）。 */
export interface PlanContentInput {
  name: string;
  overview?: string;
  planMarkdown?: string;
  todos?: PlanTodoInput[];
  isProject?: boolean;
  phases?: PlanPhaseInput[];
  allowedPrompts?: string[];
}

/** 归一化后的 todo（id/content/status 齐全）。 */
export interface NormalizedPlanTodo {
  id: string;
  content: string;
  status: PlanTodoStatus;
}

/**
 * plan 快照 —— 供 plan_proposal 事件与继续消息使用。
 * 两种 store 的 create / updateTodos 都产出统一形态。
 */
export interface PlanSnapshot {
  ref: PlanRef;
  name: string;
  overview: string;
  todos: NormalizedPlanTodo[];
  markdown: string;
  revision: number;
  /** 仅 document 载体有值（供卡片「打开文档」用）；file 载体为 null。 */
  collectionId?: string | null;
}

export type PlanStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: ToolResult };

/**
 * plan 存储抽象。
 *
 * 只保留 `create` / `updateTodos`：执行期「重读最新内容」由 LLM 通过既有工具
 * （file 载体走 `file_read`，document 载体走远端文档读工具）完成，不经 store —
 * 因此不额外造 `read()` 的未使用 HTTP 路径（避免过度设计）。
 */
export interface PlanStore {
  /** 存储介质标识，用于日志 / 断言。 */
  readonly kind: 'file' | 'document';
  create(input: PlanContentInput, context: ToolContext): Promise<PlanStoreResult<PlanSnapshot>>;
  updateTodos(
    ref: PlanRef,
    todos: PlanTodoInput[],
    merge: boolean,
    context: ToolContext,
  ): Promise<PlanStoreResult<PlanSnapshot>>;
}

// ── 共享校验（从 Django plan_schema 迁移） ─────────────────────────────

const MAX_TODO_CONTENT = 2000;
const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

export interface TodoNormalizeError {
  message: string;
  field: string;
}

/**
 * 归一化 + 校验 todos：
 *   - content 必填、非空、≤2000 字符；
 *   - status 落在枚举内，缺省 pending；
 *   - id 缺省时按 `todo-<n>` 生成；显式 id 不得重复。
 */
export function normalizePlanTodos(
  raw: PlanTodoInput[] | undefined,
): { ok: true; todos: NormalizedPlanTodo[] } | { ok: false; error: TodoNormalizeError } {
  if (!raw || raw.length === 0) {
    return { ok: true, todos: [] };
  }
  const seen = new Set<string>();
  const out: NormalizedPlanTodo[] = [];
  let autoSeq = 0;
  for (const rawTodo of raw) {
    const item = (rawTodo ?? {}) as PlanTodoInput;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) {
      return { ok: false, error: { message: 'todo content 必填且不能为空。', field: 'todos' } };
    }
    if (content.length > MAX_TODO_CONTENT) {
      return {
        ok: false,
        error: { message: `todo content 不能超过 ${MAX_TODO_CONTENT} 字符。`, field: 'todos' },
      };
    }
    const status: PlanTodoStatus =
      typeof item.status === 'string' && VALID_STATUSES.has(item.status)
        ? (item.status as PlanTodoStatus)
        : 'pending';
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id) {
      if (seen.has(id)) {
        return { ok: false, error: { message: `todo id 重复：${id}`, field: 'todos' } };
      }
    } else {
      do {
        id = `todo-${autoSeq++}`;
      } while (seen.has(id));
    }
    seen.add(id);
    out.push({ id, content, status });
  }
  return { ok: true, todos: out };
}

function toProposalTodos(todos: NormalizedPlanTodo[]): PlanProposalTodo[] {
  return todos.map((t) => ({ id: t.id, content: t.content, status: t.status }));
}

// ── LocalFilePlanStore ──────────────────────────────────────────────

export interface LocalFilePlanStoreDeps {
  threadId?: string;
  agentId?: string;
  agentMode?: string;
  onLog?: (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => void;
}

/** plan 文件相对 working_dir 的子目录（：收进隐藏的 .tabtin/plans/）。 */
const PLAN_DIR = '.tabtin/plans';

interface PlanFrontmatter {
  plan_name: string;
  overview: string;
  session_id: string;
  agent_id: string;
  agent_mode_at_create: string;
  is_project: boolean;
  created_at: string;
  updated_at: string;
  revision: number;
  todos: NormalizedPlanTodo[];
  phases?: PlanPhaseInput[];
  allowed_prompts?: string[];
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'plan';
}

function todayStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 归一化 workspaceRoot（realpath，失败回落 resolve）。 */
function canonRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/** 目标路径解析后是否落在 workspaceRoot 内（含边界本身）。 */
function isWithinRoot(absPath: string, root: string): boolean {
  const wsRoot = canonRoot(root);
  let resolved: string;
  try {
    resolved = fs.realpathSync(absPath);
  } catch {
    resolved = path.resolve(absPath);
  }
  const rel = path.relative(wsRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const PLAN_BODY_HEADING = '## 方案';

const TODO_CHECKLIST_STATUS_SUFFIX: Record<string, string> = {
  in_progress: '（进行中）',
  cancelled: '（已取消）',
};

/** 把 todos 渲染成 markdown 待办清单（completed/cancelled → [x]，其余 → [ ]）。 */
function renderTodoChecklist(todos: NormalizedPlanTodo[]): string {
  if (!todos.length) return '_（暂无待办）_';
  return todos
    .map((t) => {
      const checked = t.status === 'completed' || t.status === 'cancelled';
      const suffix = TODO_CHECKLIST_STATUS_SUFFIX[t.status] ?? '';
      return `- [${checked ? 'x' : ' '}] ${t.content}${suffix}`;
    })
    .join('\n');
}

/**
 * 序列化 plan 文件（ markdown 友好格式）：
 *   - 机器可解析的结构化元数据放进 **HTML 注释**（markdown 不渲染，js-yaml 解析）；
 *   - 可见部分是规范 markdown（# 标题 / 概述 / 待办清单 / 方案正文），打开即好看。
 */
function serializePlanFile(fm: PlanFrontmatter, body: string): string {
  const yaml = jsYaml.dump(fm, { lineWidth: -1, noRefs: true, sortKeys: false });
  const overview = fm.overview ? `${fm.overview}\n\n` : '';
  const checklist = renderTodoChecklist(fm.todos ?? []);
  const bodyText = body.trim() ? `${body.trim()}\n` : '';
  return (
    `<!-- tabtin:plan\n${yaml}-->\n\n` +
    `# ${fm.plan_name}\n\n` +
    `${overview}` +
    `## 待办\n\n${checklist}\n\n` +
    `${PLAN_BODY_HEADING}\n\n${bodyText}`
  );
}

/** 从可见 markdown 中取回「## 方案」之后的正文（我们生成的结构，标记稳定）。 */
function extractPlanBody(visible: string): string {
  const idx = visible.indexOf(`${PLAN_BODY_HEADING}\n`);
  if (idx < 0) return '';
  return visible.slice(idx + PLAN_BODY_HEADING.length + 1).replace(/^\s*\n/, '').trimEnd();
}

function parsePlanFile(raw: string): { fm: PlanFrontmatter; body: string } | null {
  // 新格式：HTML 注释 + 可见 markdown。
  const commentMatch = /^<!-- tabtin:plan\r?\n([\s\S]*?)\r?\n-->\r?\n?([\s\S]*)$/.exec(raw);
  if (commentMatch) {
    try {
      const fm = jsYaml.load(commentMatch[1]) as PlanFrontmatter;
      if (!fm || typeof fm !== 'object') return null;
      return { fm, body: extractPlanBody(commentMatch[2] ?? '') };
    } catch {
      return null;
    }
  }
  // 兼容旧格式：YAML frontmatter（--- ... ---），正文即其后全部。
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  try {
    const fm = jsYaml.load(match[1]) as PlanFrontmatter;
    if (!fm || typeof fm !== 'object') return null;
    return { fm, body: (match[2] ?? '').replace(/^\s*\n/, '') };
  } catch {
    return null;
  }
}

function planStoreError(message: string, metadata: Record<string, unknown>): PlanStoreResult<never> {
  return { ok: false, result: jsonError(message, metadata) };
}

function invalidTodoResult(error: TodoNormalizeError, hint?: string): PlanStoreResult<never> {
  return planStoreError(error.message, {
    error_kind: 'invalid_param_format',
    field: error.field,
    ...(hint ? { hint } : {}),
  });
}

function allocatePlanPath(planDir: string, stamp: string, slug: string): { absPath: string; relPath: string } | null {
  // 冲突时追加短序号，保证同名 plan 不互相覆盖。
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const fname = `${stamp}-${slug}${suffix}.plan.md`;
    const candidate = path.join(planDir, fname);
    if (!fs.existsSync(candidate)) {
      return { absPath: candidate, relPath: path.join(PLAN_DIR, fname) };
    }
  }
  return null;
}

function buildLocalPlanFrontmatter(args: {
  input: PlanContentInput;
  planName: string;
  overview: string;
  now: Date;
  todos: NormalizedPlanTodo[];
  deps: LocalFilePlanStoreDeps;
}): PlanFrontmatter {
  const { input, planName, overview, now, todos, deps } = args;
  return {
    plan_name: planName,
    overview,
    session_id: deps.threadId ?? '',
    agent_id: deps.agentId ?? '',
    agent_mode_at_create: deps.agentMode ?? 'plan',
    is_project: Boolean(input.isProject),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    revision: 0,
    todos,
    ...(Array.isArray(input.phases) && input.phases.length > 0 ? { phases: input.phases } : {}),
    ...(Array.isArray(input.allowedPrompts) && input.allowedPrompts.length > 0
      ? { allowed_prompts: input.allowedPrompts }
      : {}),
  };
}

function mergePlanTodos(
  existing: NormalizedPlanTodo[] | undefined,
  incoming: NormalizedPlanTodo[],
  merge: boolean,
): NormalizedPlanTodo[] {
  if (!merge) return incoming;
  const byId = new Map<string, NormalizedPlanTodo>();
  for (const t of existing ?? []) byId.set(t.id, t);
  for (const t of incoming) byId.set(t.id, t);
  return Array.from(byId.values());
}

async function readExistingLocalPlan(args: {
  absPath: string;
  refPath: string;
  onLog?: (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => void;
}): Promise<PlanStoreResult<{ fm: PlanFrontmatter; body: string }>> {
  const { absPath, refPath, onLog } = args;
  try {
    const raw = await fsp.readFile(absPath, 'utf-8');
    const existing = parsePlanFile(raw);
    if (existing) return { ok: true, value: existing };
    return planStoreError(`plan 文件格式损坏，无法解析（${refPath}）。`, {
      error_kind: UPSTREAM_ERROR,
    });
  } catch (err) {
    onLog?.('warn', `读取 plan 文件失败: ${absPath}`, err);
    return planStoreError(
      `找不到 plan 文件（${refPath}）；可能已被回滚或删除。请重新 plan_create。`,
      {
        error_kind: 'resource_not_found',
        hint: 'The plan file no longer exists (possibly rolled back). Create a new plan with plan_create.',
      },
    );
  }
}

function localPlanSnapshot(args: {
  ref: PlanRef;
  name: string;
  overview: string;
  todos: NormalizedPlanTodo[];
  markdown: string;
  revision: number;
}): PlanSnapshot {
  return {
    ref: args.ref,
    name: args.name,
    overview: args.overview,
    todos: args.todos,
    markdown: args.markdown,
    revision: args.revision,
    collectionId: null,
  };
}

export class LocalFilePlanStore implements PlanStore {
  readonly kind = 'file' as const;

  constructor(private readonly deps: LocalFilePlanStoreDeps = {}) {}

  private resolveRoot(context: ToolContext): string | undefined {
    const root = context.workspaceRoot?.trim();
    if (!root || root.length === 0) return undefined;
    // canonicalize 一次：workspaceRoot 可能是 symlink（如 macOS /var → /private/var），
    // 后续 planDir / absPath / 边界校验统一基于 canonical 根，避免 realpath 前后不一致
    // 把合法路径误判为越界。
    return canonRoot(root);
  }

  private async trackForRollback(context: ToolContext, absPath: string): Promise<void> {
    // 与 tabcode-adapter 一致：写盘前把「改之前」内容登记到本轮回退锚点。
    const anchorId = context.fileHistoryAnchorId ?? context.agentRunId;
    if (context.fileHistory && anchorId) {
      try {
        await context.fileHistory.trackEdit(anchorId, absPath);
      } catch (err) {
        // fail-soft：备份失败不阻断写入（该文件本轮回退能力可能受限）。
        this.deps.onLog?.('warn', `plan file trackEdit 失败（non-fatal）: ${absPath}`, err);
      }
    }
  }

  async create(
    input: PlanContentInput,
    context: ToolContext,
  ): Promise<PlanStoreResult<PlanSnapshot>> {
    const root = this.resolveRoot(context);
    if (!root) {
      return planStoreError(
        '当前工作区没有可写的 working_dir，无法创建本地 plan 文件。' +
          '请确认该 Space 绑定了 Agent 工作目录。',
        {
          error_kind: RUNTIME_MISCONFIG,
          hint: 'Tell the user this Space has no working directory bound, so plans cannot be created locally.',
        },
      );
    }

    const normalized = normalizePlanTodos(input.todos);
    if (!normalized.ok) {
      return invalidTodoResult(
        normalized.error,
        'Fix the todo fields (content required, ≤2000 chars, unique ids) and retry plan_create.',
      );
    }

    const now = new Date();
    const planName = input.name.trim();
    const overview = input.overview?.trim() ?? '';
    const body = input.planMarkdown ?? '';

    const planDir = path.join(root, PLAN_DIR);
    const stamp = todayStamp(now);
    const slug = slugify(planName);

    const allocatedPath = allocatePlanPath(planDir, stamp, slug);
    if (!allocatedPath) {
      return planStoreError('无法为 plan 文件分配唯一文件名（同名过多）。', {
        error_kind: UPSTREAM_ERROR,
        hint: 'Ask the user to clean up the plans/ directory; too many plans share this name.',
      });
    }
    const { absPath, relPath } = allocatedPath;

    // 边界校验：解析后必须仍在 workspace 内（防 symlink 逃逸 / ../ 穿越）。
    if (!isWithinRoot(path.dirname(absPath), root)) {
      return planStoreError('plan 文件目标路径超出工作区边界，已拒绝写入。', {
        error_kind: 'permission_denied',
        hint: 'The plan directory resolves outside the workspace root; report this environment issue.',
      });
    }

    const fm = buildLocalPlanFrontmatter({
      input,
      planName,
      overview,
      todos: normalized.todos,
      now,
      deps: this.deps,
    });

    try {
      await fsp.mkdir(planDir, { recursive: true });
      await this.trackForRollback(context, absPath);
      await fsp.writeFile(absPath, serializePlanFile(fm, body), 'utf-8');
    } catch (err) {
      this.deps.onLog?.('error', `写 plan 文件失败: ${absPath}`, err);
      return planStoreError(`写 plan 文件失败：${(err as Error)?.message ?? String(err)}`, {
        error_kind: UPSTREAM_ERROR,
        hint: 'Tell the user the plan file could not be written to the working directory.',
      });
    }

    const ref: PlanRef = { kind: 'file', path: relPath };
    return {
      ok: true,
      value: localPlanSnapshot({
        ref,
        name: planName,
        overview,
        todos: normalized.todos,
        markdown: body,
        revision: 0,
      }),
    };
  }

  async updateTodos(
    ref: PlanRef,
    todos: PlanTodoInput[],
    merge: boolean,
    context: ToolContext,
  ): Promise<PlanStoreResult<PlanSnapshot>> {
    if (ref.kind !== 'file') {
      return planStoreError('LocalFilePlanStore 只能更新 file 类型的 plan。', {
        error_kind: RUNTIME_MISCONFIG,
      });
    }
    const root = this.resolveRoot(context);
    if (!root) {
      return planStoreError('当前工作区没有可写的 working_dir，无法更新本地 plan 文件。', {
        error_kind: RUNTIME_MISCONFIG,
      });
    }
    const absPath = path.resolve(root, ref.path);
    if (!isWithinRoot(absPath, root)) {
      return planStoreError('plan 文件路径超出工作区边界，已拒绝更新。', {
        error_kind: 'permission_denied',
      });
    }

    const existingResult = await readExistingLocalPlan({
      absPath,
      refPath: ref.path,
      onLog: this.deps.onLog,
    });
    if (!existingResult.ok) return existingResult;
    const existing = existingResult.value;

    const incoming = normalizePlanTodos(todos);
    if (!incoming.ok) {
      return invalidTodoResult(incoming.error);
    }

    const nextTodos = mergePlanTodos(existing.fm.todos, incoming.todos, merge);

    const now = new Date();
    const nextRevision = (Number(existing.fm.revision) || 0) + 1;
    const nextFm: PlanFrontmatter = {
      ...existing.fm,
      todos: nextTodos,
      updated_at: now.toISOString(),
      revision: nextRevision,
    };

    try {
      await this.trackForRollback(context, absPath);
      await fsp.writeFile(absPath, serializePlanFile(nextFm, existing.body), 'utf-8');
    } catch (err) {
      this.deps.onLog?.('error', `更新 plan 文件失败: ${absPath}`, err);
      return planStoreError(`更新 plan 文件失败：${(err as Error)?.message ?? String(err)}`, {
        error_kind: UPSTREAM_ERROR,
      });
    }

    return {
      ok: true,
      value: localPlanSnapshot({
        ref,
        name: nextFm.plan_name,
        overview: nextFm.overview,
        todos: nextTodos,
        markdown: existing.body,
        revision: nextRevision,
      }),
    };
  }
}

/** 供卡片事件使用：把快照 todos 转成 wire 形态。 */
export function snapshotTodosForProposal(snapshot: PlanSnapshot): PlanProposalTodo[] {
  return toProposalTodos(snapshot.todos);
}
