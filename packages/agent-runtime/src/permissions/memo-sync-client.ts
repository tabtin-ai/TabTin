/**
 * `memo-sync-client` — 把 ``InMemoryApprovalMemoStore`` 的 ``commitAlways`` /
 * ``refetchAll`` 两个**可选 hook** 接到真实的 Django REST 接口（PRD 05 v0.4
 * §7.3 + §8.1.2）。
 *
 * 提供两个工厂：
 *
 * - {@link createApprovalMemoCommitClient} — 返回 ``CommitAlwaysCallback``，
 *   把单条 always 决策上行 ``PUT /api/context/workspaces/{workspace_id}/approval-memo/{entry_key}``，
 *   ``If-Match: <generation>`` 走 optimistic lock。
 * - {@link createApprovalMemoRefetchClient} — 返回 ``RefetchAllCallback``，
 *   全量拉 ``GET /api/context/workspaces/{workspace_id}/approval-memo`` 用于 bootstrap /
 *   ``maybeRefetch`` 触发的失效后重拉。
 *
 * **路径权威**：URL 模式跟 ``packages/tabtin-config/src/endpoints.ts`` 的
 * ``API_ENDPOINTS.APPROVAL_MEMO`` 保持同步。本包不直接 import tabtin-config（避免
 * agent-runtime 依赖向上扩散），但 path 字面量必须跟那边一致——endpoints.ts 是
 * 多端 SSoT。漂移过两次：原本写成 ``/agents/...`` 漏 ``/context`` 前缀导致全链路
 * 静默 404（Django access log 才看得到，refetch / commit 都 fail-soft 吞掉）。
 *
 * **fail-soft 哲学**（PRD §7.3 + §8.1.2）：
 * - PUT 失败（网络 / 401 / 5xx）：log warn + 不抛、不重试、不主动 maybeRefetch。
 *   本地 cache 已经在 ``putAlways`` 调用时同步写入；用户在本机连续操作仍命中。
 *   下次别处改 memo 时 server 端 publish ``approval_memo_updated`` →
 *   maybeRefetch → replaceAll 路径自然把本地未同步的 entry 刷成 server 视图
 *   （略有 silent 漏 desktop A 写入的代价；W3 持久化 / Skill Trust 阶段再加
 *   重试机制，本期 D6 不留 MVP 形态）。
 * - PUT 409 ``GENERATION_CONFLICT``：同样 log warn + 不重试。客户端依赖 WS
 *   ``approval_memo_updated`` 广播触发 ``maybeRefetch``——服务端写入时**已经**
 *   广播过最新 generation，客户端拿到后 replaceAll 把"自己写但 server 没存"
 *   的 entry 覆盖成最新 server 视图（产品语义：用户最近一次成功 commit 胜出）。
 * - GET 失败：log warn + 不更新 store（保持本地旧 generation + 旧 cache）；
 *   下次 ``maybeRefetch`` / bootstrap 重试时再尝试。
 *
 * **生命周期不变量**：
 * - 工厂返回的回调没有内部状态——都是闭包 capture ``getAuthToken`` /
 *   ``getCurrentGeneration``，store / host 销毁时回调跟随 GC。
 * - 工厂**不**直接依赖 store ref（避免 chicken-and-egg：store 用 commitAlways
 *   构造，commitAlways 又要 store.generation）。host 装配代码需用闭包延迟绑定
 *   ``getCurrentGeneration``——见 ElectronAgentHost / DaemonAgentHost 装配点。
 */

import type {
  CommitAlwaysCallback,
  RefetchAllCallback,
} from './memo-store.js';
import type { ApprovalMemoEntry } from './types.js';

/**
 * Auth token 提供者：兼容 Electron (async ``TokenManager.getAccessToken``) 和
 * Daemon (sync ``gateway.getAccessToken``)；返回 null/空字符串视为"未登录"，
 * 此时 commit / refetch 均直接 fail-soft 跳过（不发请求）。
 */
export type AuthTokenProvider = () => string | null | Promise<string | null>;

export interface MemoSyncLogger {
  warn(message: string): void;
  debug?(message: string): void;
}

