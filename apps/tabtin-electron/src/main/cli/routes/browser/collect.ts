import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import {
  collectBrowserTableDataset,
  type BrowserToTableDataset,
  type BrowserToTableField,
} from '@tabtin/browser-core'
import { buildBulkImportResultPayload } from '@tabtin/cli-routes'
import type { SendJSON, ActionExecutor } from './_helpers'
import {
  buildBrowserRequestScope,
  errorResponse,
  getCLISpaceId,
  isSafeUrl,
  makeTaskId,
  resolveTabId,
} from './_helpers'
import { djangoRequest } from '../shared/error-handler'
import { handleTabsRoute } from './tabs'
import { runWithBrowserApprovalContext } from '../../browser-policy-middleware'

type EpisodeEvent = Record<string, unknown>

interface RouteFailure {
  status: number
  body: unknown
}

type BulkImportResult = ReturnType<typeof buildBulkImportResultPayload>

interface TableSuccess {
  table: { id: string; name: string }
  importResult: BulkImportResult
  warnings: string[]
}

const DEFAULT_TABLE_NAME = 'Browser Collection'
const DOCUMENT_READY_ATTEMPTS = 20
const DOCUMENT_READY_INTERVAL_MS = 250
const DOCUMENT_READY_SETTLE_MS = 500
const DOM_FALLBACK_VERSION = 'dom-v3-diagnostics'
const DOM_FALLBACK_ATTEMPTS = 12
const DOM_FALLBACK_INTERVAL_MS = 750
const DOCUMENT_READY_SCRIPT = `
JSON.stringify({
  ready_state: document.readyState,
  url: location.href,
  title: document.title,
  body_text_length: (document.body && (document.body.innerText || document.body.textContent) || '').trim().length,
})
`
const DOM_TABLE_EXTRACTION_SCRIPT = `
(() => {
  const text = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const rowsFromTable = () => {
    const tables = [...document.querySelectorAll('table')];
    const candidates = tables.map((table) => {
      const headers = [...table.querySelectorAll('thead th, thead td')].map(text).filter(Boolean);
      const scopedRows = table.querySelectorAll('tbody tr').length > 0
        ? [...table.querySelectorAll('tbody tr')]
        : [...table.querySelectorAll('tr')];
      const bodyRows = scopedRows
        .map((tr) => [...tr.querySelectorAll('th,td')].map(text).filter(Boolean))
        .filter((cells) => cells.length >= 2);
      const header = headers.length > 0 ? headers : bodyRows.shift() || [];
      const records = bodyRows
        .filter((cells) => cells.join('\\u0001') !== header.join('\\u0001'))
        .filter((cells) => cells.length >= Math.min(2, header.length || 2))
        .map((cells) => Object.fromEntries(cells.map((cell, index) => [
          header[index] || 'field_' + (index + 1),
          cell,
        ])));
      return records;
    }).filter((records) => records.length > 0);
    return candidates.sort((a, b) => b.length - a.length)[0] || [];
  };

  const rowsFromRoleGrid = () => {
    const rowEls = [...document.querySelectorAll('[role="row"]')];
    const rows = rowEls.map((row) => {
      const hasHeaderCells = row.querySelector('[role="columnheader"]') != null;
      const cells = [...row.querySelectorAll('[role="columnheader"],[role="cell"],[role="gridcell"]')]
        .map(text)
        .filter(Boolean);
      return { cells, hasHeaderCells };
    }).filter((row) => row.cells.length >= 2);
    if (rows.length < 2) return [];
    const headerRow = rows[0]?.hasHeaderCells ? rows[0] : undefined;
    const header = headerRow?.cells ?? [];
    const dataRows = headerRow ? rows.slice(1) : rows;
    return dataRows.map(({ cells }) => Object.fromEntries(cells.map((cell, index) => [
      header[index] || 'field_' + (index + 1),
      cell,
    ])));
  };

  const rowsFromRepeatedBlocks = () => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 10;
    };
    const classCounts = new Map();
    for (const el of [...document.querySelectorAll('div,li,section,article')]) {
      if (!visible(el)) continue;
      const cls = [...el.classList].filter(Boolean).sort().join('.');
      if (!cls) continue;
      const item = classCounts.get(cls) || [];
      item.push(el);
      classCounts.set(cls, item);
    }
    const groups = [...classCounts.values()]
      .filter((items) => items.length >= 3)
      .map((items) => ({
        items,
        score: items.length * Math.min(8, Math.max(...items.map((el) => text(el).split(' ').length))),
      }))
      .sort((a, b) => b.score - a.score);

    for (const group of groups) {
      const records = group.items.map((row) => {
        const chunks = [...row.querySelectorAll('a,span,p,div')]
          .filter((el) => el !== row && visible(el))
          .map(text)
          .filter(Boolean)
          .filter((value, index, arr) => arr.indexOf(value) === index);
        const values = chunks.length >= 2 ? chunks : text(row).split(/\\n+/).map((part) => part.trim()).filter(Boolean);
        if (values.length < 2) return null;
        const record = {};
        values.slice(0, 8).forEach((value, index) => {
          record['field_' + (index + 1)] = value;
        });
        return record;
      }).filter(Boolean);
      if (records.length >= 3) return records;
    }
    return [];
  };

  const rows = rowsFromTable();
  if (rows.length > 0) return JSON.stringify({ records: rows, diagnostics: diagnostics(rows) });
  const gridRows = rowsFromRoleGrid();
  if (gridRows.length > 0) return JSON.stringify({ records: gridRows, diagnostics: diagnostics(gridRows) });
  const blockRows = rowsFromRepeatedBlocks();
  return JSON.stringify({ records: blockRows, diagnostics: diagnostics(blockRows) });

  function diagnostics(records) {
    const bodyText = text(document.body);
    const classCounts = new Map();
    for (const el of [...document.querySelectorAll('div,li,section,article,table,tr,[role="row"]')]) {
      const cls = [...el.classList].filter(Boolean).sort().join('.');
      if (!cls) continue;
      classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
    }
    return {
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      body_text_length: bodyText.length,
      iframe_count: document.querySelectorAll('iframe').length,
      table_count: document.querySelectorAll('table').length,
      role_row_count: document.querySelectorAll('[role="row"]').length,
      candidate_rows: records.length,
      top_classes: [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      text_sample: bodyText.slice(0, 240),
    };
  }
})()
`

