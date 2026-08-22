import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeOAuthClientProvider } from 'mcp-remote/dist/chunk-65X3S4HB.js'
import { installMcpRemoteOptionalScopeCompat } from '../mcp-remote-oauth-compat'

const appRoot = resolve(import.meta.dirname, '../../../..')

describe('内置 mcp-remote 打包契约', () => {
  it('授权服务器未声明 scope 时不注入 OIDC 默认权限', () => {
    installMcpRemoteOptionalScopeCompat(NodeOAuthClientProvider)
    const provider = new NodeOAuthClientProvider({
      serverUrl: 'https://mcp.cloudflare.com',
      callbackPort: 3334,
      host: 'localhost',
      clientName: 'TabTin',
      serverUrlHash: 'cloudflare-scope-contract',
      authorizationServerMetadata: {},
      protectedResourceMetadata: {},
    })

    expect(provider.getEffectiveScope()).toBeUndefined()
  })

  it('保留连接器显式声明的 OAuth scope', () => {
    installMcpRemoteOptionalScopeCompat(NodeOAuthClientProvider)
    const provider = new NodeOAuthClientProvider({
      serverUrl: 'https://mcp.stripe.com',
      callbackPort: 3334,
      host: 'localhost',
      clientName: 'TabTin',
      serverUrlHash: 'stripe-scope-contract',
      staticOAuthClientMetadata: { scope: 'mcp' },
      authorizationServerMetadata: {},
      protectedResourceMetadata: {},
    })

    expect(provider.getEffectiveScope()).toBe('mcp')
  })

  it('授权跳转 URL 在 scope 缺省时不发送 scope 参数', async () => {
    class FakeProvider {
      capturedUrl?: URL

      getEffectiveScope(): string | undefined {
        return 'openid email profile'
      }

      async redirectToAuthorization(url: URL): Promise<void> {
        url.searchParams.set('scope', this.getEffectiveScope()!)
        this.capturedUrl = url
      }
    }

    installMcpRemoteOptionalScopeCompat(FakeProvider)
    const provider = new FakeProvider()
    await provider.redirectToAuthorization(new URL('https://mcp.cloudflare.com/authorize'))

    expect(provider.capturedUrl?.searchParams.has('scope')).toBe(false)
  })

  it('宿主使用字面量动态导入，确保授权代理在桥接 stdio 后加载且可被构建器收集', () => {
    const source = readFileSync(
      resolve(appRoot, 'src/main/services/mcp-remote-host-process.ts'),
      'utf8',
    )

    expect(source).toContain("await import('mcp-remote/dist/chunk-65X3S4HB.js')")
    expect(source).toContain("await import('mcp-remote/dist/proxy.js')")
    expect(source).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/)
  })

  it('主进程构建明确禁止 externalize mcp-remote', () => {
    const config = readFileSync(resolve(appRoot, 'electron.vite.config.ts'), 'utf8')

    expect(config).toContain("'mcp-remote',")
    expect(config).toContain('exclude: mainDependencyExternalExcludes')
  })
})
