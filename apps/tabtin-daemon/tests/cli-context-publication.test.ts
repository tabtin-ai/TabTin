import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('CLI request context publication lifecycle', () => {
  const source = readFileSync(resolve(__dirname, '../src/transport/cli/cli-server.ts'), 'utf8')

  it('publishes context only after the HTTP server is created', () => {
    expect(source.indexOf('owner.context = context')).toBeGreaterThan(source.indexOf('createCLIHttpServer((req, res)'))
  })

  it('clears context even when no server instance exists', () => {
    expect(source).toMatch(/if \(!owner\.server\) \{\s*clearCLIServerState\(owner\)/)
    expect(source).toMatch(/function clearCLIServerState[\s\S]*?owner\.context = null/)
  })

  it('separates ingress suspension from forced connection shutdown', () => {
    const suspend = source.slice(source.indexOf('export function suspendCLIServerIngress'), source.indexOf('function clearCLIServerState'))
    expect(suspend).toContain('currentCliServer().suspendIngress()')
    expect(suspend).not.toContain('closeAllConnections')
    expect(suspend).not.toContain('cliContext = null')
  })
})
