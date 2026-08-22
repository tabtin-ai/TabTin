import http from 'node:http'
import {
  analyzeCaptchaFromPageMeta,
  buildDeepOuterHTMLExpression,
  getSharedCaptchaGuard,
  projectCaptchaRequired,
  type CaptchaRequiredWire,
} from '@tabtin/browser-core'
import { okResponse } from '@tabtin/agent-wire'
import {
  getSharedCrawlToolImpl,
  isPrintTextFormat,
  renderPrintContent,
} from '@tabtin/action-tools/impl'
import type { SendJSON, ActionExecutor } from './_helpers'
import { buildBrowserRequestScope, resolveTabId, requireTabWithView, makeTaskId, errorResponse, sanitizeSavePath, isSafeUrl } from './_helpers'
import { recordBrowserNavigationEvidenceFromHtml } from './navigation-evidence'

/**
 * `/browser/print` — 导出页面内容到文件（命令面重设计：原 extract + markdown + pdf 收编）。
 *
 * 契约：
 *  - `save` 必填、始终落盘；响应只回 `{path, format, title, url, bytes, …}` 等元信息，
 *    不把正文灌进上下文（要读用 grep/read 按需取文件片段）。
 *  - `as` = text | markdown(默认) | html | json | pdf；文本类形态经 action-tools 共享
 *    渲染器（含 --include 内容类型白名单 + --schema 结构化投影），pdf 走 printToPDF。
 *  - 来源：`url`（轨 B 临时隐藏 tab，无会话）或缺省当前 tab / `tabId`（轨 A 共享会话）。
 */
export async function handlePrintRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  if (route !== '/print') return false

  const format = body?.as ?? 'markdown'
  if (format !== 'pdf' && !isPrintTextFormat(format)) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `不支持的产物形态: ${format}`, {
      suggestions: ['--as 取值: text / markdown / html / json / pdf'],
    }))
    return true
  }

  const rawSave = body?.save ?? body?.savePath ?? body?.save_path
  if (!rawSave || typeof rawSave !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 --save 参数（print 始终落盘）', {
      suggestions: ['示例: tabtin browser print --save /tmp/page.md'],
    }))
    return true
  }
  const savePath = sanitizeSavePath(rawSave)
  if (!savePath) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `不允许保存到该路径: ${rawSave}。允许目录: ~/.tabtin, /tmp`, {
      suggestions: ['使用 ~/.tabtin/exports/ 下的路径', '或使用 /tmp/ 下的路径'],
    }))
    return true
  }

  if (format === 'pdf') {
    await handlePdfPrint(body, savePath, res, sendJSON)
    return true
  }

  // ── 文本类形态：取页面 HTML → 共享渲染器 → 落盘 ───────────────────────
  let page: { html: string; title: string; url: string }
  try {
    if (body?.url) {
      const fetched = await fetchPageViaUrl(body, res, sendJSON)
      if (!fetched) return true
      page = fetched
    } else {
      const fetched = await fetchPageViaTab(body, res, sendJSON, executor)
      if (!fetched) return true
      page = fetched
    }
  } catch (err: any) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || '页面内容获取失败', { retryable: true }))
    return true
  }

  // 页面上真实存在的链接补录导航证据（事实源=页面真相；与产物是否保留链接无关）。
  if (page.url && page.html) {
    recordBrowserNavigationEvidenceFromHtml(page.url, page.html)
  }

  try {
    const rendered = await renderPrintContent(format, {
      html: page.html,
      title: page.title,
      url: page.url,
      include: body?.include,
      schema: body?.schema,
    })
    await writeFileEnsuringDir(savePath, rendered.content)
    const wordCount = format === 'markdown' || format === 'text'
      ? rendered.content.split(/\s+/).filter(Boolean).length
      : undefined
    // 撞墙后 Agent 常先 print 再 read_file；正文在文件里，门禁只认工具 JSON。
    // 故在 print 元信息上投影 captcha_required（与 glance/observe 同契约）。
    const captchaRequired = await resolvePrintCaptchaRequired(page, body)
    sendJSON(res, 200, okResponse({
      ...(captchaRequired ? { captcha_required: captchaRequired } : {}),
      path: savePath,
      format,
      title: page.title,
      url: page.url,
      bytes: Buffer.byteLength(rendered.content, 'utf-8'),
      ...(wordCount !== undefined ? { word_count: wordCount } : {}),
      ...(rendered.warnings?.length ? { schema_warnings: rendered.warnings } : {}),
    }))
  } catch (error: any) {
    // 渲染器抛错 = 入参校验失败（如 --as json 缺 schema）
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', error?.message || '内容渲染失败', {
      suggestions: ['--as json 需要 --schema，例如 \'{"type":"object","properties":{"title":{"type":"string"}}}\''],
    }))
  }
  return true
}