export async function handleCollectRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  if (route !== '/collect/table') return false

  const episodeId =
    stringValue(body?.episodeId, body?.episode_id) ||
    `browser-to-table-${Date.now()}`
  const events: EpisodeEvent[] = []
  const warnings: string[] = []
  const recoveries: string[] = []
  const url = stringValue(body?.url)
  const requestedTabId = stringValue(body?.tabId, body?.tab_id)
  const target = stringValue(body?.target) || 'tabdata'
  const rowLimit = intValue(body?.rowLimit, body?.row_limit)
  const pageLimit = intValue(body?.pageLimit, body?.page_limit)

  if (!url && !requestedTabId) {
    sendJSON(
      res,
      400,
      errorResponse('VALIDATION_ERROR', '缺少 url 或 tab-id 参数', {
        suggestions: [
          '提供 url 参数：{"url":"https://example.com","target":"tabdata"}',
          '或复用已打开页面：{"tabId":"<tabId>","target":"tabdata"}',
        ],
      }),
    )
    return true
  }
  if (url && !isSafeUrl(url)) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        `不允许的 URL 协议: ${url}。仅支持 http/https`,
      ),
    )
    return true
  }
  if (target !== 'tabdata') {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        `不支持的 target: ${target}。ATE-3 仅支持 tabdata`,
      ),
    )
    return true
  }

  pushEvent(events, 'episode.started', {
    episode_id: episodeId,
    episode_type: 'browser_to_table',
    goal: `从网页创建多维表：${url || '当前网页'}`,
  })

  await runWithBrowserApprovalContext(body, async () => {
    try {
      const sourceInput = await collectSourceInput(
        body,
        url,
        events,
        episodeId,
        executor,
      )
      const sourceUrl = url || sourceInput.url
      if (!sourceUrl) {
        throw new Error('复用已有网页时未能读取当前页面 URL')
      }
      if (!isSafeUrl(sourceUrl)) {
        throw new Error(`不允许的 URL 协议: ${sourceUrl}。仅支持 http/https`)
      }
      let dataset: BrowserToTableDataset
      try {
        dataset = collectBrowserTableDataset({
          url: sourceUrl,
          records: body?.records,
          network: sourceInput.network,
          rowLimit,
          pageLimit,
        })
      } catch (err) {
        if (!shouldTryDomFallback(err, body, sourceInput.tabId)) throw err
        const domRecords = await collectDomRecords(
          body,
          sourceInput.tabId,
          events,
          episodeId,
          executor,
        )
        dataset = collectBrowserTableDataset({
          url: sourceUrl,
          records: body?.records,
          network: sourceInput.network,
          domRecords,
          rowLimit,
          pageLimit,
        })
      }
      warnings.push(...dataset.warnings)
      recoveries.push(...dataset.recoveries)
      for (const warning of dataset.warnings) {
        pushEvent(events, 'episode.warning', {
          episode_id: episodeId,
          warning,
        })
      }

      pushEvent(events, 'episode.stage.completed', {
        episode_id: episodeId,
        stage_id: 'collect_rows',
        label: '采集数据行',
        metrics: {
          rows: dataset.row_count,
          pages: dataset.capture_scope.pages,
          source_kind: dataset.capture_scope.source_kind,
        },
      })
      pushEvent(events, 'episode.stage.completed', {
        episode_id: episodeId,
        stage_id: 'infer_schema',
        label: '推断字段',
        metrics: { fields: dataset.field_count },
      })

      const tableName =
        stringValue(body?.tableName, body?.table_name) ||
        inferTableName(sourceUrl)
      const tableResult = await writeTabDataTable(
        body,
        tableName,
        dataset,
        events,
        episodeId,
      )
      if ('failure' in tableResult) {
        pushEvent(events, 'episode.warning', {
          episode_id: episodeId,
          warning: 'Browser-to-Table 写入 TabData 失败',
          detail: tableResult.failure.body,
        })
        pushEvent(events, 'episode.completed', {
          episode_id: episodeId,
          status: 'failed',
        })
        const final = buildFinalResult({
          episodeId,
          status: 'failed',
          url: sourceUrl,
          dataset,
          warnings,
          recoveries,
          events,
          failure: tableResult.failure,
        })
        sendJSON(
          res,
          tableResult.failure.status,
          errorResponse(
            'VALIDATION_ERROR',
            'Browser-to-Table 写入 TabData 失败',
            {
              detail: final,
            },
          ),
        )
        return true
      }
      warnings.push(...tableResult.warnings)

      pushEvent(events, 'episode.artifact.created', {
        episode_id: episodeId,
        artifact: {
          type: 'tabdata_table',
          id: tableResult.table.id,
          name: tableResult.table.name,
        },
      })
      pushEvent(events, 'episode.completed', {
        episode_id: episodeId,
        status: 'succeeded',
      })

      sendJSON(
        res,
        200,
        okResponse(
          buildFinalResult({
            episodeId,
            status: 'succeeded',
            url: sourceUrl,
            dataset,
            warnings,
            recoveries,
            events,
            table: tableResult.table,
            importResult: tableResult.importResult,
          }),
        ),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(message)
      pushEvent(events, 'episode.warning', {
        episode_id: episodeId,
        warning: message,
      })
      pushEvent(events, 'episode.completed', {
        episode_id: episodeId,
        status: 'failed',
      })
      sendJSON(
        res,
        500,
        errorResponse('INTERNAL_ERROR', message, {
          detail: {
            status: 'failed',
            episode_type: 'browser_to_table',
            episode_id: episodeId,
            warnings,
            recoveries,
            episode_events: events,
          },
        }),
      )
    }
  })
  return true
}

