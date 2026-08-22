/**
 * Daemon Sentry 接入单测。
 *
 * 覆盖：无 DSN 时零副作用 no-op、同指纹限频（与 Django tabtin/sentry.py
 * 同口径：每指纹每分钟 5 条）、captureRunError 未启用时静默、以及真 SDK
 * init（无效 host DSN，SDK 惰性发送不会真出网络）下的 release / beforeSend
 * 链 / captureRunError tags 断言。
 * 脱敏本体的测试在 packages/tabtin-shared/src/__tests__/sentry-scrub.test.ts。
 *
 * ⚠️ 「真 SDK init」的 describe 必须放在文件最后：initSentryDaemon 成功后
 * 模块级 sdk 单例不可逆，会让前面的 no-op 断言失效。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initSentryDaemon,
  isSentryEnabled,
  isRateLimited,
  resetRateLimiter,
  captureRunError,
  captureFatal,
} from '../src/platform/observability/logging/sentry.js';
import { readDaemonVersion } from '../src/platform/system/update/daemon-version.js';
import type { DaemonConfig } from '../src/base/types/daemon-config.js';
import type { Logger } from '../src/platform/observability/logging/logger.js';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function fakeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    server_url: 'http://localhost:6060',
    ws_url: 'ws://localhost:6060',
    device_id: 'device-1',
    fingerprint: 'daemon-abc',
    credential: 'cred',
    organization_id: 'wt-1',
    device_name: 'test',
    plugins: [],
    capabilities: [],
    log_level: 'info',
    log_file: null,
    heartbeat_interval_ms: 15_000,
    proxy: null,
    ...overrides,
  };
}

describe('initSentryDaemon', () => {
  it('无 DSN（env 与 config 均空）时不启用', () => {
    delete process.env.SENTRY_DSN;
    initSentryDaemon(fakeConfig(), noopLogger);
    expect(isSentryEnabled()).toBe(false);
  });

  it('未启用时 captureRunError / captureFatal 是安全 no-op', async () => {
    expect(() =>
      captureRunError(new Error('x'), {
        handled_by: 'daemon_agent_host',
        error_category: 'AGENT_RUN_FATAL',
        error_code: 'INTERNAL',
        session_id: 's1',
      }),
    ).not.toThrow();
    await expect(captureFatal(new Error('y'), 'daemon_uncaught_exception')).resolves.toBeUndefined();
  });
});

describe('DaemonAgentHost run 错误接线', () => {
  it('只把可上报且非取消的 turn 错误交给 Sentry', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'application', 'agent', 'daemon-agent-host.ts'),
      'utf-8',
    );
    const hookStart = source.indexOf('onTurnError: (error, query, aborted) => {');
    const hookEnd = source.indexOf('onTurnFinally:', hookStart);
    expect(hookStart).toBeGreaterThan(-1);
    expect(hookEnd).toBeGreaterThan(hookStart);
    const hook = source.slice(hookStart, hookEnd);
    expect(hook).toContain('if (aborted) return;');
    expect(hook).toContain('isReportableRunError(classified.category)');
    expect(hook).toContain('captureRunError(error, {');
    expect(hook).toContain("handled_by: 'daemon_agent_host'");
    expect(hook).toContain('run_id: query.identity.runId');
  });
});

describe('isRateLimited（同指纹限频，窗口 60s / 上限 5 条）', () => {
  beforeEach(() => resetRateLimiter());

  const excEvent = (value: string) => ({
    exception: { values: [{ type: 'Error', value }] },
  });

  it('同指纹第 6 条起被丢弃', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(excEvent('boom'), t0 + i)).toBe(false);
    }
    expect(isRateLimited(excEvent('boom'), t0 + 10)).toBe(true);
  });

  it('不同指纹互不影响', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) isRateLimited(excEvent('boom'), t0);
    expect(isRateLimited(excEvent('boom'), t0)).toBe(true);
    expect(isRateLimited(excEvent('other failure'), t0)).toBe(false);
  });

  it('窗口过期后重新放行', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) isRateLimited(excEvent('boom'), t0);
    expect(isRateLimited(excEvent('boom'), t0 + 61_000)).toBe(false);
  });

  it('message 类事件按 message 指纹', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited({ message: 'relay drop' }, t0)).toBe(false);
    }
    expect(isRateLimited({ message: 'relay drop' }, t0)).toBe(true);
  });
});

describe('readDaemonVersion', () => {
  it('逐级上找包根，返回 @tabtin/daemon 的真实版本（不是 unknown）', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(readDaemonVersion()).toBe(pkg.version);
  });
});

// ⚠️ 必须是文件最后一个 describe（init 后模块级 sdk 单例不可逆，见文件头注释）
describe('真 SDK init（DSN 指向无效 host，惰性发送不出网络）', () => {
  beforeEach(() => resetRateLimiter());

  it('init 成功：release/environment/beforeSend 生效，run 分类与关联上下文分层上报', async () => {
    delete process.env.SENTRY_ENVIRONMENT;
    initSentryDaemon(
      fakeConfig({ sentry_dsn: 'https://pubkey@sentry.invalid.localdomain/1' }),
      noopLogger,
    );
    expect(isSentryEnabled()).toBe(true);

    const Sentry = await import('@sentry/node');
    const client = Sentry.getClient();
    expect(client).toBeDefined();
    const options = client!.getOptions();

    // P1-1 回归：tsup 单 bundle 布局下曾恒为 unknown
    expect(options.release).toBe(`tabtin-daemon@${readDaemonVersion()}`);
    expect(options.release).not.toContain('unknown');
    expect(options.environment).toBe('prod');
    expect(options.tracesSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);

    // beforeSend 链：先限频后脱敏
    const beforeSend = options.beforeSend!;
    const scrubbed = beforeSend(
      { message: 'login failed for 13812345678 at /Users/alice/app' } as never,
      {},
    ) as { message?: string } | null;
    expect(scrubbed).not.toBeNull();
    expect(scrubbed!.message).not.toContain('13812345678');
    expect(scrubbed!.message).toContain('/Users/<user>');

    resetRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(beforeSend({ message: 'flood msg' } as never, {})).not.toBeNull();
    }
    expect(beforeSend({ message: 'flood msg' } as never, {})).toBeNull();

    // captureRunError：run 上下文 tags + 进程级静态 tags 都进最终事件
    const seen: Array<{
      tags?: Record<string, unknown>;
      contexts?: Record<string, Record<string, unknown>>;
    }> = [];
    client!.on('beforeSendEvent', (event) => {
      seen.push(event as {
        tags?: Record<string, unknown>;
        contexts?: Record<string, Record<string, unknown>>;
      });
    });
    resetRateLimiter();
    captureRunError(new Error('run exploded'), {
      handled_by: 'daemon_agent_host',
      error_category: 'AGENT_RUN_FATAL',
      error_code: 'INTERNAL',
      run_id: 'run-1',
      session_id: 'sess-1',
      agent_id: 'agent-1',
      space_id: undefined, // 缺省字段不应上报
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const tags = seen[0].tags ?? {};
    expect(tags.handled_by).toBe('daemon_agent_host');
    expect(tags.error_category).toBe('AGENT_RUN_FATAL');
    expect(tags.error_code).toBe('INTERNAL');
    expect(tags).not.toHaveProperty('run_id');
    expect(tags).not.toHaveProperty('session_id');
    expect(tags).not.toHaveProperty('agent_id');
    const tabtin = seen[0].contexts?.tabtin ?? {};
    expect(tabtin.run_id).toBe('run-1');
    expect(tabtin.session_id).toBe('sess-1');
    expect(tabtin.agent_id).toBe('agent-1');
    expect(tabtin).not.toHaveProperty('space_id');
    // init 时设置的进程级静态 tags
    expect(tags.device_id).toBe('device-1');
    expect(tags.organization_id).toBe('wt-1');
  });

  it('启用后 captureFatal 返回的 Promise 必然 settle（flush 超时 + watchdog 兜底）', async () => {
    await expect(captureFatal(new Error('fatal'), 'daemon_uncaught_exception')).resolves.toBeUndefined();
  });
});
