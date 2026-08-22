/**
 * Host-side local skill module — disk IO, registry, watcher, install/preinstall.
 *
 * Electron / Daemon import orchestration from `@tabtin/agent-host/skills`.
 * Pure contracts (enablement / renderer / types / listing) stay on
 * `@tabtin/agent-runtime/skills`.
 */

import * as fsp from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import {
  resolveOrganizationSkillsDir,
  resolveUserSkillsDir,
} from '@tabtin/agent-runtime/paths';
import type {
  HiddenSkillSets,
  ScanRoot,
  SkillRecallPort,
} from '@tabtin/agent-runtime/skills';
import { LocalSkillRegistry, type RegistryLogger } from './local-skill-registry.js';
import { SkillDirWatcher } from './skill-dir-watcher.js';
import type { PreinstallResult, SkillPreinstallSource } from './skill-preinstaller.js';

export {
  LocalSkillRegistry,
  type RegistryOptions,
  type RegistryLogger,
} from './local-skill-registry.js';

export {
  SkillDirWatcher,
  type WatcherOptions,
} from './skill-dir-watcher.js';

export {
  WORKSPACE_SCAN_SKIP_DIRS,
  DEFAULT_WORKSPACE_SCAN_LIMITS,
  clearWorkspaceSkillScanCache,
  getCachedWorkspaceSkills,
  buildWorkspaceSkillKey,
  scanWorkspaceSkills,
  isWorkspaceRootAllowed,
  scanWorkspaceSkillsGuarded,
  type WorkspaceScanLimits,
  type WorkspaceScanResult,
  type ScanWorkspaceSkillsOptions,
  type GuardedScanOptions,
} from './workspace-skill-scanner.js';

export {
  computeScanRoots,
  defaultScannerEnv,
  type ScannerEnv,
} from './skill-scanner.js';

export {
  AGENTS_SKILLS_ENV,
  CLIENT_SKILL_DIR_SEGMENTS,
  resolveDefaultAgentsSkillsDir,
  resolveGlobalInteropSkillDirs,
  resolveDefaultInteropRoots,
  resolveWorkspaceAgentsSkillsDir,
  resolveWorkspaceClientSkillDirs,
} from './interop-roots.js';

export {
  installSkillFromBundle,
  uninstallSkillLocal,
  isValidSkillKey,
  type SkillInstallOptions,
  type SkillInstallMeta,
  type SkillInstallResult,
  type PackageRegistryFile,
} from './skill-installer.js';

export {
  preinstallDefaultSkills,
  installSkillSource,
  removeBuiltinCopiesFromSpace,
  collectPlatformSources,
  collectAppSources,
  collectPackageSkillSources,
  type SkillPreinstallSource,
  type PreinstallResult,
} from './skill-preinstaller.js';

// ─── Disposable lifecycle ─────────────────────────────────────────────

type SkillsDisposable = () => Promise<void> | void;

const skillsDisposables = new Set<SkillsDisposable>();

export function registerSkillsDisposable(
  disposer: SkillsDisposable,
): () => void {
  skillsDisposables.add(disposer);
  return (): void => {
    skillsDisposables.delete(disposer);
  };
}

export async function disposeSkillsModule(): Promise<void> {
  const snapshot = Array.from(skillsDisposables).reverse();
  skillsDisposables.clear();

  const errors: string[] = [];
  for (const d of snapshot) {
    try {
      await d();
    } catch (err) {
      errors.push((err as Error)?.message ?? String(err));
    }
  }

  if (errors.length > 0) {
    console.warn(
      `[skills] disposeSkillsModule: ${errors.length} disposer(s) threw — ${errors.join('; ')}`,
    );
  }
}

export function _skillsDisposableCountForTest(): number {
  return skillsDisposables.size;
}

// ─── initSkillsModule ─────────────────────────────────────────────────

