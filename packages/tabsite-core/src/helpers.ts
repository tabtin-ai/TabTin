/**
 * Shared TabSite helpers — pure Node.js, no Electron dependencies.
 * Used by both Electron CLI Server and Daemon CLI Server.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceSiteDir } from '@tabtin/terminal-core';
import type { CopyDirOptions, DjangoRequestFn, InitTemplateOptions, ProvisionOptions, ProvisionResult } from './types.js';

// ── Path sanitization ────────────────────────────────────

const MAX_SEGMENT_LENGTH = 128;

export function sanitizePathSegment(segment: string): string {
  let s = segment.trim();
  s = s.replace(/\0/g, '');
  s = s.replace(/[/\\]/g, '_');
  s = s.replace(/\.\./g, '_');
  s = s.replace(/^\.+/, '');
  if (s.length > MAX_SEGMENT_LENGTH) {
    s = s.slice(0, MAX_SEGMENT_LENGTH);
  }
  return s || 'default';
}

// ── Template resolution ──────────────────────────────────

const ALLOWED_TEMPLATE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Resolve template directory from a list of candidate search paths.
 * Each candidate is expected to be a directory containing the template
 * (i.e. `{candidate}/package.json` must exist).
 *
 * Callers provide the candidate list — Electron adds `process.resourcesPath`,
 * Daemon adds `__dirname`-relative paths, etc.
 */
export function resolveTemplatePath(
  templateName: string,
  searchPaths: string[],
): string | null {
  if (!templateName || !ALLOWED_TEMPLATE_PATTERN.test(templateName)) {
    return null;
  }

  const candidates = searchPaths.map((base) =>
    path.join(base, templateName),
  );

  // Also try cwd-based resolution as fallback
  const cwdCandidate = path.join(process.cwd(), 'packages', 'tabsite-templates', templateName);
  if (!candidates.includes(cwdCandidate)) {
    candidates.push(cwdCandidate);
  }

  for (const p of candidates) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'package.json'))) {
      return p;
    }
  }
  return null;
}

// ── Directory copy ───────────────────────────────────────

const DEFAULT_SKIP = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', '.env', '.env.local',
  '.next', '.turbo', '.cache',
]);

export async function copyDirSafe(
  src: string,
  dest: string,
  options?: CopyDirOptions,
): Promise<void> {
  const skip = options?.extraSkip?.length
    ? new Set([...DEFAULT_SKIP, ...options.extraSkip])
    : DEFAULT_SKIP;

  await fsPromises.mkdir(dest, { recursive: true });
  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirSafe(srcPath, destPath, options);
    } else {
      try {
        await fsPromises.copyFile(srcPath, destPath);
      } catch (err: any) {
        throw new Error(`复制文件失败 ${srcPath} → ${destPath}: ${err.message}`);
      }
    }
  }
}

// ── Token validation ─────────────────────────────────────

export function hasValidTokenInEnvFile(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    if (trimmed.startsWith('VITE_TABTIN_TOKEN=')) {
      const value = trimmed.slice('VITE_TABTIN_TOKEN='.length).trim();
      return value.length > 0;
    }
  }
  return false;
}

// ── Token provisioning ───────────────────────────────────

export async function provisionTokenAndWriteEnv(
  siteId: string,
  projectPath: string,
  djangoRequest: DjangoRequestFn,
  options?: ProvisionOptions,
): Promise<ProvisionResult> {
  try {
    const body = options?.force ? { force: true } : undefined;
    const tokenResult = await djangoRequest(
      'POST',
      `/api/tabsite/sites/${siteId}/provision-token/`,
      body,
    );
    if (tokenResult.status !== 200 || !tokenResult.data?.success) {
      return { tokenProvisioned: false, error: tokenResult.data?.message || 'provision failed' };
    }
    const envData = tokenResult.data.data;
    const newVars: Record<string, string> = {};
    if (envData.VITE_TABTIN_API_URL) newVars.VITE_TABTIN_API_URL = envData.VITE_TABTIN_API_URL;
    if (envData.VITE_TABTIN_TOKEN) newVars.VITE_TABTIN_TOKEN = envData.VITE_TABTIN_TOKEN;
    if (envData.VITE_TABTIN_SPACE_ID) newVars.VITE_TABTIN_SPACE_ID = envData.VITE_TABTIN_SPACE_ID;
    if (envData.VITE_TABTIN_TABLE_ID) newVars.VITE_TABTIN_TABLE_ID = envData.VITE_TABTIN_TABLE_ID;
    if (Object.keys(newVars).length > 0) {
      const envPath = path.join(projectPath, '.env.local');
      const existing: Record<string, string> = {};
      try {
        const content = await fsPromises.readFile(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            existing[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
          }
        }
      } catch {
        // file doesn't exist yet
      }
      const merged = { ...existing, ...newVars };
      const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
      await fsPromises.writeFile(envPath, lines.join('\n') + '\n', 'utf-8');
    }
    const hasNewToken = !!envData.VITE_TABTIN_TOKEN;
    if (hasNewToken) {
      return {
        tokenProvisioned: true,
        tokenExpiresSoon: !!envData.token_expires_soon,
      };
    }

    const envFilePath = path.join(projectPath, '.env.local');
    try {
      const existingContent = await fsPromises.readFile(envFilePath, 'utf-8');
      if (hasValidTokenInEnvFile(existingContent)) {
        return {
          tokenProvisioned: true,
          tokenAlreadyExists: true,
          tokenExpiresSoon: !!envData.token_expires_soon,
        };
      }
    } catch { /* file doesn't exist */ }

    return {
      tokenProvisioned: false,
      tokenAlreadyExists: true,
      error: 'Token 已存在但未返回明文，.env.local 中缺少 Token，请使用 force 模式重新签发',
    };
  } catch (err: any) {
    return { tokenProvisioned: false, error: err?.message };
  }
}

