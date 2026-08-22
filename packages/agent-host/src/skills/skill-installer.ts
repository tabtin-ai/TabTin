/**
 * Skill Installer — downloads skill bundles from Package Registry to local disk.
 *
 * Wave 4 N3: Bridges the gap between "install = MySQL record" and
 * "install = files on device". After Django install API returns presigned
 * download URLs, the caller invokes `installSkillFromBundle` to materialise
 * the skill into the current Space sandbox.
 *
 * Also provides `uninstallSkillLocal` for symmetric removal.
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  getDataRoot,
  getHomeTabtinPath,
  getPlatformDataRoot,
} from '@tabtin/agent-runtime/paths';

// ─── Public types ────────────────────────────────────────────────────────────

export interface PackageRegistryFile {
  path: string;
  sha256: string;
  size: number;
  download_url: string;
  content_type: string;
}

export interface SkillInstallMeta {
  source: string;
  version: string;
  installedAt: string;
  packageId: string;
  versionSeq?: number;
  bundleSha256?: string;
}

export interface SkillInstallOptions {
  skillKey: string;
  /** Individual file download entries from Package Registry */
  files: PackageRegistryFile[];
  /** Absolute per-Space sandbox path for this skill bundle. */
  targetDir: string;
  meta?: SkillInstallMeta;
  /**
   * Migration/import-only escape hatch for legacy global bundles.
   * New install/create callers must leave this unset.
   */
  allowLegacyGlobalForMigration?: boolean;
}

export interface SkillInstallResult {
  ok: boolean;
  filesWritten: number;
  error?: string;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const SKILL_KEY_RE = /^[\w][\w.\-@]*$/;

/**
 * Validate that a skillKey cannot be used for path injection.
 * Must be a single segment (no slashes, no `..`).
 */
export function isValidSkillKey(skillKey: string): boolean {
  return SKILL_KEY_RE.test(skillKey) && !skillKey.includes('..');
}

/**
 * Reject file paths that attempt directory traversal outside the target root.
 */
function isSafePath(targetDir: string, filePath: string): boolean {
  const resolved = path.resolve(targetDir, filePath);
  const normalTarget = path.normalize(targetDir + path.sep);
  return resolved.startsWith(normalTarget) || resolved === path.normalize(targetDir);
}

/**
 * Validate targetDir is inside known safe roots.
 *
 *  布局：
 *   - 个人 Skill: `{dataRoot}/users/{userId}/skills/{slug}/`
 *   - 组织 Skill: `{dataRoot}/users/{userId}/organizations/{orgId}/skills/{slug}/`
 *
 * 兼容期同时允许旧 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/...`
 * 供未迁移调用方过渡。老 `~/.tabtin/skills` 全局根仅在
 * `allowLegacyGlobalForMigration` 显式声明时允许（迁移 harness 专用）。
 *
 * Root 都从 `storage-paths` SSoT 派生，保证与 on-disk 布局跨平台一致。
 */
function isTargetDirSafe(
  targetDir: string,
  options?: { allowLegacyGlobalForMigration?: boolean },
): boolean {
  const normalTarget = path.normalize(targetDir);
  const safeRoots = [
    // 新布局：`{dataRoot}/users/…` 全部允许（scanner 双层枚举 user/org skills）
    path.normalize(path.join(getDataRoot(), 'users') + path.sep),
    // 兼容期：旧 platform-data 布局
    path.normalize(getPlatformDataRoot() + path.sep),
  ];
  if (options?.allowLegacyGlobalForMigration) {
    safeRoots.push(path.normalize(getHomeTabtinPath('skills') + path.sep));
  }
  return safeRoots.some((root) => normalTarget.startsWith(root));
}

const FETCH_TIMEOUT_MS = 60_000;

function validateInstallOptions(options: SkillInstallOptions): string | undefined {
  const { skillKey, files, targetDir, allowLegacyGlobalForMigration } = options;
  if (!skillKey || !targetDir) return 'skillKey and targetDir are required';
  if (!isValidSkillKey(skillKey)) return `Invalid skillKey: ${skillKey}`;
  if (!isTargetDirSafe(targetDir, { allowLegacyGlobalForMigration })) {
    return `targetDir outside safe root: ${targetDir}`;
  }
  if (!files || files.length === 0) return 'No files provided for installation';
  for (const f of files) {
    if (!isSafePath(targetDir, f.path)) return `Path traversal blocked: ${f.path}`;
  }
  return undefined;
}

async function cleanupTempDir(tmpDir: string): Promise<void> {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

async function downloadBundleFile(
  file: PackageRegistryFile,
  destPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await fetch(file.download_url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Download failed for ${file.path}: ${msg}` };
  }

  if (!resp.ok) {
    return { ok: false, error: `Failed to download ${file.path}: HTTP ${resp.status}` };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Body read failed for ${file.path}: ${msg}` };
  }

  if (file.sha256) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== file.sha256) {
      return {
        ok: false,
        error: `SHA256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`,
      };
    }
  }

  await fsp.writeFile(destPath, buffer);
  return { ok: true };
}

// ─── Windows-safe directory swap  ──────────────────────────────────────
//
// Windows often returns EPERM/EACCES/EBUSY on directory rename when Defender /
// Explorer / a file watcher still holds a handle. Mac rarely hits this; the
// production diag for  showed enable looping on:
//   rename('.tmp-slug-…' → '…/skills/slug') → EPERM
// Strategy: rename-with-retry, park the old dir aside, then cp fallback.

