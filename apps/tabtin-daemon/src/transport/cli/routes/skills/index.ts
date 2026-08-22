/**
 * Skills route handler for Daemon CLI Server.
 *
 * Wave 1：安装主契约与 Electron 对齐——
 *   云端 `POST /skills/{canonicalKey}/enable|disable`
 *   设备端 enable 成功后物化本地文件（app → materializeAppSkill；
 *   user+package_id → Package Registry 下载）。
 *
 * 旧 `POST /managed/install` / `DELETE /managed/{key}` 已随 Django 下线，
 * 本路由不再识别它们。
 */

import http from 'node:http';
import nodePath from 'node:path';
import { SkillsApplication } from '../../../../application/skills/index.js';
import type { CliRequestContext } from '../../cli-context.js';
import { djangoRequest, errorResponse, sendDjangoResult, type SendJSON } from '../shared/error-handler.js';
import { handleSkillImport, handleSkillInstallNpm } from './import-npm.js';

const LOG_TAG = '[CLI Skills]';

function fullyDecodeURIComponent(str: string): string {
  let prev = str;
  for (;;) {
    try {
      const decoded = decodeURIComponent(prev);
      if (decoded === prev) return decoded;
      prev = decoded;
    } catch {
      return prev;
    }
  }
}

function normalizeIdField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** ：优先从 body 读 organization_id；缺失时回退 CLI context 的活跃组织。 */
function getBodyOrganizationId(body: any, cliContext: CliRequestContext): string | null {
  return (
    normalizeIdField(body?.organization_id) ??
    normalizeIdField(body?.organizationId) ??
    normalizeIdField(cliContext.getOrganizationId())
  );
}

/** 兼容：本地物化仍用 spaceId 定位 sandbox。 */
function getBodySpaceId(body: any): string | null {
  return normalizeIdField(body?.space_id) ?? normalizeIdField(body?.spaceId);
}

function missingOrganizationResponse(action: 'enable' | 'disable') {
  const verb = action === 'enable' ? '启用' : '禁用';
  return errorResponse('VALIDATION_ERROR', `缺少有效的 organization_id，无法${verb} skill`, {
    suggestions: [
      '请在请求中传入当前 Organization 的 organization_id',
      '或先通过 `tabtin auth login` / 环境变量设置活跃组织',
    ],
  });
}

function withCanonicalOrganizationId(body: any, organizationId: string): any {
  if (!body || typeof body !== 'object') {
    return { organization_id: organizationId };
  }
  const next = { ...body, organization_id: organizationId };
  delete next.space_id;
  delete next.spaceId;
  return next;
}

function matchEnableDisable(
  method: string,
  normalized: string,
): { action: 'enable' | 'disable'; canonicalKey: string } | null {
  if (method !== 'POST') return null;
  const m = /^\/(.+)\/(enable|disable)$/.exec(normalized);
  if (!m) return null;
  const canonicalKey = fullyDecodeURIComponent(m[1]);
  if (!canonicalKey || canonicalKey.includes('..')) return null;
  return { action: m[2] as 'enable' | 'disable', canonicalKey };
}

export async function handleSkillsRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const route = url.replace(/^\/skills/, '');

  if (route && route !== '/') {
    const routeParts = normalizeSkillsRoute(route);
    if (!routeParts) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '非法路由路径'));
      return;
    }
    if (await handleLocalSkillsRoute(routeParts.normalized, method, body, res, sendJSON, cliContext)) return;

    const enableDisable = matchEnableDisable(method, routeParts.normalized);
    // ：Django enable/disable 锚点从 space_id 迁到 organization_id。
    const organizationId = enableDisable ? getBodyOrganizationId(body, cliContext) : null;
    const spaceId = enableDisable ? getBodySpaceId(body) : null;

    if (enableDisable && !organizationId) {
      sendJSON(res, 400, missingOrganizationResponse(enableDisable.action));
      return;
    }

    const djangoBody = enableDisable && organizationId
      ? withCanonicalOrganizationId(body, organizationId)
      : body;
    const djangoPath = `/api/skills${routeParts.normalized}${routeParts.queryPart}`;
    const result = await djangoRequest(method, djangoPath, djangoBody, { logTag: LOG_TAG });

    if (enableDisable && organizationId && result.status >= 200 && result.status < 300) {
      await applyLocalEnablement(enableDisable, spaceId, djangoBody, result, cliContext);
    }

    sendDjangoResult(res, sendJSON, result);
    return;
  }

  sendJSON(
    res,
    404,
    errorResponse('UNKNOWN_ROUTE', `未知的 Skill 路由: ${url}`, {
      suggestions: ['请检查命令拼写', '使用 tabtin skill --help 查看可用命令'],
    }),
  );
}