async function collectSourceInput(
  body: any,
  url: string,
  events: EpisodeEvent[],
  episodeId: string,
  executor: NonNullable<ActionExecutor>,
): Promise<{ network?: unknown; tabId?: string; url?: string }> {
  if (body?.records != null) {
    pushEvent(events, 'episode.stage.completed', {
      episode_id: episodeId,
      stage_id: 'open_source',
      label: '使用已提供记录',
      metrics: { source_kind: 'provided_records' },
    })
    return {}
  }
  if (body?.input != null || body?.network != null) {
    pushEvent(events, 'episode.stage.completed', {
      episode_id: episodeId,
      stage_id: 'discover_data_source',
      label: '读取已提供网络日志',
      metrics: { source_kind: 'network_fixture' },
    })
    return { network: body.input ?? body.network }
  }

  const requestedTabId = stringValue(body?.tabId, body?.tab_id)
  const openSourceLabel = requestedTabId ? '复用已有网页' : '打开网页'
  pushEvent(events, 'episode.stage.started', {
    episode_id: episodeId,
    stage_id: 'open_source',
    label: openSourceLabel,
  })
  const tabId = await resolveOrOpenTab(body, url, executor)
  const readyMetrics = await waitForDocumentReady(
    body,
    tabId,
    events,
    episodeId,
    executor,
  )
  const currentUrl = stringValue(readyMetrics.url)
  pushEvent(events, 'episode.stage.completed', {
    episode_id: episodeId,
    stage_id: 'open_source',
    label: openSourceLabel,
    metrics: {
      tab_id: tabId,
      ...(currentUrl ? { url: currentUrl } : {}),
      document_ready: readyMetrics.ready_state,
      ...(requestedTabId ? { reused_tab: true } : {}),
    },
  })

  pushEvent(events, 'episode.stage.started', {
    episode_id: episodeId,
    stage_id: 'discover_data_source',
    label: '读取页面接口数据',
  })
  const networkResult = await executor({
    task_id: makeTaskId('collect-table-network'),
    type: 'browser_network',
    params: {
      crawlTabId: tabId,
      filter: body?.filter,
      includeRequestHeaders: false,
      includeResponseHeaders: false,
      includeRequestBody: false,
      includeResponseBody: true,
      ...(body?.runId || body?.run_id
        ? { runId: body.runId ?? body.run_id }
        : {}),
    },
    thread_id: '',
  })
  if (networkResult?.success === false) {
    throw new Error(networkResult.error || '读取 browser network 日志失败')
  }
  pushEvent(events, 'episode.stage.completed', {
    episode_id: episodeId,
    stage_id: 'discover_data_source',
    label: '读取页面接口数据',
    metrics: { source_kind: 'network_api' },
  })
  return { network: networkResult?.data ?? [], tabId, url: currentUrl }
}

