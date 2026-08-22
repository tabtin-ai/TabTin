/**
 * 客户端展示用版本号：与 errorReporter / sourcemap 链路同源。
 *
 * 优先级：
 *   1. build 期 vite 注入的 VITE_APP_VERSION（package.json version，可由 CI 显式覆盖）
 *   2. main 进程 app.getVersion()（dev 未注入时的兜底）
 */
export function getBuildTimeAppVersion(): string {
  // 必须精确访问 import.meta.env.VITE_APP_VERSION，见 errorReporter.ts
  return import.meta.env.VITE_APP_VERSION || ''
}

export async function resolveDisplayAppVersion(): Promise<string> {
  const buildVersion = getBuildTimeAppVersion()
  if (buildVersion) return buildVersion

  try {
    const ipcVersion = await window.tabtin?.updater?.getAppVersion?.()
    return ipcVersion || ''
  } catch {
    return ''
  }
}