export interface InitSkillsModuleOptions {
  /**
   * 新数据根：`{platformBase}` 或 env `TABTIN_DATA_ROOT`。
   * 提供时 scanner 走 `.../users/{userId}/…` 双层布局。
   */
  dataRoot?: string;
  /**
   * 当前登录用户 id（ 新模式必填）。缺失时 scanner 不产出 user/org 根。
   */
  userId?: string;
  /**
   * 可选：仅扫这批 organization id（scanner 新模式）。缺省枚举 `users/{userId}/organizations/*`。
   */
  organizationIds?: readonly string[];
  /** 可选：互操作目录列表 */
  interopRoots?: string[];
  /**
   * 可选：内置 skill 的**单份共享store**目录（去重复用）。提供时：
   * - init 阶段把 `preinstallSources` 里的内置 platform/app skill **只物化一份**
   *   到此目录，并作为 `builtin/shared` 扫描根全局扫一次（scope=shared，全局可见）；
   * - `ensureOrganizationSkills()` **不再**往每个 organization 拷内置，
   *   组织根只承载该组织独有的 user / marketplace skill。
   *
   * 不提供时行为完全不变（内置仍 per-organization 预装）——便于灰度与回滚。
   */
  sharedSkillsDir?: string;
  /** 可选：预装源列表（bundled platform + app skills 的源目录）。
   * 注意：预装在 `ensureOrganizationSkills()` 中按需触发，不在 init 时全量执行。 */
  preinstallSources?: SkillPreinstallSource[];
  /**
   * 可选：`packages/apps/` 根。用于 {@link SkillsModuleHandle.materializeAppSkill}
   * 按需解析 marketplace 分发 app skill 的 bundled 源目录
   * （`{appsRoot}/{appId}/skills/{slug}/SKILL.md`）。
   */
  appsRoot?: string;
  /**
   * 可选：`packages/skills/` 根（首方 package skill）。materialize 解析源目录时的
   * 回退位置（`{packageSkillsRoot}/{slug}/SKILL.md`）。
   */
  packageSkillsRoot?: string;
  logger?: RegistryLogger;
  /**
   * Skill 召回端口（ /  Stage 6c），透传给 LocalSkillRegistry。
   * 宿主传 `new RecallIndex({ scorer })`；缺省会在 Registry 构造期 throw。
   */
  skillRecall?: SkillRecallPort;
  /**
   * 可选：宿主注入的临时隐藏 skill 名单。缺省不隐藏任何 skill。
   * 「隐藏哪个 app / key」是宿主运营决策，透传给 LocalSkillRegistry。
   */
  hiddenSkills?: HiddenSkillSets;
}

export interface SkillsModuleHandle {
  registry: LocalSkillRegistry;
  watcher: SkillDirWatcher;
  ready(): Promise<void>;
  /**
   * 新 API：确保 `{dataRoot}/users/{userId}/skills/` 目录存在并纳入扫描。
   * 未提供 `dataRoot`+`userId` 时抛错。幂等。
   */
  ensureUserSkills(userId: string): Promise<void>;
  /**
   * 新 API：确保 `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`
   * 目录存在并纳入扫描。幂等。
   */
  ensureOrganizationSkills(userId: string, organizationId: string): Promise<void>;
  /**
   * 动态追加互操作扫描根：例如 Space working_dir 下的 `.agents/skills`。
   * 目录不存在时 scanner 静默跳过；已存在的 path 幂等。
   */
  addInteropRoot(rootPath: string): Promise<void>;
  /**
   * 按需把一个 marketplace 分发的 app skill（或首方 package skill）的 bundled 源
   * 物化进 `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`，并让 registry
   * 立即可见（不等 watcher debounce）。
   *
   * （硬切）：唯一布局 (userId + dataRoot)；`spaceId` 仅为兼容调用方
   * surface 依赖签名保留、不参与路径计算。缺 userId / dataRoot、找不到 bundled
   * 源时抛错。
   */
  materializeAppSkill(params: {
    organizationId: string;
    spaceId?: string;
    userId?: string;
    appId: string;
    slug: string;
  }): Promise<PreinstallResult>;
}

