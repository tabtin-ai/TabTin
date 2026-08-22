/**
 * 本地文件产物的 TabTin 资源 URI 构造。
 *
 * `tabtin://` 协议与 `hint=tabfiles` 是 TabTin 平台约定，从中性 agent-runtime
 * 本地文件 artifact URL 构造器，经 `present_to_user` 的 local_file item 注入。
 */
export function buildLocalFileArtifactUrl(relativePath: string): string {
  return `tabtin://resource/file/${encodeURIComponent(relativePath)}?hint=tabfiles`
}
