// import-export.test.ts —  W3 异步导入/导出 HTTP 闭环的 cli-server 侧契约测试。
//
// 覆盖点对应 Go CLI 的五条命令：
//   table export csv|excel|pdf --async → /export 透传 async_mode
//   table export stats                 → /export-stats
//   table export wait                  → /task-status（轮询单次请求形态）
//   table export download              → /export-download（签名 URL → __binary 信封）
//   table import file                  → /import-file（base64 JSON 通道）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { configureCLIRoutes } from '../../host-bindings.js'
import {
  handleTableImportExportRoute,
  normalizeImportFileType,
  normalizeRecordIdsParam,
} from './import-export.js'

interface RecordedRequest {
  method: string
  path: string
  body: any
}

function captureSendJSON() {
  const calls: Array<{ status: number; data: any }> = []
  return {
    calls,
    sendJSON: (_res: ServerResponse, status: number, data: any) => {
      calls.push({ status, data })
    },
  }
}

/** 装一个只记请求、按 responder 回响应的 djangoRequest。 */
function stubDjango(
  responder: (method: string, path: string, body: any) => { status: number; data: any },
) {
  const requests: RecordedRequest[] = []
  configureCLIRoutes({
    djangoRequest: async (method, path, body) => {
      requests.push({ method, path, body })
      return responder(method, path, body) as any
    },
    getSpaceId: () => 'space-1',
  })
  return requests
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('table /export async_mode 透传', () => {
  it('--async 时把 async_mode=true 发给 Django', async () => {
    const requests = stubDjango(() => ({
      status: 200,
      data: { success: true, data: { async: true, task_id: 'task-1' } },
    }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/export',
      'POST',
      { table_id: 'tbl-1', format: 'excel', async: true },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.path, '/tabdata/export/excel')
    assert.equal(requests[0]?.body?.async_mode, true)
    assert.equal(capture.calls[0]?.data?.data?.task_id, 'task-1')
  })

  it('不传 async 时不注入 async_mode（保持同步导出行为）', async () => {
    const requests = stubDjango(() => ({ status: 200, data: { success: true, data: 'a,b\n' } }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/export',
      'POST',
      { table_id: 'tbl-1', format: 'csv' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal('async_mode' in (requests[0]?.body ?? {}), false)
  })

  it('export json 仍然 410（W3 不重开 JSON 导出）', async () => {
    stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/export',
      'POST',
      { table_id: 'tbl-1', format: 'json', async: true },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 410)
  })
})

describe('table /export-stats', () => {
  it('走 GET /tabdata/export/stats/{table_id}，record_ids 归一为逗号分隔', async () => {
    const requests = stubDjango(() => ({
      status: 200,
      data: { success: true, data: { record_count: 12, estimated_size_mb: 0.3 } },
    }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/export-stats',
      'POST',
      { table_id: 'tbl-1', record_ids: '["rec-1","rec-2"]', view_id: 'view-9' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.method, 'GET')
    assert.equal(
      requests[0]?.path,
      '/tabdata/export/stats/tbl-1?record_ids=rec-1%2Crec-2&view_id=view-9',
    )
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('缺 table_id 时本地 400，不打后端', async () => {
    const requests = stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute('/export-stats', 'POST', {}, {} as ServerResponse, capture.sendJSON)

    assert.equal(requests.length, 0)
    assert.equal(capture.calls[0]?.status, 400)
  })
})

describe('table /task-status', () => {
  it('转发到 GET /tabdata/tasks/{task_id} 并原样回传三态', async () => {
    const requests = stubDjango(() => ({
      status: 200,
      data: { success: true, data: { task_id: 't-1', status: 'success', ready: true, file_id: 'f-1' } },
    }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/task-status',
      'POST',
      { task_id: 't-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.method, 'GET')
    assert.equal(requests[0]?.path, '/tabdata/tasks/t-1')
    assert.equal(capture.calls[0]?.data?.data?.status, 'success')
  })

  it('缺 task_id 时本地 400', async () => {
    const requests = stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute('/task-status', 'POST', {}, {} as ServerResponse, capture.sendJSON)

    assert.equal(requests.length, 0)
    assert.equal(capture.calls[0]?.status, 400)
  })
})

describe('table /export-download', () => {
  const downloadMeta = {
    file_id: 'file-1',
    file_name: 'export.xlsx',
    file_size: 8,
    content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    download_url: 'https://oss.example.com/export.xlsx?sig=abc',
    expires_in: 3600,
  }

  it('先取签名 URL（redirect=false）再回 __binary 信封', async () => {
    const requests = stubDjango(() => ({ status: 200, data: { success: true, data: downloadMeta } }))
    const capture = captureSendJSON()
    // PK\x03\x04 + 非法 UTF-8 字节：验证不会被当文本重新编码弄坏。
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01])
    globalThis.fetch = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'content-type': downloadMeta.content_type },
      })) as typeof fetch

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.method, 'GET')
    assert.equal(requests[0]?.path, '/tabdata/exports/file-1/download?redirect=false')
    const payload = capture.calls[0]?.data
    assert.equal(capture.calls[0]?.status, 200)
    assert.equal(payload?.__binary, true)
    assert.equal(payload?.content_type, downloadMeta.content_type)
    assert.equal(payload?.file_name, 'export.xlsx')
    assert.ok(Buffer.from(payload.base64, 'base64').equals(raw))
  })

  it('--url-only 时只回签名地址，不读对象存储', async () => {
    stubDjango(() => ({ status: 200, data: { success: true, data: downloadMeta } }))
    const capture = captureSendJSON()
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('')
    }) as typeof fetch

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1', url_only: true },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(fetched, false)
    assert.equal(capture.calls[0]?.data?.data?.inline, false)
    assert.equal(capture.calls[0]?.data?.data?.download_url, downloadMeta.download_url)
  })

  it('文件超过 CLI 通道上限时退化成签名地址而不是截断字节', async () => {
    stubDjango(() => ({
      status: 200,
      data: { success: true, data: { ...downloadMeta, file_size: 64 * 1024 * 1024 } },
    }))
    const capture = captureSendJSON()
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('')
    }) as typeof fetch

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(fetched, false)
    const data = capture.calls[0]?.data?.data
    assert.equal(data?.inline, false)
    assert.match(String(data?.message), /上限/)
  })

  it('服务端没给 file_size 时回签名地址，不无上限地把对象读进内存', async () => {
    const { file_size: _omitted, ...noSize } = downloadMeta
    stubDjango(() => ({ status: 200, data: { success: true, data: noSize } }))
    const capture = captureSendJSON()
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('')
    }) as typeof fetch

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(fetched, false)
    const data = capture.calls[0]?.data?.data
    assert.equal(data?.inline, false)
    assert.equal(data?.file_size, null)
    assert.match(String(data?.message), /未返回文件大小/)
  })

  it('Django 侧鉴权失败时原样回传状态码', async () => {
    stubDjango(() => ({ status: 403, data: { success: false, code: 'PERMISSION_DENIED' } }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 403)
  })

  it('对象存储读取失败时报 502 且不泄露签名 URL', async () => {
    stubDjango(() => ({ status: 200, data: { success: true, data: downloadMeta } }))
    const capture = captureSendJSON()
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch

    await handleTableImportExportRoute(
      '/export-download',
      'POST',
      { file_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 502)
    assert.equal(JSON.stringify(capture.calls[0]?.data).includes('sig=abc'), false)
  })
})