function normalizeSkillsRoute(route: string): { normalized: string; queryPart: string } | null {
  const queryIndex = route.indexOf('?');
  const pathPart = queryIndex >= 0 ? route.substring(0, queryIndex) : route;
  const queryPart = queryIndex >= 0 ? route.substring(queryIndex) : '';
  const decoded = fullyDecodeURIComponent(pathPart);
  if (decoded.includes('..') || !decoded.startsWith('/')) return null;
  const normalized = nodePath.posix.normalize(decoded);
  return normalized.includes('..') || !normalized.startsWith('/') ? null : { normalized, queryPart };
}

async function handleLocalSkillsRoute(normalized: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON, cliContext: CliRequestContext): Promise<boolean> {
  if (method !== 'POST') return false;
  if (normalized === '/import') {
    await handleSkillImport({ body, organizationId: cliContext.getOrganizationId(), sendJSON, res, cliContext });
    return true;
  }
  if (normalized !== '/install-npm' && normalized !== '/npm-install') return false;
  const adder = cliContext.getSkillsInteropAdder();
  await handleSkillInstallNpm({ body, organizationId: cliContext.getOrganizationId(), sendJSON, res, addInteropRoot: adder ?? undefined, cliContext });
  return true;
}

async function applyLocalEnablement(enableDisable: { action: 'enable' | 'disable'; canonicalKey: string }, spaceId: string | null, djangoBody: any, result: any, cliContext: CliRequestContext): Promise<void> {
  try {
    if (!spaceId) {
      if (enableDisable.action === 'enable') console.log(`${LOG_TAG} skip local materialize: no space_id in body (canonicalKey=${enableDisable.canonicalKey})`);
      return;
    }
    const application = createSkillsApplication(cliContext);
    if (enableDisable.action === 'enable') {
      await application.materializeEnabled({ canonicalKey: enableDisable.canonicalKey, djangoData: result.data, spaceId });
    } else {
      await application.cleanupDisabled({ canonicalKey: enableDisable.canonicalKey, remove: djangoBody?.remove === true });
    }
  } catch (err) {
    mergeLocalEnablementWarning(result, enableDisable.action, err);
  }
}

function createSkillsApplication(cliContext: CliRequestContext): SkillsApplication {
  return new SkillsApplication({
    organizationId: cliContext.getOrganizationId() ?? undefined,
    requireUserId: () => cliContext.requireUserId(),
    request: (method, path, body) => djangoRequest(method, path, body, { logTag: LOG_TAG }),
    materializeApp: async (input) => {
      const materializer = cliContext.getSkillsMaterializer();
      if (!materializer) throw new Error('Skill materializer 未注入（DaemonAgentHost 未就绪）');
      return materializer(input);
    },
  });
}

function mergeLocalEnablementWarning(result: any, action: 'enable' | 'disable', err: unknown): void {
  console.warn(`${LOG_TAG} local materialize/cleanup error (not fatal):`, err);
  const errMsg = err instanceof Error ? err.message : String(err);
  const rawResult: any = result.data;
  const rawInner: any = rawResult && typeof rawResult === 'object' && 'data' in rawResult
    ? (rawResult as { data?: unknown }).data ?? rawResult : rawResult;
  const merged = {
    ...(typeof rawInner === 'object' && rawInner ? rawInner : {}),
    warning: action === 'enable' ? `local_install:failed ${errMsg}` : `local_uninstall:failed ${errMsg}`,
    detail: { local_install: action === 'enable' ? 'failed' : undefined, local_uninstall: action === 'disable' ? 'failed' : undefined, error_message: errMsg },
  };
  result.data = rawResult && typeof rawResult === 'object' && 'ok' in rawResult ? { ...rawResult, data: merged } : merged;
}