async function waitForDocumentReady(
  body: any,
  tabId: string | undefined,
  events: EpisodeEvent[],
  episodeId: string,
  executor: NonNullable<ActionExecutor>,
): Promise<Record<string, unknown>> {
  pushEvent(events, 'episode.stage.started', {
    episode_id: episodeId,
    stage_id: 'wait_document_ready',
    label: '等待页面加载完成',
  })

  let lastMetrics: Record<string, unknown> = { ready_state: 'unknown' }
  for (let attempt = 1; attempt <= DOCUMENT_READY_ATTEMPTS; attempt += 1) {
    const result = await executor({
      task_id: makeTaskId('collect-table-document-ready'),
      type: 'eval',
      params: {
        crawlTabId: tabId,
        code: DOCUMENT_READY_SCRIPT,
        ...(body?.runId || body?.run_id
          ? { runId: body.runId ?? body.run_id }
          : {}),
      },
      thread_id: '',
    })

    if (result?.success !== false) {
      const parsed = parseEvalResult(
        result?.data?.result ?? result?.result ?? result?.data,
      )
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lastMetrics = parsed as Record<string, unknown>
      }
      if (lastMetrics.ready_state === 'complete') {
        await delay(DOCUMENT_READY_SETTLE_MS)
        const metrics = {
          ...lastMetrics,
          attempts: attempt,
          settle_ms: DOCUMENT_READY_SETTLE_MS,
        }
        pushEvent(events, 'episode.stage.completed', {
          episode_id: episodeId,
          stage_id: 'wait_document_ready',
          label: '等待页面加载完成',
          metrics,
        })
        return metrics
      }
    }

    if (attempt < DOCUMENT_READY_ATTEMPTS) {
      await delay(DOCUMENT_READY_INTERVAL_MS)
    }
  }

  const metrics = {
    ...lastMetrics,
    attempts: DOCUMENT_READY_ATTEMPTS,
    timed_out: true,
  }
  pushEvent(events, 'episode.stage.completed', {
    episode_id: episodeId,
    stage_id: 'wait_document_ready',
    label: '等待页面加载完成',
    metrics,
  })
  return metrics
}

