/**
 * TabSite route handler for Daemon CLI Server.
 *
 * Full-featured version that supports init-template and upload-dist
 * via @tabtin/tabsite-core shared utilities.
 *
 * Routes:
 *   POST  /site/create             → POST   /api/tabsite/sites/
 *   GET   /site/list               → GET    /api/tabsite/sites/
 *   GET   /site/info/:id           → GET    /api/tabsite/sites/:id/
 *   PATCH /site/update/:id         → PATCH  /api/tabsite/sites/:id/
 *   POST  /site/publish/:id        → POST   /api/tabsite/sites/:id/publish/
 *   POST  /site/rollback/:id/:ver  → POST   /api/tabsite/sites/:id/rollback/:ver/
 *   GET   /site/build-info/:id     → GET    /api/tabsite/sites/:id/ (extract metadata)
 *   POST  /site/init-template/:id  → copy template → PATCH /api/tabsite/sites/:id/
 *   POST  /site/upload-dist/:id    → presign + upload → return dist_url
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliRequestContext } from '../../cli-context.js';
import { djangoRequest, errorResponse, okResponse, sendDjangoResult, type SendJSON } from '../shared/error-handler.js';
import { initTemplate, uploadDist } from '@tabtin/tabsite-core';
import { resolveDataRoot, resolveSpacesRoot } from '@tabtin/terminal-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getSpaceId(body?: any): string | null {
  if (body?.space_id) return body.space_id;
  return null;
}

function getOrganizationId(body?: any): string | null {
  return body?.organization_id || null;
}

function getTemplateSearchPaths(): string[] {
  const paths: string[] = [];
  // 1. Bundled alongside daemon binary
  paths.push(path.join(__dirname, '..', 'tabsite-templates'));
  paths.push(path.join(__dirname, '..', '..', 'tabsite-templates'));
  // 2. Monorepo development — cwd-based (also checked by tabsite-core as fallback)
  paths.push(path.join(process.cwd(), 'packages', 'tabsite-templates'));
  // 3. Ancestor traversal from __dirname
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, 'packages', 'tabsite-templates');
    if (!paths.includes(candidate)) {
      paths.push(candidate);
    }
  }
  return paths;
}

// ── Route handler ────────────────────────────────────────

export async function handleTabsiteRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  body = { ...body, space_id: body?.space_id || cliContext.getSpaceId(), organization_id: body?.organization_id || cliContext.getOrganizationId() };
  const route = url.replace(/^\/site/, '');
  const matchers: ReadonlyArray<readonly [RegExp, string | null, (match: RegExpMatchArray) => Promise<void>]> = [
    [/^\/init-template\/([^/]+)$/, 'POST', match => handleInitTemplate(match[1], body, res, sendJSON, cliContext)],
    [/^\/upload-dist\/([^/]+)$/, 'POST', match => handleUploadDist(match[1], body, res, sendJSON, cliContext)],
    [/^\/build-info\/([^/]+)$/, null, match => handleBuildInfo(match[1], res, sendJSON)],
    [/^\/create$/, 'POST', () => handleCreateSite(body, res, sendJSON)],
    [/^\/list$/, null, () => handleListSites(method, body, res, sendJSON)],
    [/^\/update\/([^/]+)$/, 'PATCH', match => handleUpdateSite(match[1], body, res, sendJSON)],
    [/^\/info\/([^/]+)$/, null, match => handleSiteInfo(match[1], method, res, sendJSON)],
    [/^\/publish\/([^/]+)$/, 'POST', match => handlePublishSite(match[1], body, res, sendJSON)],
    [/^\/rollback\/([^/]+)\/([^/]+)$/, 'POST', match => handleRollbackSite(match[1], match[2], res, sendJSON)],
  ];
  const matched = matchers.map(([pattern, expectedMethod, handler]) => ({ match: route.match(pattern), expectedMethod, handler })).find(item => item.match && (!item.expectedMethod || item.expectedMethod === method));
  if (matched?.match) { await matched.handler(matched.match); return; }
  sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown site route: ${url}`));
}

async function handleInitTemplate(siteId: string, body: any, res: http.ServerResponse, sendJSON: SendJSON, cliContext: CliRequestContext): Promise<void> {
  const spaceId = getSpaceId(body);
  if (!spaceId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id')); return; }
  try {
    const organizationId = cliContext.getOrganizationId();
    if (!organizationId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id（ hard-cut — 禁止 _unscoped）')); return; }
    const result = await initTemplate({ siteId, spaceId, organizationId, userId: cliContext.requireUserId(), djangoRequest, dataRoot: resolveDataRoot(), templateSearchPaths: getTemplateSearchPaths() });
    if (!result.success) {
      const status = result.status || 500;
      sendJSON(res, status, status === 404 ? errorResponse('NOT_FOUND', result.error || '模板未找到') : errorResponse('INTERNAL_ERROR', result.error || '模板初始化失败', result.data ? { detail: result.data } : undefined));
      return;
    }
    sendJSON(res, 200, okResponse(result.data));
  } catch (err: any) {
    console.error('[TabSite Daemon] init-template error:', err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', `模板初始化失败: ${err.message}`));
  }
}

async function handleUploadDist(siteId: string, body: any, res: http.ServerResponse, sendJSON: SendJSON, cliContext: CliRequestContext): Promise<void> {
  const distPath = body?.dist_path;
  if (!distPath) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 dist_path')); return; }
  try {
    const allowedRoots = [resolveSpacesRoot(), resolveDataRoot()];
    const organizationRoot = cliContext.getOrganizationRoot();
    if (organizationRoot) allowedRoots.push(organizationRoot);
    const result = await uploadDist({ siteId, distPath, djangoRequest, allowedRoots, organizationId: getOrganizationId(body) });
    if (!result.success) {
      const statuses: Record<string, number> = { DIST_NOT_FOUND: 400, PERMISSION_DENIED: 403, EMPTY_DIST: 400, UPLOAD_FAILED: 500, UNAVAILABLE: 500 };
      sendJSON(res, statuses[result.error_code || ''] || 500, errorResponse(result.error_code || 'INTERNAL_ERROR', result.error || '上传失败', result.detail ? { detail: result.detail } : undefined));
      return;
    }
    sendJSON(res, 200, okResponse(result));
  } catch (err: any) {
    console.error('[TabSite Daemon] upload-dist error:', err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', `上传失败: ${err.message}`));
  }
}

async function handleBuildInfo(siteId: string, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  const result = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`);
  if (result.status >= 400) { sendDjangoResult(res, sendJSON, result); return; }
  const site = result.data?.data ?? result.data;
  sendJSON(res, 200, okResponse({ id: site?.id, name: site?.name, code_project_path: site?.code_project_path || null, framework: site?.framework, upload_available: true }));
}

async function handleCreateSite(body: any, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  const spaceId = getSpaceId(body);
  const organizationId = getOrganizationId(body);
  if (!spaceId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id')); return; }
  if (!organizationId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id')); return; }
  if (!body?.name) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name')); return; }
  const result = await djangoRequest('POST', '/api/tabsite/sites/', { organization_id: organizationId, space_id: spaceId, name: body.name, description: body.description || '', framework: body.framework || 'react', template: body.template || 'blank' });
  sendDjangoResult(res, sendJSON, result);
}

async function handleListSites(method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  if (method !== 'GET') { sendJSON(res, 405, errorResponse('VALIDATION_ERROR', '/list 仅支持 GET 请求')); return; }
  const spaceId = getSpaceId(body);
  const organizationId = getOrganizationId(body);
  if (!spaceId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id')); return; }
  if (!organizationId) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id')); return; }
  const query: Record<string, string> = { organization_id: organizationId, space_id: spaceId };
  if (body?.status) query.status = body.status;
  if (body?.page) query.page = String(body.page);
  if (body?.page_size) query.page_size = String(body.page_size);
  sendDjangoResult(res, sendJSON, await djangoRequest('GET', `/api/tabsite/sites/?${new URLSearchParams(query)}`));
}

async function handleUpdateSite(siteId: string, body: any, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  if (!body || Object.keys(body).length === 0) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '至少需要提供一个要更新的字段')); return; }
  sendDjangoResult(res, sendJSON, await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, body));
}

async function handleSiteInfo(siteId: string, method: string, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  if (method !== 'GET') { sendJSON(res, 405, errorResponse('VALIDATION_ERROR', '/info 仅支持 GET 请求')); return; }
  sendDjangoResult(res, sendJSON, await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`));
}

async function handlePublishSite(siteId: string, body: any, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  if (!body?.dist_url) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '必须提供 dist_url 参数。请先执行构建并上传，或手动提供产物地址。')); return; }
  const result = await djangoRequest('POST', `/api/tabsite/sites/${siteId}/publish/`, { message: body?.message || '', dist_url: body.dist_url, file_count: body?.file_count ?? 0, total_size: body?.total_size ?? 0 });
  sendDjangoResult(res, sendJSON, result);
}

async function handleRollbackSite(siteId: string, versionStr: string, res: http.ServerResponse, sendJSON: SendJSON): Promise<void> {
  const version = parseInt(versionStr, 10);
  if (Number.isNaN(version) || version < 1) { sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'version 必须是正整数')); return; }
  sendDjangoResult(res, sendJSON, await djangoRequest('POST', `/api/tabsite/sites/${siteId}/rollback/${version}/`));
}
