import type { ImportSourceId } from '@tabtin/cli-server-core'

/**
 * 外部 Agent 导入源平台图标（打包静态资源，publicDir static/import-sources）。
 * 路径相对 renderer 根，dev / 打包一致。
 */
export const IMPORT_SOURCE_ICON_URLS: Record<ImportSourceId, string> = {
  claude_code: '/import-sources/claude_code.png',
  codex: '/import-sources/codex.png',
  cursor: '/import-sources/cursor.png',
  workbuddy: '/import-sources/workbuddy.png',
}
