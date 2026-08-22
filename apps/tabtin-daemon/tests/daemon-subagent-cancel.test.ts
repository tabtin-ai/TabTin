/**
 * W0（2026-05-30）：`agent.subagent.cancel` 取消链路的 daemon 单测。
 *
 * 对照 `daemon-prompt-forward-validation.test.ts` 里 `prompt.cancel` 的三条对称
 * 用例，为「取消单个子 Agent」补自动化保护网。覆盖两条入口：
 *
 *   1. WS envelope `agent.subagent.cancel`（经 handleAgentEnvelopeEvent →
 *      feedAgentEnvelope → AgentHost.cancelSubagent）→ cancelSubagentById。
 *   2. CLI route `DELETE /agent/subagents/:childId`（经 handleAgentRoute → 注入的
 *      cliSubagentCancelResolver）→ 同样落到 cancelSubagentById。
 *
 * 背景：子 Agent 的 active/queued 登记是 agent-runtime 模块级**进程内**状态，
 * query 跑在哪个进程取消就要路由到哪个进程；这两条入口是让取消能打到 daemon
 * 进程的产线/CLI 通道，typecheck 之外必须有行为级单测兜住。
 *
 * 隔离说明：daemon 测试套件存在与本改动无关的预存红测（gitTools / security-ssrf /
 * persona / build / workspace-root / schema 漂移等多个独立根因）。本文件不依赖
 * 它们，按文件隔离可独立跑过。
 */

import { describe, expect, it, vi } from 'vitest';

import { TabTinDaemon } from '../src/bootstrap/daemon.js';
import { PromptForwardController } from '../src/application/agent/prompt-forward-controller.js';
import { handleAgentRoute } from '../src/transport/cli/routes/agent/index.js';
import { CliRequestContext } from '../src/transport/cli/cli-context.js';
import { createFeedAgentEnvelope } from './helpers/feed-agent-envelope-harness.js';

function createDaemonHarness() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const gateway = {
    sendAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
  const daemon = Object.create(TabTinDaemon.prototype) as {
    c: unknown;
    localAgentHost: unknown;
    state: string;
    lifecycle: { acceptsNewTasks(): boolean; getState(): string };
    promptForwardController: PromptForwardController;
    handleAgentEnvelopeEvent: (envelope: unknown) => Promise<void>;
  };
  daemon.c = { logger, gateway };
  daemon.state = 'running';
  daemon.lifecycle = {
    acceptsNewTasks: () => daemon.state === 'running',
    getState: () => daemon.state,
  };
  const cancelSubagentById = vi.fn().mockReturnValue(true);
  const host = {
    cancelSubagentById,
    feedAgentEnvelope: vi.fn(),
  };
  host.feedAgentEnvelope = vi.fn(
    createFeedAgentEnvelope({ cancelSubagentById }, logger),
  );
  daemon.localAgentHost = host;
  daemon.promptForwardController = new PromptForwardController({
    acceptsNewTasks: () => daemon.lifecycle.acceptsNewTasks(),
    lifecycleState: () => daemon.lifecycle.getState(),
    hasAgentHost: () => Boolean(daemon.localAgentHost),
    feed: envelope => {
      (daemon.localAgentHost as { feedAgentEnvelope(value: unknown): void }).feedAgentEnvelope(envelope);
    },
    reportFailure: vi.fn().mockResolvedValue(undefined),
    handleUnavailableUserResponse: vi.fn().mockResolvedValue(undefined),
    warn: message => logger.warn(message),
    debug: message => logger.debug(message),
  });
  return { daemon, gateway, logger };
}

function getCancelFn(daemon: { localAgentHost: unknown }) {
  return (daemon.localAgentHost as { cancelSubagentById: ReturnType<typeof vi.fn> }).cancelSubagentById;
}

