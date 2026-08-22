/**
 * Slide route handler for CLI Server.
 *
 * Proxies all requests to Django TabSlide API (/api/tabslide/).
 *
 * Routes:
 *   POST /slide/create              → POST   /api/tabslide/projects/
 *   GET  /slide/list                → GET    /api/tabslide/projects/
 *   GET  /slide/outline/:id         → GET    /api/tabslide/projects/:id/page-outline/
 *   GET  /slide/page/:id/:pid       → GET    /api/tabslide/projects/:id/pages/:pid/
 *   POST /slide/generate            → POST   /api/tabslide/projects/:id/create-slides/ (replace)
 *   POST /slide/update              → PATCH  /api/tabslide/projects/:id/pages-by-id/:pid/elements/:eid/
 *   POST /slide/batch-update        → POST   /api/tabslide/projects/:id/batch-update-elements/
 *   POST /slide/add-page            → POST   /api/tabslide/projects/:id/save-pages-v2/ or append-slides/
 *   POST /slide/delete-page         → POST   /api/tabslide/projects/:id/save-pages-v2/
 *   POST /slide/reorder             → POST   /api/tabslide/projects/:id/save-pages-v2/
 *   POST /slide/preview             → POST   /api/tabslide/projects/:id/preview/
 *   POST /slide/lint                → POST   /api/tabslide/projects/:id/lint/
 *   POST /slide/grep                → POST   /api/tabslide/projects/:id/grep/
 *   POST /slide/export              → POST   /api/tabslide/projects/:id/export/
 */

import http from 'node:http'
import { getCLISpaceId } from '../cli-context'
import { djangoRequest, errorResponse, type SendJSON } from './shared/error-handler'

// ── Helpers ──────────────────────────────────────────────

function getSpaceId(body?: any): string | null {
  if (body?.space_id) return body.space_id
  return getCLISpaceId() || null
}

function getOrganizationId(body?: any): string | null {
  return body?.organization_id || process.env.TABTIN_ORGANIZATION_ID || null
}

function extractDjangoData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null
  const envelope = data as { data?: unknown }
  return envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : data as Record<string, unknown>
}

function pageCountFromOutline(data: unknown): number | null {
  const outline = extractDjangoData(data)
  const pages = outline?.pages
  return Array.isArray(pages) ? pages.length : null
}

function pageIdsFromOutline(data: unknown): string[] | null {
  const outline = extractDjangoData(data)
  const pages = outline?.pages
  if (!Array.isArray(pages)) return null
  return pages
    .map((page: unknown) => (
      page && typeof page === 'object' ? (page as { id?: unknown; page_id?: unknown }) : null
    ))
    .map(page => page?.id || page?.page_id)
    .filter((pageId): pageId is string => typeof pageId === 'string' && pageId.length > 0)
}

// ── Route handler ────────────────────────────────────────