export async function initSkillsModule(
  options: InitSkillsModuleOptions,
): Promise<SkillsModuleHandle> {
  // （硬切）：老布局 (spaceId + platformDataRoot) 已彻底移除，未
  // 类型化调用方（如宿主动态拼参）仍传该字段时直接拒绝，别静默忽略。
  if ('platformDataRoot' in options) {
    throw new Error(
      'initSkillsModule: platformDataRoot 已移除（ 硬切），改用 dataRoot + userId',
    );
  }

  const { preinstallDefaultSkills, installSkillSource } =
    await import('./skill-preinstaller.js');

  const preinstallSources = options.preinstallSources ?? [];
  const sharedSkillsDir = options.sharedSkillsDir;
  const sharedEnabled = !!sharedSkillsDir;

  // 内置共享store：init 阶段**只物化一份**，再作为 builtin/shared 扫描根扫入。
  // 必须在 registry.ready() 之前完成，好让首轮全量扫描就看到共享内置。
  if (sharedEnabled && preinstallSources.length > 0) {
    try {
      const r = await preinstallDefaultSkills(
        sharedSkillsDir!,
        preinstallSources,
        options.logger ? (msg) => options.logger!.info(`[Skills] shared-store: ${msg}`) : undefined,
      );
      options.logger?.info(
        `[Skills] shared builtin store ready: installed=${r.installed} skipped=${r.skipped} removed=${r.removed} dir=${sharedSkillsDir}`,
      );
    } catch (err) {
      // 物化失败不致命：不注册共享根，doEnsureOrganization 仍按 sharedEnabled
      // 标志走（见下），失败详情已 warn，交由宿主决策是否重试。
      options.logger?.info(
        `[Skills] shared builtin store materialize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const env = {
    ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.organizationIds ? { organizationIds: options.organizationIds } : {}),
    interopRoots: options.interopRoots,
    ...(sharedEnabled ? { sharedBuiltinRoot: sharedSkillsDir } : {}),
  };

  const registry = new LocalSkillRegistry({
    env,
    logger: options.logger,
    skillRecall: options.skillRecall,
    hiddenSkills: options.hiddenSkills,
  });
  await registry.ready();
  if (sharedEnabled && preinstallSources.length > 0) {
    const count = await registry.ensureSharedBuiltinCatalogReady({
      expectedCount: preinstallSources.length,
      rootPath: sharedSkillsDir,
    });
    options.logger?.info(
      `[Skills] shared builtin catalog indexed=${count}/${preinstallSources.length}`,
    );
  }

  const watcher = new SkillDirWatcher({ registry, logger: options.logger });
  watcher.start();

  registerSkillsDisposable(() => {
    // registry no-op placeholder (pure memory, no fd/timer to release)
  });
  registerSkillsDisposable(() => watcher.close());

  const ensuredKeys = new Set<string>();
  const inflightEnsure = new Map<string, Promise<void>>();

  const doEnsureUser = async (userId: string): Promise<void> => {
    if (!options.dataRoot) {
      throw new Error('ensureUserSkills: initSkillsModule must be initialised with dataRoot');
    }
    const skillsDir = resolveUserSkillsDir(options.dataRoot, userId);
    await fsp.mkdir(skillsDir, { recursive: true });
    const root = { kind: 'user/personal' as const, path: skillsDir, userId };
    watcher.addRoot(root);
    await registry.addScanRoot(root);
  };

  const doEnsureOrganization = async (userId: string, organizationId: string): Promise<void> => {
    if (!options.dataRoot) {
      throw new Error('ensureOrganizationSkills: initSkillsModule must be initialised with dataRoot');
    }
    const skillsDir = resolveOrganizationSkillsDir(options.dataRoot, userId, organizationId);
    await fsp.mkdir(skillsDir, { recursive: true });

    if (!sharedEnabled && preinstallSources.length > 0) {
      const result = await preinstallDefaultSkills(
        skillsDir,
        preinstallSources,
        options.logger
          ? (msg) => options.logger!.info(`[Skills] user=${userId} org=${organizationId}: ${msg}`)
          : undefined,
      );
      if (result.installed > 0) {
        options.logger?.info(
          `[Skills] preinstalled ${result.installed} skills for user=${userId} org=${organizationId}`,
        );
      }
    }

    const root = {
      kind: 'user/organization' as const,
      path: skillsDir,
      userId,
      organizationId,
    };
    watcher.addRoot(root);
    await registry.addScanRoot(root);
  };

  const cached = (key: string, work: () => Promise<void>): Promise<void> => {
    if (ensuredKeys.has(key)) return Promise.resolve();
    const existing = inflightEnsure.get(key);
    if (existing) return existing;
    const p = work()
      .then(() => { ensuredKeys.add(key); })
      .finally(() => { inflightEnsure.delete(key); });
    inflightEnsure.set(key, p);
    return p;
  };

  const ensureUserSkills = (userId: string): Promise<void> =>
    cached(`user::${userId}`, () => doEnsureUser(userId));

  const ensureOrganizationSkills = (userId: string, organizationId: string): Promise<void> =>
    cached(`org::${userId}::${organizationId}`, () => doEnsureOrganization(userId, organizationId));

  const materializeAppSkill = async (params: {
    organizationId: string;
    /** （硬切）：仅兼容调用方 surface 依赖签名，不参与路径计算。 */
    spaceId?: string;
    userId?: string;
    appId: string;
    slug: string;
  }): Promise<PreinstallResult> => {
    const { organizationId, userId, appId, slug } = params;
    if (!organizationId || !appId || !slug) {
      throw new Error(
        'materializeAppSkill: organizationId / appId / slug 均为必填',
      );
    }
    // （硬切）：唯一布局 (userId + dataRoot)，老布局
    // (spaceId + platformDataRoot) 已彻底移除。
    if (!userId || !options.dataRoot) {
      throw new Error(
        'materializeAppSkill: 需要 (userId + dataRoot)（ 硬切已移除老布局）',
      );
    }

    // 解析 bundled 源目录：优先 packages/apps/<appId>/skills/<slug>，
    // 回退 packages/skills/<slug>（首方 package skill 布局）。
    const candidates: string[] = [];
    if (options.appsRoot) {
      candidates.push(join(options.appsRoot, appId, 'skills', slug));
    }
    if (options.packageSkillsRoot) {
      candidates.push(join(options.packageSkillsRoot, slug));
    }
    let sourceDir: string | undefined;
    for (const c of candidates) {
      try {
        await fsp.access(join(c, 'SKILL.md'));
        sourceDir = c;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!sourceDir) {
      throw new Error(
        `materializeAppSkill: 未找到 app=${appId} slug=${slug} 的 bundled 源`
        + `（appsRoot=${options.appsRoot ?? '<none>'}）`,
      );
    }

    const installSlug = `${appId}-${slug}`;
    await ensureOrganizationSkills(userId, organizationId);
    const skillsDir = resolveOrganizationSkillsDir(options.dataRoot, userId, organizationId);
    const root: ScanRoot = {
      kind: 'user/organization',
      path: skillsDir,
      userId,
      organizationId,
    };
    const logLabel = `user=${userId} org=${organizationId}`;

    const result = await installSkillSource(
      skillsDir,
      { sourceDir, slug, installSlug, source: 'app', appId },
      options.logger
        ? (msg) => options.logger!.info(`[Skills] ${logLabel}: ${msg}`)
        : undefined,
    );

    // 立即强制重扫该 root，让新落盘的 skill 当轮可见（不等 watcher 300ms debounce）。
    await registry.refreshSlug(root, join(skillsDir, installSlug));

    return result;
  };

  const addInteropRoot = async (rootPath: string): Promise<void> => {
    const trimmed = rootPath?.trim();
    if (!trimmed) return;
    const root = { kind: 'user/interop' as const, path: resolvePath(trimmed) };
    watcher.addRoot(root);
    await registry.addScanRoot(root);
  };

  return {
    registry,
    watcher,
    ready: () => registry.ready(),
    ensureUserSkills,
    ensureOrganizationSkills,
    addInteropRoot,
    materializeAppSkill,
  };
}
