/**
 * Project Rules 读盘 helper —— 读取工作目录根部 `AGENTS.md`（项目规约 MVP）。
 *
 * **落点（PRD §4.5 / §5#7 拍板）**：放 agent-runtime 的 node-only `tools/`
 * 子目录，经 `@tabtin/agent-runtime/tools` 暴露给两端宿主（Electron / Daemon）
 * import 同一份——完全复刻 `callMemorySearchAPI` 范式（实现在 `tools/`、经
 * subpath 共享）。
 *
 * **为什么 helper 碰 fs、hook 本体不碰**：纪律范围是 `engine/hooks/` 层纯净
 * （便于单测、跨端安全），不是整个包禁用 fs。hook（`rules-injector.ts`）收
 * `() => readProjectRules(workspaceRoot)` 闭包，读盘细节全在本 helper——与
 * memory-injector 把 HTTP 交给 `callMemorySearchAPI` 闭包同理。
 *
 * **缓存（PRD §4.5 E3 拍板）**：按 `workspaceRoot` 路径**分桶** mtime 缓存
 * （`Map<workspaceRoot, {...}>`，不是全局单条）——Electron 主进程 / Daemon
 * 同时托管多 session、多个 working_dir，全局单条会串内容 + 反复 miss。
 *
 * **热更新**：每轮 `stat` 一次比对 mtime，未变直接返回缓存（不重读盘），变了
 * 重读——"编辑 AGENTS.md → 下一轮即生效"。文件不存在（ENOENT/ENOTDIR）/
 * workspaceRoot 空 → 返回 null（不抛、不缓存 null，让中途新建文件下一轮能被
 * 发现）。**瞬时 IO 错误（权限/锁/句柄耗尽等）→ throw**，由 hook 保留 last-good，
 * 不把一次抖动误判成"文件被删"而撤销规约。
 *
 * **大小写严格（跨端一致）**：用 `readdir` 拿真实文件名精确比对，只认大写
 * `AGENTS.md`，不依赖底层 FS 的大小写敏感性——杜绝"macOS 读到 agents.md、
 * Linux Daemon 读不到"的跨端分歧。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 只认大写 `AGENTS.md`（跨工具标准，跨工具 AGENTS.md 约定）。大小写一致性由
 * `readProjectRules` 第 3 步的 readdir 精确比对强制，不依赖底层 FS 行为。
 */
const PROJECT_RULES_FILENAME = 'AGENTS.md';

/**
 * 读取上限（约 32KB）。helper 侧的内存天花板——`fs.readFile` 会先把整文件读进
 * `raw`，本上限**不防 readFile 的瞬时峰值**，只约束「缓存 + 往下游传的 content
 * 副本」的大小（AGENTS.md 体量实际很小，峰值无虞）。hook 侧 `charBudget`（默认
 * 32000）是更细的预算闸 + 截断标记，二者叠加：helper 先粗截到 32768（无标记），
 * hook 再按 32000 截 + 追加 `[... truncated]`（有标记，模型可感知）。
 */
const DEFAULT_MAX_CHARS = 32 * 1024;

interface ProjectRulesCacheEntry {
  /** 上次读盘时文件的 mtimeMs，用于热更新比对。 */
  mtimeMs: number;
  /** 上次读到的内容（已按 maxChars 粗截）。 */
  content: string;
}

/**
 * 按 `workspaceRoot` 路径分桶的 mtime 缓存。模块级单例——同进程内多 session
 * 共享（不同 workspaceRoot 各占一桶，互不污染）。
 *
 * **缓存键只含 workspaceRoot**：假定同一 root 的 `maxChars` 在进程内稳定（两端
 * 宿主都用默认值、不传 options）。若未来对同一 root 用不同 `maxChars` 调用，
 * mtime 未变时会返回首次按旧 maxChars 截过的 content——届时需把 maxChars 纳入键。
 */
const cache = new Map<string, ProjectRulesCacheEntry>();

/**
 * 判断错误是否为"文件 / 目录确实不存在"（可安全坍缩成 null = 无规则）。
 *
 * 其它错误（`EACCES` 权限 / `EBUSY` 文件锁 / `EMFILE` 句柄耗尽等瞬时故障）
 * **不**应被误判成"文件被删"——让它们冒泡 throw，由 `rules-injector` hook 的
 * try/catch 保留 last-good（上一轮已注入的规约不撤销），避免规约因一次 IO
 * 抖动从上下文里闪烁消失。这让 hook 里那段"throw → 保留 last-good"韧性逻辑
 * 真正可达（独立 review 指出：旧实现把所有错误坍缩成 null，那段韧性是死代码）。
 */
function isNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function statProjectRulesFile(
  workspaceRoot: string,
  filePath: string,
): Promise<{ found: true; mtimeMs: number } | { found: false }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      cache.delete(workspaceRoot);
      return { found: false };
    }
    return { found: true, mtimeMs: stat.mtimeMs };
  } catch (err) {
    if (isNotFoundError(err)) {
      cache.delete(workspaceRoot);
      return { found: false };
    }
    throw err;
  }
}

async function hasExactProjectRulesFilename(workspaceRoot: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(workspaceRoot);
    return entries.includes(PROJECT_RULES_FILENAME);
  } catch (err) {
    if (isNotFoundError(err)) {
      cache.delete(workspaceRoot);
      return false;
    }
    throw err;
  }
}

async function readProjectRulesFile(
  workspaceRoot: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isNotFoundError(err)) {
      cache.delete(workspaceRoot);
      return null;
    }
    throw err;
  }
}

export interface ReadProjectRulesOptions {
  /** 读取字符上限，超出粗截（无标记，标记交给 hook 侧）。默认 `32 * 1024`。 */
  maxChars?: number;
}

/**
 * 读 `workspaceRoot/AGENTS.md` 内容。
 *
 * @param workspaceRoot Agent 工作目录根（Electron `normalizeWorkspaceRoot(getCLIOrganizationRoot())`；
 *   Daemon `this.workspaceRoot`）。空 / undefined → 返回 null。
 * @returns 文件内容（按 maxChars 粗截）；文件不存在 / 非普通文件 / 读失败 /
 *   workspaceRoot 空 → null。**不抛**。
 */
export async function readProjectRules(
  workspaceRoot: string | undefined,
  options?: ReadProjectRulesOptions,
): Promise<string | null> {
  if (!workspaceRoot || !workspaceRoot.trim()) return null;

  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const filePath = path.join(workspaceRoot, PROJECT_RULES_FILENAME);

  // 1. stat 拿 mtime。
  //    - ENOENT/ENOTDIR（文件 / 目录确实不在）→ 清桶 + null（清桶很关键：
  //      AGENTS.md 被删后下一轮不能再返回缓存的陈旧内容）。
  //    - 其它瞬时错误 → throw，由 hook 保留 last-good（见 isNotFoundError）。
  const statResult = await statProjectRulesFile(workspaceRoot, filePath);
  if (!statResult.found) return null;

  // 2. mtime 未变 → 命中缓存，不重读盘（热更新比对的核心：避免每轮全量读）。
  //    缓存只在「大小写精确校验通过」后写入，故命中即合法，无需重复校验。
  const cached = cache.get(workspaceRoot);
  if (cached && cached.mtimeMs === statResult.mtimeMs) {
    return cached.content;
  }

  // 3. 大小写精确校验（消除跨端分歧）：`fs.stat('AGENTS.md')` 在大小写不敏感
  //    的 FS（macOS APFS / Windows NTFS）上会命中 `agents.md`，但在大小写敏感
  //    的 FS（Linux ext4）上不会——同一仓库会出现「Electron 读到、Linux Daemon
  //    读不到」的分歧（违背"两端一致"验收标准）。用 readdir 拿真实文件名做精确
  //    比对，让所有平台都**只认大写 `AGENTS.md`**。仅在缓存未命中（首次 / mtime
  //    变 / 大小写不符的 degraded 路径）时走 readdir，正常稳态命中缓存不读目录。
  if (!(await hasExactProjectRulesFilename(workspaceRoot))) {
    cache.delete(workspaceRoot);
    return null;
  }

  // 4. mtime 变了 / 首次 → 重读。ENOENT（竞态删除）→ 清桶 + null；其它瞬时
  //    错误 → throw 保留 last-good。
  const raw = await readProjectRulesFile(workspaceRoot, filePath);
  if (raw === null) return null;

  const content = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  cache.set(workspaceRoot, { mtimeMs: statResult.mtimeMs, content });
  return content;
}

/**
 * 测试专用：清空 mtime 缓存。生产代码勿调。
 */
export function __resetProjectRulesCacheForTests(): void {
  cache.clear();
}
