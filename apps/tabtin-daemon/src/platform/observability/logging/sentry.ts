/**
 * Daemon Sentry 错误监控接入（，errors-only）。
 *
 * 启用条件：`SENTRY_DSN` 环境变量或 config.json 的 `sentry_dsn` 字段有值。
 * Daemon 不读仓库根 .env（部署形态是 npm 全局安装 + systemd/launchd），
 * DSN 走运维口径：`Environment=SENTRY_DSN=...` 或
 * `tabtin-daemon config --set sentry_dsn=...`。不配置时不加载 SDK，零开销。
 *
 * 字段契约（tags 白名单 / 脱敏红线）：docs/agent/error-context-schema.md。
 * 脱敏与 Electron 同源（@tabtin/shared/sentry-scrub）；同指纹限频与 Django
 * 端 tabtin/sentry.py 同口径（每指纹每分钟最多 5 条），防止 relay/重试类
 * 高频错误路径打爆自部署 Sentry。
 *
 * Runtime（@tabtin/agent-runtime）本身不依赖 @sentry/*：run 级致命错误统一
 * 由宿主 DaemonAgentHost.handleQuery 的 catch 调 `captureRunError` 收口，
 * capture 时显式带 run 上下文 tags——Daemon 并发多 session，全局 scope
 * setTag 会互相污染，收口处显式传 tags 才并发安全。
 */

import { createRequire } from 'node:module';
import { scrubSentryEvent } from '@tabtin/shared/sentry-scrub';
import type { DaemonConfig } from '../../../base/types/daemon-config.js';
import { readDaemonVersion } from '../../../platform/system/update/daemon-version.js';
import type { Logger } from './logger.js';

type SentryNode = typeof import('@sentry/node');

const requireModule = createRequire(import.meta.url);

let sdk: SentryNode | null = null;

/** 供诊断/自检读取：Daemon Sentry 是否真正启用。 */
export function isSentryEnabled(): boolean {
  return sdk !== null;
}

// ── 同指纹限频（洪水保护，与 Django tabtin/sentry.py 同口径） ──────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_TABLE_CAP = 512;

interface SentryEventLike {
  message?: unknown;
  logentry?: { message?: unknown };
  exception?: { values?: Array<{ type?: unknown; value?: unknown }> };
}

/** fingerprint -> [窗口起点, 窗口内已放行条数] */
const fingerprintHits = new Map<string, [number, number]>();

function eventFingerprint(event: SentryEventLike): string {
  const first = event.exception?.values?.[0];
  if (first) {
    return `exc:${String(first.type)}:${String(first.value).slice(0, 120)}`;
  }
  if (typeof event.logentry?.message === 'string') {
    return `log:${event.logentry.message.slice(0, 160)}`;
  }
  return `msg:${String(event.message).slice(0, 160)}`;
}

/**
 * 同指纹限频判定。返回 true 表示该事件应被丢弃。导出仅为单测。
 * 用单调钟（performance.now，与 Django 版 time.monotonic 对齐）——挂钟回拨
 * 会让 `now - started < 0`、窗口迟迟不重置，限频窗口被无声拉长。
 */
export function isRateLimited(event: SentryEventLike, now = performance.now()): boolean {
  const key = eventFingerprint(event);
  let [started, count] = fingerprintHits.get(key) ?? [0, 0];
  if (now - started >= RATE_LIMIT_WINDOW_MS) {
    started = now;
    count = 0;
  }
  if (count >= RATE_LIMIT_MAX) {
    fingerprintHits.set(key, [started, count]);
    return true;
  }
  if (fingerprintHits.size >= RATE_LIMIT_TABLE_CAP && !fingerprintHits.has(key)) {
    // 表满先清过期项；仍满则整表重置（宁可放行也不无界增长）
    for (const [k, [ts]] of fingerprintHits) {
      if (now - ts >= RATE_LIMIT_WINDOW_MS) fingerprintHits.delete(k);
    }
    if (fingerprintHits.size >= RATE_LIMIT_TABLE_CAP) fingerprintHits.clear();
  }
  fingerprintHits.set(key, [started, count + 1]);
  return false;
}

/** 单测隔离用：清空限频表。 */
export function resetRateLimiter(): void {
  fingerprintHits.clear();
}

// ── 初始化 ──────────────────────────────────────────────────────────

/**
 * 初始化 Daemon Sentry。在 createDaemonContainer 里 config 加载后立即调用
 * （早于所有服务构建，保证后续任何位置的 captureRunError 可用）。
 * 失败绝不阻塞启动。
 */
