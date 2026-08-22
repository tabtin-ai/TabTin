import { describe, it, expect } from 'vitest'
import {
  normalizeTransportConfig,
  parseMcpConfigEntries,
  normalizeStringMap,
  normalizeStringArray,
} from './parse-mcp-config'

describe('normalizeTransportConfig', () => {
  it('http：url + headers（非字符串过滤）', () => {
    expect(
      normalizeTransportConfig({ url: ' http://x/mcp ', headers: { A: 'b', n: 1 } }),
    ).toEqual({ kind: 'http', url: 'http://x/mcp', headers: { A: 'b' } })
  })

  it('stdio：command + args/env（非字符串过滤）', () => {
    expect(
      normalizeTransportConfig({ command: ' npx ', args: ['-y', 3, 'pkg'], env: { K: 'v', z: null } }),
    ).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], cwd: undefined, env: { K: 'v' } })
  })

  it('url 优先于 command', () => {
    expect(normalizeTransportConfig({ url: 'http://x', command: 'npx' })?.kind).toBe('http')
  })

  it('既无 url 也无 command → null', () => {
    expect(normalizeTransportConfig({ foo: 'bar' })).toBeNull()
    expect(normalizeTransportConfig(null)).toBeNull()
    expect(normalizeTransportConfig([])).toBeNull()
  })
})

describe('parseMcpConfigEntries', () => {
  it('裸单 server 对象 → 单条，name=null', () => {
    const entries = parseMcpConfigEntries({ url: 'http://x/mcp' })
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBeNull()
    expect(entries[0].transport.kind).toBe('http')
  })

  it('标准 mcpServers 包装 → name 取自 key', () => {
    const entries = parseMcpConfigEntries({
      mcpServers: {
        tushare: { url: 'http://api/mcp' },
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('tushare')
    expect(entries[0].transport).toMatchObject({ kind: 'http', url: 'http://api/mcp' })
  })

  it('VS Code servers 包装同样识别', () => {
    const entries = parseMcpConfigEntries({
      servers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp'] } },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('pw')
    expect(entries[0].transport.kind).toBe('stdio')
  })

  it('多 server 包装 → 返回全部（调用方决定单/多策略）', () => {
    const entries = parseMcpConfigEntries({
      mcpServers: {
        a: { url: 'http://a' },
        b: { command: 'npx' },
      },
    })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.name).sort()).toEqual(['a', 'b'])
  })

  it('包装内无效条目被跳过', () => {
    const entries = parseMcpConfigEntries({
      mcpServers: {
        good: { url: 'http://good' },
        bad: { note: 'no url or command' },
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('good')
  })

  it('无法识别任何 server → 空数组', () => {
    expect(parseMcpConfigEntries({ foo: 'bar' })).toEqual([])
    expect(parseMcpConfigEntries({ mcpServers: {} })).toEqual([])
    expect(parseMcpConfigEntries(null)).toEqual([])
    expect(parseMcpConfigEntries('str')).toEqual([])
  })
})

describe('normalize helpers', () => {
  it('normalizeStringMap 只保留字符串值', () => {
    expect(normalizeStringMap({ a: 'x', b: 2, c: null })).toEqual({ a: 'x' })
    expect(normalizeStringMap(null)).toEqual({})
  })

  it('normalizeStringArray 过滤非字符串/空白', () => {
    expect(normalizeStringArray(['a', '', 3, ' b '])).toEqual(['a', ' b '])
    expect(normalizeStringArray('nope')).toEqual([])
  })
})
