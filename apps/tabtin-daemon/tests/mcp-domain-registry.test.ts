import { describe, expect, it } from 'vitest'

import { McpDomainRegistry } from '../src/application/mcp/registry.js'

describe('McpDomainRegistry declarations', () => {
  it('fails fast when declared and registered tool sets drift apart', () => {
    const domains = {
      table: {},
      document: {},
      canvas: {},
      memo: {},
      sql: {},
      site: {},
    }

    expect(() => new McpDomainRegistry(
      domains as ConstructorParameters<typeof McpDomainRegistry>[0],
      new Set(['tabtin_missing_tool']),
    )).toThrow(/MCP registry mismatch: missing=\[tabtin_missing_tool\]/)
  })
})
