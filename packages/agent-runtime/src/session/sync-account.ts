/**
 * @tabtin/agent-runtime — Sync 目录的账号 / 租户分桶工具（LH2-D1 / LH2-D2）。
 *
 * 解决的问题：
 *   v1 设计下 SyncQueue 把所有账号的 transcript 全丢同一目录
 *   （Electron `userData/agent-sync/`，Daemon `~/.tabtin-daemon/agent-sync/`）。
 *   一旦 Phase 6 接通 uploadFn，账号 A 残留在磁盘上的 batch 在账号 B
 *   登录后会被 B 的凭证上传，依赖云端 endpoint 校验 sessionId/agentId
 *   拒绝，是个脆弱兜底。
 *
 * 本模块提供"目录命名规范 + 清理工具"，把分桶下沉到 fs 层：
 *   <syncRoot>/<userId>/<organizationId>/{pending,archive}.jsonl
 *
 * - 不同账号的 entry 物理隔离，A 看不到 B 的目录就不会触发 owner mismatch；
 * - 登出 / 切账号时按 owner 维度精确清理（LH2-D2），不会误清其他账号目录；
 * - 与 `SyncQueue.owner` + `PersistedEntry.owner` 双重防御：即使有人
 *   手工拷贝文件到错误目录，上传前的 owner 校验仍会拒绝（LH2-D3）。
 *
 * 不变量：
 * 1. **路径不可变**：构造 segment 失败（非法字符 / 空串）必须**抛错**，
 *    不能静默回退到默认目录——这会让"分桶失效"以无声方式发生。
 * 2. **大小写敏感**：fs 在 Linux 上区分大小写、macOS / Windows 不区分。
 *    不做 lowercasing；调用方传什么进来路径就什么样。前后端协议层确保
 *    一致即可（实际上 user_id / organization_id 都是 UUID 或数字 ID，没有
 *    大小写歧义）。
 * 3. **path traversal 防护**：sanitize 严格白名单字符 `[A-Za-z0-9_-]`，
 *    禁止 `.` / `/` / `..` / 空格 / 控制字符；防止恶意 token / config 把
 *    sync 目录写到沙箱外。
 *
 * 设计决策：
 * - **二级路径** `<userId>/<organizationId>` 而非单层 `<userId>_<organizationId>`：
 *   - 同一用户加入多个 organization 时下游分析（du -sh / 备份）按 user 聚合更直观；
 *   - 单层下划线连接如果 ID 本身含 `_` 会有歧义。
 * - **不含 agentId 层**：agentId 是 SyncQueue 级而非 Disk Queue 级——
 *   每个 host 把同一 (user, organization) 下所有 agent 的 batch 共享同一 disk
 *   queue（agentId 通过 PersistedEntry.owner.agentId 区分），避免把磁盘
 *   切得过碎（每个 agent 一份小 JSONL 在 compact / loadAll 时反而退化）。
 * - **路径 SSoT**：`buildSyncAccountDir` 是唯一构造点，禁止宿主自己拼字符串。
 *   未来如果改成三级或加 hash 扰动，只改这一个函数即可全链路对齐。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PersistedEntryOwner } from './persistent-queue.js';

/**
 * 构造账号 sync 目录的相对结构：`<syncRoot>/<userId>/<organizationId>/`。
 *
 * @throws Error 当 owner.userId / organizationId 含非法字符 / 为空 / 超长。
 *               故意抛硬错而非回退默认目录——避免分桶机制以无声方式失效。
 */
export function buildSyncAccountDir(
  syncRoot: string,
  owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
): string {
  const userBucket = sanitizeAccountSegment(owner.userId, 'userId');
  const organizationBucket = sanitizeAccountSegment(owner.organizationId, 'organizationId');
  return path.join(syncRoot, userBucket, organizationBucket);
}

/**
 * 删除指定账号 sync 目录及其下所有内容（pending.jsonl / archive.jsonl / 子目录）。
 *
 * - 目录不存在时 no-op（幂等：登出时即使从未持久化过也不抛错）；
 * - I/O 失败抛 Error（调用方决定是否吞掉——通常宿主会 try/catch 转 log.warn
 *   而不阻塞登出流程）；
 * - **不删父级 syncRoot**：syncRoot 下还可能有其他账号的目录，删除范围严格
 *   限制在 `<userId>/<organizationId>/` 这一层（LH2-D2 的产品要求）；
 * - **不联动清理空的 userBucket 父目录**：登出 A 但 A 在另一 organization 还有
 *   数据时，userBucket 应保留。需要 GC 空目录可以另开任务（LH2-D5 类）。
 *
 * @returns 是否实际删除了文件。`false` = 目录原本就不存在；`true` = 至少
 *          有文件被清掉。供调用方记 telemetry / 日志区分"清了 vs 本来就空"。
 */
