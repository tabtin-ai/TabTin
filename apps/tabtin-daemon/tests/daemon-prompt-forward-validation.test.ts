import { describe, expect, it, vi } from 'vitest';
import { AgentStreamEvents } from '@tabtin/ws-gateway-client';
import { correlateSourceClientEvent } from '@tabtin/agent-host/delivery';
import {
  decodeForwardRequestDetailed,
  type ForwardConversationRequest,
} from '@tabtin/agent-host/conversation';

import { TabTinDaemon } from '../src/bootstrap/daemon.js';
import { PromptForwardController } from '../src/application/agent/prompt-forward-controller.js';
import { createFeedAgentEnvelope } from './helpers/feed-agent-envelope-harness.js';

interface DaemonHarness {
  c: unknown;
  localAgentHost: unknown;
  promptForwardController: PromptForwardController;
  lifecycle: { acceptsNewTasks(): boolean; getState(): string };
  state: string;
  handleAgentEnvelopeEvent: (envelope: unknown) => Promise<void>;
  routeToLocalAgentHost: (
    request: ForwardConversationRequest,
    envelope: Record<string, unknown>,
  ) => Promise<boolean>;
  reportPromptForwardFailure: (
    envelope: Record<string, unknown>,
    rawPayload: Record<string, unknown>,
    errorMessage: string,
  ) => Promise<void>;
  getPromptForwardRawPayload: (envelope: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * 把 forward envelope 走一遍共享 decoder + 走 daemon 端映射。共享 decoder 失败
 * 直接调 `reportPromptForwardFailure`（等价于 `bindPromptForwardDecodeFailedHandler`
 * 走的路径）；成功则调用 `routeToLocalAgentHost(request, envelope)`。
 */
async function dispatchForward(
  daemon: DaemonHarness,
  envelope: Record<string, unknown>,
): Promise<void> {
  const rawPayload = daemon.getPromptForwardRawPayload(envelope);
  const result = decodeForwardRequestDetailed(
    envelope,
    { warn: vi.fn(), debug: vi.fn() },
  );
  if (!result.ok) {
    await daemon.reportPromptForwardFailure(envelope, rawPayload, result.error);
    return;
  }
  await daemon.routeToLocalAgentHost(result.request, envelope);
}

function createDaemonHarness() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const gateway = {
    sendAgentEvent: vi.fn().mockResolvedValue(undefined),
    relayEvents: vi.fn().mockResolvedValue(undefined),
  };
  const daemon = Object.create(TabTinDaemon.prototype) as DaemonHarness;
  (daemon as unknown as { c: { logger: unknown; gateway: unknown } }).c = { logger, gateway };
  daemon.state = 'running';
  daemon.lifecycle = {
    acceptsNewTasks: () => daemon.state === 'running',
    getState: () => daemon.state,
  };
  const handleAbort = vi.fn().mockReturnValue({ success: true });
  const host = {
    handleQuery: vi.fn().mockResolvedValue({ success: true }),
    handleAbort,
    feedAgentEnvelope: vi.fn(),
  };
  host.feedAgentEnvelope = vi.fn(
    createFeedAgentEnvelope(
      {
        handleAbort,
        routeForward: (envelope) => dispatchForward(daemon, envelope),
      },
      logger,
    ),
  );
  daemon.localAgentHost = host;
  daemon.promptForwardController = new PromptForwardController({
    acceptsNewTasks: () => daemon.lifecycle.acceptsNewTasks(),
    lifecycleState: () => daemon.lifecycle.getState(),
    hasAgentHost: () => Boolean(daemon.localAgentHost),
    feed: (envelope) => {
      (daemon.localAgentHost as { feedAgentEnvelope(value: unknown): void }).feedAgentEnvelope(envelope);
    },
    reportFailure: (envelope, payload, message) => daemon.reportPromptForwardFailure(envelope, payload, message),
    handleUnavailableUserResponse: async () => undefined,
    warn: (message) => logger.warn(message),
    debug: (message) => logger.debug(message),
  });
  return { daemon, gateway, logger };
}

describe('TabTinDaemon prompt.forward validation', () => {
  it('correlates main-turn assistant and lifecycle events with the source client event', () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    for (const type of [
      'agent.stream.lifecycle',
      'agent.stream.message_start',
      'agent.stream.message_delta',
      'agent.stream.message_stop',
      'agent.stream.assistant',
      'agent.stream.persist_message',
      'agent.stream.done',
    ]) {
      expect(
        correlateSourceClientEvent({ type, payload: {} }, sourceId).payload,
      ).toMatchObject({ source_client_event_id: sourceId });
    }
  });

  it('relays schema failures as an agent.stream.done(error) event', async () => {
    const { daemon, gateway } = createDaemonHarness();

    // 触发共享 decoder 校验失败（authorization_preset 非枚举值不会失败，因为
    // wire schema 无该字段；用非法枚举字段——譬如 approval_mode）。这里保留
    // 老测试的 authorization_preset 但补一个真正会让 zod 拒的字段以触发 schema
    // 失败：agent_config 非 object。
    await dispatchForward(daemon, {
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-sess-1',
      payload: {
        task_id: 'prompt_bad',
        client_message_id: '11111111-1111-4111-8111-111111111111',
        prompt: 'hello',
        attachments: [],
        agent_config: 'not-an-object',
      },
    });

    expect(gateway.sendAgentEvent).not.toHaveBeenCalled();
    expect(gateway.relayEvents).toHaveBeenCalledTimes(1);
    expect(gateway.relayEvents).toHaveBeenCalledWith('sess-1', [
      expect.objectContaining({
        type: AgentStreamEvents.DONE,
        payload: expect.objectContaining({
          task_id: 'prompt_bad',
          agent_type: 'local-runtime',
          content: '',
          error: true,
          source_client_event_id: '11111111-1111-4111-8111-111111111111',
        }),
      }),
    ]);
    expect(gateway.relayEvents.mock.calls[0]?.[1]?.[0]?.payload?.error_message)
      .toContain('Invalid prompt.forward payload');
  });

  it('routes prompt.forward with task id for runtime and chat session id for relay_events', async () => {
    const { daemon } = createDaemonHarness();

    await dispatchForward(daemon, {
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-session-123',
      payload: {
        task_id: 'prompt_abc',
        run_id: '33333333-3333-4333-8333-333333333333',
        client_message_id: '22222222-2222-4222-8222-222222222222',
        prompt: 'hello',
        agent_config: { type: 'local' },
        model_id: 'model-1',
        agent_id: 'agent-1',
        workspace_id: 'workspace-1',
        attachment_strategy: 'local_first',
      },
    });

    const handleQuery = (daemon.localAgentHost as { handleQuery: ReturnType<typeof vi.fn> }).handleQuery;
    expect(handleQuery).toHaveBeenCalledTimes(1);
    expect(handleQuery).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'prompt_abc',
      runId: '33333333-3333-4333-8333-333333333333',
      taskId: 'prompt_abc',
      relaySessionId: 'session-123',
      modelId: 'model-1',
      agentId: 'agent-1',
      attachmentStrategy: 'local_first',
      clientMessageId: '22222222-2222-4222-8222-222222222222',
    }));
  });

  it('解出 custom_rules / personal_rules 分层规则并透传 handleQuery（IA Phase 3·3B-1 I-1 行为不变量）', async () => {
    // 锁 wire envelope snake→camel 解包：Django prompt_forward_service 以
    // snake_case 透传 Agent 专属 custom_rules + owner 个人 personal_rules，
    // 共享 decoder 解出 camelCase 两字段 → daemon.ts routeToLocalAgentHost
    // 直接从 request 拿再透到 DaemonAgentHost.handleQuery。
    const { daemon } = createDaemonHarness();

    await dispatchForward(daemon, {
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-session-rules',
      payload: {
        task_id: 'prompt_rules',
        prompt: 'hello',
        agent_config: { type: 'local' },
        workspace_id: 'workspace-rules',
        custom_rules: 'Agent专属',
        personal_rules: '请用中文',
      },
    });

    const handleQuery = (daemon.localAgentHost as { handleQuery: ReturnType<typeof vi.fn> }).handleQuery;
    expect(handleQuery).toHaveBeenCalledTimes(1);
    expect(handleQuery).toHaveBeenCalledWith(expect.objectContaining({
      customRules: 'Agent专属',
      personalRules: '请用中文',
    }));
  });

  it('does not report schema failures without a thread id', async () => {
    const { daemon, gateway, logger } = createDaemonHarness();

    await dispatchForward(daemon, {
      type: 'agent.prompt.forward',
      payload: {
        task_id: 'prompt_bad',
        prompt: 'hello',
        attachments: [],
        agent_config: 'not-an-object',
      },
    });

    expect(gateway.sendAgentEvent).not.toHaveBeenCalled();
    expect(gateway.relayEvents).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Daemon] Cannot report prompt.forward failure: missing thread_id',
    );
  });

  it('relays a terminal error when the daemon is draining', async () => {
    const { daemon, gateway } = createDaemonHarness();
    daemon.state = 'draining';

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-sess-1',
      payload: {
        task_id: 'prompt_draining',
        prompt: 'hello',
        attachments: [],
        agent_config: {},
      },
    });

    expect(gateway.relayEvents).toHaveBeenCalledTimes(1);
    expect(gateway.relayEvents).toHaveBeenCalledWith('sess-1', [
      expect.objectContaining({
        type: AgentStreamEvents.DONE,
        payload: expect.objectContaining({
          task_id: 'prompt_draining',
          error: true,
          error_message: expect.stringContaining('daemon is draining'),
        }),
      }),
    ]);
  });

  it('does not route prompt.forward before the complete runtime is ready', async () => {
    const { daemon, gateway } = createDaemonHarness();
    daemon.state = 'starting';

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-sess-1',
      payload: {
        task_id: 'prompt_during_startup',
        prompt: 'hello',
        attachments: [],
        agent_config: {},
      },
    });

    const host = daemon.localAgentHost as { feedAgentEnvelope: ReturnType<typeof vi.fn> };
    expect(host.feedAgentEnvelope).not.toHaveBeenCalled();
    expect(gateway.relayEvents).toHaveBeenCalledWith('sess-1', [
      expect.objectContaining({
        type: AgentStreamEvents.DONE,
        payload: expect.objectContaining({
          task_id: 'prompt_during_startup',
          error: true,
          error_message: expect.stringContaining('daemon is starting'),
        }),
      }),
    ]);
  });

  it('relays a terminal error when the local host is not initialised', async () => {
    const { daemon, gateway } = createDaemonHarness();
    daemon.localAgentHost = null;

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-sess-1',
      payload: {
        task_id: 'prompt_no_host',
        prompt: 'hello',
        attachments: [],
        agent_config: {},
      },
    });

    expect(gateway.relayEvents).toHaveBeenCalledTimes(1);
    expect(gateway.relayEvents).toHaveBeenCalledWith('sess-1', [
      expect.objectContaining({
        type: AgentStreamEvents.DONE,
        payload: expect.objectContaining({
          task_id: 'prompt_no_host',
          error: true,
          error_message: expect.stringContaining('DaemonAgentHost is not initialised'),
        }),
      }),
    ]);
  });

  it('routes prompt.cancel to the local runtime by task id', async () => {
    const { daemon, gateway } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.cancel',
      thread_id: 'session-1',
      payload: { task_id: 'prompt_cancel_me' },
    });

    const handleAbort = (daemon.localAgentHost as { handleAbort: ReturnType<typeof vi.fn> }).handleAbort;
    expect(handleAbort).toHaveBeenCalledTimes(1);
    expect(handleAbort).toHaveBeenCalledWith('prompt_cancel_me');
    expect(gateway.sendAgentEvent).not.toHaveBeenCalled();
  });

  it('cancels by envelope thread_id when payload has no task_id ( 按 thread 取消)', async () => {
    // 契约变更：task_id 改 optional。普通 chat stop 前端没有 task_id，
    // Django forward_cancel 只保证 envelope 顶层 thread_id ——设备端按业务
    // 会话（resolveConversationAbortKeys）命中当前 run。
    const { daemon, gateway } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.cancel',
      thread_id: 'session-1',
      payload: {},
    });

    const handleAbort = (daemon.localAgentHost as { handleAbort: ReturnType<typeof vi.fn> }).handleAbort;
    expect(handleAbort).toHaveBeenCalledTimes(1);
    expect(handleAbort).toHaveBeenCalledWith('session-1');
    expect(gateway.sendAgentEvent).not.toHaveBeenCalled();
  });

  it('rejects invalid prompt.cancel payloads before touching the runtime', async () => {
    const { daemon, logger } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.cancel',
      thread_id: 'session-1',
      // task_id 非 string → PromptCancelPayloadSchema safeParse fail。
      payload: { task_id: 42 },
    });

    const handleAbort = (daemon.localAgentHost as { handleAbort: ReturnType<typeof vi.fn> }).handleAbort;
    expect(handleAbort).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid prompt.cancel payload'));
  });

  it('ignores prompt.cancel without any id (no runtime touch, no abort-all)', async () => {
    // 无 task_id 且无 thread_id：不允许落到「全停」，直接忽略并留痕。
    const { daemon, logger } = createDaemonHarness();

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.cancel',
      payload: {},
    });

    const handleAbort = (daemon.localAgentHost as { handleAbort: ReturnType<typeof vi.fn> }).handleAbort;
    expect(handleAbort).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('prompt.cancel without task_id or thread_id'),
    );
  });

  it('does not cancel when prompt.cancel arrives before local host init', async () => {
    const { daemon, logger } = createDaemonHarness();
    daemon.localAgentHost = null;

    await daemon.handleAgentEnvelopeEvent({
      type: 'agent.prompt.cancel',
      thread_id: 'session-1',
      payload: { task_id: 'prompt_cancel_me' },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Daemon] prompt.cancel received but localAgentHost not initialised',
    );
  });

  it('source contract: Agent envelopes feed AgentHost; cancel/subagent no longer private switch handlers', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const daemonSrc = fs.readFileSync(path.resolve(__dirname, '../src/bootstrap/daemon.ts'), 'utf-8');
    const hostSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/application/agent/daemon-agent-host.ts'),
      'utf-8',
    );
    expect(daemonSrc).toMatch(/feedAgentEnvelope/);
    expect(daemonSrc).not.toMatch(/private handlePromptCancel/);
    expect(daemonSrc).not.toMatch(/private handleSubagentCancel/);
    expect(hostSrc).toMatch(/AgentHost\.start/);
    expect(hostSrc).toMatch(/PromptCancelPayloadSchema/);
    expect(hostSrc).toMatch(/SubagentCancelPayloadSchema/);
    // ：abortSessionByKey = abort（active）+ abortConversationRuns（强制清队）。
    expect(hostSrc).toMatch(/requireSharedHost\(\)\.abort\(identity\)/);
    expect(hostSrc).toMatch(/requireSharedHost\(\)\.abortConversationRuns\(identity\)/);
    expect(hostSrc).toMatch(/#6582：host 停路径组合/);
  });
});
