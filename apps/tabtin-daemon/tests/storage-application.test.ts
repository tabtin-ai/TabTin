import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetForTesting,
  registerStorageBucket,
} from '@tabtin/storage-manager'

import { createDaemonStorageApplication } from '../src/application/storage/daemon-storage.js'
import { NodeStorageFileSystem } from '../src/platform/storage/node-storage-file-system.js'

const storageApplication = createDaemonStorageApplication(new NodeStorageFileSystem())

afterEach(() => {
  __resetForTesting()
})

describe('storage application', () => {
  it('executes storage measurement without an HTTP response object', async () => {
    registerStorageBucket({
      id: 'test:application-size',
      category: 'cache',
      group: 'cache',
      displayName: 'application size',
      description: 'application seam test',
      sizeFn: async () => ({ bytes: 42, itemCount: 2 }),
    })

    const outcome = await storageApplication.execute('size', { bucket: 'test:application-size' })

    expect(outcome.status).toBe(200)
    expect(outcome.payload).toEqual({
      ok: true,
      data: expect.objectContaining({
        id: 'test:application-size',
        bytes: 42,
        itemCount: 2,
      }),
    })
  })

  it('returns a transport-neutral validation outcome', async () => {
    const outcome = await storageApplication.execute('clear', {
      bucket: 'test:bucket',
      category: 'cache',
    })

    expect(outcome).toEqual({
      status: 400,
      payload: {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'bucket 与 category 不能同时传',
        },
      },
    })
  })
})
