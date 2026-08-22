import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configureTableRuntime,
  getTableApiPort,
  getTableFilePort,
  requireTableApiPort,
  resetTableRuntime,
  type TableApiPort,
} from '../src'

const createApiPort = (token = 'token'): TableApiPort => ({
  request: async <T = unknown>() => ({ data: ({ ok: true } as unknown) as T, status: 200 }),
  getAccessToken: async () => token,
})

test('runtime registry: requireTableApiPort 在未配置时抛错', () => {
  resetTableRuntime()
  assert.throws(
    () => requireTableApiPort(),
    /Table API port is not configured/
  )
})

test('runtime registry: configureTableRuntime 支持合并 api 与 file 端口', async () => {
  resetTableRuntime()

  const api = createApiPort('abc')
  const fileCalls: Array<{ size: number; filename: string }> = []

  configureTableRuntime({
    api,
  })

  configureTableRuntime({
    file: {
      downloadBlob: (blob, filename) => {
        fileCalls.push({ size: blob.size, filename })
      },
    },
  })

  const resolvedApi = getTableApiPort()
  assert.equal(resolvedApi, api)

  const token = await resolvedApi!.getAccessToken()
  assert.equal(token, 'abc')

  const filePort = getTableFilePort()
  assert.ok(filePort?.downloadBlob)

  filePort!.downloadBlob!(new Blob(['ok']), 'demo.txt')
  assert.deepEqual(fileCalls, [{ size: 2, filename: 'demo.txt' }])
})
