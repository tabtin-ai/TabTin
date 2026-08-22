/**
 * Electron 宿主 telemetry sink 安装器。
 *
 * 职责：
 *   - 把 Runtime 的 `TelemetryRecord` 序列化后写入 electron-log（本地文件）
 *   - 补全宿主侧通用字段（host / app_version / platform）
 *   - **本期只落本地**；未来云端上报走 FR-10 AdminDash 接通
 *
 * 输出格式约定（对下游 jq 消费友好，Review Agent 要求）：
 *   一条 telemetry 事件 = 一行 `[telemetry] {完整 JSON}`，无多参数 meta 拆分。
 *   这样运维可以 `grep '^\[telemetry\]' main.log | sed 's/^\[telemetry\] //' | jq ...`。
 *
 * dev 模式落盘（Review #10）：
 *   `createLogger` 的 info 在 isDev 只 console.log，会导致开发环境 main.log 空。
 *   此处**单独**通过 `electronLog.scope('telemetry')` 强制文件 transport，
 *   让 dev 环境也能 tail 到日志，避免 Runbook 在开发机不可用。
 */

import { app } from 'electron'
import electronLog from 'electron-log'
import type { TelemetryRecord } from '@tabtin/agent-runtime'
import { setTelemetrySink } from '@tabtin/agent-runtime'

let installed = false

/**
 * 安装 Electron 侧 telemetry sink。多次调用会被忽略（幂等）。
 */
export function installElectronTelemetrySink(): void {
  if (installed) return
  installed = true

  const platform = process.platform
  const appVersion = safeGetVersion()
  const scopedLog = electronLog.scope('telemetry')
  // 不论开发/生产，埋点都要落本地文件，便于统一 Runbook。console 保持默认。
  const fileTransport = (electronLog.transports as { file?: { level?: string | false } }).file
  if (fileTransport && fileTransport.level === false) {
    fileTransport.level = 'info'
  }

  setTelemetrySink((record: TelemetryRecord) => {
    const enriched = {
      ...record,
      host: 'electron',
      platform,
      app_version: appVersion,
    }
    // 单行 `[telemetry] {JSON}` —— 与 Daemon sink 对齐，避免 jq 贪婪正则踩坑
    scopedLog.info(`[telemetry] ${JSON.stringify(enriched)}`)
  })
}

function safeGetVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}
