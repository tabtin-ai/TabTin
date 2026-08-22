/**
 * Skill 目录扫描（ rewrite）。
 *
 * 职责：
 * 1. 根据 scan sources 解析出扫描根路径列表（ 布局：user + organization
 *    双层，废除 space）
 * 2. 对每个根 `<root>/<slug>/SKILL.md` 并行读取（`Promise.all`）+ 解析
 * 3. 返回"parsed candidates"列表，registry 再做 realpath 去重入库
 *
 * 关键设计：
 * - **目录不存在不是错误**：user / org skills 目录首次启动很可能没创建，
 *   scanner 要静默返回空；EACCES / EPERM 只 warn 并跳过。
 * - **深度限制**：只扫一层（`<root>/<dir>/SKILL.md`），不递归。
 * - **并行但有限并发**：避免 EMFILE。
 * - **scanner 不做 realpath 去重**：registry 拿到 candidates 后统一按 realpath 去重。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  getDataRoot,
  resolveOrganizationSkillsDir,
  resolveUserSkillsDir,
} from '@tabtin/agent-runtime/paths';
import {
  parseSkillDoc,
  type ParsedSkillCandidate,
  type ScanRoot,
  type ScanRootKind,
  type SkillSource,
  type UserScope,
} from '@tabtin/agent-runtime/skills';

const SKILL_FILE = 'SKILL.md';

/** 并发扫描上限：单根 50 个 skill 并行——对 ulimit 友好。 */
const SKILL_READ_CONCURRENCY = 50;

/**
 * Scanner 注入的环境依赖（ 新布局； 硬切老布局）。
 *
 * 唯一模式：提供 `dataRoot` + `userId` → 扫描
 *   - `{dataRoot}/users/{userId}/skills/`（个人 Skill）
 *   - `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`（组织 Skill）
 *
 * 老 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/` 双层枚举布局已
 * 彻底移除（ 硬切）——不再有任何调用方可以静默回落到该扫描根；
 * 一次性存量迁移见 `storage-migration.ts`（迁移完成后旧树只是 leftover，
 * scanner 不再读）。
 */
export interface ScannerEnv {
  /** 新数据根（`{platformBase}` 或 env `TABTIN_DATA_ROOT`） */
  dataRoot?: string;
  /**
   * 当前登录用户 id。**给了 `dataRoot` 就必填**—— 硬切：缺失时
   * `computeScanRoots` 直接抛错，不再静默跳过 / 落 `_unscoped/skills`。
   */
  userId?: string;
  /**
   * 可选：仅扫这批 organization id（新模式）。未提供则枚举
   * `users/{userId}/organizations/*` 目录。
   */
  organizationIds?: readonly string[];
  /** 可选：跨客户端互操作目录列表（只读发现） */
  interopRoots?: string[];
  /**
   * 可选：内置 platform/app skill 的单份共享store目录（去重复用）。
   * 提供时作为一个 `builtin/shared` 扫描根全局扫一次；其中的 skill 以
   * `scope: 'shared'` 入库、对所有 workspace 可见。
   */
  sharedBuiltinRoot?: string;
}

export const defaultScannerEnv = (): ScannerEnv => ({
  dataRoot: getDataRoot(),
});

/**
 * 基于 env 生成所有扫描根。
 *
 * 扫多类路径：
 * 1. `{dataRoot}/users/{userId}/skills/` + `.../organizations/{orgId}/skills/`
 * 2. Interop（只读）: 用户指定的互操作目录
 * 3. Shared builtin（可选）
 */
