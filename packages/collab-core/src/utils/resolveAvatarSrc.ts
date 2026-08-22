/**
 * 把协作 Presence 里的 avatar 收成可加载 URL。
 * 与 smartsheet-ui `resolvePublicAvatarUrl` 对齐；collab-core 不依赖 UI 包。
 */
export function resolveAvatarSrc(avatar?: string | null): string | null {
  const value = (avatar || "").trim();
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;

  const key = value.replace(/^\//, "");
  if (key.startsWith("user-avatars/") || key.startsWith("avatars/")) {
    return `https://assets.example.com/${key}`;
  }

  return null;
}
