/**
 * Tab 应用工具（TabSite）。
 *
 * 2026-04-30 dogfood P0 清理（CLI first 转向）：原 TabVideo 系列 8 个工具卡片
 * （tabvideo_render_html_clip / tabvideo_place_clip 等）已删除——所有视频
 * 编排能力改由 ``tabtin video <subcommand>`` CLI 命令暴露给 Agent，
 * `run_terminal_command` 工具卡片即可呈现 Agent 的 CLI 调用，无需专属卡片。
 */

import type { ToolCardDescriptor } from '@tabtin/chat-client'
import { truncate, getNestedArgs } from './toolCardUtils'

export const TABAPP_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  /* ── TabSite ─── */
  'tabsite_create_site': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_create', icon: 'Globe', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.name ? truncate(String(args.name), 40) : null } },
  'tabsite_list_sites': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_list', icon: 'LayoutGrid', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  'tabsite_get_site': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_get', icon: 'Info', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.site_id ? truncate(String(args.site_id), 12) : null } },
  'tabsite_update_site': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_update', icon: 'PenLine', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.site_id ? truncate(String(args.site_id), 12) : null } },
  'tabsite_publish_site': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_publish', icon: 'Upload', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.site_id ? truncate(String(args.site_id), 12) : null } },
  'tabsite_rollback_site': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_rollback', icon: 'RotateCcw', riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.site_id ? truncate(String(args.site_id), 12) : null } },
  'tabsite_provision_token': { id: 'tabsite', category: 'tool', labelKey: 'chat.card.site_provision_token', icon: 'KeyRound', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard', compactSummary: (input) => { const args = getNestedArgs(input); return args?.site_id ? truncate(String(args.site_id), 12) : null } },
}
