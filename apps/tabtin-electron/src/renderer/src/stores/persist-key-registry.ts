/**
 * Persist key registry — single source of truth for all zustand persist keys.
 *
 * ⚠️ ZERO-IMPORT CONSTRAINT: This module MUST NOT import any store or
 * runtime module. It is imported by store-version-guard.ts which runs
 * before any store hydration. Adding imports here risks circular
 * dependencies that would silently break the version guard.
 *
 * Every persist store must register its key here. store-version-guard.ts and
 * sessionReset.ts reference this module instead of hardcoded string arrays.
 */

export const PERSIST_KEYS = {
  // ── domain ──
  auth: 'tabtin-domain-auth',
  bookmarks: 'tabtin-domain-bookmarks',
  browsingHistory: 'tabtin-domain-browsing-history',
  organization: 'tabtin-organization-store',

  // ── session ──
  chat: 'tabtin-session-chat',
  crawlTabs: 'tabtin-session-crawl-tabs',

  // ── prefs ──
  ui: 'tabtin-prefs-ui',
  // TabData「风格」面板的字体外观偏好，按 tableId 独立存储。
  tableAppearance: 'tabtin-prefs-table-appearance',
  canvasLayout: 'tabtin-prefs-canvas-layout',
  contextTabs: 'tabtin-prefs-context-tabs',
  // 工作台 surface 记忆（真实 tab / 桌面主页）。前身 tabtin-prefs-conversation-canvas
  // （对话画板  已拆除），经 LEGACY_KEY_MAP 迁移。
  workbenchSurface: 'tabtin-prefs-workbench-surface',
  browser: 'tabtin-prefs-browser',
  chatSplit: 'tabtin-prefs-chat-split',
  terminalSplit: 'tabtin-prefs-terminal-split',
  i18n: 'tabtin-prefs-i18n',
  voice: 'tabtin-prefs-voice',
  spaceView: 'tabtin-prefs-space-view',
  sessionRead: 'tabtin-prefs-session-read',
  // 跨设备已读 ACK 离线队列；按 session 单调压缩，重连后重放。
  sessionReadOutbox: 'tabtin-session-read-outbox',
  // 登出后按账号隔离保留的会话读态；登录后仅恢复当前账号的回执。
  sessionReadAccounts: 'tabtin-prefs-session-read-accounts',
  // 本机 ChatGPT 会话选模不进 Django；本地持久化使应用重启后仍恢复原渠道。
  localSessionModels: 'tabtin-prefs-local-session-models',
  /**
   * 桌面侧栏主导航 tab（agent / im / me）。
   * 切 tab 的主画布行为：me 接管主画布（SettingsSpace）；
   * agent 保持当前 Space 状态，im 进入私信工作台。
   * 详见 useShellLayoutState 的 workbenchMode 分支。
   */
  mainNav: 'tabtin-prefs-main-nav',
  // 「我的 / 设置」当前路由。mainNav 只记住是否停在 me tab，
  // 这里记住 me tab 内部的具体设置页，避免窗口重建后退回首页。
  settingsSpace: 'tabtin-prefs-settings-space',
  // 「Agent 产物在 Space 内的打开」：用户对"哪种内容默认用哪个 App
  // 打开"的全局偏好（个人维度，不绑 organization / space）。
  resourceOpenPreferences: 'tabtin-prefs-resource-open-preferences',
  /**
   * IA Phase 2 个人偏好同步的 per-namespace `updatedAt` 注册表
   * （`{ [namespace]: number }`）。用于 last-write-wins 合并：本地较新则
   * 不被服务器覆盖。登出清除（跟人走、避免串账号），升级保留（见下）。
   */
  uiSettingsSync: 'tabtin-prefs-ui-settings-sync',
  // 本地目录「Git 流程模式」按目录路径的显示开关（用户关掉后记住，不再自动切回）。
  gitFlowPreference: 'tabtin-prefs-git-flow',
  // TabCode 的文件标签、最近关闭与文件树展开状态；按工作台 scope 隔离。
  tabCode: 'tabcode-store',
} as const

/**
 * 非 Zustand store 的设备级 localStorage key。
 *
 * 这些值不承载账号身份或业务数据，只记录当前安装实例的入口/版本状态；
 * 集中定义后由会话清理与具体消费方共享，避免白名单和写入方使用不同字面量。
 */
export const DEVICE_LOCAL_KEYS = {
  authEntrySeen: 'tabtin-auth-entry-seen',
  deviceId: 'tabtin.device_id',
  storeVersion: '__store_version',
} as const

export type PersistKeyId = keyof typeof PERSIST_KEYS
export type PersistKeyValue = (typeof PERSIST_KEYS)[PersistKeyId]

export const ALL_PERSIST_KEYS: readonly PersistKeyValue[] = Object.values(PERSIST_KEYS)

