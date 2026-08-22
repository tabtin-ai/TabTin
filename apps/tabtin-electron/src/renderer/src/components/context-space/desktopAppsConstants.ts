/**
 * 桌面应用相关纯常量（无 React / 无 registry 依赖的 leaf 模块）。
 *
 * 单独成文件的原因：`registry/homeSections/desktopApps.tsx` 在**模块初始化时**
 * 就要读取 `DESKTOP_APPS_HOME_ID`（写进 section 的 `appId`）。若它从
 * `desktopAppsModel` 取该常量，会经 `desktopAppsModel → ./registry →
 * homeRegistry 注册 homeSections → desktopApps.tsx → desktopAppsModel` 的循环
 * 依赖，命中 TDZ（"Cannot access 'DESKTOP_APPS_HOME_ID' before initialization"）。
 * 把常量放在这个不参与上述环的 leaf 模块里，任何一方都能安全引用。
 */
export const DESKTOP_APPS_HOME_ID = 'desktop-apps'
export const TABFOLDER_HOME_ID = 'tabfolder'
export const PINNED_APPS_STORAGE_KEY = 'tabtin:desktop-sidebar:pinned-apps:v1'
export const MAX_PINNED_DESKTOP_APPS = 5
