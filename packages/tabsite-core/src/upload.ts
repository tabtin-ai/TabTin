/**
 * Shared dist upload logic — used by both Electron and Daemon CLI Servers.
 * Pure Node.js, no Electron dependencies.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DjangoRequestFn, DistFile, UploadDistOptions, UploadDistResult } from './types.js';

// ── Content-Type mapping ─────────────────────────────────

const CONTENT_TYPE_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

// ── File collection ──────────────────────────────────────

const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024;

export async function collectDistFiles(
  distPath: string,
): Promise<{ files: DistFile[]; skippedFiles: string[] }> {
  const files: DistFile[] = [];
  const skippedFiles: string[] = [];

  async function walk(dir: string, base: string) {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = nodePath.join(dir, entry.name);
      const relPath = nodePath.join(base, entry.name);
      const normalizedRel = relPath.replace(/\\/g, '/');
      if (normalizedRel.split('/').includes('..')) {
        skippedFiles.push(normalizedRel);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else {
        const stat = await fsPromises.stat(fullPath);
        if (stat.size > MAX_SINGLE_FILE_SIZE) {
          skippedFiles.push(`${normalizedRel} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
          continue;
        }
        files.push({ relativePath: relPath, absolutePath: fullPath, size: stat.size });
      }
    }
  }

  await walk(distPath, '');
  return { files, skippedFiles };
}

// ── CDN base URL resolution ──────────────────────────────

export function resolveCdnBaseUrl(folder: string): string {
  const cdnDomain = process.env.TABTIN_CDN_DOMAIN || process.env.ALIYUN_OSS_CDN_DOMAIN || '';
  if (cdnDomain) {
    return `https://${cdnDomain}/${folder}`;
  }
  const ossDomain = process.env.ALIYUN_OSS_ENDPOINT || process.env.TABTIN_OSS_DOMAIN || '';
  const bucket = process.env.ALIYUN_OSS_BUCKET || '';
  if (ossDomain && bucket) {
    return `https://${bucket}.${ossDomain}/${folder}`;
  }
  return '';
}

// ── Upload dist ──────────────────────────────────────────

const UPLOAD_TIMEOUT_MIN_MS = 60_000;
const UPLOAD_BYTES_PER_SEC = 50 * 1024;
const CONCURRENCY = 5;

export async function uploadDist(options: UploadDistOptions): Promise<UploadDistResult> {
  const { siteId, distPath, djangoRequest, allowedRoots, organizationId, onProgress } = options;

  if (!fs.existsSync(distPath)) {
    return { success: false, error_code: 'DIST_NOT_FOUND', error: `构建产物目录不存在: ${distPath}` };
  }

  // Path safety check
  const resolvedDist = nodePath.resolve(distPath);
  const isWithinAllowed = allowedRoots.some(
    (root) => {
      const resolved = nodePath.resolve(root);
      return resolvedDist === resolved || resolvedDist.startsWith(resolved + nodePath.sep);
    },
  );
  if (!isWithinAllowed) {
    return { success: false, error_code: 'PERMISSION_DENIED', error: 'dist_path 必须位于 TabTin 工作区或沙盒目录内' };
  }

  // Fetch site info
  const siteResult = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`);
  if (siteResult.status !== 200 || !siteResult.data?.success) {
    return { success: false, error_code: 'BACKEND_ERROR', error: siteResult.data?.message || 'Failed to fetch site info' };
  }
  const siteData = siteResult.data.data;

  const uploadId = randomUUID().slice(0, 8);
  const folder = `tabsite/sites/${siteId}/${uploadId}`;

  // Collect files
  const { files, skippedFiles } = await collectDistFiles(distPath);
  if (files.length === 0) {
    return { success: false, error_code: 'EMPTY_DIST', error: '构建产物目录为空' };
  }

  let cdnBaseUrl = resolveCdnBaseUrl(folder);
  let uploadedCount = 0;
  let totalSize = 0;
  const uploadedKeys: string[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  async function uploadOne(file: DistFile) {
    const relPath = file.relativePath.replace(/\\/g, '/');
    const baseName = nodePath.basename(relPath);
    const ext = nodePath.extname(baseName).toLowerCase();
    const contentType = CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
    const objectKey = `${folder}/${relPath}`;

    const presignResult = await djangoRequest('POST', '/api/services/oss/presign-upload', {
      filename: baseName,
      folder,
      content_type: contentType,
      file_size: file.size,
      organization_id: siteData.organization_id || organizationId,
      object_key: objectKey,
      module: 'tabsite',
      context_type: 'site',
      context_id: siteId,
      is_public: true,
    });

    if (presignResult.status !== 200 || !presignResult.data?.success) {
      throw new Error(`Presign 失败: ${relPath} — ${presignResult.data?.message || ''}`);
    }

    const presignData = presignResult.data.data;
    if (!presignData.instant) {
      const fileBuffer = await fsPromises.readFile(file.absolutePath);
      const dynamicTimeoutMs = Math.max(UPLOAD_TIMEOUT_MIN_MS, Math.ceil(file.size / UPLOAD_BYTES_PER_SEC) * 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), dynamicTimeoutMs);
      try {
        const putResp = await fetch(presignData.presigned_url, {
          method: 'PUT',
          headers: { 'Content-Type': presignData.content_type || contentType },
          body: fileBuffer,
          signal: controller.signal,
        });
        if (!putResp.ok) {
          throw new Error(`OSS PUT 失败: ${relPath} (HTTP ${putResp.status})`);
        }
      } finally {
        clearTimeout(timer);
      }

      const confirmResult = await djangoRequest('POST', '/api/services/oss/confirm-upload', {
        object_key: presignData.object_key,
        file_name: baseName,
        file_size: file.size,
        content_type: contentType,
        module: 'tabsite',
        context_type: 'site',
        context_id: siteId,
        organization_id: siteData.organization_id || organizationId,
        is_public: true,
      });
      if (confirmResult.status !== 200 || !confirmResult.data?.success) {
        throw new Error(`Confirm 失败: ${relPath} — ${confirmResult.data?.message || ''}`);
      }
    }

    uploadedKeys.push(presignData.object_key || objectKey);

    if (!cdnBaseUrl) {
      const url = presignData.cdn_url || presignData.access_url || '';
      if (url) {
        try {
          const urlObj = new URL(url);
          cdnBaseUrl = `${urlObj.origin}/${folder}`;
        } catch { /* ignore malformed URLs */ }
      }
    }

    uploadedCount++;
    totalSize += file.size;
  }

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(uploadOne));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'rejected') {
        failedFiles.push({
          path: batch[j].relativePath,
          error: r.reason?.message || String(r.reason),
        });
      }
    }
    const done = Math.min(i + CONCURRENCY, files.length);
    onProgress?.(done, files.length);
    if (files.length > CONCURRENCY) {
      console.log(`[TabSite] 上传进度: ${done}/${files.length}`);
    }
  }

  if (failedFiles.length > 0 && uploadedCount === 0) {
    return {
      success: false,
      error_code: 'UPLOAD_FAILED',
      error: `全部 ${failedFiles.length} 个文件上传失败`,
      detail: { failed_files: failedFiles, total_files: files.length, skipped_files: skippedFiles },
    };
  }

  const distUrl = cdnBaseUrl ? `${cdnBaseUrl}/` : '';
  if (!distUrl) {
    return {
      success: false,
      error_code: 'BACKEND_ERROR',
      error: '上传成功但无法推导 dist_url，请检查 CDN/OSS 域名环境变量（TABTIN_CDN_DOMAIN 或 ALIYUN_OSS_CDN_DOMAIN）',
      detail: { uploaded_keys: uploadedKeys, uploaded_count: uploadedCount },
    };
  }

  return {
    success: true,
    dist_url: distUrl,
    file_count: uploadedCount,
    total_size: totalSize,
    ...(skippedFiles.length > 0 ? { skipped_files: skippedFiles } : {}),
    ...(failedFiles.length > 0 ? { failed_files: failedFiles } : {}),
  };
}