/**
 * Keys preserved during logout — only non-user-specific preferences.
 * Auth data is NOT preserved (user is changing identity).
 *
 * IA Phase 2：`ui` / `voice` 从"登出保留"移除——这两类偏好已接后端同步、
 * 改为"跟人走"语义：登出清本地，换人登录由 `syncFromServer` 重新拉取，
 * 避免在共享设备上把上一个账号的主题 / 字号 / 配色 / 语音热词串给下一个账号。
 * 同理 `uiSettingsSync`（updatedAt 注册表）不在此列——登出一并清除，防止
 * 旧账号的时间戳压制新账号的服务器值。`resourceOpenPreferences` 本就不在
 * 保留名单，登出已清除。
 * Organization store 在 logout reset action 中会先被清成只保留 `lastOpenedOrganizationId`
 * 的安全形态，用于下次登录恢复上次打开团队。
 */
export const KEYS_PRESERVED_ON_LOGOUT: readonly string[] = [
  PERSIST_KEYS.organization,
  PERSIST_KEYS.i18n,
  PERSIST_KEYS.browser,
  PERSIST_KEYS.chatSplit,
  PERSIST_KEYS.terminalSplit,
  // 同账号重新登录后恢复读态；数据按账号隔离，UI 不会向其他账号暴露。
  PERSIST_KEYS.sessionReadAccounts,
  // 当前仍是同一登录账号；升级不能把老会话的本机 ChatGPT 选择悄悄改回平台。
  PERSIST_KEYS.localSessionModels,
  DEVICE_LOCAL_KEYS.authEntrySeen,
  DEVICE_LOCAL_KEYS.deviceId,
  DEVICE_LOCAL_KEYS.storeVersion,
]

/**
 * Keys preserved when store-version-guard bumps STORE_VERSION.
 * Auth is preserved so the user doesn't get logged out on app upgrade.
 */
export const KEYS_PRESERVED_ON_VERSION_BUMP: readonly string[] = [
  PERSIST_KEYS.auth,
  PERSIST_KEYS.i18n,
  PERSIST_KEYS.ui,
  // 表外观偏好跟着 app version 解耦——升级保留，避免每次升级用户都要重设字体风格。
  PERSIST_KEYS.tableAppearance,
  // 「Agent 产物在 Space 内的打开」：升级保留资源打开偏好（用户配的"始终
  // 用 X 打开"映射跟 app version 解耦——升级也保留，避免每次升级用户都要重设）
  PERSIST_KEYS.resourceOpenPreferences,
  // 一级导航 tab 是个人 UI 偏好，升级保留
  PERSIST_KEYS.mainNav,
  // 升级期间当前登录账号仍可从常规读态恢复；账号快照兜底登出再登录。
  PERSIST_KEYS.sessionRead,
  PERSIST_KEYS.sessionReadAccounts,
  // 设置页当前位置是个人 UI 偏好，升级后仍应恢复用户离开前所在页面。
  PERSIST_KEYS.settingsSpace,
  // IA Phase 2 同步 updatedAt 注册表跟着偏好走、与 app version 解耦——升级保留，
  // 避免升级后时间戳清零导致下次同步一律被服务器值覆盖（丢掉离线期的本地改动）。
  PERSIST_KEYS.uiSettingsSync,
  DEVICE_LOCAL_KEYS.authEntrySeen,
  DEVICE_LOCAL_KEYS.deviceId,
]

/**
 * Legacy key → new key mapping. Used by store-version-guard to ensure
 * legacy keys survive a STORE_VERSION bump so that createMigratingStorage
 * can find them during hydration.
 */
export const LEGACY_KEY_MAP: Record<string, PersistKeyValue> = {
  'tabtin-auth-store': PERSIST_KEYS.auth,
  'tabtin-ui-store': PERSIST_KEYS.ui,
  'tabtin-chat-store': PERSIST_KEYS.chat,
  'canvas-layout': PERSIST_KEYS.canvasLayout,
  'agent-space-context-tabs': PERSIST_KEYS.contextTabs,
  'tabtin-browser-prefs': PERSIST_KEYS.browser,
  'chat-split-layout': PERSIST_KEYS.chatSplit,
  'terminal-split-layout': PERSIST_KEYS.terminalSplit,
  'tabtin-i18n-store': PERSIST_KEYS.i18n,
  'tabtin-voice-settings': PERSIST_KEYS.voice,
  'tabtin-space-view-prefs': PERSIST_KEYS.spaceView,
  'agent-bookmarks': PERSIST_KEYS.bookmarks,
  'agent-browsing-history': PERSIST_KEYS.browsingHistory,
  'tabtin-crawl-tabs': PERSIST_KEYS.crawlTabs,
  'tabtin-session-read-receipts': PERSIST_KEYS.sessionRead,
  //  对话画板拆除：三态 surface 存储迁移为两态 workbench surface
  'tabtin-prefs-conversation-canvas': PERSIST_KEYS.workbenchSurface,
}