export async function handleSlideRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/slide/, '')

  // ── Create project ─────────────────────────────────

  if (route === '/create' && method === 'POST') {
    const spaceId = getSpaceId(body)
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
      return
    }
    const organizationId = getOrganizationId(body)
    if (!organizationId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'))
      return
    }
    const hasHtml = body?.html !== undefined && body.html !== null
    if (hasHtml && (typeof body.html !== 'string' || body.html.trim() === '')) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'html 内容不能为空'))
      return
    }

    const result = await djangoRequest('POST', '/api/tabslide/projects/', {
      organization_id: organizationId,
      space_id: spaceId,
      name: body.name,
      preset: body.preset || 'ppt',
      //  canvas 统一：默认 1280×720，与 html-spec / PPTX EMU 1:1
      canvas_width: body.canvas_width || 1280,
      canvas_height: body.canvas_height || 720,
    })
    if (result.status < 200 || result.status >= 300) {
      sendJSON(res, result.status, result.data)
      return
    }

    if (!hasHtml) {
      sendJSON(res, result.status, result.data)
      return
    }

    const project = extractDjangoData(result.data)
    const projectId = project?.id
    if (!projectId) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '创建演示文稿成功但未返回 project id'))
      return
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
    )
    if (generateResult.status < 200 || generateResult.status >= 300) {
      await djangoRequest('DELETE', `/api/tabslide/projects/${projectId}/`)
    }
    sendJSON(res, generateResult.status, generateResult.data)
    return
  }

  // ── List projects ──────────────────────────────────

  if (route === '/list') {
    const spaceId = getSpaceId(body)
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
      return
    }
    const organizationId = getOrganizationId(body)
    if (!organizationId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'))
      return
    }

    const result = await djangoRequest(
      'GET',
      `/api/tabslide/projects/?organization_id=${organizationId}&space_id=${spaceId}`,
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Page outline ───────────────────────────────────

  const outlineMatch = route.match(/^\/outline\/([^/]+)$/)
  if (outlineMatch) {
    const projectId = outlineMatch[1]
    const result = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`)
    sendJSON(res, result.status, result.data)
    return
  }
  if (route === '/outline' && body?.project_id) {
    const result = await djangoRequest('GET', `/api/tabslide/projects/${body.project_id}/page-outline/`)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Page detail ────────────────────────────────────

  const pageMatch = route.match(/^\/page\/([^/]+)\/([^/]+)$/)
  if (pageMatch) {
    const [, projectId, pageId] = pageMatch
    const result = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/pages/${pageId}/`)
    sendJSON(res, result.status, result.data)
    return
  }
  if (route === '/page' && body?.project_id && body?.page_id) {
    const result = await djangoRequest('GET', `/api/tabslide/projects/${body.project_id}/pages/${body.page_id}/`)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Generate (HTML → slides) ───────────────────────

  if (route === '/generate' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }
    if (!body?.html) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 html 内容'))
      return
    }
    if (!body.replace) {
      const outlineResult = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`)
      if (outlineResult.status < 200 || outlineResult.status >= 300) {
        sendJSON(res, outlineResult.status, outlineResult.data)
        return
      }
      const pageCount = pageCountFromOutline(outlineResult.data)
      if (pageCount === null) {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '无法读取项目页面列表，已拒绝覆盖生成'))
        return
      }
      if (pageCount !== null && pageCount > 0) {
        sendJSON(
          res,
          409,
          errorResponse(
            'VALIDATION_ERROR',
            'slide generate 会覆盖当前项目全部页面；如需插入 HTML 页，请使用 slide add-page --html；如确认要覆盖，请加 --replace',
          ),
        )
        return
      }
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/create-slides/`,
      { html: body.html, title: body.title, mode: body.mode || 'direct' },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Update single element ──────────────────────────

  if (route === '/update' && method === 'POST') {
    const { project_id, page_id, element_id, patch, base_version } = body || {}
    if (!project_id || !page_id || !element_id) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id / page_id / element_id'))
      return
    }
    if (!patch || typeof patch !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 patch 对象'))
      return
    }

    const result = await djangoRequest(
      'PATCH',
      `/api/tabslide/projects/${project_id}/pages-by-id/${page_id}/elements/${element_id}/`,
      { patch, base_version },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Batch update elements ──────────────────────────

  if (route === '/batch-update' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }
    if (!body?.updates || !Array.isArray(body.updates)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 updates 数组'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/batch-update-elements/`,
      { updates: body.updates, base_version: body.base_version },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Add page ───────────────────────────────────────

  if (route === '/add-page' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
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
          after_page_id: body.after_page || body.after_page_id,
          base_version: body.base_version,
        },
        { timeout: 120_000 },
      )
      sendJSON(res, result.status, result.data)
      return
    }

    const newPageId = body.page_id || crypto.randomUUID()
    const newPage: Record<string, unknown> = { elements: [] }
    if (body.background) {
      newPage.background = body.background
    }
    const payload: Record<string, unknown> = {
      changed_pages: { [newPageId]: newPage },
      deleted_page_ids: [],
    }
    // page_order 接受字符串（JSON 数组）或数组本身
    let pageOrder = body.page_order
    if (typeof pageOrder === 'string') {
      try {
        pageOrder = JSON.parse(pageOrder)
      } catch {
        sendJSON(
          res, 400,
          errorResponse(
            'VALIDATION_ERROR',
            '--page-order 必须是 JSON 数组字符串，如 \'["p1","p2","p3"]\'；只想插入位置请改用 --after-page <page-id>',
          ),
        )
        return
      }
    }
    if (Array.isArray(pageOrder)) {
      payload.page_order = pageOrder
    } else {
      // 优先用 --after-page（CLI 新名），兼容 after_page_id（老调用）
      const afterPage = body.after_page || body.after_page_id
      if (afterPage) {
        const outlineResult = await djangoRequest('GET', `/api/tabslide/projects/${projectId}/page-outline/`)
        if (outlineResult.status < 200 || outlineResult.status >= 300) {
          sendJSON(res, outlineResult.status, outlineResult.data)
          return
        }
        const pageIds = pageIdsFromOutline(outlineResult.data)
        if (!pageIds) {
          sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '无法读取项目页面列表，不能计算插入位置'))
          return
        }
        const insertIndex = pageIds.indexOf(afterPage)
        if (insertIndex < 0) {
          sendJSON(res, 404, errorResponse('NOT_FOUND', `页面不存在: ${afterPage}`))
          return
        }
        payload.page_order = [
          ...pageIds.slice(0, insertIndex + 1),
          newPageId,
          ...pageIds.slice(insertIndex + 1),
        ]
      }
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      payload,
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Delete page ────────────────────────────────────

  if (route === '/delete-page' && method === 'POST') {
    const projectId = body?.project_id
    const pageId = body?.page_id
    if (!projectId || !pageId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id 或 page_id'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      {
        changed_pages: {},
        deleted_page_ids: [pageId],
      },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Reorder pages ──────────────────────────────────

  if (route === '/reorder' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }
    if (!body?.page_order || !Array.isArray(body.page_order)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 page_order 数组'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/save-pages-v2/`,
      {
        changed_pages: {},
        deleted_page_ids: [],
        page_order: body.page_order,
      },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Preview (Playwright screenshot) ────────────────

  if (route === '/preview' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/preview/`,
      {
        page_id: body.page_id,
        response_format: body.response_format || 'url',
      },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Lint (visual check) ────────────────────────────

  if (route === '/lint' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/lint/`,
      {
        page_id: body.page_id,
        problems_only: body.problems_only ?? false,
        // Phase-3 Wave-3：min_severity 过滤 / skip_visual 跳过 Playwright（毫秒级 structural-only）
        min_severity: body.min_severity ?? null,
        skip_visual: body.skip_visual ?? false,
      },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Grep (全文本搜索) ─────────────────────────────

  if (route === '/grep' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }
    if (!body?.query || typeof body.query !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 query'))
      return
    }

    // element_types 接受字符串（逗号分隔或 JSON 数组）或数组本身
    let elementTypes = body.element_types
    if (typeof elementTypes === 'string') {
      const trimmed = elementTypes.trim()
      if (trimmed.startsWith('[')) {
        try {
          elementTypes = JSON.parse(trimmed)
        } catch {
          sendJSON(
            res, 400,
            errorResponse('VALIDATION_ERROR', '--element-types 必须是 JSON 数组或逗号分隔字符串'),
          )
          return
        }
      } else {
        elementTypes = trimmed.split(',').map((s: string) => s.trim()).filter(Boolean)
      }
    }

    const payload: Record<string, unknown> = { query: body.query }
    if (body.page_id) payload.page_id = body.page_id
    if (Array.isArray(elementTypes) && elementTypes.length > 0) {
      payload.element_types = elementTypes
    }
    if (typeof body.max_results === 'number') {
      payload.max_results = body.max_results
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/grep/`,
      payload,
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Export ─────────────────────────────────────────

  if (route === '/export' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }

    const result = await djangoRequest(
      'POST',
      `/api/tabslide/projects/${projectId}/export/`,
      { format: body.format || body.export_format || 'pptx' },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Delete project ─────────────────────────────────
  // 供 `tabtin slide render` 用完即删临时渲染项目：Agent「做 PPT」
  // 走 create→export→delete 的瞬时渲染，不留用户可见的云演示文稿。
  // 复用 create 失败回滚同款 DELETE 端点。

  if (route === '/delete-project' && method === 'POST') {
    const projectId = body?.project_id
    if (!projectId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 project_id'))
      return
    }
    const result = await djangoRequest('DELETE', `/api/tabslide/projects/${projectId}/`)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Fallback ───────────────────────────────────────

  sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown slide route: ${url}`))
}
