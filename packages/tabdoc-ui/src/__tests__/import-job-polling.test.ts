import type { AppHostClient } from '@tabtin/app-host-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importDocumentFileDraft } from '../api-client'

const makeJob = (status: 'running' | 'partial_ready') => ({
  id: 'job-1',
  file_record_id: 'file-1',
  parsed_document_id: null,
  status,
  stage: status === 'running' ? 'extracting' : 'building_draft',
  total_pages: 5,
  processed_pages: status === 'running' ? 3 : 5,
  failed_pages: status === 'running' ? 0 : 3,
  retry_count: 0,
  error_code: status === 'partial_ready' ? 'partial_pages_failed' : '',
  error_message: status === 'partial_ready' ? '3 页解析失败，已生成部分结果' : '',
  result_available: status === 'partial_ready',
})

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('importDocumentFileDraft polling', () => {
  it('keeps polling long enough for slow PDF jobs that finish just after two minutes', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const request = vi.fn(async ({ method, endpoint }: { method: string; endpoint: string }) => {
      if (method === 'POST' && endpoint === '/tabdoc/import/jobs') {
        return { job: makeJob('running'), created: true }
      }
      if (method === 'GET' && endpoint === '/tabdoc/import/jobs/job-1/result') {
        return {
          job: {
            ...makeJob('partial_ready'),
            result_payload: {
              pm_json: { type: 'doc', content: [{ type: 'paragraph' }] },
              markdown: 'parsed pdf',
              plaintext: 'parsed pdf',
              title: 'Slow PDF',
              total_pages: 5,
              skipped_images: 0,
              uploaded_images: 0,
            },
          },
        }
      }
      if (method === 'GET' && endpoint === '/tabdoc/import/jobs/job-1') {
        return {
          job: makeJob(Date.now() - startedAt >= 121_000 ? 'partial_ready' : 'running'),
        }
      }
      throw new Error(`unexpected request: ${method} ${endpoint}`)
    })
    const client = { request } as unknown as AppHostClient

    const resultPromise = importDocumentFileDraft(client, {
      organizationId: 'org-1',
      spaceId: 'space-1',
      fileRecordId: 'file-1',
    })
    await vi.advanceTimersByTimeAsync(121_000)

    await expect(resultPromise).resolves.toMatchObject({
      markdown: 'parsed pdf',
      plaintext: 'parsed pdf',
      title: 'Slow PDF',
      totalPages: 5,
    })
  })
})