const RENAME_RETRYABLE_CODES = new Set([
  'EPERM',
  'EACCES',
  'EEXIST',
  'EBUSY',
  'ENOTEMPTY',
]);

const RENAME_MAX_ATTEMPTS = 3;

export type ReplaceDirFs = {
  rename: typeof fsp.rename;
  rm: typeof fsp.rm;
  cp: typeof fsp.cp;
  access: typeof fsp.access;
  sleep: (ms: number) => Promise<void>;
};

const defaultReplaceDirFs: ReplaceDirFs = {
  rename: fsp.rename.bind(fsp),
  rm: fsp.rm.bind(fsp),
  cp: fsp.cp.bind(fsp),
  access: fsp.access.bind(fsp),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function formatFsError(op: string, err: unknown, from: string, to: string): string {
  const code = errnoCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  const codePart = code ? ` [${code}]` : '';
  return `${op} failed${codePart}: ${msg} (${from} -> ${to})`;
}

function isRetryableRenameError(err: unknown): boolean {
  const code = errnoCode(err);
  return code != null && RENAME_RETRYABLE_CODES.has(code);
}

async function renameWithRetry(
  from: string,
  to: string,
  fs: ReplaceDirFs,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRenameError(err) || attempt === RENAME_MAX_ATTEMPTS - 1) {
        throw err;
      }
      await fs.sleep(50 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Replace `targetDir` with the contents of `tmpDir` in a Windows-safe way.
 *
 * 1. If target exists, try renaming it aside to `.old-{skillKey}-{ts}`.
 * 2. Rename tmp → target (with short retries for transient locks).
 * 3. On persistent EPERM/EACCES/…: fallback to `fs.cp` then remove tmp.
 * 4. Best-effort cleanup of the parked `.old-*` directory.
 *
 * Exported for unit tests (injectable fs).
 */
export async function replaceDirAtomically(
  tmpDir: string,
  targetDir: string,
  skillKey: string,
  fs: ReplaceDirFs = defaultReplaceDirFs,
): Promise<void> {
  const parent = path.dirname(targetDir);
  const stamp = Date.now();
  const oldDir = path.join(parent, `.old-${skillKey}-${stamp}`);
  let parkedOld = false;

  const targetExists = await fs.access(targetDir).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    try {
      await renameWithRetry(targetDir, oldDir, fs);
      parkedOld = true;
    } catch {
      // Direct rm when park-aside fails (destination locked / already gone).
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let swapped = false;
  try {
    try {
      await renameWithRetry(tmpDir, targetDir, fs);
      swapped = true;
    } catch (renameErr) {
      if (!isRetryableRenameError(renameErr)) {
        throw new Error(formatFsError('rename', renameErr, tmpDir, targetDir));
      }
      // Fallback: copy into place, then drop tmp. force covers a half-deleted target.
      try {
        await fs.cp(tmpDir, targetDir, { recursive: true, force: true });
        swapped = true;
      } catch (cpErr) {
        throw new Error(
          `${formatFsError('rename', renameErr, tmpDir, targetDir)}; ` +
            `${formatFsError('cp-fallback', cpErr, tmpDir, targetDir)}`,
        );
      }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    if (parkedOld) {
      if (swapped) {
        await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
      } else {
        // Swap failed: restore previous install so enable-rollback leaves a usable dir.
        const targetStillThere = await fs.access(targetDir).then(
          () => true,
          () => false,
        );
        if (!targetStillThere) {
          await fs.rename(oldDir, targetDir).catch(() => {});
        }
      }
    }
  }
}

// ─── Core installer ──────────────────────────────────────────────────────────

export async function installSkillFromBundle(
  options: SkillInstallOptions,
): Promise<SkillInstallResult> {
  const { skillKey, files, targetDir, meta } = options;
  const validationError = validateInstallOptions(options);
  if (validationError) return { ok: false, filesWritten: 0, error: validationError };

  // Download to a temp dir first, then Windows-safe swap into targetDir.
  // Prevents watcher from seeing half-written state and preserves
  // existing installation if download fails.
  const tmpDir = path.join(
    path.dirname(targetDir),
    `.tmp-${skillKey}-${Date.now()}`,
  );

  let filesWritten = 0;

  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    for (const f of files) {
      const destPath = path.resolve(tmpDir, f.path);
      const destDir = path.dirname(destPath);

      await fsp.mkdir(destDir, { recursive: true });

      const downloaded = await downloadBundleFile(f, destPath);
      if (!downloaded.ok) {
        await cleanupTempDir(tmpDir);
        return { ok: false, filesWritten, error: downloaded.error };
      }
      filesWritten++;
    }

    if (meta) {
      const metaPath = path.join(tmpDir, '.skill-meta.json');
      await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    }

    await replaceDirAtomically(tmpDir, targetDir, skillKey);

    return { ok: true, filesWritten };
  } catch (err) {
    // Catch-all: clean up temp dir
    await cleanupTempDir(tmpDir);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, filesWritten, error: msg };
  }
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

export async function uninstallSkillLocal(
  targetDir: string,
  options?: { allowLegacyGlobalForMigration?: boolean },
): Promise<boolean> {
  if (!isTargetDirSafe(targetDir, options)) return false;
  try {
    const stat = await fsp.stat(targetDir);
    if (!stat.isDirectory()) return false;
    await fsp.rm(targetDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
