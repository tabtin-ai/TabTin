import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOSSClient } from '@tabtin/oss-client'

function mockPresignResponse(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
}

describe('oss-client presign errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills safe detail into legacy unformatted presign templates', async () => {
    mockPresignResponse({
      success: false,
      message: '生成签名失败: {detail}',
      detail: 'OSS 配置不完整',
      error_code: 'PRESIGN_FAILED',
    })

    const client = createOSSClient({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getToken: () => 'token',
    })

    let error: unknown
    try {
      await client.presign('avatar.png', 1024, 'image/png')
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('生成签名失败: OSS 配置不完整')
    expect((error as Error).message).toContain('PRESIGN_FAILED')
    expect((error as Error).message).not.toContain('{detail}')
  })

  it('redacts sensitive diagnostic detail before surfacing it', async () => {
    mockPresignResponse({
      success: false,
      message: '生成签名失败: {detail}',
      detail: 'access_key_secret=plain-text-secret is invalid',
      error_code: 'PRESIGN_FAILED',
    })

    const client = createOSSClient({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getToken: () => 'token',
    })

    await expect(client.presign('avatar.png', 1024, 'image/png')).rejects.toThrow(
      '生成签名失败: OSS 配置或权限不可用',
    )
  })

  it('uses nested diagnostic detail when top-level detail is absent', async () => {
    mockPresignResponse({
      success: false,
      message: '生成签名失败: {detail}',
      data: {
        detail: 'OSS Endpoint 网络或配置不可用',
        error_code: 'PRESIGN_ENDPOINT_UNAVAILABLE',
      },
    })

    const client = createOSSClient({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getToken: () => 'token',
    })

    await expect(client.presign('avatar.png', 1024, 'image/png')).rejects.toThrow(
      '生成签名失败: OSS Endpoint 网络或配置不可用 (PRESIGN_ENDPOINT_UNAVAILABLE)',
    )
  })

  it('does not expose the storage quota error code in the user-facing message', async () => {
    mockPresignResponse({
      success: false,
      message: '附件空间不足：当前套餐剩余存储空间不足。套餐容量 500.00MB，本次后预计占用 504.21MB。',
      error_code: 'STORAGE_QUOTA_EXCEEDED',
    })

    const client = createOSSClient({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getToken: () => 'token',
    })

    let error: unknown
    try {
      await client.presign('large-file.docx', 15 * 1024 * 1024, 'application/octet-stream')
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/504\.21MB。$/)
    expect((error as Error).message).not.toContain('STORAGE_QUOTA_EXCEEDED')
  })
})
