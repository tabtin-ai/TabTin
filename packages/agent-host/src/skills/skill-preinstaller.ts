/**
 * Skill Preinstaller — copies bundled platform/app skills into Space sandbox.
 *
 * Wave 6: When a user enters a Space for the first time, default skills
 * (platform + app) are copied from their source directories into
 * `{sandboxRoot}/agent-spaces/<spaceId>/skills/<slug>/`.
 *
 * ── 升级判定：源内容 hash 检测（2026-06 治本）─────────────────────────
 *
 * 历史问题：原判定**只看 frontmatter `version`**——source version == sandbox
 * version 就 skip。Skills 大重构（frontmatter 标准化、多文件拆分、新增
 * `metadata.tabtin.category`）改了内容但**没 bump version**，于是对所有已存在
 * 的 sandbox 一律 skip，重构成果全没落到用户 Space。
 *
 * 治本：preinstaller 不再只靠 version，而是**检测源目录内容有没有变**：
 * - 每次 install / upgrade 落盘时，算**源目录** content hash（Merkle，递归、
 *   规范化行尾、带 ignore 列表，复用 `@tabtin/terminal-core`
 *   `computeSkillContentHash`），写进 sandbox 的 `.skill-meta.json`
 *   `sourceContentHash` 字段——这是「上次装入时的源内容指纹」。
 * - 判定时算**当前源目录** hash，跟 meta 里记录的指纹比：
 *   - sandbox SKILL.md 不存在 → install（首次安装）
 *   - `TABTIN_DEV_REFRESH_SKILLS` → upgrade（DEV 强制刷新）
 *   - meta 缺 `sourceContentHash`（老 sandbox 没记录）→ **upgrade**：强制同步
 *     一次，既建立 hash 基线、又让存量 sandbox 立刻拿到最新（这是解决上面那个
 *     bug 的关键一步）
 *   - 当前源 hash ≠ 记录 → upgrade；相等 → skip
 *   - version 比较仅作**兜底**：当 hash 算不出来（源目录 I/O 异常）时回退
 *
 * 关键陷阱（务必避开）：比的是「当前源 hash」vs「meta 记录的源 hash」，
 * **绝不能**直接拿 `computeSkillContentHash(sourceDir)` 跟
 * `computeSkillContentHash(sandboxDir)` 比——sandbox 多了 `.skill-meta.json`
 * （source 没有），直接比会恒不等、每次启动全量覆盖。
 *
 * ── 历代 installSlug 孤儿清理（2026-06）──────────────────────────────
 *
 * 问题：同一个内置 skill 在 sandbox 里可能存了多套副本——早期裸 slug 目录
 * （`operations` / `tabcode-operator`）+ 现在带前缀的 installSlug
 * （`mcp-operations` / `tabcode-tabcode-operator`）。installSlug 命名格式换过
 * 但旧目录从没删，`LocalSkillRegistry` 两套都扫到 → UI 重复、Installed 计数虚高。
 * 源 hash 升级只更新「当前 installSlug」那份，删不掉「旧 installSlug」孤儿。
 *
 * 清理：每轮 preinstall 末尾，对每个当前默认内置 source 算它**当前**的
 * canonicalKey 与 installSlug；扫 targetDir 下所有目录：
 * - canonicalKey 属于当前 source，但目录名不是当前 installSlug → 过期孤儿，删；
 * - canonicalKey 是内置 platform/app，但已不属于当前默认 source → 默认下线/移除，
 *   删。
 * canonicalKey 派生规则与 skill-scanner / `buildCanonicalKey` 字面对齐（source +
 * domain|appId + slug ?? dirName），这样旧裸 slug 目录（meta 无 slug→回退目录名）
 * 与新带前缀目录会算出同一个 key、被正确识别为「同一个 skill 的新旧两份」。
 *
 * 安全红线（宁可漏删也别误删）：
 * - 只删 canonicalKey 前缀为 `platform:` / `app:`（= preinstall 内置）的目录；
 * - user skill（canonicalKey `user:*` / 无 meta）一律不碰；
 * - 无 `.skill-meta.json` / 解析失败 / canonicalKey 认不出 → 跳过不删；
 * - 当前 installSlug 目录（dirName 命中当前有效集合）保留。
 *
 * ── 语义边界（设计意图）──────────────────────────────────────────────
 *
 * 内置（platform / app）skill **以源为准**：源内容变化会覆盖 sandbox 副本，
 * 包含用户对**内置副本**的本地改动。这是可接受的——内置 skill 本就只读
 * （UI 已是只读查看器）。user skill 不走 preinstaller，不受影响。
 *
 * DEV mode：环境变量 `TABTIN_DEV_REFRESH_SKILLS=1` 绕过 hash 比对、强制全量
 * 覆盖（开发体验：改源 SKILL 不必手动清 sandbox）。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { computeSkillContentHash } from '@tabtin/agent-runtime/paths';
import { isFirstPartyStarterPackAppId, parseSkillDoc } from '@tabtin/agent-runtime/skills';

export interface SkillPreinstallSource {
  /** Absolute path of the source directory containing SKILL.md + assets */
  sourceDir: string;
  /** Canonical skill slug from the source catalog. */
  slug: string;
  /** Collision-free subdirectory name under the target Space skills dir. */
  installSlug?: string;
  /** Written to .skill-meta.json for provenance tracking */
  source: 'platform' | 'app';
  /** For app skills: which app this came from */
  appId?: string;
  /** For platform skills: domain (e.g. "device", "mcp") */
  domain?: string;
}

