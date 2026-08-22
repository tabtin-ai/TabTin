/**
 * 把协作者接口里的 avatar 字段收成浏览器可加载的 URL。
 *
 * 后端 User.avatar 存的是 OSS object key（如 `user-avatars/xxx.png`），
 * 正确路径应由服务端 `build_public_asset_url` 转成 CDN。此处兜底兼容
 * 尚未部署该修复的正式环境，避免分享弹窗只剩首字母。
 */
export function resolvePublicAvatarUrl(
  avatar?: string | null,
  assetOriginHint?: string | null,
): string | null {
  const value = (avatar || '').trim()
  if (!value) return null
  if (/^(https?:|data:|blob:)/i.test(value)) return value

  const key = value.replace(/^\//, '')
  if (assetOriginHint) {
    try {
      const origin = new URL(assetOriginHint).origin
      return `${origin}/${key}`
    } catch {
      // ignore invalid hint
    }
  }

  // 平台头像 object key 的稳定 CDN（与正式/测试 assets 域名对齐）
  if (key.startsWith('user-avatars/') || key.startsWith('avatars/')) {
    return `https://assets.example.com/${key}`
  }

  // 未知相对路径不当作 img src（会拼到页面 origin → 404 破图）
  return null
}
