/**
 * 设备操作（TabPhone / 屏幕自动化 / 传感器 / 系统设置）
 */

import type { ToolCardDescriptor } from '@tabtin/chat-client'
import { truncate, getNestedArgs } from './toolCardUtils'

export const DEVICE_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  /* ── 设备查询 ─── */
  get_device_info: { id: 'device', category: 'tool', labelKey: 'chat.card.device_get_info', icon: 'Smartphone', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  get_battery_info: { id: 'device', category: 'tool', labelKey: 'chat.card.device_get_battery', icon: 'Battery', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  get_network_info: { id: 'device', category: 'tool', labelKey: 'chat.card.device_get_network', icon: 'Wifi', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  read_contacts: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_contacts', icon: 'ContactRound', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  search_contacts: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_search_contacts', icon: 'UserSearch',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.query ? truncate(String(args.query), 40) : null },
  },
  read_sms: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_sms', icon: 'MessageSquare', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  send_sms: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_send_sms', icon: 'Send',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.to ? truncate(String(args.to), 20) : null },
  },
  read_call_log: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_call_log', icon: 'Phone', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  make_call: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_make_call', icon: 'PhoneCall',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.number ? truncate(String(args.number), 20) : null },
  },
  read_calendar: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_calendar', icon: 'Calendar', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  read_notifications: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_notifications', icon: 'Bell', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  list_installed_apps: { id: 'device', category: 'tool', labelKey: 'chat.card.device_list_installed_apps', icon: 'AppWindow', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  read_media: { id: 'device', category: 'tool', labelKey: 'chat.card.device_read_media', icon: 'Images', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  get_location: { id: 'device', category: 'tool', labelKey: 'chat.card.device_get_location', icon: 'MapPin', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },

  /* ── 屏幕自动化 ─── */
  screen_capture: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_capture', icon: 'ScanLine', riskLevel: 'safe', defaultCollapsed: false, renderer: 'PhoneScreenshotCard' },
  screen_snapshot: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_snapshot', icon: 'MonitorSmartphone', riskLevel: 'safe', defaultCollapsed: false, renderer: 'PhoneScreenshotCard' },
  screen_ui_tree: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_ui_tree', icon: 'Network', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  screen_tap: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_tap', icon: 'MousePointerClick', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_tap_area: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_tap_area', icon: 'MousePointerClick', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_swipe: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_swipe', icon: 'MoveHorizontal', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_long_press: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_long_press', icon: 'Hand', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_long_press_element: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_long_press_element', icon: 'Hand', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_find_element: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_find_element', icon: 'SearchCode', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  screen_get_context: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_get_context', icon: 'Scan', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  screen_tap_element: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_tap_element', icon: 'MousePointerClick', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_type_in_element: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_type_in_element', icon: 'Keyboard',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.text ? truncate(String(args.text), 30) : null },
  },
  screen_type_text: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_type_text', icon: 'Keyboard',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.text ? truncate(String(args.text), 30) : null },
  },
  screen_type_secret: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_type_secret', icon: 'Lock', riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_key_event: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_key_event', icon: 'Command', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  screen_wait_for_idle: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_wait_idle', icon: 'Hourglass', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  screen_wait_for_element: { id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_wait_element', icon: 'Hourglass', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  screen_open_app: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_open_app', icon: 'AppWindow',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.app_name ?? args?.package_name ? truncate(String(args.app_name ?? args.package_name ?? ''), 30) : null },
  },
  screen_launch_app: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_launch_app', icon: 'Play',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.package_name ? truncate(String(args.package_name), 30) : null },
  },
  // W A0.4.续：riskLevel 'review' → 'strict'，对齐 Django ScreenForceStopAppTool
  // `risk_level: "strict"` + `required_permission: "admin"` 的 server 端权威分级。
  //
  // **数据源边界**（W A0.4.续 三视角 Review 同声必修）：主进程绕过
  // ApprovalScopeCache 的 isStrict 开关由 server 推下来的 sandbox_policy.risk_level
  // 决定（FrontendActionBridge.ts:325-327 + ApprovalManager.ts:168-171），**不**
  // 取自此处 registry。本字段的真实作用：
  //   1. renderer 端工具卡视觉档位与"不可逆操作"同级展示（与 send_sms / make_call /
  //      screen_type_secret 同等"strict"待遇）；
  //   2. 为未来 renderer-only 实现"strict 模式下隐藏'总是允许'按钮"提供数据基础
  //      （ApprovalManager.ts:189 注释明示需 renderer 单独 PR）。
  // **不**作为"绕过 cache 屏障"的根因 —— main 端审批严格态以 server risk_level
  // 为准（Django ScreenForceStopAppTool 已 strict + admin 权威）。
  screen_force_stop_app: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_screen_force_stop', icon: 'Square',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.package_name ? truncate(String(args.package_name), 30) : null },
  },

  /* ── 系统设置 ─── */
  set_system_setting: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_set_system_setting', icon: 'Settings',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.key ? truncate(String(args.key), 30) : null },
  },
  get_system_setting: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_get_system_setting', icon: 'Settings2',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.key ? truncate(String(args.key), 30) : null },
  },
  set_stealth_mode: { id: 'device', category: 'tool', labelKey: 'chat.card.device_set_stealth_mode', icon: 'EyeOff', riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard' },
  launch_with_intent: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_launch_intent', icon: 'ExternalLink',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.action ? truncate(String(args.action), 40) : null },
  },
  save_to_device: {
    id: 'device', category: 'tool', labelKey: 'chat.card.device_save_to_device', icon: 'HardDriveDownload',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.filename ? truncate(String(args.filename), 30) : null },
  },
  get_automation_status: { id: 'device', category: 'tool', labelKey: 'chat.card.device_get_automation_status', icon: 'Activity', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
}