export interface PreinstallResult {
  installed: number;
  skipped: number;
  /** 删掉的「历代 installSlug 孤儿目录」数（同 canonicalKey、目录名是过期格式） */
  removed: number;
  errors: string[];
}

/**
 * Recursively copy a directory. SKILL.md is deferred (skipped here)
 * so the caller can write it last as a commit marker — if process crashes
 * mid-copy, the missing SKILL.md triggers a re-copy on next startup.
 */
async function copyDirRecursive(
  src: string,
  dest: string,
  skipFile?: string,
): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skipFile && entry.name === skipFile) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, skipFile);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Compare two semver-ish version strings.
 * Returns: 1 if a > b, 0 if a == b or unparseable, -1 if a < b.
 *
 * 接受形态：`0.3.1` / `0.3` / `1.0.0-beta.1`（pre-release 段忽略）。
 * 任何一边解析失败时返回 0（保守 = 视为同版本 → skip 升级）——避免对
 * 非语义化版本（如 `2026-05-04` / `latest` / 空字符串）做错误覆盖。
 */
function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const parse = (v: string): number[] | null => {
    const main = v.split('-')[0]?.split('+')[0];
    if (!main) return null;
    const parts = main.split('.').map((s) => parseInt(s, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Read SKILL.md and extract frontmatter version. Returns undefined on any error
 * (file missing / parse fail / no version field).
 */
async function readSkillVersion(
  skillMdPath: string,
  dirName: string,
): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(skillMdPath, 'utf-8');
    const parsed = parseSkillDoc(
      raw,
      { dirName, docPath: skillMdPath },
      () => {}, // suppress warnings — caller handles missing/invalid as "skip"
    );
    return parsed?.frontmatter.version;
  } catch {
    return undefined;
  }
}

/**
 * 读 sandbox `.skill-meta.json` 里上次装入时记录的「源目录 content hash」。
 * 文件缺失 / 解析失败 / 无该字段 → 返回 undefined（视为「无 hash 基线」）。
 */
async function readRecordedSourceContentHash(
  destDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(
      path.join(destDir, '.skill-meta.json'),
      'utf-8',
    );
    const meta = JSON.parse(raw) as { sourceContentHash?: unknown };
    if (typeof meta.sourceContentHash === 'string' && meta.sourceContentHash) {
      return meta.sourceContentHash;
    }
  } catch {
    // 无 meta / 解析失败 — 当作没有 hash 基线
  }
  return undefined;
}

interface RecordedPreinstallMeta {
  source?: unknown;
  canonicalKey?: unknown;
  appId?: unknown;
  domain?: unknown;
}

async function readRecordedPreinstallMeta(
  destDir: string,
): Promise<RecordedPreinstallMeta | undefined> {
  try {
    const raw = await fsp.readFile(
      path.join(destDir, '.skill-meta.json'),
      'utf-8',
    );
    return JSON.parse(raw) as RecordedPreinstallMeta;
  } catch {
    return undefined;
  }
}