export async function computeScanRoots(env: ScannerEnv): Promise<ScanRoot[]> {
  // （硬切）：老 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/`
  // 双层枚举布局已彻底移除。未类型化调用方（如宿主动态拼参）仍传该字段时直接
  // 拒绝，别静默忽略导致「扫描看似正常、实际扫空」。
  if ('platformDataRoot' in env) {
    throw new Error(
      'computeScanRoots: platformDataRoot 已移除（ 硬切），改用 dataRoot + userId',
    );
  }

  const roots: ScanRoot[] = [];

  // `{dataRoot}/users/{userId}/...`。
  // （硬切）：给了 dataRoot 就是明确要走新布局——缺 userId 直接抛错，
  // 不再静默跳过（避免装配方以为扫描正常，实际拿到空 user/org 根）。
  if (env.dataRoot) {
    if (!env.userId) {
      throw new Error(
        'computeScanRoots: dataRoot 已提供但缺少 userId（ 硬切新布局，'
        + '不允许静默落到 _unscoped）',
      );
    }
    roots.push({
      kind: 'user/personal',
      path: resolveUserSkillsDir(env.dataRoot, env.userId),
      userId: env.userId,
    });

    if (env.organizationIds && env.organizationIds.length > 0) {
      for (const orgId of env.organizationIds) {
        if (!orgId) continue;
        roots.push({
          kind: 'user/organization',
          path: resolveOrganizationSkillsDir(env.dataRoot, env.userId, orgId),
          userId: env.userId,
          organizationId: orgId,
        });
      }
    } else {
      try {
        const orgParent = path.join(env.dataRoot, 'users', env.userId, 'organizations');
        const entries = await fsp.readdir(orgParent, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const orgId = entry.name;
          if (orgId === '_unscoped') continue;
          roots.push({
            kind: 'user/organization',
            path: resolveOrganizationSkillsDir(env.dataRoot, env.userId, orgId),
            userId: env.userId,
            organizationId: orgId,
          });
        }
      } catch {
        // organizations 目录尚未创建 —— 静默
      }
    }
  }

  // 内置共享store：单份物化、全局扫一次（去重复用）。
  if (env.sharedBuiltinRoot) {
    roots.push({
      kind: 'builtin/shared',
      path: env.sharedBuiltinRoot,
    });
  }

  for (const r of env.interopRoots ?? []) {
    if (!r) continue;
    roots.push({
      kind: 'user/interop',
      path: r,
    });
  }

  return roots;
}

/**
 * 把 ScanRootKind 映射到业务模型的 (source, scope)。
 *
 * ：user/personal 与 user/organization 都走 `source='user'`；scope 决定
 * registryKey 里带哪个前缀（个人 vs 组织）。老 `space` 兼容 kind 仍映射 `scope='space'`
 * 以保留 registry 现有 `spaceId` 过滤链路。
 */
function kindToSourceScope(
  kind: ScanRootKind,
): { source: SkillSource; scope?: UserScope } {
  switch (kind) {
    case 'user/personal':
      return { source: 'user', scope: 'user' };
    case 'user/organization':
      return { source: 'user', scope: 'organization' };
    case 'space':
      return { source: 'user', scope: 'space' };
    case 'user/interop':
      // 规范互操作目录（~/.agents/skills 等）对面板归「本机 / device」
      return { source: 'device', scope: 'interop' };
    case 'builtin/shared':
      // 内置共享store：base source 记 'platform'，真实来源由 .skill-meta.json
      // 的 metaSource（platform/app）覆盖；scope='shared' → 全局可见、去重。
      return { source: 'platform', scope: 'shared' };
    case 'workspace':
      // 目录自带 skill 不走常驻 registry 扫描；若误入则按 user 降级（真正来源看 sourceType）。
      return { source: 'user' };
  }
}

