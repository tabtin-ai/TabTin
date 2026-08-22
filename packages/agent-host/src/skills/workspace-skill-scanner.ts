/**
 * 目录自带 Skill 扫描（ W3 / ）。
 *
 * 按内容识别（SKILL.md + parseSkillDoc），不按路径白名单——故用有限 BFS
 *（默认深 4 / 2000 目录 / 50 skills），而不是只枚举 `.agents|cursor|claude|codex/skills`。
 * 跳过 node_modules/.git/dist 等；不跟随符号链接；skill 目录为叶子。
 * 门控（Trust / unattended）在宿主层，本模块只发现。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseSkillDoc, type LocalSkill } from '@tabtin/agent-runtime/skills';
import { computeSkillContentHash } from '@tabtin/agent-runtime/paths';

const SKILL_FILE = 'SKILL.md';

/** 体积大 / 与 skill 无关；不含通配「所有点目录」（`.cursor` 等需可扫）。 */
export const WORKSPACE_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'target',
  'vendor',
  'Pods',
  'DerivedData',
  '.gradle',
]);

export interface WorkspaceScanLimits {
  /** 相对 Workspace 根的最大目录深度（根 = 0）。 */
  maxDepth: number;
  /** 目录访问数上限（readdir 次数）——超过即截断返回。 */
  maxDirs: number;
  /** 收录 skill 数上限——超过即截断返回。 */
  maxSkills: number;
  /** 缓存 TTL：期内直接复用结果，不做任何 fs 访问。 */
  cacheTtlMs: number;
  /** 缓存最长寿命：TTL~maxAge 间做 stat 校验，超过强制重扫。 */
  cacheMaxAgeMs: number;
}

export const DEFAULT_WORKSPACE_SCAN_LIMITS: WorkspaceScanLimits = {
  maxDepth: 4,
  maxDirs: 2_000,
  maxSkills: 50,
  cacheTtlMs: 15_000,
  cacheMaxAgeMs: 120_000,
};

export interface WorkspaceScanResult {
  /** 识别出的目录自带 skill（sourceType='workspace'，key=workspace:<相对路径 slug>）。 */
  skills: LocalSkill[];
  /** 是否因成本上限（maxDirs / maxSkills）截断——UI 可提示「仅展示部分」。 */
  truncated: boolean;
  /** 实际访问的目录数（诊断用）。 */
  scannedDirs: number;
  scannedAt: number;
}

export interface ScanWorkspaceSkillsOptions {
  limits?: Partial<WorkspaceScanLimits>;
  onWarn?: (msg: string) => void;
  /** 跳过缓存强制重扫（面板手动刷新用）。 */
  force?: boolean;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

interface CacheEntry {
  result: WorkspaceScanResult;
  /** skill 所在目录 + 根目录的 mtimeMs 快照（stat 校验用）。 */
  dirMtimes: Map<string, number>;
}

const scanCache = new Map<string, CacheEntry>();

/** 测试 / 面板「刷新」用：清空指定根（缺省全部）的扫描缓存。 */
export function clearWorkspaceSkillScanCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    scanCache.clear();
    return;
  }
  scanCache.delete(normalizeRoot(workspaceRoot));
}

/**
 * 同步读缓存中最近一次扫描结果（不触发扫描）。
 *
 * 消费方：宿主 skills_read / skills_search 工具闭包（同步签名）——
 * fetchSkills（beforeAgent）已异步刷新过缓存，工具调用发生在其后。
 */
export function getCachedWorkspaceSkills(workspaceRoot: string): LocalSkill[] {
  return scanCache.get(normalizeRoot(workspaceRoot))?.result.skills ?? [];
}

function normalizeRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