export function initSentryDaemon(config: DaemonConfig, logger: Logger): void {
  const dsn = (process.env.SENTRY_DSN || config.sentry_dsn || '').trim();
  if (!dsn) return;

  try {
    // 同步 require（CJS 入口）：与 Electron 主进程同款条件加载手法，
    // 未配置 DSN 时完全不加载 SDK。
    const Sentry = requireModule('@sentry/node') as SentryNode;
    Sentry.init({
      dsn,
      environment: (process.env.SENTRY_ENVIRONMENT || '').trim() || 'prod',
      release: `tabtin-daemon@${readDaemonVersion()}`,
      // errors-only：不采集性能事务
      tracesSampleRate: 0,
      sendDefaultPii: false,
      // 进程级钩子的唯一真相在 ProcessManager（captureFatal + flush 后再优雅
      // 停机）。SDK 默认的 OnUncaughtException / OnUnhandledRejection 集成
      // 会：① 对同一崩溃重复上报一条；② OnUncaughtException 在检测到其他
      // handler 后仍可能自行 exit，与 ProcessManager 的 graceful shutdown
      // （15s 收尾）打架。两个都禁掉，保证单一收口。
      integrations: (defaults) =>
        defaults.filter(
          (i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection',
        ),
      beforeSend: (event) => {
        if (isRateLimited(event as SentryEventLike)) return null;
        return scrubSentryEvent(event);
      },
    });

    // 静态 tags：Daemon 是单 organization / 单 device 模型，进程级设置即可
    Sentry.setTag('device_id', config.device_id);
    Sentry.setTag('organization_id', config.organization_id);

    sdk = Sentry;
    logger.info(`[Sentry] Daemon 错误上报已启用 environment=${process.env.SENTRY_ENVIRONMENT || 'prod'}`);
  } catch (error) {
    logger.error('[Sentry] Daemon 初始化失败（继续启动，不上报）:', error);
  }
}

// ── 上报入口 ────────────────────────────────────────────────────────

/** run 错误上下文（键名以 error-context-schema.md 白名单为准）。 */
export interface RunErrorContext {
  handled_by: string;
  error_category: 'AGENT_RUN_FATAL' | 'AGENT_DOOM_LOOP' | 'AGENT_PROTOCOL_FATAL';
  error_code: string;
  run_id?: string;
  session_id?: string;
  agent_id?: string;
  organization_id?: string;
  workspace_id?: string;
  space_id?: string;
  task_id?: string;
}

/**
 * Run 级致命错误收口上报。未启用时是 no-op。
 * 低基数分类走 tags，高基数关联 ID 走 contexts.tabtin；两者都用 withScope
 * 逐事件设置，避免并发 session 互相污染。
 */
export function captureRunError(error: unknown, context: RunErrorContext): void {
  if (!sdk) return;
  try {
    sdk.withScope((scope) => {
      scope.setTag('handled_by', context.handled_by);
      scope.setTag('error_category', context.error_category);
      scope.setTag('error_code', context.error_code);
      const tabtinContext = Object.fromEntries(Object.entries({
        organization_id: context.organization_id,
        workspace_id: context.workspace_id,
        space_id: context.space_id,
        agent_id: context.agent_id,
        session_id: context.session_id,
        run_id: context.run_id,
        task_id: context.task_id,
      }).filter(([, value]) => Boolean(value)));
      scope.setContext('tabtin', tabtinContext);
      scope.setFingerprint([
        'agent-run',
        context.error_category,
        context.error_code,
      ]);
      sdk!.captureException(error);
    });
  } catch {
    // 上报失败不影响主流程
  }
}

/**
 * 进程级兜底上报（uncaughtException / 致命 unhandledRejection）。
 * 返回的 Promise **保证 settle**（flush 2s 超时 + 3s watchdog race 双保险），
 * 调用方 `.finally(shutdown)` 不会因 SDK flush 违约悬挂而永不进入 shutdown。
 */
export function captureFatal(error: unknown, kind: string): Promise<void> {
  if (!sdk) return Promise.resolve();
  try {
    sdk.withScope((scope) => {
      scope.setTag('handled_by', kind);
      sdk!.captureException(error);
    });
    const flushed = sdk
      .flush(2_000)
      .then(() => undefined)
      .catch(() => undefined);
    const watchdog = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      timer.unref?.();
    });
    return Promise.race([flushed, watchdog]);
  } catch {
    return Promise.resolve();
  }
}