export interface CommitClientOptions {
  /** Django API base URL，e.g. ``https://api.example.com`` 或本地 ``http://127.0.0.1:6060``。 */
  apiBaseUrl: string;
  /** 当前 runtime 绑定的 Workspace id（审批记忆随执行现场隔离）。 */
  workspaceId: string;
  /** Auth token 提供者；返回 null 时跳过本次 commit（fail-soft）。 */
  getAuthToken: AuthTokenProvider;
  /**
   * 当前已知 server generation（用于 ``If-Match`` header）。
   *
   * 装配时需后置绑定到 ``memoStore.generation``——store 用 commitAlways 构造，
   * 而 commitAlways 又要读 store.generation，host 必须用闭包延迟绑定：
   *
   * @example
   * ```ts
   * let memoStore: InMemoryApprovalMemoStore | null = null;
   * const commit = createApprovalMemoCommitClient({
   *   getCurrentGeneration: () => memoStore?.generation ?? 0,
   *   onCommitGenerationAdvance: (gen) => memoStore?.advanceGeneration(gen),
   *   onConflict: (gen) => memoStore?.maybeRefetch(gen),
   *   // ...
   * });
   * memoStore = createApprovalMemoStore({ commitAlways: commit, ... });
   * ```
   */
  getCurrentGeneration: () => number;
  /**
   * commit 成功后由 client 调用：把 server 返回的最新 ``generation`` 推给
   * store（W2-轮 2 自修复 CRITICAL #1：避免同批多条 always 必撞 409）。
   *
   * 选填——不传则只 log debug；测试 / 单笔写入场景可不接。
   * 内部应调 ``InMemoryApprovalMemoStore.advanceGeneration(gen)``——
   * 单调推进、非递减。
   */
  onCommitGenerationAdvance?: (newGeneration: number) => void;
  /**
   * 409 ``GENERATION_CONFLICT`` 时由 client 调用：把 server 返回的
   * ``current_generation`` 推给 store + 触发主动 ``maybeRefetch``
   * （W2-轮 2 自修复 CRITICAL #3：WS 广播不一定到达，主动 refetch 收敛）。
   *
   * 选填——不传则纯 log warn 让 fail-soft 自然回稳。
   * 内部典型实现 ``(gen) => store.maybeRefetch(gen)``——
   * maybeRefetch 内部会比对 generation + 调 refetchAll + replaceAll，
   * 不会构造 retry storm。
   */
  onConflict?: (currentGeneration: number) => void | Promise<void>;
  /** 请求超时（毫秒），默认 10s。 */
  timeoutMs?: number;
  /** Log hook；通常注入 host 的 electron-log / winston。默认 console.warn。 */
  log?: MemoSyncLogger;
  /** 测试 hook：覆盖 ``fetch`` 实现。 */
  fetchImpl?: typeof fetch;
}