/** 相对路径 → canonical key 尾段：每段 slug 化（非 [a-z0-9-] 归并为 '-'）。 */
function slugifyRelPath(relPath: string): string {
  return relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((seg) =>
      seg
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('/');
}

/**
 * canonical 标识派生：沿用现有 `<source>:<qualifier>` key 体系，以相对路径为
 * 自然限定段（同 slug 不同目录不冲突）。段内字符对齐 skills_read 的
 * CANONICAL_KEY_PATTERN（`[a-z0-9-/]`），点段等非法字符 slug 化清洗；清洗后
 * 碰撞（罕见）追加序号后缀保唯一。
 */
export function buildWorkspaceSkillKey(
  relPath: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugifyRelPath(relPath) || 'skill';
  let key = `workspace:${base}`;
  let n = 2;
  while (taken.has(key)) {
    key = `workspace:${base}-${n}`;
    n += 1;
  }
  return key;
}

/**
 * 类型特征识别 + 有限深度 BFS 扫描。
 */
export async function scanWorkspaceSkills(
  workspaceRoot: string,
  options: ScanWorkspaceSkillsOptions = {},
): Promise<WorkspaceScanResult> {
  const limits: WorkspaceScanLimits = {
    ...DEFAULT_WORKSPACE_SCAN_LIMITS,
    ...options.limits,
  };
  const warn = options.onWarn ?? (() => undefined);
  const now = options.now ?? Date.now;
  const root = normalizeRoot(workspaceRoot);

  if (!options.force) {
    const cached = await tryUseCache(root, limits, now());
    if (cached) return cached;
  }

  const result = await doScan(root, limits, warn, now);

  // 缓存 mtime 快照：根目录 + 每个 skill 所在目录。
  const dirMtimes = new Map<string, number>();
  const statDirs = [root, ...result.skills.map((s) => path.dirname(s.docPath))];
  for (const dir of statDirs) {
    try {
      const st = await fsp.stat(dir);
      dirMtimes.set(dir, st.mtimeMs);
    } catch {
      // 目录消失等竞态——不缓存该项，下次校验必然失败触发重扫
    }
  }
  scanCache.set(root, { result, dirMtimes });
  return result;
}

async function tryUseCache(
  root: string,
  limits: WorkspaceScanLimits,
  nowMs: number,
): Promise<WorkspaceScanResult | null> {
  const entry = scanCache.get(root);
  if (!entry) return null;
  const age = nowMs - entry.result.scannedAt;
  if (age < 0 || age > limits.cacheMaxAgeMs) return null;
  if (age <= limits.cacheTtlMs) return entry.result;
  // TTL~maxAge：轻量 stat 校验（skill 目录数量少，代价可忽略）。
  for (const [dir, mtimeMs] of entry.dirMtimes) {
    try {
      const st = await fsp.stat(dir);
      if (st.mtimeMs !== mtimeMs) return null;
    } catch {
      return null;
    }
  }
  return entry.result;
}

async function doScan(
  root: string,
  limits: WorkspaceScanLimits,
  warn: (msg: string) => void,
  now: () => number,
): Promise<WorkspaceScanResult> {
  const skills: LocalSkill[] = [];
  const takenKeys = new Set<string>();
  let scannedDirs = 0;
  let truncated = false;

  // BFS：浅层优先——同名冲突时「更靠近根的版本」更可能是用户意图。
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (scannedDirs >= limits.maxDirs) {
      truncated = true;
      break;
    }
    scannedDirs += 1;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 已删除——静默跳过该目录
    }

    // 类型特征识别：目录含 SKILL.md → 尝试按内容 schema 解析。
    const hasSkillDoc = entries.some(
      (e) => e.isFile() && e.name === SKILL_FILE,
    );
    if (hasSkillDoc && dir !== root) {
      if (skills.length >= limits.maxSkills) {
        truncated = true;
        break;
      }
      const skill = await tryParseWorkspaceSkill(root, dir, takenKeys, warn, now);
      if (skill) {
        skills.push(skill);
        takenKeys.add(skill.canonicalKey);
      }
      // skill 目录是自包含单元（references/examples 归它自己）——不再深入。
      continue;
    }

    if (depth >= limits.maxDepth) continue;
    for (const entry of entries) {
      // 不跟随符号链接目录：防循环 + 防逃逸 Workspace 根（供应链考虑）。
      if (!entry.isDirectory()) continue;
      if (WORKSPACE_SCAN_SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return { skills, truncated, scannedDirs, scannedAt: now() };
}

async function tryParseWorkspaceSkill(
  root: string,
  skillDir: string,
  takenKeys: ReadonlySet<string>,
  warn: (msg: string) => void,
  now: () => number,
): Promise<LocalSkill | null> {
  const docPath = path.join(skillDir, SKILL_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(docPath, 'utf-8');
  } catch (err) {
    warn(`读取 ${docPath} 失败：${(err as Error).message}`);
    return null;
  }

  const parsed = parseSkillDoc(raw, { dirName: path.basename(skillDir), docPath }, warn);
  if (!parsed) return null; // 内容 schema 未通过 → 不是 Skill（类型识别失败）

  let realpath = docPath;
  try {
    realpath = await fsp.realpath(docPath);
  } catch {
    // realpath 失败不阻断（identity 回落 docPath）
  }

  const relPath = path.relative(root, skillDir).split(path.sep).join('/');
  const fm = parsed.frontmatter;
  let contentHash: string | undefined;
  try {
    contentHash = await computeSkillContentHash(skillDir);
  } catch (err) {
    warn(`计算 ${skillDir} 内容哈希失败：${(err as Error).message}`);
  }

  return {
    canonicalKey: buildWorkspaceSkillKey(relPath, takenKeys),
    // source 归 'user'（四档枚举内最贴近「非平台供给」）；真正的来源判定走
    // 结构化字段 sourceType —— 消费端一律读 sourceType，不判 key 前缀。
    source: 'user',
    sourceType: 'workspace',
    workspaceRelPath: relPath,
    slug: fm.slug,
    name: fm.name,
    displayName: fm.displayName,
    description: fm.description,
    whenToUse: fm.when_to_use,
    version: fm.version,
    docPath,
    realpath,
    contentHash,
    content: parsed.content,
    xTabtinApps: fm['x-tabtin-apps'],
    xTabtinAgents: fm['x-tabtin-agents'],
    tags: fm.tags,
    category: fm.category,
    requires: fm.requires,
    install: fm.install,
    osFilter: fm.os_filter,
    always: fm.always,
    emoji: fm.emoji,
    homepage: fm.homepage,
    agents: fm.agents,
    primaryEnv: fm.primary_env,
    rootKind: 'workspace',
    indexedAt: now(),
  };
}

export {
  computeWorkspaceShadowing,
  mergeWorkspaceSkillsForRuntime,
  type SkillSlugRef,
  type WorkspaceShadowingResult,
  type WorkspaceSkillMergeResult,
} from '@tabtin/agent-runtime/skills';

/** 根须等于或位于某个 allowedRoot 之下（发现 / 注入共用）。 */
export function isWorkspaceRootAllowed(
  workspaceRoot: string,
  allowedRoots: readonly string[],
): boolean {
  if (!workspaceRoot) return false;
  const resolved = path.resolve(workspaceRoot);
  for (const root of allowedRoots) {
    if (!root) continue;
    const allowed = path.resolve(root);
    if (resolved === allowed) return true;
    const prefix = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

export interface GuardedScanOptions extends ScanWorkspaceSkillsOptions {
  /** 允许扫描的根边界（通常 = [os.homedir()]），两侧必须传同一份。 */
  allowedRoots: readonly string[];
}

/** 越界 → null；否则同 {@link scanWorkspaceSkills}。 */
export async function scanWorkspaceSkillsGuarded(
  workspaceRoot: string,
  options: GuardedScanOptions,
): Promise<WorkspaceScanResult | null> {
  const { allowedRoots, ...scanOptions } = options;
  if (!isWorkspaceRootAllowed(workspaceRoot, allowedRoots)) return null;
  return scanWorkspaceSkills(workspaceRoot, scanOptions);
}
