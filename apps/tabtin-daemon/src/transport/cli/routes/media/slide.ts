/**
 * Slide route handler for Daemon CLI Server.
 *
 * Proxies all requests to Django TabSlide API (/api/tabslide/).
 */

import http from 'node:http';
import type { CliRequestContext } from '../../cli-context.js';
import { djangoRequest, errorResponse, sendDjangoResult, type SendJSON } from '../shared/error-handler.js';

function getSpaceId(body?: any): string | null {
  if (body?.space_id) return body.space_id;
  return null;
}

function getOrganizationId(body?: any): string | null {
  return body?.organization_id || null;
}

function extractDjangoData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const envelope = data as { data?: unknown };
  return envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : data as Record<string, unknown>;
}

function pageCountFromOutline(data: unknown): number | null {
  const outline = extractDjangoData(data);
  const pages = outline?.pages;
  return Array.isArray(pages) ? pages.length : null;
}

function pageIdsFromOutline(data: unknown): string[] | null {
  const outline = extractDjangoData(data);
  const pages = outline?.pages;
  if (!Array.isArray(pages)) return null;
  return pages
    .map((page: unknown) => (
      page && typeof page === 'object' ? (page as { id?: unknown; page_id?: unknown }) : null
    ))
    .map(page => page?.id || page?.page_id)
    .filter((pageId): pageId is string => typeof pageId === 'string' && pageId.length > 0);
}

function isDjangoSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function getAfterPageId(body: any): string | undefined {
  const value = body.after_page || body.after_page_id;
  return typeof value === 'string' ? value : undefined;
}

export async function handleSlideRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  body = { ...body, space_id: body?.space_id || cliContext.getSpaceId(), organization_id: body?.organization_id || cliContext.getOrganizationId() };
  const route = url.replace(/^\/slide/, '');

  if (route === '/create' && method === 'POST') {
    const createInput = validateCreateInput(body, res, sendJSON);
    if (!createInput) return;
    const { spaceId, organizationId, hasHtml } = createInput;

    const result = await djangoRequest('POST', '/api/tabslide/projects/', {
      organization_id: organizationId,
      space_id: spaceId,
      name: body.name,
      preset: body.preset || 'ppt',
      //  canvas 统一：默认 1280×720，与 html-spec / PPTX EMU 1:1
      canvas_width: body.canvas_width || 1280,
      canvas_height: body.canvas_height || 720,
    });
    if (!isDjangoSuccess(result.status)) {
      sendDjangoResult(res, sendJSON, result);
      return;
    }

    if (!hasHtml) {
      sendDjangoResult(res, sendJSON, result);
      return;
    }

    const project = extractDjangoData(result.data);
    const projectId = project?.id;
    if (!projectId) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '创建演示文稿成功但未返回 project id'));
      return;
    }

    const generateResult = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/create-slides/`,
      {
        html: body.html,
        title: body.title || body.name,
        mode: body.mode || 'direct',
        //  render 链路：图片 data:base64 内嵌、不上传 OSS（临时渲染项目专用）
        inline_images: body.inline_images === true,
      },
      { timeout: 120_000 },
    );
    if (!isDjangoSuccess(generateResult.status)) {
      await djangoRequest('DELETE', `/api/tabslide/projects/${projectId}/`);
    }
    sendDjangoResult(res, sendJSON, generateResult);
    return;
  }

  return handleSlideReadRoutes(url, method, body, res, sendJSON);
}

function validateCreateInput(body: any, res: http.ServerResponse, sendJSON: SendJSON): {
  spaceId: string; organizationId: string; hasHtml: boolean;
} | null {
  const spaceId = getSpaceId(body);
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'));
    return null;
  }
  const organizationId = getOrganizationId(body);
  if (!organizationId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'));
    return null;
  }
  const hasHtml = body?.html !== undefined && body.html !== null;
  if (hasHtml && (typeof body.html !== 'string' || body.html.trim() === '')) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'html 内容不能为空'));
    return null;
  }
  return { spaceId, organizationId, hasHtml };
}

async function handleSlideReadRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/list') {
    const spaceId = getSpaceId(body);
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'));
      return;
    }
    const organizationId = getOrganizationId(body);
    if (!organizationId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'));
      return;
    }

    const result = await djangoRequest(
      'GET',
      `/api/tabslide/projects/?organization_id=${organizationId}&space_id=${spaceId}`,
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  const outlineMatch = route.match(/^\/outline\/([^/]+)$/);
  if (outlineMatch) {
    const projectId = outlineMatch[1];
    const result = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`);
    sendDjangoResult(res, sendJSON, result);
    return;
  }
  if (route === '/outline' && body?.project_id) {
    const result = await djangoRequest('GET', `/api/tabslide/projects/${body.project_id}/page-outline/`);
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  const pageMatch = route.match(/^\/page\/([^/]+)\/([^/]+)$/);
  if (pageMatch) {
    const [, projectId, pageId] = pageMatch;
    const result = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/pages/${pageId}/`);
    sendDjangoResult(res, sendJSON, result);
    return;
  }
  if (route === '/page' && body?.project_id && body?.page_id) {
    const result = await djangoRequest('GET', `/api/tabslide/projects/${body.project_id}/pages/${body.page_id}/`);
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideGenerateRoutes(url, method, body, res, sendJSON);
}

async function handleSlideGenerateRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/generate' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }
    if (!body?.html) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 html 内容'));
      return;
    }
    if (!body.replace) {
      const outlineResult = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`);
      if (!isDjangoSuccess(outlineResult.status)) {
        sendDjangoResult(res, sendJSON, outlineResult);
        return;
      }
      const pageCount = pageCountFromOutline(outlineResult.data);
      if (pageCount === null) {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '无法读取项目页面列表，已拒绝覆盖生成'));
        return;
      }
      if (pageCount !== null && pageCount > 0) {
        sendJSON(
          res,
          409,
          errorResponse(
            'VALIDATION_ERROR',
            'slide generate 会覆盖当前项目全部页面；如需插入 HTML 页，请使用 slide add-page --html；如确认要覆盖，请加 --replace',
          ),
        );
        return;
      }
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/create-slides/`,
      { html: body.html, title: body.title, mode: body.mode || 'direct' },
      { timeout: 120_000 },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideProjectUpdateRoute(url, method, body, res, sendJSON);
}

async function handleSlideProjectUpdateRoute(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/update-project' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }
    const payload: Record<string, unknown> = {};
    if (body.name != null) payload.name = body.name;
    if (body.preset != null) payload.preset = body.preset;
    if (body.canvas_width != null) payload.canvas_width = body.canvas_width;
    if (body.canvas_height != null) payload.canvas_height = body.canvas_height;
    if (body.theme != null) payload.theme = body.theme;
    if (body.thumbnail != null) payload.thumbnail = body.thumbnail;

    if (Object.keys(payload).length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '至少需要提供一个要更新的字段（name/preset/theme 等）'));
      return;
    }

    const result = await djangoRequest(
      'PATCH',
      `/api/tabslide/projects/${projectId}/`,
      payload,
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideElementRoutes(url, method, body, res, sendJSON);
}

async function handleSlideElementRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/update' && method === 'POST') {
    const { project_id, page_id, element_id, patch, base_version } = body || {};
    if (!project_id || !page_id || !element_id) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id / page_id / element_id'));
      return;
    }
    if (!patch || typeof patch !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 patch 对象'));
      return;
    }

    const result = await djangoRequest(
      'PATCH',
      `/api/tabslide/projects/${project_id}/pages-by-id/${page_id}/elements/${element_id}/`,
      { patch, base_version },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideBatchUpdateRoute(url, method, body, res, sendJSON);
}

async function handleSlideBatchUpdateRoute(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/batch-update' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }
    if (!body?.updates || !Array.isArray(body.updates)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 updates 数组'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/batch-update-elements/`,
      { updates: body.updates, base_version: body.base_version },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideAddPageRoute(url, method, body, res, sendJSON);
}

