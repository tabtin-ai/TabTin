import { describe, expect, it } from 'vitest'
import { authorizeHostHintFromCatalogTransport } from './ConnectorOAuthAuthorizeDialog'

describe('authorizeHostHintFromCatalogTransport', () => {
  it('extracts hostname from mcp-remote stdio args', () => {
    expect(
      authorizeHostHintFromCatalogTransport({
        kind: 'stdio',
        args: ['-y', 'mcp-remote', 'https://mcp.stripe.com'],
      }),
    ).toBe('mcp.stripe.com')
  })

  it('extracts hostname from http transport', () => {
    expect(
      authorizeHostHintFromCatalogTransport({
        kind: 'http',
        url: 'https://mcp.notion.com/mcp',
      }),
    ).toBe('mcp.notion.com')
  })
})