/**
 * 小型并发池：tasks 依次 `pool.add()`，`pool.drain()` 收集所有结果。
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runOne(),
  );
  await Promise.all(workers);
  return results;
}

async function readSkillMeta(skillDir: string): Promise<{
  metaSource?: SkillSource;
  metaAppId?: string;
  metaSlug?: string;
}> {
  try {
    const metaRaw = await fsp.readFile(
      path.join(skillDir, '.skill-meta.json'),
      'utf-8',
    );
    const meta = JSON.parse(metaRaw);
    const metaSource = meta.source === 'platform' || meta.source === 'app'
      ? meta.source as SkillSource
      : undefined;
    let metaAppId = typeof meta.appId === 'string' ? meta.appId : undefined;
    const metaSlug = typeof meta.slug === 'string' && meta.slug.trim()
      ? meta.slug.trim()
      : undefined;
    // Platform skills use domain as the "appId" for canonical key generation
    if (meta.source === 'platform' && typeof meta.domain === 'string') {
      metaAppId = meta.domain;
    }
    return { metaSource, metaAppId, metaSlug };
  } catch {
    // No meta file or parse error — defaults to 'user'
    return {};
  }
}

async function scanSkillDir(args: {
  root: ScanRoot;
  dirent: fs.Dirent;
  source: SkillSource;
  scope?: UserScope;
  warn: (msg: string) => void;
}): Promise<ParsedSkillCandidate | null> {
  const { root, dirent, source, scope, warn } = args;
  const dirName = dirent.name;
  // 忽略点开头的目录（约定：`.xxx` 是配置目录，不是 skill）
  if (dirName.startsWith('.')) return null;

  const skillDir = path.join(root.path, dirName);
  const docPath = path.join(skillDir, SKILL_FILE);

  // realpath 解算（跨平台软链接；Windows junction 也会被 Node 处理）
  let realpath: string;
  try {
    realpath = await fsp.realpath(docPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    warn(`realpath 失败 ${docPath}：${(err as Error).message}`);
    return null;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(docPath, 'utf-8');
  } catch (err: unknown) {
    warn(`读取 ${docPath} 失败：${(err as Error).message}`);
    return null;
  }

  const parsed = parseSkillDoc(raw, { dirName, docPath }, warn);
  if (!parsed) return null;

  const { metaSource, metaAppId, metaSlug } = await readSkillMeta(skillDir);
  // user / organization / space skill：目录名才是唯一身份（导入撞名会变成 slug-2）。
  const canonicalSlug =
    metaSlug
    ?? (metaSource === 'platform' || metaSource === 'app' ? dirName : undefined)
    ?? (root.kind === 'user/personal'
      || root.kind === 'user/organization'
      || root.kind === 'space'
      ? dirName
      : undefined);

  return {
    frontmatter: canonicalSlug
      ? { ...parsed.frontmatter, slug: canonicalSlug }
      : parsed.frontmatter,
    content: parsed.content,
    docPath,
    realpath,
    rootKind: root.kind,
    source: metaSource ?? source,
    scope,
    appId: metaAppId,
    metaSource,
    organizationId: root.organizationId,
    spaceId: root.spaceId,
    dirName,
  };
}

/**
 * 扫描单个根目录：列出子目录 + 读每个 `<slug>/SKILL.md` + 解析。
 *
 * 返回成功解析的 `ParsedSkillCandidate` 列表；目录/文件缺失或解析失败都静默跳过。
 */
export async function scanRoot(
  root: ScanRoot,
  onWarn?: (msg: string) => void,
): Promise<ParsedSkillCandidate[]> {
  const warn = onWarn ?? ((msg: string) => console.warn(`[skills] ${msg}`));

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root.path, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return [];
    }
    if (code === 'EACCES' || code === 'EPERM') {
      warn(
        `无法读取技能目录，请检查权限或联系 IT 管理员。（路径：${root.path}）`,
      );
      return [];
    }
    warn(`读取 ${root.path} 失败：${(err as Error).message}`);
    return [];
  }

  const dirs = entries.filter(
    (e) => e.isDirectory() || e.isSymbolicLink(),
  );

  const { source, scope } = kindToSourceScope(root.kind);

  const tasks = dirs.map((dirent) => async (): Promise<
    ParsedSkillCandidate | null
  > => scanSkillDir({ root, dirent, source, scope, warn }));

  const results = await runWithConcurrency(
    tasks,
    SKILL_READ_CONCURRENCY,
    (fn) => fn(),
  );

  return results.filter(
    (r): r is ParsedSkillCandidate => r !== null,
  );
}

/**
 * 扫所有根，返回全部 candidates。registry 拿去做 realpath 去重 + 入库。
 */
export async function scanAll(
  roots: ScanRoot[],
  onWarn?: (msg: string) => void,
): Promise<ParsedSkillCandidate[]> {
  const perRoot = await Promise.all(
    roots.map((root) => scanRoot(root, onWarn)),
  );
  return perRoot.flat();
}