async function handleSlideAddPageRoute(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/add-page' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }

    if (body.html) {
      const result = await djangoRequest(
        'POST',
        `/api/tabslide/projects/${projectId}/append-slides/`,
        {
          html: body.html,
          title: body.title,
          mode: body.mode || 'direct',
          page_id: body.page_id,
          after_page_id: getAfterPageId(body),
          base_version: body.base_version,
        },
        { timeout: 120_000 },
      );
      sendDjangoResult(res, sendJSON, result);
      return;
    }

    const newPageId = body.page_id || crypto.randomUUID();
    const newPage: Record<string, unknown> = { elements: [] };
    if (body.background) {
      newPage.background = body.background;
    }
    const payload: Record<string, unknown> = {
      changed_pages: { [newPageId]: newPage },
      deleted_page_ids: [],
    };
    if (body.page_order) {
      payload.page_order = body.page_order;
    } else {
      const afterPage = getAfterPageId(body);
      if (afterPage) {
        const outlineResult = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`);
        if (!isDjangoSuccess(outlineResult.status)) {
          sendDjangoResult(res, sendJSON, outlineResult);
          return;
        }
        const pageIds = pageIdsFromOutline(outlineResult.data);
        if (!pageIds) {
          sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '无法读取项目页面列表，不能计算插入位置'));
          return;
        }
        const insertIndex = pageIds.indexOf(afterPage);
        if (insertIndex < 0) {
          sendJSON(res, 404, errorResponse('NOT_FOUND', `页面不存在: ${afterPage}`));
          return;
        }
        payload.page_order = [
          ...pageIds.slice(0, insertIndex + 1),
          newPageId,
          ...pageIds.slice(insertIndex + 1),
        ];
      }
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      payload,
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideFinalRoutes(url, method, body, res, sendJSON);
}

async function handleSlideFinalRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/delete-page' && method === 'POST') {
    const projectId = body?.project_id;
    const pageId = body?.page_id;
    if (!projectId || !pageId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id 或 page_id'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      {
        changed_pages: {},
        deleted_page_ids: [pageId],
      },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/reorder' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }
    if (!body?.page_order || !Array.isArray(body.page_order)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 page_order 数组'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      {
        changed_pages: {},
        deleted_page_ids: [],
        page_order: body.page_order,
      },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlidePreviewRoutes(url, method, body, res, sendJSON);
}

async function handleSlidePreviewRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/preview' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/preview/`,
      {
        page_id: body.page_id,
        response_format: body.response_format || 'url',
      },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/lint' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/lint/`,
      {
        page_id: body.page_id,
        problems_only: body.problems_only ?? false,
      },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  return handleSlideExportRoutes(url, method, body, res, sendJSON);
}

async function handleSlideExportRoutes(
  url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '');

  if (route === '/export' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/export/`,
      { format: body.format || body.export_format || 'pptx' },
      { timeout: 120_000 },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  // ── Delete project ─────────────────────────────────
  // 供 `tabtin slide render` 用完即删临时渲染项目：Agent「做 PPT」
  // 走 create→export→delete 的瞬时渲染，不留用户可见的云演示文稿。
  if (route === '/delete-project' && method === 'POST') {
    const projectId = body?.project_id;
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'));
      return;
    }
    const result = await djangoRequest('DELETE', `/api/tabslide/projects/${projectId}/`);
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown slide route: ${url}`));
}
