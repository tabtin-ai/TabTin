/**
 * Daemon 宿主 telemetry sink 安装器。
 *
 * 与 Electron 对称：序列化为 JSON 一行，写入 daemon Logger。运维可用：
 *   tail -f ~/.tabtin-daemon/daemon.log | grep '\[telemetry\]' | \
 *     jq -R 'sub("^.*\\[telemetry\\] ";"") | fromjson'
 *
 * 日志路径取决于 `ConfigManager`（默认 `~/.tabtin-daemon/daemon.log`）。
 * 调用时机：`DaemonAgentHost.start()` 首行，保证早于任何埋点发出。
 */

import type { TelemetryRecord } from '@tabtin/agent-runtime';
import { setTelemetrySink } from '@tabtin/agent-runtime';
import { readDaemonVersion } from '../../../platform/system/update/daemon-version.js';
import type { Logger } from '../logging/logger.js';

let installed = false;

/**
 * 安装 Daemon 侧 sink。幂等——多次调用仅首次生效。
 */
export function installDaemonTelemetrySink(logger: Logger): void {
  if (installed) return;
  installed = true;

  const platform = process.platform;
  // 逐级向上找包根读版本——旧实现写死两级上跳，在 tsup 单 bundle 布局
  // （dist/index.js）下落到错误路径，生产 app_version 恒为 unknown。
  const appVersion = readDaemonVersion();

  setTelemetrySink((record: TelemetryRecord) => {
    const enriched = {
      ...record,
      host: 'daemon',
      platform,
      app_version: appVersion,
    };
    logger.info(`[telemetry] ${JSON.stringify(enriched)}`);
  });
}