describe('TabTinDaemon agent.subagent.cancel — WS envelope', () => {
  it('routes subagent.cancel to the local runtime by child id', async () => {
    const { daemon, gateway } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: { child_id: 'child-abc-1234' },
    });

    const cancelSubagentById = getCancelFn(daemon);
    expect(cancelSubagentById).toHaveBeenCalledTimes(1);
    // 透传完整 childId（== subagent_run_id），不截断
    expect(cancelSubagentById).toHaveBeenCalledWith('child-abc-1234');
    // 取消是纯进程内动作，不往 gateway 回吐事件
    expect(gateway.sendAgentEvent).not.toHaveBeenCalled();
  });

  it('logs a not-matched warning when the child id is unknown / wrong process (resolver false)', async () => {
    const { daemon, logger } = createDaemonHarness();
    getCancelFn(daemon).mockReturnValue(false); // 本进程没这个 childId

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: { child_id: 'child-not-here' },
    });

    expect(getCancelFn(daemon)).toHaveBeenCalledWith('child-not-here');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('subagent.cancel not matched'),
    );
  });

  it('rejects invalid subagent.cancel payloads before touching the runtime (missing child_id)', async () => {
    const { daemon, logger } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: {},
    });

    expect(getCancelFn(daemon)).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid subagent.cancel payload'),
    );
  });

  it('rejects subagent.cancel payloads with a non-string child_id', async () => {
    const { daemon, logger } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: { child_id: 12345 },
    });

    expect(getCancelFn(daemon)).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid subagent.cancel payload'),
    );
  });

  it('rejects subagent.cancel payloads with an empty-string child_id (W0 polish: schema .min(1))', async () => {
    const { daemon, logger } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: { child_id: '' },
    });

    // .min(1) 让空串与"缺失/非字符串"同走 invalid 分支，不触碰 runtime，
    // 与 CLI route 的 `if (!childId)` 400 兜底两端一致。
    expect(getCancelFn(daemon)).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid subagent.cancel payload'),
    );
  });

  it('does not cancel (and does not crash) when subagent.cancel arrives before local host init', async () => {
    const { daemon, logger } = createDaemonHarness();
    daemon.localAgentHost = null;

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.subagent.cancel',
      thread_id: 'session-1',
      payload: { child_id: 'child-abc-1234' },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('subagent.cancel received but localAgentHost not initialised'),
    );
  });
});

describe('Daemon CLI route DELETE /agent/subagents/:childId', () => {
  const createContext = (resolver: ((childId: string) => boolean) | null) => new CliRequestContext(
    { get: () => undefined, set: () => {} },
    { subagentCancelResolver: resolver },
  );

  it('routes the DELETE to the injected resolver → cancelSubagentById, returns 200', async () => {
    const cancelFn = vi.fn().mockReturnValue(true);
    const context = createContext(cancelFn);

    const sendJSON = vi.fn();
    const res = {} as never; // handleSubagentCancel 只把 res 透传给 sendJSON（已 mock）

    await handleAgentRoute('/agent/subagents/child-xyz-9', 'DELETE', undefined, res, sendJSON, context);

    expect(cancelFn).toHaveBeenCalledTimes(1);
    expect(cancelFn).toHaveBeenCalledWith('child-xyz-9');
    expect(sendJSON).toHaveBeenCalledTimes(1);
    expect(sendJSON.mock.calls[0][1]).toBe(200); // status code
  });

  it('returns 404 when the child id is not found in this process (resolver false)', async () => {
    const cancelFn = vi.fn().mockReturnValue(false);
    const context = createContext(cancelFn);

    const sendJSON = vi.fn();
    const res = {} as never;

    await handleAgentRoute('/agent/subagents/child-gone', 'DELETE', undefined, res, sendJSON, context);

    expect(cancelFn).toHaveBeenCalledWith('child-gone');
    expect(sendJSON.mock.calls[0][1]).toBe(404);
  });

  it('returns 503 when no resolver is injected (local agent host not up)', async () => {
    const context = createContext(null);

    const sendJSON = vi.fn();
    const res = {} as never;

    await handleAgentRoute('/agent/subagents/child-xyz-9', 'DELETE', undefined, res, sendJSON, context);

    expect(sendJSON.mock.calls[0][1]).toBe(503);
  });
});