async function collectDomRecords(
  body: any,
  tabId: string | undefined,
  events: EpisodeEvent[],
  episodeId: string,
  executor: NonNullable<ActionExecutor>,
): Promise<unknown> {
  pushEvent(events, 'episode.stage.started', {
    episode_id: episodeId,
    stage_id: 'discover_dom_rows',
    label: '读取页面可见表格',
  })

  let lastError: string | undefined
  let lastRows = 0
  let lastDiagnostics: unknown
  for (let attempt = 1; attempt <= DOM_FALLBACK_ATTEMPTS; attempt += 1) {
    const result = await executor({
      task_id: makeTaskId('collect-table-dom'),
      type: 'eval',
      params: {
        crawlTabId: tabId,
        code: DOM_TABLE_EXTRACTION_SCRIPT,
        ...(body?.runId || body?.run_id
          ? { runId: body.runId ?? body.run_id }
          : {}),
      },
      thread_id: '',
    })

    if (result?.success === false) {
      lastError = result.error || 'DOM row extraction failed'
    } else {
      const domResult = parseEvalResult(
        result?.data?.result ?? result?.result ?? result?.data,
      )
      const domRecords = recordsFromDomEvalResult(domResult)
      lastDiagnostics = diagnosticsFromDomEvalResult(domResult)
      const rows = domRecords.length
      lastRows = rows
      if (rows > 0) {
        pushEvent(events, 'episode.stage.completed', {
          episode_id: episodeId,
          stage_id: 'discover_dom_rows',
          label: '读取页面可见表格',
          metrics: {
            source_kind: 'dom_table',
            dom_fallback_version: DOM_FALLBACK_VERSION,
            rows,
            attempts: attempt,
            ...(lastDiagnostics ? { diagnostics: lastDiagnostics } : {}),
          },
        })
        return domRecords
      }
    }

    if (attempt < DOM_FALLBACK_ATTEMPTS) {
      await delay(DOM_FALLBACK_INTERVAL_MS)
    }
  }

  pushEvent(events, 'episode.stage.completed', {
    episode_id: episodeId,
    stage_id: 'discover_dom_rows',
    label: '读取页面可见表格',
    metrics: {
      source_kind: 'dom_table',
      dom_fallback_version: DOM_FALLBACK_VERSION,
      rows: lastRows,
      attempts: DOM_FALLBACK_ATTEMPTS,
      ...(lastDiagnostics ? { diagnostics: lastDiagnostics } : {}),
    },
    ...(lastError ? { status: 'failed', summary: lastError } : {}),
  })
  return undefined
}

