interface OAuthProviderLike {
  staticOAuthClientMetadata?: { scope?: string }
  wwwAuthenticateScope?: string
  protectedResourceMetadata?: { scopes_supported?: string[] }
  authorizationServerMetadata?: { scopes_supported?: string[] }
  _clientInfo?: { scope?: string }
  getEffectiveScope(): string | undefined
  redirectToAuthorization(url: URL): Promise<void>
}

interface OAuthProviderConstructor {
  prototype: OAuthProviderLike & { __tabtinScopeCompatInstalled?: boolean }
}

function hasDiscoveredScope(provider: OAuthProviderLike): boolean {
  return Boolean(
    provider.staticOAuthClientMetadata?.scope?.trim()
    || provider.wwwAuthenticateScope?.trim()
    || provider.protectedResourceMetadata?.scopes_supported?.length
    || provider._clientInfo?.scope?.trim()
    || provider.authorizationServerMetadata?.scopes_supported?.length,
  )
}

/**
 * mcp-remote 0.1.38 在服务端未声明 scope 时会注入 OIDC 的
 * `openid email profile`。MCP OAuth 允许省略 scope，Cloudflare 等服务端会在
 * 授权页内选择权限，并会拒绝这三个未知值。
 *
 * 该兼容层只运行在 TabTin 内置 mcp-remote utility process 中；有任一显式或
 * 发现到的 scope 时完全沿用上游行为。
 */
export function installMcpRemoteOptionalScopeCompat(
  Provider: OAuthProviderConstructor,
): void {
  const prototype = Provider.prototype
  if (prototype.__tabtinScopeCompatInstalled) return

  const upstreamGetEffectiveScope = prototype.getEffectiveScope
  const upstreamRedirect = prototype.redirectToAuthorization

  prototype.getEffectiveScope = function getEffectiveScope(): string | undefined {
    if (!hasDiscoveredScope(this)) return undefined
    return upstreamGetEffectiveScope.call(this)
  }

  prototype.redirectToAuthorization = async function redirectToAuthorization(
    authorizationUrl: URL,
  ): Promise<void> {
    const searchParams = authorizationUrl.searchParams
    const upstreamSet = searchParams.set.bind(searchParams)
    searchParams.set = ((name: string, value: string | undefined) => {
      if (name === 'scope' && value === undefined) return
      upstreamSet(name, value as string)
    }) as typeof searchParams.set
    try {
      await upstreamRedirect.call(this, authorizationUrl)
    } finally {
      searchParams.set = upstreamSet
    }
  }

  prototype.__tabtinScopeCompatInstalled = true
}