describe('table /import-file', () => {
  it('小文件走本地路径读盘 → base64 → /tabdata/import/file-base64', async () => {
    const requests = stubDjango(() => ({
      status: 200,
      data: { success: true, data: { async: false, created: 3 } },
    }))
    const capture = captureSendJSON()

    const dir = mkdtempSync(join(tmpdir(), 'tabtin-import-file-'))
    const filePath = join(dir, 'small.csv')
    writeFileSync(filePath, 'id,name\n1,Bob\n')

    try {
      await handleTableImportExportRoute(
        '/import-file',
        'POST',
        { table_id: 'tbl-1', file: filePath, file_type: 'csv' },
        {} as ServerResponse,
        capture.sendJSON,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    assert.equal(requests[0]?.path, '/tabdata/import/file-base64')
    assert.equal(
      Buffer.from(requests[0]?.body?.file_base64, 'base64').toString('utf8'),
      'id,name\n1,Bob\n',
    )
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('超过内联上限的文件改走 OSS，绝不把字节塞进 Django JSON body', async () => {
    // 这条钉的是 Critical 修复本身：>6MB 不能再走 base64——CLI 请求体 10MB、
    // base64 膨胀 4/3，之前会在传输层被掐断。
    const requests = stubDjango(() => ({ status: 200, data: { success: true, data: {} } }))
    const capture = captureSendJSON()

    const dir = mkdtempSync(join(tmpdir(), 'tabtin-import-file-big-'))
    const filePath = join(dir, 'big.csv')
    writeFileSync(filePath, Buffer.alloc(6 * 1024 * 1024 + 1024))

    try {
      await handleTableImportExportRoute(
        '/import-file',
        'POST',
        { table_id: 'tbl-1', file: filePath, file_type: 'csv' },
        {} as ServerResponse,
        capture.sendJSON,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // 本测试环境没有可用的 OSS 上传实现/凭证，所以上传这步必然失败——
    // 但要断言的是「没有退化成 base64 直发」：Django 一次都没被调到，
    // 且失败被映射成明确的错误响应而不是掐断连接。
    assert.equal(requests.length, 0)
    assert.ok((capture.calls[0]?.status ?? 0) >= 400)
  })

  it('路径越出 home/tmp 白名单时 403，不落到 base64 分支', async () => {
    const requests = stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/import-file',
      'POST',
      { table_id: 'tbl-1', file: '/etc/passwd', file_type: 'csv' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 0)
    assert.equal(capture.calls[0]?.status, 403)
  })

  it('直传的 base64 超过内联上限时明确报错并指向 file 路径参数', async () => {
    const requests = stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/import-file',
      'POST',
      {
        table_id: 'tbl-1',
        file_base64: 'A'.repeat(9 * 1024 * 1024),
        file_type: 'csv',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 0)
    assert.equal(capture.calls[0]?.status, 400)
    assert.match(String(capture.calls[0]?.data?.error?.message ?? ''), /file 参数/)
  })

  it('转发到 /tabdata/import/file-base64 并带上导入参数', async () => {
    const requests = stubDjango(() => ({
      status: 200,
      data: { success: true, data: { async: true, task_id: 'task-9' } },
    }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/import-file',
      'POST',
      {
        table_id: 'tbl-1',
        file_base64: 'YWJj',
        file_type: 'XLSX',
        sheet_name: 'Sheet1',
        update_existing: true,
        primary_key_field: 'id',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.path, '/tabdata/import/file-base64')
    assert.deepEqual(requests[0]?.body, {
      table_id: 'tbl-1',
      file_base64: 'YWJj',
      file_type: 'xlsx',
      update_existing: true,
      primary_key_field: 'id',
      auto_create_missing_fields: true,
      sheet_name: 'Sheet1',
    })
    assert.equal(capture.calls[0]?.data?.data?.task_id, 'task-9')
  })

  it('file / file_base64 都没给、或 file_type 非法时本地 400', async () => {
    const requests = stubDjango(() => ({ status: 200, data: {} }))
    const capture = captureSendJSON()

    await handleTableImportExportRoute(
      '/import-file',
      'POST',
      { table_id: 'tbl-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )
    await handleTableImportExportRoute(
      '/import-file',
      'POST',
      { table_id: 'tbl-1', file_base64: 'YWJj', file_type: 'parquet' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 0)
    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[1]?.status, 400)
  })
})

describe('参数归一助手', () => {
  it('normalizeRecordIdsParam 接受 JSON 数组 / 真数组 / 逗号串', () => {
    assert.equal(normalizeRecordIdsParam('["a","b"]'), 'a,b')
    assert.equal(normalizeRecordIdsParam(['a', ' b ']), 'a,b')
    assert.equal(normalizeRecordIdsParam('a, b ; c'), 'a,b,c')
    assert.equal(normalizeRecordIdsParam(undefined), '')
  })

  it('normalizeImportFileType 缺省 csv、大小写不敏感、非法返回 null', () => {
    assert.equal(normalizeImportFileType(undefined), 'csv')
    assert.equal(normalizeImportFileType('Excel'), 'excel')
    assert.equal(normalizeImportFileType('xls'), 'xls')
    assert.equal(normalizeImportFileType('parquet'), null)
    assert.equal(normalizeImportFileType(42), null)
  })
})