function metaMatchesSource(
  meta: RecordedPreinstallMeta | undefined,
  src: SkillPreinstallSource,
): boolean {
  if (!meta) return false;
  return meta.source === src.source
    && meta.canonicalKey === sourceCanonicalKey(src)
    && (meta.appId ?? undefined) === (src.appId ?? undefined)
    && (meta.domain ?? undefined) === (src.domain ?? undefined);
}

/**
 * 算**源目录** content hash；任何异常 → undefined（让调用方走 version 兜底）。
 *
 * ⚠️ 只 hash 源目录，**绝不** hash sandbox 目录——sandbox 多一个
 * `.skill-meta.json`，混进来会让对比恒不等、每次启动全量覆盖。
 */
async function computeSourceContentHashSafe(
  sourceDir: string,
): Promise<string | undefined> {
  try {
    return await computeSkillContentHash(sourceDir);
  } catch {
    return undefined;
  }
}

interface PreinstallDecision {
  action: 'install' | 'upgrade' | 'skip';
  /**
   * 决策过程中已算出的「当前源目录」content hash。带出来给写 meta 复用，
   * 避免 upgrade-by-hash 路径重复算。install / 缺基线 upgrade / 兜底路径不带
   * （写盘时再算）。
   */
  sourceContentHash?: string;
}

/**
 * 判定 sandbox 副本是否需要被源刷新。
 *
 * 主判据是「源目录内容指纹」对比（当前源 hash vs meta 记录的源 hash）；
 * version 仅在 hash 算不出来时兜底。完整规则见文件头。
 *
 * - install：destDir 没有 SKILL.md（首次安装）
 * - upgrade：源内容变了 / 老 sandbox 无 hash 基线 / DEV 强制
 * - skip：源内容与上次装入时一致
 */
async function decidePreinstallAction(
  src: SkillPreinstallSource,
  sourceDir: string,
  destDir: string,
  slug: string,
  forceRefresh: boolean,
): Promise<PreinstallDecision> {
  const marker = path.join(destDir, 'SKILL.md');
  let markerExists = false;
  try {
    await fsp.access(marker);
    markerExists = true;
  } catch {
    // SKILL.md doesn't exist
  }

  if (!markerExists) {
    return { action: 'install' }; // 首次安装
  }

  if (forceRefresh) {
    return { action: 'upgrade' }; // DEV_MODE 强制
  }

  const recordedHash = await readRecordedSourceContentHash(destDir);

  // 老 sandbox 没记录源 hash → 强制同步一次：建立 hash 基线 + 立刻拿到最新。
  // 这是让存量 sandbox 吃到本次重构成果的关键一步。
  if (!recordedHash) {
    return { action: 'upgrade' };
  }

  // 源归属 / canonical key 也属于预装状态的一部分。内容未变但从 platform
  // 迁到 app（或 appId/domain 修正）时，必须刷新 `.skill-meta.json`，否则
  // registry 会继续暴露旧 canonical key。
  const recordedMeta = await readRecordedPreinstallMeta(destDir);
  if (!metaMatchesSource(recordedMeta, src)) {
    return { action: 'upgrade' };
  }

  const currentHash = await computeSourceContentHashSafe(sourceDir);

  // 兜底：当前源 hash 算不出来（源目录 I/O 异常）→ 回退 version 比较。
  if (currentHash === undefined) {
    const sourceVersion = await readSkillVersion(
      path.join(sourceDir, 'SKILL.md'),
      slug,
    );
    const sandboxVersion = await readSkillVersion(marker, slug);
    if (compareVersions(sourceVersion, sandboxVersion) > 0) {
      return { action: 'upgrade' };
    }
    return { action: 'skip' };
  }

  // 主判据：当前源内容指纹 ≠ 上次装入时记录 → 源变了 → 升级。
  if (currentHash !== recordedHash) {
    return { action: 'upgrade', sourceContentHash: currentHash };
  }

  return { action: 'skip', sourceContentHash: currentHash };
}

/**
 * 算一个内置 source 在 registry 里的 canonicalKey。
 * 必须与 skill-scanner + skill-renderer `buildCanonicalKey` 的规则字面一致：
 *  - platform → `platform:<domain>/<slug>`（无 domain 则 `platform:<slug>`）
 *  - app      → `app:<appId>/<slug>`（无 appId 则 `app:<slug>`）
 */