async function resolveOrOpenTab(
  body: any,
  url: string,
  executor: NonNullable<ActionExecutor>,
): Promise<string | undefined> {
  const requestedTabId = stringValue(body?.tabId, body?.tab_id)
  if (requestedTabId) {
    const resolved = await resolveTabId(requestedTabId, buildBrowserRequestScope(body))
    if (!resolved) {
      throw new Error(`找不到目标 tab: ${requestedTabId}`)
    }
    // 复用已有 tab 且显式带 url：先导航到该 url（/open 的 tabId 分支走 load_tab_url，默认 settled），
    // 与 browser open 的就绪契约一致——否则会忽略 url、直接抓旧页 / 未渲染数据。
    if (url) {
      await invokeOpenRoute({ ...body, url, tabId: resolved }, executor)
    }
    return resolved
  }
  if (!url) {
    throw new Error('缺少 url 参数；不传 url 时必须提供 --tab-id 复用已有网页')
  }
  const openResult = await invokeOpenRoute({ ...body, url }, executor)
  return openResult?.tabId ?? openResult?.viewId
}

async function invokeOpenRoute(
  body: any,
  executor: NonNullable<ActionExecutor>,
): Promise<Record<string, any>> {
  const responses: Array<{ status: number; data: any }> = []
  const captureSendJSON: SendJSON = (_res, status, data) => {
    responses.push({ status, data })
  }
  await handleTabsRoute(
    '/open',
    body,
    {} as http.ServerResponse,
    captureSendJSON,
    executor,
  )
  const captured = responses[0]
  if (!captured) {
    throw new Error('browser open route did not return a response')
  }
  const payload = captured.data?.data ?? captured.data
  if (captured.status >= 400 || captured.data?.ok === false) {
    throw new Error(
      captured.data?.error?.message || payload?.error || '打开 URL 失败',
    )
  }
  return payload
}

async function writeTabDataTable(
  body: any,
  tableName: string,
  dataset: BrowserToTableDataset,
  events: EpisodeEvent[],
  episodeId: string,
): Promise<TableSuccess | { failure: RouteFailure }> {
  const spaceId = stringValue(body?.spaceId, body?.space_id) || getCLISpaceId()
  if (!spaceId) {
    return {
      failure: {
        status: 400,
        body: { message: '缺少 space_id，无法创建 TabData table' },
      },
    }
  }

  pushEvent(events, 'episode.stage.started', {
    episode_id: episodeId,
    stage_id: 'create_table',
    label: '创建多维表',
  })
  const createResult = await djangoRequest('POST', '/tabdata/tables', {
    space_id: spaceId,
    name: tableName,
    description: 'Created by browser-to-table collection',
    use_default_fields: false,
  })
  if (createResult.status >= 400) {
    return {
      failure: { status: createResult.status, body: createResult.data },
    }
  }
  const table = createResult.data?.data ?? createResult.data
  const tableId = table?.id
  const createdTable = tableId
    ? { id: String(tableId), name: String(table?.name ?? tableName) }
    : undefined
  if (!tableId) {
    return {
      failure: {
        status: 500,
        body: {
          message: 'TabData table create response missing id',
          response: createResult.data,
        },
      },
    }
  }

  const fieldsResult = await djangoRequest(
    'POST',
    `/tabdata/tables/${tableId}/fields/bulk`,
    {
      fields: dataset.fields.map(fieldToTabDataPayload),
    },
  )
  if (fieldsResult.status >= 400) {
    return {
      failure: {
        status: fieldsResult.status,
        body: {
          message: 'TabData fields create failed after table creation',
          created_table: createdTable,
          cleanup_required: true,
          response: fieldsResult.data,
        },
      },
    }
  }
  const fieldResult = normalizeBulkFieldResult(
    fieldsResult.data,
    dataset.fields.length,
  )
  if (fieldResult.hasFailure) {
    return {
      failure: {
        status: 400,
        body: {
          message:
            'TabData fields bulk-create returned partial errors after table creation',
          created_table: createdTable,
          cleanup_required: true,
          field_result: fieldsResult.data,
        },
      },
    }
  }

  const importResult = await djangoRequest(
    'POST',
    '/tabdata/records/bulk-create',
    {
      table_id: tableId,
      records: dataset.records,
    },
  )
  if (importResult.status >= 400) {
    return {
      failure: {
        status: importResult.status,
        body: {
          message:
            'TabData records bulk-create request failed after table creation',
          created_table: createdTable,
          cleanup_required: true,
          response: importResult.data,
        },
      },
    }
  }

  const importPayload = buildBulkImportResultPayload(
    importResult.data,
    dataset.records.length,
  )
  if (importPayload.operation_status === 'complete_failure') {
    return {
      failure: {
        status: 400,
        body: {
          message: `批量写入全部失败：0/${importPayload.total_count} 条写入成功`,
          created_table: createdTable,
          cleanup_required: true,
          import_result: importPayload,
        },
      },
    }
  }
  const warnings: string[] = []
  if (importPayload.operation_status === 'partial_success') {
    const warning = `${importPayload.failed_count}/${importPayload.total_count} rows failed to import`
    warnings.push(warning)
    pushEvent(events, 'episode.warning', {
      episode_id: episodeId,
      warning,
      detail: importPayload.error_summary,
    })
  }

  pushEvent(events, 'episode.stage.completed', {
    episode_id: episodeId,
    stage_id: 'create_table',
    label: '创建多维表',
    metrics: {
      table_id: tableId,
      rows_written: importPayload.success_count,
      operation_status: importPayload.operation_status,
    },
  })

  return { table: createdTable!, importResult: importPayload, warnings }
}

