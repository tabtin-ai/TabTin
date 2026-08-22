/**
 * conversation-abort — 中止请求 → host `sessions` Map 命中 key 的统一解析
 * 纯函数（ 停止链路收口）。
 *
 * ## 背景（为什么会 miss）
 *
 * 于是「按业务 sessionId 中止」对 forward 启动的 run 必然 miss（UI 点了停止
 * 但 run 继续跑，即  现象）；反过来「按 task_id 中止」对 IPC run 也
 * miss。本模块把两套 key 归一：无论调用方拿到的是业务 sessionId、
 * `chat-session-<uuid>` 形态的 thread_id、还是 forward 的 task_id，都能解析
 * 到正确的 sessions key。
 *
 * ## 为什么抽纯函数
 *
 * 与 `conversation-identity.ts` 同一理由：host 文件顶层 import 带大量 main-process
 * side effect，vitest 无法直接拉起；纯函数让 Electron / Daemon 双宿主共享同
 * 一份解析行为（跨宿主分歧会让同一条 cancel envelope 在一端命中、另一端
 * miss 成为隐藏 bug），并且可单测锁行为。
 */

const CHAT_SESSION_PREFIX = 'chat-session-';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** host `sessions` Map 单条会话在取消视角下的投影。 */
export interface ConversationSessionIdentity {
  key: string;
  /**
   * 业务对话 thread（ChatSession UUID，带不带 `chat-session-` 前缀均可）。
   * forward 路径与 key 不同；IPC 路径与 key 相同（重复无害）。
   */
  businessThreadId?: string | undefined;
}

/** 剥 `chat-session-` 前缀，归一到 raw UUID 形态；无前缀原样返回。 */
export function normalizeConversationId(id: string): string {
  return id.startsWith(CHAT_SESSION_PREFIX) && id.length > CHAT_SESSION_PREFIX.length
    ? id.slice(CHAT_SESSION_PREFIX.length)
    : id;
}

/**
 * 解析中止请求 id → 命中的 sessions key 列表。
 *
 * 匹配规则（对每条 entry）：
 *   1. key 与请求 id 直接相等（含前缀归一后相等）——IPC 路径 / task_id 直达；
 *   2. businessThreadId 与请求 id 前缀归一后相等——forward 路径按业务会话命中。
 *
 * 返回**去重后的 key 列表**（正常至多 1 条；同业务会话理论上不会有并行多条
 * host session，防御性支持多条全停）。空列表 = miss，调用方应如实返回失败。
 */
export function resolveConversationAbortKeys(
  requestedId: string | undefined | null,
  entries: Iterable<ConversationSessionIdentity>,
): string[] {
  if (typeof requestedId !== 'string' || !requestedId.trim()) return [];
  const normalized = normalizeConversationId(requestedId);
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.key) continue;
    if (entry.key === requestedId || entry.key === normalized) {
      if (!keys.includes(entry.key)) keys.push(entry.key);
      continue;
    }
    if (typeof entry.businessThreadId === 'string' && entry.businessThreadId) {
      const business = normalizeConversationId(entry.businessThreadId);
      if (business === normalized) {
        if (!keys.includes(entry.key)) keys.push(entry.key);
      }
    }
  }
  return keys;
}

/**
 * Resolve every identity that may own run state for a requested conversation.
 *
 * Unlike abort, state lookup must inspect both the host session key and the
 * stable business-thread key because forward runs are queued by business
 * thread while runtime/session registries remain keyed by task id.
 */
export function resolveConversationStateKeys(
  requestedId: string | undefined | null,
  entries: Iterable<ConversationSessionIdentity>,
): string[] {
  if (typeof requestedId !== 'string' || !requestedId.trim()) return [];
  const normalized = normalizeConversationId(requestedId);
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  add(requestedId);
  if (requestedId.startsWith(CHAT_SESSION_PREFIX)) {
    add(normalized);
  } else if (UUID_PATTERN.test(requestedId)) {
    add(`${CHAT_SESSION_PREFIX}${requestedId}`);
  }

  for (const entry of entries) {
    const businessThreadId = entry.businessThreadId;
    const matchesKey = entry.key === requestedId || entry.key === normalized;
    const matchesBusiness = typeof businessThreadId === 'string'
      && normalizeConversationId(businessThreadId) === normalized;
    if (!matchesKey && !matchesBusiness) continue;
    add(businessThreadId);
    add(entry.key);
  }
  return candidates;
}

/**
 * 从 `agent.prompt.cancel` envelope 提取候选中止 id（按可信度排序）：
 *
 *   1. `payload.task_id` —— forward 路径 sessions key 直达（零歧义）；
 *   2. envelope 顶层 `thread_id` —— Django `build_envelope(..., thread_id=)`
 *      始终写入，业务会话命中（本次  修复的关键：老实现只读 payload，
 *      Django `forward_cancel` 的 payload 只有 task_id，导致要么 miss 要么
 *      走「无 id → 全停」的危险分支）；
 *   3. `payload.thread_id` / `payload.session_id` —— 历史调用方兼容。
 *
 * 调用方按序逐个尝试 `handleAbort(id)`，首个命中即停。
 */
export function extractAbortIdentityCandidates(envelope: Record<string, unknown>): string[] {
  const payload = (envelope.payload && typeof envelope.payload === 'object')
    ? envelope.payload as Record<string, unknown>
    : {};
  const raw = [payload.task_id, envelope.thread_id, payload.thread_id, payload.session_id];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
  }
  return out;
}
