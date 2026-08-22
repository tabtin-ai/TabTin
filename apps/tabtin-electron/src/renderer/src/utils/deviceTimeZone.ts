/**
 * 解析当前设备的 IANA 时区名（譬如 `Asia/Shanghai`）。
 *
 * 这是「用户设备时区」的 SSoT —— 凡是要把时区透传给 Agent runtime（让它按用户
 * 本地而非 host 时区渲染时间）的地方都从这里取，避免各处 `Intl...` 散落 + 不一致。
 *
 * 取不到（极旧环境 / Intl 不可用）时返回 `undefined`，下游按 UTC 安全降级。
 */
export function resolveDeviceTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && typeof tz === 'string' ? tz : undefined
  } catch {
    return undefined
  }
}