export interface RefetchClientOptions {
  apiBaseUrl: string;
  workspaceId: string;
  getAuthToken: AuthTokenProvider;
  timeoutMs?: number;
  log?: MemoSyncLogger;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface ServerEntryRaw {
  decision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  approver_user_id?: unknown;
  reason?: unknown;
  // M4.1 L-W6-24：记忆创建时的业务名（如"总是允许向远程仓库推送代码"）
  scope_description?: unknown;
}

interface ServerMemoData {
  version?: unknown;
  entries?: Record<string, ServerEntryRaw>;
  generation?: unknown;
}

interface ServerEnvelope {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  data?: ServerMemoData | { current_generation?: unknown };
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function defaultLog(): MemoSyncLogger {
  return {
    warn: (msg) => {
      console.warn(msg);
    },
    debug: (msg) => {
      console.debug?.(msg);
    },
  };
}

function normalizeServerEntry(raw: ServerEntryRaw): ApprovalMemoEntry | null {
  const decision = raw.decision;
  if (decision !== 'allow' && decision !== 'deny') return null;
  const createdAt = typeof raw.created_at === 'number' ? raw.created_at : 0;
  const updatedAt = typeof raw.updated_at === 'number' ? raw.updated_at : createdAt;
  const approverUserId = typeof raw.approver_user_id === 'string' ? raw.approver_user_id : undefined;
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  // M4.1 L-W6-24：从服务端拉回 scope_description，保障跨设备 bootstrap 后仍显示人话标签
  const scopeDescription = typeof raw.scope_description === 'string' && raw.scope_description
    ? raw.scope_description
    : undefined;
  const entry: ApprovalMemoEntry = {
    decision,
    createdAt,
    updatedAt,
  };
  if (approverUserId) entry.approverUserId = approverUserId;
  if (reason !== undefined) entry.reason = reason;
  if (scopeDescription) entry.scope_description = scopeDescription;
  return entry;
}

/**
 * 把 server 返回的 ``data`` 段转成 store 内部格式（snake_case → camelCase）。
 *
 * @internal 单测可见；正常路径走 ``createApprovalMemoRefetchClient``。
 */
export function parseApprovalMemoSnapshot(
  data: ServerMemoData | undefined | null,
): { entries: Record<string, ApprovalMemoEntry>; generation: number } {
  const out: Record<string, ApprovalMemoEntry> = {};
  const rawEntries = data?.entries;
  if (rawEntries && typeof rawEntries === 'object') {
    for (const [key, raw] of Object.entries(rawEntries)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = normalizeServerEntry(raw as ServerEntryRaw);
      if (entry) out[key] = entry;
    }
  }
  const generation = typeof data?.generation === 'number' ? data.generation : 0;
  return { entries: out, generation };
}

function describeCaughtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readCommitToken(
  opts: CommitClientOptions,
  log: MemoSyncLogger,
  approvalKey: string,
): Promise<string | null> {
  try {
    const token = await opts.getAuthToken();
    if (token) return token;
    log.debug?.(`[ApprovalMemo] commit skipped (no auth token) key=${approvalKey}`);
    return null;
  } catch (err) {
    log.warn(`[ApprovalMemo] commit token fetch failed for key=${approvalKey}: ${describeCaughtError(err)}`);
    return null;
  }
}

function buildCommitUrl(opts: CommitClientOptions, approvalKey: string): string {
  // ⚠️ path 里**不要**加 /api 前缀：调用方传入的 apiBaseUrl（来自
  // tabtin-config.getApiRuntimeConfig().apiBaseUrl）已包含 /api 后缀
  // （见 tabtin-config/src/index.ts:135 normalizeApiBaseUrl）。重复加会
  // 拼出 /api/api/context/workspaces/.../approval-memo（dogfood 504718c9 的 404 噪声源）。
  // ⚠️ /context 前缀必须有：approval_memo router 通过 tabtinspace_router 挂载在
  // /context 下（apps/tabtin_django/tabtin/urls.py:544）。漏掉 → 静默 404。
  return joinUrl(
    opts.apiBaseUrl,
    `/context/workspaces/${encodeURIComponent(opts.workspaceId)}/approval-memo/${encodeURIComponent(approvalKey)}`,
  );
}

function buildCommitBody(entry: ApprovalMemoEntry): string {
  // M4.1 L-W6-24：带上 scope_description，Django 才能持久化人话标签；
  // 缺失时写空字符串（与 Django schema default 一致）。
  return JSON.stringify({
    decision: entry.decision,
    reason: entry.reason ?? '',
    scope_description: entry.scope_description ?? '',
  });
}

async function sendCommitRequest(params: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  approvalKey: string;
  token: string;
  url: string;
  ifMatch: string;
  body: string;
  log: MemoSyncLogger;
}): Promise<Response | null> {
  try {
    return await params.fetchImpl(params.url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
        'If-Match': params.ifMatch,
      },
      body: params.body,
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (err) {
    params.log.warn(`[ApprovalMemo] commit network error for key=${params.approvalKey}: ${describeCaughtError(err)}`);
    return null;
  }
}

async function readServerEnvelope(resp: Response): Promise<ServerEnvelope | null> {
  try {
    return (await resp.json()) as ServerEnvelope;
  } catch {
    // server 返回非 JSON（譬如 502 HTML）；envelope 留 null
    return null;
  }
}

function handleCommitSuccess(
  opts: CommitClientOptions,
  log: MemoSyncLogger,
  approvalKey: string,
  status: number,
  envelope: ServerEnvelope | null,
): void {
  // W2-轮 2 自修复 CRITICAL #1：成功路径必须把 server 返回的最新 generation
  // 推给 store——否则同批多条 always 第二条起的 If-Match 仍是旧值 → server
  // 比对失败抛 409 → 静默丢失 commit。
  const successData = (envelope?.data ?? {}) as { generation?: unknown };
  const newGen = typeof successData.generation === 'number' ? successData.generation : null;
  if (newGen !== null && opts.onCommitGenerationAdvance) {
    try {
      opts.onCommitGenerationAdvance(newGen);
    } catch (err) {
      // advanceGeneration 抛错不影响主路径——log 一下让排障可见
      log.warn(`[ApprovalMemo] advanceGeneration callback threw for key=${approvalKey}: ${describeCaughtError(err)}`);
    }
  }
  log.debug?.(
    `[ApprovalMemo] commit ok key=${approvalKey} (status=${status} server_gen=${newGen ?? '?'})`,
  );
}

function maybeHandleCommitConflict(params: {
  opts: CommitClientOptions;
  log: MemoSyncLogger;
  approvalKey: string;
  ifMatch: string;
  resp: Response;
  envelope: ServerEnvelope | null;
  code: string;
}): boolean {
  if (params.resp.status !== 409 || params.code !== 'GENERATION_CONFLICT') return false;
  const conflictData = (params.envelope?.data ?? {}) as { current_generation?: unknown };
  const currentGen = typeof conflictData.current_generation === 'number'
    ? conflictData.current_generation
    : null;
  params.log.warn(
    `[ApprovalMemo] commit conflict key=${params.approvalKey}: server gen=${currentGen ?? '?'} ` +
      `(client If-Match=${params.ifMatch}); will reconcile via maybeRefetch + WS approval_memo_updated`,
  );
  // W2-轮 2 自修复 CRITICAL #3：主动触发 maybeRefetch 而不仅依赖 WS 广播——
  // server _broadcast_updated 是 best-effort（失败只 log），WS 链路抖动时
  // 客户端可能永远不收到 broadcast，409 后必须自己拉一次让 generation 收敛。
  if (currentGen !== null && params.opts.onConflict) {
    notifyCommitConflict(params.opts, params.log, params.approvalKey, currentGen);
  }
  return true;
}

function notifyCommitConflict(
  opts: CommitClientOptions,
  log: MemoSyncLogger,
  approvalKey: string,
  currentGen: number,
): void {
  try {
    const ret = opts.onConflict?.(currentGen);
    if (ret && typeof (ret as Promise<void>).catch === 'function') {
      (ret as Promise<void>).catch((err) => {
        log.warn(`[ApprovalMemo] onConflict refetch failed for key=${approvalKey}: ${describeCaughtError(err)}`);
      });
    }
  } catch (err) {
    log.warn(`[ApprovalMemo] onConflict callback threw for key=${approvalKey}: ${describeCaughtError(err)}`);
  }
}

/**
 * 创建 ``commitAlways`` 回调：把单条 always 决策上行 PUT 到 Django。
 *
 * 失败语义：
 * - 网络 / 5xx / 401 / 403：log warn + 静默吞掉（fail-soft）
 * - 409 GENERATION_CONFLICT：log warn + 静默吞掉；server 已经 broadcast 最新
 *   generation，客户端依赖 WS 推送的 ``approval_memo_updated`` 走 maybeRefetch
 *   路径同步。本工厂**不**主动调 maybeRefetch（避免 commit ↔ store 循环依赖）。
 */
export function createApprovalMemoCommitClient(
  opts: CommitClientOptions,
): CommitAlwaysCallback {
  const log = opts.log ?? defaultLog();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (approvalKey: string, entry: ApprovalMemoEntry): Promise<void> => {
    const token = await readCommitToken(opts, log, approvalKey);
    if (!token) return;

    const url = buildCommitUrl(opts, approvalKey);
    const ifMatch = String(opts.getCurrentGeneration());
    const body = buildCommitBody(entry);

    const resp = await sendCommitRequest({
      fetchImpl,
      timeoutMs,
      approvalKey,
      token,
      url,
      ifMatch,
      body,
      log,
    });
    if (!resp) return;

    const envelope = await readServerEnvelope(resp);

    if (resp.ok) {
      handleCommitSuccess(opts, log, approvalKey, resp.status, envelope);
      return;
    }

    const code = envelope && typeof envelope.code === 'string' ? envelope.code : '';
    if (maybeHandleCommitConflict({ opts, log, approvalKey, ifMatch, resp, envelope, code })) return;

    log.warn(
      `[ApprovalMemo] commit failed key=${approvalKey}: status=${resp.status} code=${code || 'unknown'}`,
    );
  };
}

/**
 * 创建 ``refetchAll`` 回调：全量拉 GET 端点，把 server 视图转换成 store 内部
 * 格式（``{ entries: { ... camelCase ... }, generation }``）。
 *
 * 失败语义：抛异常给上层（``InMemoryApprovalMemoStore.maybeRefetch`` /
 * ``bootstrap`` 在调用栈外捕获并 log warn）。**不**返回半完整快照——避免
 * replaceAll 把内存 cache 写成"残缺 server 视图"。
 */
export function createApprovalMemoRefetchClient(
  opts: RefetchClientOptions,
): RefetchAllCallback {
  const log = opts.log ?? defaultLog();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (): Promise<{ entries: Record<string, ApprovalMemoEntry>; generation: number }> => {
    const token = await opts.getAuthToken();
    if (!token) {
      throw new Error('approval-memo refetch failed: no auth token');
    }

    // ⚠️ 同上：apiBaseUrl 已含 /api 前缀，path 不要重复加（避免 /api/api/...）
    // 同时 /context 前缀必须有（commit client 注释里详述了该坑）。
    const url = joinUrl(
      opts.apiBaseUrl,
      `/context/workspaces/${encodeURIComponent(opts.workspaceId)}/approval-memo`,
    );

    const resp = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`approval-memo refetch failed: status=${resp.status}`);
    }

    let envelope: ServerEnvelope;
    try {
      envelope = (await resp.json()) as ServerEnvelope;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`approval-memo refetch JSON parse failed: ${msg}`);
    }

    if (envelope.success !== true) {
      const code = typeof envelope.code === 'string' ? envelope.code : 'unknown';
      throw new Error(`approval-memo refetch envelope error: code=${code}`);
    }

    const snapshot = parseApprovalMemoSnapshot(envelope.data as ServerMemoData | undefined);
    log.debug?.(
      `[ApprovalMemo] refetch ok workspace=${opts.workspaceId} entries=${Object.keys(snapshot.entries).length} gen=${snapshot.generation}`,
    );
    return snapshot;
  };
}
