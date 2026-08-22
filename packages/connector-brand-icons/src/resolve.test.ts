import { describe, expect, it } from 'vitest'
import { connectorBrandManifest, resolveConnectorBrandIconFromRegistry } from './index.js'
import { listApprovedBrandKeys, resolveConnectorBrandIcon } from './resolve.js'

describe('resolveConnectorBrandIcon', () => {
  it('resolves by catalog id without hardcoding in UI', () => {
    expect(resolveConnectorBrandIconFromRegistry({ catalogId: 'github' })).toEqual({
      brandKey: 'github',
      file: 'github.svg',
      title: 'GitHub',
    })
  })

  it('resolves by remote host from endpoint', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        endpointUrl: 'https://mcp.notion.com/mcp',
      })?.brandKey,
    ).toBe('notion')
  })

  it('resolves by npm package in stdio args', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        commandArgs: ['-y', '@supabase/mcp-server-supabase@latest', '--access-token', 'x'],
      })?.brandKey,
    ).toBe('supabase')
  })

  it('does not resolve deferred brands even when id matches', () => {
    expect(resolveConnectorBrandIconFromRegistry({ catalogId: 'canva' })).toBeNull()
  })

  it('resolves approved China connectors from catalog id', () => {
    expect(resolveConnectorBrandIconFromRegistry({ catalogId: 'dingtalk' })?.brandKey).toBe(
      'dingtalk',
    )
    expect(resolveConnectorBrandIconFromRegistry({ catalogId: 'tianyancha' })?.brandKey).toBe(
      'tianyancha',
    )
    expect(resolveConnectorBrandIconFromRegistry({ catalogId: 'hithink-a-share' })?.brandKey).toBe(
      'hithink-a-share',
    )
  })

  it('falls through unknown connectors', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        catalogId: 'custom-thing',
        name: 'My private MCP',
        endpointUrl: 'https://example.com/mcp',
      }),
    ).toBeNull()
  })

  it('lists only approved keys that have files', () => {
    const keys = listApprovedBrandKeys(connectorBrandManifest)
    expect(keys).toContain('github')
    expect(keys).not.toContain('canva')
  })

  it('prefers explicit brandKey', () => {
    expect(
      resolveConnectorBrandIcon(
        { brandKey: 'stripe', catalogId: 'github' },
        connectorBrandManifest,
      )?.brandKey,
    ).toBe('stripe')
  })

  it('does not treat docsUrl on github.com as the GitHub brand', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        name: 'Some private MCP',
        docsUrl: 'https://github.com/HiThink-Tech/Financial-API',
        // no catalogId / endpoint — docs host alone must not become GitHub
      }),
    ).toBeNull()
  })

  it('resolves hithink by catalog id even when docs live on GitHub', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        catalogId: 'hithink-a-share',
        name: '同花顺 · A股数据',
        docsUrl: 'https://github.com/HiThink-Tech/Financial-API',
        endpointUrl: 'https://fuyao.aicubes.cn/mcp/a-share',
      })?.brandKey,
    ).toBe('hithink-a-share')
  })

  it('still resolves GitHub from its own endpoint host', () => {
    expect(
      resolveConnectorBrandIconFromRegistry({
        endpointUrl: 'https://api.githubcopilot.com/mcp/',
      })?.brandKey,
    ).toBe('github')
  })
})
