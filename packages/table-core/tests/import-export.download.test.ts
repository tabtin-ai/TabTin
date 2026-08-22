import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ImportExportApiService,
  configureTableRuntime,
  resetTableRuntime,
} from '../src'

test('ImportExportApiService.downloadFile 使用 runtime.file.downloadBlob', () => {
  resetTableRuntime()

  const calls: Array<{ size: number; filename: string }> = []
  configureTableRuntime({
    api: {
      request: async <T = unknown>() => ({ data: ({ ok: true } as unknown) as T, status: 200 }),
      getAccessToken: async () => 'token',
    },
    file: {
      downloadBlob: (blob, filename) => {
        calls.push({ size: blob.size, filename })
      },
    },
  })

  ImportExportApiService.downloadFile(new Blob(['abc']), 'records.csv')
  assert.deepEqual(calls, [{ size: 3, filename: 'records.csv' }])
})

test('ImportExportApiService.downloadFile 在宿主未注入 file port 时报错', () => {
  resetTableRuntime()
  configureTableRuntime({
    api: {
      request: async <T = unknown>() => ({ data: ({ ok: true } as unknown) as T, status: 200 }),
      getAccessToken: async () => 'token',
    },
  })

  assert.throws(
    () => ImportExportApiService.downloadFile(new Blob(['abc']), 'records.csv'),
    /未实现文件下载能力/
  )
})
