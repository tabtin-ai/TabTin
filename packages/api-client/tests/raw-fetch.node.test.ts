import assert from 'node:assert/strict'
import test from 'node:test'

import { createRawFetcher } from '../src/raw.ts'

function successfulResponse(): Response {
  return new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('raw fetch keeps FormData as multipart request body', async () => {
  let capturedInit: RequestInit | undefined
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init
    return successfulResponse()
  }) as typeof globalThis.fetch
  const raw = createRawFetcher({ baseUrl: 'https://api.example.test', fetch })
  const formData = new FormData()
  formData.append('file', new Blob(['cover'], { type: 'image/png' }), 'cover.png')

  await raw('POST', '/oss/direct-upload', {
    body: formData,
    rawResponse: true,
    timeout: 0,
  })

  assert.equal(capturedInit?.body, formData)
  assert.equal(
    new Headers(capturedInit?.headers).has('Content-Type'),
    false,
    'browser must generate multipart Content-Type with its boundary',
  )
})

test('raw fetch keeps JSON request serialization unchanged', async () => {
  let capturedInit: RequestInit | undefined
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init
    return successfulResponse()
  }) as typeof globalThis.fetch
  const raw = createRawFetcher({ baseUrl: 'https://api.example.test', fetch })
  const body = { title: 'cover' }

  await raw('POST', '/documents', { body, rawResponse: true, timeout: 0 })

  assert.equal(capturedInit?.body, JSON.stringify(body))
  assert.equal(
    new Headers(capturedInit?.headers).get('Content-Type'),
    'application/json',
  )
})