function sourceCanonicalKey(src: SkillPreinstallSource): string {
  if (src.source === 'platform') {
    const seg = src.domain ? `${src.domain}/` : '';
    return `platform:${seg}${src.slug}`;
  }
  const seg = src.appId ? `${src.appId}/` : '';
  return `app:${seg}${src.slug}`;
}

async function readBuiltinMeta(dirPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsp.readFile(
      path.join(dirPath, '.skill-meta.json'),
      'utf-8',
    );
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined; // 无 meta / 解析失败 → 认不出 → 跳过
  }
}

function readBuiltinCanonicalKeyFromMeta(meta: Record<string, unknown>): string | undefined {
  if (typeof meta.canonicalKey !== 'string' || !meta.canonicalKey) return undefined;
  return meta.canonicalKey.startsWith('platform:')
    || meta.canonicalKey.startsWith('app:')
    ? meta.canonicalKey
    : undefined;
}

function deriveLegacyBuiltinCanonicalKey(
  meta: Record<string, unknown>,
  dirName: string,
): string | undefined {
  const source = meta.source;
  if (source !== 'platform' && source !== 'app') {
    return undefined; // user / 未知 source → 非内置 → 跳过
  }
  let appIdSeg: string | undefined;
  if (typeof meta.appId === 'string' && meta.appId) {
    appIdSeg = meta.appId;
  }
  // platform：domain 段覆盖 appId（与 scanner 一致）
  if (source === 'platform' && typeof meta.domain === 'string' && meta.domain) {
    appIdSeg = meta.domain;
  }
  const slug =
    typeof meta.slug === 'string' && meta.slug.trim()
      ? meta.slug.trim()
      : dirName;
  const seg = appIdSeg ? `${appIdSeg}/` : '';
  return `${source}:${seg}${slug}`;
}

/**
 * 从一个 sandbox 目录的 (.skill-meta.json + 目录名) 派生它的「内置 canonicalKey」，
 * 用于孤儿清理时跟内置 source 比对。
 *
 * 规则与 skill-scanner 完全一致（这样才能跟 registry 实际去重用的 key 对齐）：
 *  - 优先信任 meta 里显式写的 `canonicalKey`（新 preinstaller 会写），但只接受
 *    `platform:` / `app:` 前缀（user:* 等非内置一律不认）；
 *  - 旧 meta 无该字段时按 (source, domain|appId, slug ?? dirName) 派生
 *    （旧裸 slug 目录 meta 常缺 slug → 回退目录名，正好与新带前缀目录算出同 key）。
 *
 * 任何「认不出是内置」的情况一律返回 undefined（无 meta / 解析失败 / source 非
 * platform|app / canonicalKey 非内置前缀）——调用方据此跳过，**绝不误删**。
 */
async function deriveBuiltinCanonicalKey(
  dirPath: string,
  dirName: string,
): Promise<string | undefined> {
  const meta = await readBuiltinMeta(dirPath);
  if (!meta) return undefined;

  // 优先用 meta 里显式写的 canonicalKey（新 preinstaller 落盘时写），
  // 但严格限制为内置前缀——user:* / 其它一律不碰。
  const canonicalKey = readBuiltinCanonicalKeyFromMeta(meta);
  if (canonicalKey) return canonicalKey;

  // 旧 meta 无 canonicalKey → 按 scanner 规则派生。
  return deriveLegacyBuiltinCanonicalKey(meta, dirName);
}

function shouldRemoveStaleInstallDir(
  key: string,
  dirName: string,
  validByKey: Map<string, Set<string>>,
  sources: SkillPreinstallSource[],
): boolean {
  const validSlugs = validByKey.get(key);
  if (validSlugs) return !validSlugs.has(dirName);
  return sources.length === 0 && key.startsWith('app:');
}

/**
 * 删除「历代 installSlug 孤儿目录」：同一内置 source 在 sandbox 里残留的、旧命名
 * 格式的副本（canonicalKey 相同、目录名不是当前 installSlug）。安全红线见文件头。
 *
 * 时序：在所有 source preinstall 完成**之后**调用——这样当前 installSlug 目录都已
 * 就位，「当前有效集合」完整，不会把刚装好的当前副本误判成孤儿。
 */