// ── workspace:* dependency fix ───────────────────────────

/**
 * Post-copy处理：将 package.json 中的 workspace:* 依赖替换为实际版本号。
 * 解决模板被拷贝到沙箱后脱离 monorepo 上下文导致 pnpm install 失败的问题。
 */
export async function fixWorkspaceDeps(projectPath: string): Promise<string[]> {
  const pkgPath = path.join(projectPath, 'package.json');
  const fixed: string[] = [];
  try {
    const content = await fsPromises.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    let changed = false;

    for (const depType of ['dependencies', 'devDependencies'] as const) {
      const deps = pkg[depType];
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          deps[name] = '^0.1.0';
          fixed.push(`${name}: ${version} → ^0.1.0`);
          changed = true;
        }
      }
    }

    if (changed) {
      await fsPromises.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    }
  } catch {
    // package.json doesn't exist or is invalid
  }
  return fixed;
}

// ── Init template (full flow) ────────────────────────────

export async function initTemplate(options: InitTemplateOptions): Promise<{
  success: boolean;
  data?: Record<string, any>;
  error?: string;
  status?: number;
}> {
  const { siteId, spaceId, organizationId, userId, djangoRequest, dataRoot, templateSearchPaths } = options;

  const siteResult = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`);
  if (siteResult.status !== 200 || !siteResult.data?.success) {
    return { success: false, error: siteResult.data?.error?.message || 'Failed to fetch site', status: siteResult.status };
  }
  const siteData = siteResult.data.data;

  const safeSpaceId = sanitizePathSegment(spaceId);
  const safeSlug = sanitizePathSegment(siteData.slug || siteId);
  const projectPath = resolveWorkspaceSiteDir(dataRoot, userId, organizationId, safeSpaceId, safeSlug);

  // Already exists — patch path if needed, provision token for dashboard
  if (fs.existsSync(projectPath) && fs.readdirSync(projectPath).length > 0) {
    if (!siteData.code_project_path) {
      const patchRes = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
        code_project_path: projectPath,
      });
      if (patchRes.status !== 200 || !patchRes.data?.success) {
        return {
          success: false,
          error: `目录已存在但更新站点信息失败: ${patchRes.data?.error || patchRes.status}`,
          data: { code_project_path: projectPath },
        };
      }
    }

    let tokenProvisioned = false;
    let tokenWarning: string | undefined;
    let tokenExpiresSoon: boolean | undefined;
    const existsTemplate = siteData.template || 'blank';
    if (existsTemplate === 'dashboard') {
      const envPath = path.join(projectPath, '.env.local');
      let hasToken = false;
      try {
        const content = await fsPromises.readFile(envPath, 'utf-8');
        hasToken = hasValidTokenInEnvFile(content);
      } catch { /* file doesn't exist */ }
      if (!hasToken) {
        const result = await provisionTokenAndWriteEnv(siteId, projectPath, djangoRequest, { force: true });
        tokenProvisioned = result.tokenProvisioned;
        tokenExpiresSoon = result.tokenExpiresSoon;
        if (!tokenProvisioned) {
          tokenWarning = result.error || 'Token 恢复失败，站点数据功能可能不可用';
        }
      } else {
        tokenProvisioned = true;
      }
    }

    return {
      success: true,
      data: {
        code_project_path: projectPath,
        already_exists: true,
        token_provisioned: tokenProvisioned,
        ...(tokenWarning && { token_warning: tokenWarning }),
        ...(tokenExpiresSoon && { token_expires_soon: true }),
      },
    };
  }

  // New template — copy, patch, provision
  const template = siteData.template || 'blank';
  const templateDir = resolveTemplatePath(template, templateSearchPaths);
  if (!templateDir) {
    return { success: false, error: `模板 "${template}" 未找到`, status: 404 };
  }

  await fsPromises.mkdir(projectPath, { recursive: true });
  try {
    await copyDirSafe(templateDir, projectPath);
  } catch (copyErr: any) {
    await fsPromises.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    return { success: false, error: `模板复制失败: ${copyErr.message}`, status: 500 };
  }

  // Fix workspace:* dependencies after copy
  await fixWorkspaceDeps(projectPath);

  const patchResult = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
    code_project_path: projectPath,
  });
  if (patchResult.status !== 200 || !patchResult.data?.success) {
    return {
      success: false,
      error: `模板已复制到 ${projectPath}，但更新站点信息失败: ${patchResult.data?.error || patchResult.status}`,
      data: { code_project_path: projectPath },
    };
  }

  let tokenProvisioned = false;
  let tokenWarning: string | undefined;
  let tokenExpiresSoon: boolean | undefined;
  if (template === 'dashboard') {
    const result = await provisionTokenAndWriteEnv(siteId, projectPath, djangoRequest);
    tokenProvisioned = result.tokenProvisioned;
    tokenExpiresSoon = result.tokenExpiresSoon;
    if (!tokenProvisioned) {
      tokenWarning = result.error || 'Token 配置失败，站点数据功能可能不可用';
    }
  }

  return {
    success: true,
    data: {
      code_project_path: projectPath,
      template,
      token_provisioned: tokenProvisioned,
      ...(tokenWarning && { token_warning: tokenWarning }),
      ...(tokenExpiresSoon && { token_expires_soon: true }),
    },
  };
}
