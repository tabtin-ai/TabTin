/**
 * 执行设备型 App 白名单 —— 这些 App 依赖 Agent 的 control_device：终端窗口、浏览器画面、
 * 手机投屏、工作目录都在那台设备上。遥控器视角（当前 Electron 客户端 ≠ Agent.control_device）
 * 下点开它们,应统一显示 `RemoteAgentBanner` 占位（取向 B：保留入口 + 提示去 control_device 操作）,
 * 而不是各自报错或照常渲染失效内容。
 *
 * 为什么用白名单而不是 manifest `catalog.desktopGroup`：desktopGroup 的 `capabilities` 组混了
 * 云应用与执行设备型（`tabweb`/`tabdesktop`/`orchestration`）,且 `tabcode`/
 * `tabfolder` 缺 `desktopGroup` —— 用分组过滤会误伤云应用。此白名单与 #1148(APP-29) 的「违规
 * 应用」清单吻合,是当前最精确的判定源。
 *
 * 注：长期应由 manifest 声明 `requires_control_device` 标志位取代这份硬编码（见
 * docs/overview/app-platform-issues-overview.md 的 manifest 分组债）。新增执行设备型 App 时
 * 记得同步这里。
 */
export const EXECUTION_DEVICE_APP_IDS: ReadonlySet<string> = new Set<string>([
  'orchestration',
  'tabcode',
  'tabfolder',
  'terminal',
  'tabweb',
  'tabdesktop',
])

export function isExecutionDeviceApp(appId: string | null | undefined): boolean {
  return !!appId && EXECUTION_DEVICE_APP_IDS.has(appId)
}

/**
 * 遥控器占位 banner 里用的应用名兜底文案（中文）。各 gate 调用 `t('remoteApp.<id>', { defaultValue })`
 * 时用作 defaultValue,让占位文案能说「切到该设备才能操作终端/浏览器/手机」而不是泛泛的「这个 Agent」。
 * 未来在 i18n 资源补 `remoteApp.*` key 即可覆盖。
 */
export const EXECUTION_DEVICE_APP_LABEL_FALLBACK: Record<string, string> = {
  orchestration: '工作空间',
  tabcode: '代码',
  tabfolder: '文件',
  terminal: '终端',
  tabweb: '浏览器',
  tabdesktop: '桌面',
}