export async function clearSyncAccountDir(
  syncRoot: string,
  owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
): Promise<boolean> {
  const dir = buildSyncAccountDir(syncRoot, owner);
  let existed = false;
  try {
    const stat = await fs.promises.stat(dir);
    if (stat.isDirectory()) existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!existed) return false;
  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * 列出 sync root 下所有 (userId, organizationId) 二元组。
 *
 * 用于：宿主重启时扫描磁盘，给每个账号桶懒加载一个 `FilePersistentQueue`
 * 并跑 bootstrap recover——避免"必须当前用户登录才能发现历史 entry"的
 * 单账号假设。返回的 owner 已经通过 sanitize 校验，调用方可以直接用作
 * SyncQueue.owner（再补 agentId）。
 *
 * 行为：
 * - syncRoot 不存在 → 返回 `[]`；
 * - syncRoot 下含非目录条目 / 含非法 segment 的目录 → 跳过（不抛错——
 *   万一上一版本写入了不规范路径，新代码不应被旧脏数据卡死启动）；
 * - 第二层 organization 目录读失败 → 跳过该 user 桶（同上）。
 */
export async function listSyncAccountOwners(
  syncRoot: string,
): Promise<PersistedEntryOwner[]> {
  let userEntries: fs.Dirent[];
  try {
    userEntries = await fs.promises.readdir(syncRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const owners: PersistedEntryOwner[] = [];
  for (const userEnt of userEntries) {
    if (!userEnt.isDirectory()) continue;
    const userId = userEnt.name;
    if (!isValidAccountSegment(userId)) continue;

    const userDir = path.join(syncRoot, userId);
    let organizationEntries: fs.Dirent[];
    try {
      organizationEntries = await fs.promises.readdir(userDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const organizationEnt of organizationEntries) {
      if (!organizationEnt.isDirectory()) continue;
      const organizationId = organizationEnt.name;
      if (!isValidAccountSegment(organizationId)) continue;
      owners.push({ userId, organizationId });
    }
  }
  return owners;
}

/**
 * 校验 owner 字段（构造 SyncQueue 前调用）。
 *
 * 比 buildSyncAccountDir 更早暴露错误——构造 SyncQueue 时直接抛出，
 * 比"等到第一次 enqueue 才报错"更友好。
 *
 * @throws Error 当 owner 缺失 / userId / organizationId 含非法字符或为空。
 */
export function assertValidOwner(
  owner: PersistedEntryOwner | null | undefined,
): asserts owner is PersistedEntryOwner {
  if (owner === null || owner === undefined) {
    // 业务层经常 destructure `owner.userId` 拿 ID；缺失 owner 时尽量给出
    // 直接说明问题的错误信息，而不是让上层先报 "Cannot read property 'userId'
    // of undefined" 这种隐晦的栈。
    throw new Error('Invalid SyncQueue owner: owner is required (LH2-D3)');
  }
  sanitizeAccountSegment(owner.userId, 'userId');
  sanitizeAccountSegment(owner.organizationId, 'organizationId');
  if (owner.agentId !== undefined) {
    // agentId 进入 telemetry / payload，但**不进路径**——所以校验更宽松：
    // 只挡空白 / 控制字符 / 路径分隔符。允许更长的字符集（`.` / `:` 等）
    // 防止误拒未来的 agent ID 命名约定（例如 `agent.tin@1.0`）。
    if (typeof owner.agentId !== 'string') {
      throw new Error(`Invalid owner.agentId: must be string, got ${typeof owner.agentId}`);
    }
    if (/[\u0000-\u001f/\\]/.test(owner.agentId)) {
      throw new Error('Invalid owner.agentId: contains control or path-separator characters');
    }
  }
}

/**
 * 判断 owner 相等（顺序无关；agentId undefined 视为通配）。
 *
 * 用法：
 *   1. SyncQueue.recover 校验 entry.owner === this.owner（agentId
 *      可选——host 级 bootstrap SyncQueue 不绑特定 agent）。
 *   2. 宿主的 reset-account-sync IPC 在 sessions Map 中找匹配 session
 *      时按 (userId, organizationId) 精确比；agentId 不影响"账号清理"语义。
 */
export function ownersMatch(
  a: PersistedEntryOwner,
  b: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
): boolean {
  return a.userId === b.userId && a.organizationId === b.organizationId;
}

// ─── Private ───────────────────────────────────────────────────────

/** 路径段允许字符；与 UUID / 数字 ID / token 兼容，明确排除 path traversal。 */
const ACCOUNT_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sanitizeAccountSegment(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid sync account segment (${label}): expected string, got ${typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new Error(`Invalid sync account segment (${label}): empty string`);
  }
  if (!ACCOUNT_SEGMENT_RE.test(value)) {
    throw new Error(
      `Invalid sync account segment (${label}): "${value}" — only [A-Za-z0-9_-] up to 128 chars allowed`,
    );
  }
  return value;
}

function isValidAccountSegment(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_SEGMENT_RE.test(value);
}