function normalizeBulkFieldResult(
  data: any,
  expectedCount: number,
): { hasFailure: boolean } {
  const payload = data?.data ?? data
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  const failedCount = numberValue(payload?.failed_count, payload?.failedCount)
  const successCount = numberValue(
    payload?.success_count,
    payload?.successCount,
  )
  return {
    hasFailure:
      errors.length > 0 ||
      (failedCount != null && failedCount > 0) ||
      (successCount != null && successCount < expectedCount),
  }
}

function fieldToTabDataPayload(
  field: BrowserToTableField,
): Record<string, unknown> {
  return {
    name: field.name,
    field_type: field.field_type,
    description: field.reason ?? '',
  }
}

function buildFinalResult(input: {
  episodeId: string
  status: 'succeeded' | 'failed'
  url: string
  dataset: BrowserToTableDataset
  warnings: string[]
  recoveries: string[]
  events: EpisodeEvent[]
  table?: { id: string; name: string }
  importResult?: BulkImportResult
  failure?: RouteFailure
}): Record<string, unknown> {
  return {
    status: input.status,
    episode_type: 'browser_to_table',
    episode_id: input.episodeId,
    ...(input.table ? { table: input.table } : {}),
    capture_scope: {
      ...input.dataset.capture_scope,
      url: input.url,
    },
    dataset: {
      row_count: input.dataset.row_count,
      field_count: input.dataset.field_count,
      preview_rows: input.dataset.preview_rows,
    },
    fields: input.dataset.fields,
    ...(input.importResult ? { import_result: input.importResult } : {}),
    warnings: input.warnings,
    recoveries: input.recoveries,
    ...(input.failure ? { failure: input.failure.body } : {}),
    episode_events: input.events,
  }
}

function pushEvent(
  events: EpisodeEvent[],
  type: string,
  payload: Record<string, unknown>,
): void {
  events.push({ type, ...payload, ts: new Date().toISOString() })
}

function shouldTryDomFallback(
  err: unknown,
  body: any,
  tabId: string | undefined,
): boolean {
  if (
    !tabId ||
    body?.records != null ||
    body?.input != null ||
    body?.network != null
  )
    return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('未从页面或 network 响应中发现可导入的对象列表')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseEvalResult(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function recordsFromDomEvalResult(
  input: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input.filter(isRecord)
  if (input && typeof input === 'object') {
    const records = (input as Record<string, unknown>).records
    if (Array.isArray(records)) return records.filter(isRecord)
  }
  return []
}

function diagnosticsFromDomEvalResult(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return undefined
  return (input as Record<string, unknown>).diagnostics
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function inferTableName(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const path = url.pathname.split('/').filter(Boolean).slice(-1)[0]
    return path ? `${url.hostname} ${path}` : url.hostname
  } catch {
    return DEFAULT_TABLE_NAME
  }
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function intValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return undefined
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}
