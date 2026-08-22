import { useSpaceApps } from '@stores/useSpaceApps'
import { contextRegistry } from '@components/context-space/registry'

export type EnabledAppInfoForSend = {
  key: string
  cliKey?: string
  displayName: string
  capability: string
  aliases?: readonly string[]
}

/**
 * 采集当前执行 Space 对 Agent 可见的 App 列表（烘焙进 Host `<apps>` 段）。
 * 缺 agent metadata 的 handler 只告警跳过，不阻断发送。
 */
export function captureEnabledAppsForSend(
  runtimeSpaceId: string | undefined,
  log: { warn: (...args: unknown[]) => void },
): EnabledAppInfoForSend[] {
  if (!runtimeSpaceId) return []

  const capturedEnabledApps: EnabledAppInfoForSend[] = []
  const skippedAppIds: string[] = []

  const toEnabledAppInfo = (
    handler: ReturnType<typeof contextRegistry.getHandler>,
    fallbackKey: string,
  ): EnabledAppInfoForSend | null => {
    if (!handler?.agent) return null
    const cliKey = handler.agent.cliKey
      ?? (handler.backendAliases?.[0] && handler.backendAliases[0] !== handler.type
        ? handler.backendAliases[0]
        : undefined)
    return {
      key: handler.appId ?? fallbackKey,
      cliKey,
      displayName: handler.agent.displayName,
      capability: handler.agent.capability,
      aliases: handler.agent.aliases,
    }
  }

  const enabledAppInfos = useSpaceApps.getState().getEnabledApps(runtimeSpaceId)
  for (const info of enabledAppInfos) {
    const registeredHandler = contextRegistry.getHandler(info.id)
    const handler = contextRegistry.getAgentExposedHandler(info.id)
    // 声明了 Agent 元数据但被产品临时隐藏的 App 静默跳过。
    if (!handler && registeredHandler?.agent) continue
    const built = toEnabledAppInfo(handler, info.id)
    if (!built) {
      skippedAppIds.push(info.id)
      continue
    }
    capturedEnabledApps.push(built)
  }

  if (skippedAppIds.length > 0) {
    log.warn('[Chat] enabledApps 跳过缺 agent metadata 的 handler', { skippedAppIds })
  }

  return capturedEnabledApps
}
