/**
 * localDocParse — Daemon 侧本地附件解析
 *
 * **H2-E 实施**：thin wrapper，把 `@tabtin/local-docparse` 的纯逻辑接到 Daemon
 * 的 worker pool（`../workers/doc-parser-runner`）上。与 Electron
 * `apps/tabtin-electron/src/main/services/localDocParse.ts` 对称。
 *
 * **Daemon 默认体积上限 20MB**（vs Electron 50MB），原因：
 *   - Daemon 跑在用户的 NAS / 公司服务器 / 个人 PC 后台，CPU/内存可能弱于桌面
 *   - PRD 决策 D1：默认本地解析阈值更保守
 *
 * **配置覆盖**：当前**仅支持环境变量** `TABTIN_LOCAL_DOCPARSE_MAX_MB`（详见
 * `packages/agent-host/src/configuration/host-runtime-options.ts` 的 `resolveMaxLocalFileSizeMb`）。
 * 体积阈值未纳入 `DaemonConfig` 持久化字段（`apps/tabtin-daemon/src/base/types/daemon-config.ts`），
 * 因此 `tabtin-daemon config --set max_local_file_size_mb=N` 不生效；运维需在
 * Daemon 启动时通过环境变量传入。如未来产品需要 per-tenant 动态体积上限，
 * 应：(a) 加 DaemonConfig 字段 + CONFIG_SETTABLE_KEYS 白名单；(b) 在
 * `DaemonAgentHost` 构造期优先读 config 再 fallback env。
 */

import {
  parseLocalAttachment as parseLocalAttachmentShared,
  type LocalDocParseOptions,
  type LocalDocParseResult,
  type ParseLocalAttachmentInput,
} from '@tabtin/local-docparse';
import type { Logger } from '../../observability/logging/logger.js';
import type { RunDocParserTask } from '@tabtin/local-docparse';

/**
 * Daemon 默认本地处理上限（MB）。比 Electron 50MB 保守，对齐 PRD H2-E 决策 D1。
 * 用户可通过 env / config 调整（见 `packages/agent-host/src/configuration/host-runtime-options.ts`
 * `resolveMaxLocalFileSizeMb`）。
 */
export const DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB = 20;

export interface DaemonParseLocalAttachmentOverrides {
  /** Daemon-specific 阈值覆盖。`maxFileSizeMb` 留空走 `DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB`。 */
  maxFileSizeMb?: number;
}

/**
 * 本地解析附件（Daemon 入口）。
 *
 * 与 Electron 端签名差异：
 *   - 必须传入 `logger`（Daemon 没有全局 createLogger，logger 由 Daemon 容器
 *     注入，便于运维定位日志来源）
 *   - 默认 `maxFileSizeMb = 20`（Electron 50），通过 `defaults` 注入而非硬编码
 *     在 packages（packages 默认仍 50，否则 Electron 会被 Daemon 默认连带改）
 */
export function parseLocalAttachment(
  input: ParseLocalAttachmentInput,
  options: LocalDocParseOptions,
  logger: Logger,
  runDocParserTask: RunDocParserTask,
  overrides?: DaemonParseLocalAttachmentOverrides,
): Promise<LocalDocParseResult> {
  const effectiveMax = options.maxFileSizeMb
    ?? overrides?.maxFileSizeMb
    ?? DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB;

  return parseLocalAttachmentShared(
    input,
    {
      ...options,
      maxFileSizeMb: effectiveMax,
    },
    {
      runDocParserTask,
      // Daemon Logger 的 debug 签名是 `(message: string, ...args: any[])`；packages
      // 期望 `(...args: unknown[])`。包一层把首参字符串化即可（实际只用于 tmp 清理
      // 失败这种诊断日志，全是字符串字面量+原因，无类型损失）。
      logger: {
        debug: (...args: unknown[]) => {
          const [first, ...rest] = args;
          logger.debug(typeof first === 'string' ? first : String(first), ...rest);
        },
      },
    },
  );
}

// ─── 重导出共享包类型 ─────────────────────────────────────────────

export type {
  LocalDocParseErrorClass,
  LocalDocParseFailure,
  LocalDocParseOptions,
  LocalDocParseResult,
  LocalDocParseSuccess,
  ParseLocalAttachmentInput,
} from '@tabtin/local-docparse';

// W1（2026-05-13）：re-export 全局 ErrorCode 枚举常量，让 DaemonAgentHost
// 等消费方走 `FilePipelineErrorCode.FILE_TOO_LARGE` 等具名枚举（不再 hardcode
// `'oversize'` / `'scanned'` 等已退役字面值）。
export { FilePipelineErrorCode } from '@tabtin/local-docparse';

// W1.3 第 3 轮 Review 2 S1（2026-05-13）：持久通道 main agent 注入中文转述路径
// + type guard。SSoT 在 `@tabtin/file-pipeline-errors`，与 Electron 同源派发。
export {
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
} from '@tabtin/local-docparse';