async function cleanupStaleInstallSlugs(
  targetDir: string,
  sources: SkillPreinstallSource[],
  result: PreinstallResult,
  log: (msg: string) => void,
): Promise<void> {
  // canonicalKey → 该 key 当前有效的 installSlug 集合。
  // 理论上一个 key 只对应一个 installSlug，用 Set 防御「多个 source 撞同 key」时
  // 误删彼此的当前目录。
  const validByKey = new Map<string, Set<string>>();
  for (const src of sources) {
    const key = sourceCanonicalKey(src);
    const installSlug = src.installSlug ?? src.slug;
    let set = validByKey.get(key);
    if (!set) {
      set = new Set();
      validByKey.set(key, set);
    }
    set.add(installSlug);
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith('.')) continue; // 与 scanner 一致：跳过 .xxx 配置目录

    const dirPath = path.join(targetDir, dirName);
    const key = await deriveBuiltinCanonicalKey(dirPath, dirName);
    if (!key) continue; // 无 meta / 非内置 / 认不出 → 跳过（绝不误删）

    if (!shouldRemoveStaleInstallDir(key, dirName, validByKey, sources)) continue;

    // 命中：本次内置 source 的过期 installSlug 孤儿，或 app 默认集合为空时的下线 app 副本 → 删
    try {
      await fsp.rm(dirPath, { recursive: true, force: true });
      result.removed++;
      log(`removed stale skill dir "${dirName}" (canonicalKey=${key})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`failed to remove stale ${dirName}: ${msg}`);
    }
  }
}

/**
 * 安装/升级**单个** source 到 targetDir（不做孤儿清理）。
 *
 * 抽出自 {@link preinstallDefaultSkills} 的循环体，让「批量默认预装」与「按需
 * 物化单个 skill」（{@link installSkillSource}）共用同一套「决策 → 拷贝 → 写 meta」
 * 语义，避免行为漂移。**刻意不含 `cleanupStaleInstallSlugs`**——按需物化只关心自己
 * 这一个 skill，绝不能把同目录下其它内置 skill 当孤儿误删。
 */
async function installSingleSource(
  targetDir: string,
  src: SkillPreinstallSource,
  forceRefresh: boolean,
  result: PreinstallResult,
): Promise<void> {
  const installSlug = src.installSlug ?? src.slug;
  const destDir = path.join(targetDir, installSlug);

  try {
    await fsp.access(path.join(src.sourceDir, 'SKILL.md'));
  } catch {
    result.errors.push(`source missing SKILL.md: ${src.sourceDir}`);
    return;
  }

  const decision = await decidePreinstallAction(
    src,
    src.sourceDir,
    destDir,
    src.slug,
    forceRefresh,
  );

  if (decision.action === 'skip') {
    result.skipped++;
    return;
  }

  try {
    // 升级路径：先删旧的整个 destDir，再走跟首次安装一致的"先拷附件最后写
    // SKILL.md"流程。这样崩溃恢复语义保持不变（缺 SKILL.md 时下次会重装）。
    if (decision.action === 'upgrade') {
      await fsp.rm(destDir, { recursive: true, force: true });
    }

    // Copy everything except SKILL.md first
    await copyDirRecursive(src.sourceDir, destDir, 'SKILL.md');

    // 算（或复用决策已算的）源目录 content hash，写进 meta 作为下次判定基线。
    // 复用决策结果，避免 upgrade-by-hash 路径重复算一遍。
    const sourceContentHash =
      decision.sourceContentHash
      ?? (await computeSourceContentHashSafe(src.sourceDir));

    const meta = {
      source: src.source,
      slug: src.slug,
      installSlug,
      // 显式记录 canonicalKey：孤儿清理直接读它对比（旧 meta 没有则靠派生兜底）。
      canonicalKey: sourceCanonicalKey(src),
      appId: src.appId,
      domain: src.domain,
      preinstalledAt: new Date().toISOString(),
      sourceContentHash,
    };
    await fsp.writeFile(
      path.join(destDir, '.skill-meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );

    // SKILL.md last — serves as commit marker for crash recovery
    await fsp.copyFile(
      path.join(src.sourceDir, 'SKILL.md'),
      path.join(destDir, 'SKILL.md'),
    );

    result.installed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`failed to copy ${src.slug}: ${msg}`);
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 按需物化**单个** skill source 到某个 Space 的 skills 目录。
 *
 * 用途：普通 marketplace app skill / 首方 package skill 被 {@link collectAppSources}
 * 排除出默认预装（"等用户安装时再落盘"）。首发起步包除外——它们虽标 marketplace，
 * 仍走预装。用户在商店点安装时，宿主用本函数把该 skill 的 bundled 源目录拷进
 * Space skills 目录，让 `LocalSkillRegistry` 扫得到、Agent 的 `<skills>` 段可见。
 *
 * 与 {@link preinstallDefaultSkills} 的关键区别：**不做孤儿清理**（只认自己这一个
 * skill，不会误删同目录其它内置 skill）。`TABTIN_DEV_REFRESH_SKILLS` 仍生效（强制覆盖）。
 */
export async function installSkillSource(
  targetDir: string,
  src: SkillPreinstallSource,
  onLog?: (msg: string) => void,
): Promise<PreinstallResult> {
  const log = onLog ?? (() => {});
  const result: PreinstallResult = { installed: 0, skipped: 0, removed: 0, errors: [] };
  const forceRefresh =
    process.env.TABTIN_DEV_REFRESH_SKILLS === '1'
    || process.env.TABTIN_DEV_REFRESH_SKILLS === 'true';

  await fsp.mkdir(targetDir, { recursive: true });
  await installSingleSource(targetDir, src, forceRefresh, result);

  if (result.installed > 0) {
    log(`materialized skill "${src.installSlug ?? src.slug}"`);
  }
  return result;
}

/**
 * 迁移助手（内置 skill 去重复用）：删除某个 Space skills 目录里的**内置副本**
 * （platform / app），保留该 Space 独有的 user / marketplace skill。
 *
 * 背景：改用「单份共享store（scope=shared）」后，历史上被物理拷进每个 Space 的
 * 内置 skill 变成冗余；这些冗余若不清，registry 仍会按 `space:<spaceId>:...`
 * 各存一份，去重失效。本函数按 `.skill-meta.json` 派生的 canonicalKey 识别内置
 * （`platform:` / `app:` 前缀），只删这些目录。
 *
 * 安全红线（与 cleanupStaleInstallSlugs 一致，宁可漏删不误删）：
 * - 只删 canonicalKey 前缀为 `platform:` / `app:` 的目录；
 * - user skill（`user:*` / 无 meta / 认不出）一律不碰；
 * - `.skill-meta.json` 缺失 / 解析失败 → 跳过。
 */
export async function removeBuiltinCopiesFromSpace(
  targetDir: string,
  onLog?: (msg: string) => void,
): Promise<{ removed: number; errors: string[] }> {
  const log = onLog ?? (() => {});
  const out = { removed: 0, errors: [] as string[] };

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 → 无副本可清
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith('.')) continue;

    const dirPath = path.join(targetDir, dirName);
    const key = await deriveBuiltinCanonicalKey(dirPath, dirName);
    // 认不出是内置（无 meta / user / 未知）→ 绝不删。
    if (!key) continue;
    if (!key.startsWith('platform:') && !key.startsWith('app:')) continue;

    try {
      await fsp.rm(dirPath, { recursive: true, force: true });
      out.removed++;
      log(`migrated: removed builtin copy "${dirName}" (canonicalKey=${key})`);
    } catch (err) {
      out.errors.push(
        `failed to remove builtin copy ${dirName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Pre-install default skills into a Space's skills directory.
 *
 * @param targetDir - `{sandboxRoot}/agent-spaces/<spaceId>/skills/`
 * @param sources - list of skill sources to pre-install
 * @param onLog - optional logger callback
 */
export async function preinstallDefaultSkills(
  targetDir: string,
  sources: SkillPreinstallSource[],
  onLog?: (msg: string) => void,
): Promise<PreinstallResult> {
  const log = onLog ?? (() => {});
  const result: PreinstallResult = { installed: 0, skipped: 0, removed: 0, errors: [] };

  // DEV_MODE：强制覆盖 sandbox 副本到源版本，跳过 version 比对。
  // 主要用途：开发者改 bundled SKILL 后不必手动清 sandbox。
  const forceRefresh =
    process.env.TABTIN_DEV_REFRESH_SKILLS === '1'
    || process.env.TABTIN_DEV_REFRESH_SKILLS === 'true';

  await fsp.mkdir(targetDir, { recursive: true });

  for (const src of sources) {
    await installSingleSource(targetDir, src, forceRefresh, result);
  }

  // 所有 source 装完后清理「历代 installSlug 孤儿目录」（同 canonicalKey、目录名过期）。
  await cleanupStaleInstallSlugs(targetDir, sources, result, log);

  if (result.installed > 0 || result.removed > 0) {
    log(
      `preinstalled ${result.installed} skills `
      + `(skipped ${result.skipped}, removed ${result.removed} stale)`,
    );
  }

  return result;
}

/**
 * Collect all platform skill sources from the bundled root.
 *
 * Directory structure: `bundledRoot/platform/<domain>/<slug>/SKILL.md`
 * Each produces a source with slug = `<slug>`, domain = `<domain>`.
 */
export async function collectPlatformSources(
  bundledRoot: string,
): Promise<SkillPreinstallSource[]> {
  const sources: SkillPreinstallSource[] = [];
  const platformDir = path.join(bundledRoot, 'platform');

  let domains: import('node:fs').Dirent[];
  try {
    domains = await fsp.readdir(platformDir, { withFileTypes: true });
  } catch {
    return sources;
  }

  for (const domain of domains) {
    if (!domain.isDirectory()) continue;
    const domainPath = path.join(platformDir, domain.name);

    let slugs: import('node:fs').Dirent[];
    try {
      slugs = await fsp.readdir(domainPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      sources.push({
        sourceDir: path.join(domainPath, slug.name),
        slug: slug.name,
        installSlug: `${domain.name}-${slug.name}`,
        source: 'platform',
        domain: domain.name,
      });
    }
  }

  return sources;
}

/**
 * Collect all app skill sources from the apps root.
 *
 * Directory structure: `appsRoot/<appId>/skills/<slug>/SKILL.md`
 */
export async function collectAppSources(
  appsRoot: string,
): Promise<SkillPreinstallSource[]> {
  const sources: SkillPreinstallSource[] = [];

  let apps: import('node:fs').Dirent[];
  try {
    apps = await fsp.readdir(appsRoot, { withFileTypes: true });
  } catch {
    return sources;
  }

  for (const appEntry of apps) {
    if (!appEntry.isDirectory()) continue;
    const appId = appEntry.name;
    const appDir = path.join(appsRoot, appId);

    try {
      const manifestRaw = await fsp.readFile(path.join(appDir, 'app.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        distribution?: unknown;
        catalog?: { isDefaultEnabled?: unknown };
      };
      // 普通市场包装进货架，等用户安装再落盘。首发起步包（工作流 /
      // 工程纪律 / Ponytail）虽标 marketplace，分身模板默认携带，必须预装进
      // `_shared-skills`，否则斜杠能点、Agent 本机找不到（#11220）。
      if (!isFirstPartyStarterPackAppId(appId)) {
        if (manifest.distribution === 'marketplace') continue;
        if (manifest.catalog?.isDefaultEnabled === false) continue;
      }
    } catch {
      // Legacy tests/fixtures may omit app.json; keep the old collection behavior.
    }

    const skillsDir = path.join(appsRoot, appId, 'skills');

    let slugEntries: import('node:fs').Dirent[];
    try {
      slugEntries = await fsp.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const slugEntry of slugEntries) {
      if (!slugEntry.isDirectory()) continue;
      sources.push({
        sourceDir: path.join(skillsDir, slugEntry.name),
        slug: slugEntry.name,
        installSlug: `${appId}-${slugEntry.name}`,
        source: 'app',
        appId,
      });
    }
  }

  return sources;
}

/**
 * Collect standalone package skills from `packages/skills/<skill>/SKILL.md`.
 *
 * `packages/skills/bundled/` is handled by `collectPlatformSources`; this
 * catches first-party package skills such as TabTracker that are product skills
 * but do not live under `packages/apps/<app>/skills/`.
 */
export async function collectPackageSkillSources(
  skillsRoot: string,
): Promise<SkillPreinstallSource[]> {
  const sources: SkillPreinstallSource[] = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return sources;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'bundled') continue;
    const sourceDir = path.join(skillsRoot, entry.name);
    try {
      await fsp.access(path.join(sourceDir, 'SKILL.md'));
    } catch {
      continue;
    }
    sources.push({
      sourceDir,
      slug: entry.name,
      installSlug: `${entry.name}-${entry.name}`,
      source: 'app',
      appId: entry.name,
    });
  }

  return sources;
}