/** pdf 形态：依赖 Electron printToPDF，仅当前 tab（--url 拒绝，与 Daemon 端口径一致）。 */
async function handlePdfPrint(
  body: any,
  savePath: string,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  if (body?.url) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '--as pdf 仅支持当前 tab（先 open 再 print）', {
      suggestions: ['tabtin browser open --url <url>', '然后 tabtin browser print --as pdf --save <path>'],
    }))
    return
  }
  const resolved = await requireTabWithView(
    body?.tabId,
    res,
    sendJSON,
    buildBrowserRequestScope(body),
  )
  if (!resolved) return

  try {
    const opts: Electron.PrintToPDFOptions = {
      landscape: body?.landscape ?? false,
      printBackground: body?.printBackground ?? true,
      pageSize: body?.pageSize || 'A4',
    }
    const pdfBuffer = await resolved.view.webContents.printToPDF(opts)
    await writeFileEnsuringDir(savePath, pdfBuffer)
    sendJSON(res, 200, okResponse({
      path: savePath,
      format: 'pdf',
      url: resolved.view.webContents.getURL(),
      bytes: pdfBuffer.length,
    }))
  } catch (error: any) {
    sendJSON(res, 500, errorResponse('PDF_GENERATION_FAILED', error?.message || 'PDF 生成失败', {
      retryable: true,
    }))
  }
}

/** url 模式（轨 B）：临时隐藏 tab 抓取，不共享会话。 */
async function fetchPageViaUrl(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<{ html: string; title: string; url: string } | null> {
  if (!isSafeUrl(body.url)) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `不允许的 URL 协议: ${body.url}。仅支持 http/https`, {
      suggestions: ['使用 https:// 或 http:// 开头的 URL'],
    }))
    return null
  }
  const impl = getSharedCrawlToolImpl()
  const result: any = await impl.crawlCleanHtml({
    url: body.url,
    waitForDynamic: body?.wait_for_dynamic ?? body?.waitForDynamic ?? true,
    timeout: body?.timeout ?? 30000,
    ...(body?.runId ? { runId: body.runId } : {}),
  } as any)
  if (result?.success === false) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result.error || '页面抓取失败', { retryable: true }))
    return null
  }
  return {
    html: result.clean_html ?? result.cleanHtml ?? '',
    title: result.title ?? '',
    url: result.url ?? body.url,
  }
}

/** tab 模式（轨 A）：读当前 / 指定 tab 的渲染后 DOM，共享会话。 */
async function fetchPageViaTab(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<{ html: string; title: string; url: string } | null> {
  const tabId = await resolveTabId(
    body?.tabId ?? body?.tab_id,
    buildBrowserRequestScope(body),
  )
  if (!tabId) {
    sendJSON(res, 400, errorResponse('TAB_REQUIRED', '没有可用的 tab（且未提供 --url）', {
      suggestions: [
        '先打开页面: tabtin browser open --url https://example.com',
        '或临时抓取: tabtin browser print --url https://example.com --save <path>',
      ],
    }))
    return null
  }

  const evalResult = await executor({
    task_id: makeTaskId('print-tab'),
    type: 'eval',
    params: {
      code: `JSON.stringify({ html: (${buildDeepOuterHTMLExpression()}), title: document.title, url: window.location.href })`,
      crawlTabId: tabId,
      ...(body?.runId ? { runId: body.runId } : {}),
    },
    thread_id: '',
  })
  if (evalResult.success === false) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', evalResult.error || '无法从 tab 读取内容', { retryable: true }))
    return null
  }
  try {
    const raw = evalResult.data?.result ?? evalResult.result ?? evalResult.data
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { html: parsed.html ?? '', title: parsed.title ?? '', url: parsed.url ?? '' }
  } catch {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '解析 tab 内容失败'))
    return null
  }
}

async function writeFileEnsuringDir(filePath: string, content: string | Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

/**
 * print 路径的验证码投影：优先 live CaptchaGuard（当前 tab），
 * 否则用 url/title/html 文本启发式（覆盖 Google sorry「异常流量」且无 iframe 瞬时态）。
 */
async function resolvePrintCaptchaRequired(
  page: { html: string; title: string; url: string },
  body: any,
): Promise<CaptchaRequiredWire | undefined> {
  const tabId = body?.url
    ? undefined
    : await resolveTabId(body?.tabId ?? body?.tab_id, buildBrowserRequestScope(body)).catch(() => undefined)

  if (tabId) {
    try {
      const live = await getSharedCaptchaGuard().detect(tabId)
      const fromLive = projectCaptchaRequired(live)
      if (fromLive) return fromLive
    } catch {
      // 探测失败不阻断 print；回落页面元信息。
    }
  }

  return projectCaptchaRequired(
    analyzeCaptchaFromPageMeta({
      url: page.url,
      title: page.title,
      htmlOrText: page.html,
    }),
  )
}
