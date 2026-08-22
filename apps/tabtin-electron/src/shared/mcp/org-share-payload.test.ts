import { describe, expect, it } from 'vitest'
import {
  buildOrgSharePayloadFromHttpDetail,
  redactTransportSecrets,
} from './org-share-payload'

describe('org-share-payload', () => {
  it('moves Authorization into credential_value', () => {
    const payload = buildOrgSharePayloadFromHttpDetail({
      name: 'Remote Docs',
      description: '团队文档',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/v1',
        headers: {
          Authorization: 'Bearer secret-token',
          'X-Tenant': 'acme',
        },
      },
    })
    expect(payload.credential_value).toBe('Bearer secret-token')
    expect(payload.config).toEqual({
      headers: { 'X-Tenant': 'acme' },
      credential_header: 'Authorization',
    })
  })

  it('redacts Authorization for renderer-safe detail', () => {
    const redacted = redactTransportSecrets({
      kind: 'http',
      url: 'https://mcp.example.com/v1',
      headers: {
        Authorization: 'Bearer secret-token',
        'X-Tenant': 'acme',
      },
    })
    expect(redacted).toEqual({
      kind: 'http',
      url: 'https://mcp.example.com/v1',
      headers: {
        Authorization: '***',
        'X-Tenant': 'acme',
      },
    })
  })
})
