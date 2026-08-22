import { describe, expect, it } from 'vitest'
import {
  applyApiKeyToTransport,
  applyAppCredentialsToTransport,
  applyBearerTokenToTransport,
  applyCredentialSecretToTransport,
  transportHasCredentialPlaceholder,
} from './connectorCredentialTransport'

describe('connectorCredentialTransport', () => {
  it('replaces Authorization header placeholder with api key', () => {
    const next = applyApiKeyToTransport(
      {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.tianyancha.com/v1', '--header', 'Authorization:YOUR_TIANYANCHA_API_KEY'],
      },
      ' secret-key ',
    )
    expect(next).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'https://mcp.tianyancha.com/v1',
        '--header',
        'Authorization:secret-key',
      ],
    })
  })

  it('replaces X-api-key header value', () => {
    const next = applyApiKeyToTransport(
      {
        kind: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          'https://fuyao.aicubes.cn/mcp/a-share',
          '--header',
          'X-api-key:YOUR_HITHINK_API_KEY',
        ],
      },
      'hk_real',
    )
    expect(next.kind === 'stdio' && next.args?.at(-1)).toBe('X-api-key:hk_real')
  })

  it('writes dingtalk client env credentials', () => {
    const next = applyAppCredentialsToTransport(
      {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'dingtalk-mcp@latest'],
        env: {
          DINGTALK_Client_ID: '',
          DINGTALK_Client_Secret: '',
          ACTIVE_PROFILES: 'dingtalk-contacts',
        },
      },
      { clientId: 'cli_id', clientSecret: 'cli_secret' },
    )
    expect(next.kind === 'stdio' && next.env).toEqual({
      DINGTALK_Client_ID: 'cli_id',
      DINGTALK_Client_Secret: 'cli_secret',
      ACTIVE_PROFILES: 'dingtalk-contacts',
    })
  })

  it('applies bearer token to http transport', () => {
    const next = applyBearerTokenToTransport(
      {
        kind: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer YOUR_GITHUB_TOKEN' },
      },
      'gho_test',
    )
    expect(next).toEqual({
      kind: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer gho_test' },
    })
  })

  it('applies pasted PAT via credential secret helper for http', () => {
    const next = applyCredentialSecretToTransport(
      {
        kind: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer YOUR_GITHUB_TOKEN' },
      },
      'ghp_local_pat',
    )
    expect(next.kind === 'http' && next.headers?.Authorization).toBe('Bearer ghp_local_pat')
  })

  it('detects placeholders and empty app env', () => {
    expect(
      transportHasCredentialPlaceholder({
        kind: 'stdio',
        command: 'npx',
        args: ['--header', 'Authorization:YOUR_KEY'],
      }),
    ).toBe(true)
    expect(
      transportHasCredentialPlaceholder({
        kind: 'stdio',
        command: 'npx',
        args: [],
        env: { DINGTALK_Client_ID: '', DINGTALK_Client_Secret: '' },
      }),
    ).toBe(true)
  })
})
