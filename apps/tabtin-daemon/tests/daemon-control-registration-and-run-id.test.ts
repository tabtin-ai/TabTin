import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DaemonConfig } from '../src/base/types/daemon-config.js';
import {
  DaemonAgentHost,
  type DaemonQueryRequest,
} from '../src/application/agent/daemon-agent-host.js';
import { TabTinDaemon } from '../src/bootstrap/daemon.js';
import { registerDaemonControlDevice } from '../src/transport/gateway/daemon-control-registration.js';

vi.mock('@tabtin/agent-wire', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/agent-wire')>('@tabtin/agent-wire');
  return {
    ...actual,
    PromptEvents: { ...actual.PromptEvents, ADMITTED: 'agent.prompt.admitted' },
  };
});

const config: DaemonConfig = {
  server_url: 'https://api.tabtin.example',
  ws_url: 'wss://api.tabtin.example/ws',
  device_id: 'legacy-device-id',
  fingerprint: 'daemon-installation-1',
  credential: 'daemon-jwt',
  organization_id: 'organization-1',
  user_id: 'user-1',
  device_name: 'Home Daemon',
  plugins: [],
  capabilities: [],
  log_level: 'info',
  log_file: null,
  heartbeat_interval_ms: 15_000,
  proxy: null,
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function deviceResponse(revision: number): Response {
  return new Response(JSON.stringify({
    success: true,
    data: {
      device: {
        device_id: 'device-1',
        capabilities: { revision },
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete config.daemon_control_runtime_profile_revision;
});

function makeRegistrationHarness() {
  const own = vi.fn();
  const save = vi.fn();
  const daemon = Object.create(TabTinDaemon.prototype) as unknown as {
    c: {
      config: DaemonConfig;
      logger: ReturnType<typeof makeLogger>;
      configManager: { save: typeof save };
    };
    lifecycle: { own: typeof own };
    startDaemonControlRegistration(capabilities: string[]): void;
  };
  daemon.c = { config, logger: makeLogger(), configManager: { save } };
  daemon.lifecycle = { own };
  return { daemon, own, save };
}

describe('Daemon Control device registration', () => {
  it('registers the stable installation with the daemon JWT', async () => {
    vi.stubEnv('DAEMON_CONTROL_ENABLED', 'true');
    vi.stubEnv('TABTIN_DAEMON_CONTROL_API_BASE_URL', 'http://127.0.0.1:6080/api');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deviceResponse(7))
      .mockResolvedValueOnce(deviceResponse(8));
    vi.stubGlobal('fetch', fetchMock);
    const logger = makeLogger();

    await expect(registerDaemonControlDevice(config, ['terminal', 'file'], logger))
      .resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:6080/api/daemon-control/v1/devices/register');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer daemon-jwt' });
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({
      installation_id: 'daemon-installation-1',
      name: 'Home Daemon',
      kind: 2,
      capabilities: ['terminal', 'file'],
    });
    const [syncUrl, syncInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(syncUrl).toBe(
      'http://127.0.0.1:6080/api/daemon-control/v1/devices/device-1/runtime-profile',
    );
    expect(JSON.parse(String(syncInit.body))).toMatchObject({
      capabilities: ['terminal', 'file'],
      capabilities_revision: 8,
    });
    expect(config.daemon_control_runtime_profile_revision).toBe(8);
  });

  it('uses persisted daemon config when started as a system service', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deviceResponse(1))
      .mockResolvedValueOnce(deviceResponse(2));
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerDaemonControlDevice({
      ...config,
      daemon_control_enabled: true,
      daemon_control_api_base_url: 'http://127.0.0.1:6080/api',
      daemon_control_runtime_profile_revision: 9,
    }, [], makeLogger())).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6080/api/daemon-control/v1/devices/register',
      expect.any(Object),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilities_revision: 10,
    });
  });

  it('logs and degrades when registration is unavailable', async () => {
    vi.stubEnv('DAEMON_CONTROL_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const logger = makeLogger();

    await expect(registerDaemonControlDevice(config, [], logger)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Daemon Control] Device registration failed (non-critical): HTTP 503',
    );
  });

  it('does not send daemon credentials to a non-local HTTP origin', async () => {
    vi.stubEnv('DAEMON_CONTROL_ENABLED', 'true');
    vi.stubEnv('TABTIN_DAEMON_CONTROL_API_BASE_URL', 'http://control.example.com/api');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerDaemonControlDevice(config, [], makeLogger()))
      .resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing while daemon control rollout is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerDaemonControlDevice(config, [], makeLogger()))
      .resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries after 5s with backoff until registration succeeds', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DAEMON_CONTROL_ENABLED', 'true');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(deviceResponse(1))
      .mockResolvedValueOnce(deviceResponse(2));
    vi.stubGlobal('fetch', fetchMock);
    const { daemon, save } = makeRegistrationHarness();

    daemon.startDaemonControlRegistration([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenCalledWith(config);
    expect(config.daemon_control_runtime_profile_revision).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('clears a pending registration retry during shutdown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DAEMON_CONTROL_ENABLED', 'true');
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { daemon, own } = makeRegistrationHarness();

    daemon.startDaemonControlRegistration([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const dispose = own.mock.calls.find(([name]) => (
      name === 'daemon-control-registration'
    ))?.[2] as (() => void) | undefined;
    expect(dispose).toBeTypeOf('function');
    dispose?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('registers asynchronously after startup and each Gateway reconnect', () => {
    const daemonSource = readFileSync(resolve(__dirname, '../src/bootstrap/daemon.ts'), 'utf8');
    const authSource = readFileSync(resolve(__dirname, '../src/transport/gateway/auth.ts'), 'utf8');
    const cliSource = readFileSync(resolve(__dirname, '../src/entrypoints/daemon-cli.ts'), 'utf8');
    const localRuntime = daemonSource.indexOf('await this.startLocalAgentHost();');
    const gateway = daemonSource.indexOf('await this.connectGatewayWithRetry(5, 2000);', localRuntime);
    const registration = daemonSource.indexOf('this.startDaemonControlRegistration(', gateway);
    const reconnect = daemonSource.indexOf('this.gateway.onReconnect(', registration);
    const reconnectRegistration = daemonSource.indexOf(
      'this.triggerDaemonControlRegistration(',
      reconnect,
    );

    expect(localRuntime).toBeGreaterThan(-1);
    expect(gateway).toBeGreaterThan(localRuntime);
    expect(registration).toBeGreaterThan(gateway);
    expect(reconnectRegistration).toBeGreaterThan(reconnect);
    expect(authSource).not.toContain('registerDaemonControlDevice');
    expect(cliSource).toContain("'daemon_control_enabled'");
    expect(cliSource).toContain("'daemon_control_api_base_url'");
  });
});

describe('Daemon business run id', () => {
  it('prefers the Django run id over the client message id', async () => {
    const owner = { userId: 'user-1', organizationId: 'organization-1' };
    const mapToHostQuery = vi.fn().mockReturnValue({ identity: { runId: 'business-run' } });
    const beginSubmitHostQuery = vi.fn().mockReturnValue({
      ok: true,
      acceptance: { runId: 'business-run', runDisposition: 'started' },
      completion: Promise.resolve({ success: true }),
    });
    const host = Object.create(DaemonAgentHost.prototype) as unknown as {
      handleQuery(request: DaemonQueryRequest): Promise<{ success: boolean; error?: string }>;
      resolveOwner: ReturnType<typeof vi.fn>;
      sharedHost: {
        hasAdmittedHostQuery(runId: string): boolean;
        beginSubmitHostQuery: ReturnType<typeof vi.fn>;
      };
      relayPersistence: { activateOwner(): boolean };
      relayOrchestrator: { kickRecoverAndBackfill(): Promise<void> };
      mapToHostQuery: ReturnType<typeof vi.fn>;
      sessionState: { setPendingTurn(): void; deletePendingTurn(): void };
    };
    host.resolveOwner = vi.fn().mockReturnValue(owner);
    host.sharedHost = { hasAdmittedHostQuery: () => false, beginSubmitHostQuery };
    host.relayPersistence = { activateOwner: () => false };
    host.relayOrchestrator = { kickRecoverAndBackfill: async () => undefined };
    host.mapToHostQuery = mapToHostQuery;
    host.sessionState = { setPendingTurn: vi.fn(), deletePendingTurn: vi.fn() };
    const request: DaemonQueryRequest = {
      prompt: 'run this',
      runId: 'business-run',
      clientMessageId: 'client-message',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    };

    await expect(host.handleQuery(request)).resolves.toEqual({ success: true });
    expect(mapToHostQuery).toHaveBeenCalledWith(request, owner, 'business-run');
    expect(beginSubmitHostQuery).toHaveBeenCalledTimes(1);
  });

  it('replayed run id is admitted without a second execution', async () => {
    const host = Object.create(DaemonAgentHost.prototype) as unknown as {
      handleQuery(request: DaemonQueryRequest): Promise<{ success: boolean; error?: string }>;
      sharedHost: {
        hasAdmittedHostQuery: ReturnType<typeof vi.fn>;
        beginSubmitHostQuery: ReturnType<typeof vi.fn>;
      };
      logger: ReturnType<typeof makeLogger>;
    };
    host.sharedHost = {
      hasAdmittedHostQuery: vi.fn(() => true),
      beginSubmitHostQuery: vi.fn(),
    };
    host.logger = makeLogger();

    await expect(host.handleQuery({
      prompt: 'run this',
      runId: 'business-run',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    })).resolves.toEqual({ success: true });
    expect(host.sharedHost.beginSubmitHostQuery).not.toHaveBeenCalled();
  });

  it('sends reliable prompt admission through the existing Gateway connection', () => {
    const hostSource = readFileSync(
      resolve(__dirname, '../src/application/agent/daemon-agent-host.ts'),
      'utf8',
    );
    expect(hostSource).toContain('sharedHost.beginSubmitHostQuery(');
    expect(hostSource).toContain('PromptEvents.ADMITTED');
    expect(hostSource).toContain('buffered_event_id: eventId');
    expect(hostSource).toContain('run_id: runId');
  });

  it('confirms only an exact device forward after host admission', async () => {
    const sendAgentEvent = vi.fn().mockResolvedValue(undefined);
    const acknowledgeApplicationEvent = vi.fn();
    const host = Object.create(DaemonAgentHost.prototype) as unknown as {
      gateway: { sendAgentEvent: typeof sendAgentEvent; acknowledgeApplicationEvent: typeof acknowledgeApplicationEvent };
      logger: ReturnType<typeof makeLogger>;
      acknowledgePromptAdmission(runId: string, envelope: Record<string, unknown>): Promise<void>;
    };
    host.gateway = { sendAgentEvent, acknowledgeApplicationEvent };
    host.logger = makeLogger();

    await host.acknowledgePromptAdmission('business-run', {
      event_id: '100-0',
      thread_id: 'chat-session-session-1',
      _topic: 'agent.action.device.daemon-installation-1',
    });
    await host.acknowledgePromptAdmission('legacy-run', {
      event_id: '200-0',
      thread_id: 'chat-session-session-1',
      _topic: 'agent.action.session-1',
    });

    expect(sendAgentEvent).toHaveBeenCalledOnce();
    expect(sendAgentEvent).toHaveBeenCalledWith(
      'chat-session-session-1',
      'agent.prompt.admitted',
      { buffered_event_id: '100-0', run_id: 'business-run' },
    );
    expect(acknowledgeApplicationEvent).toHaveBeenCalledOnce();
    expect(acknowledgeApplicationEvent).toHaveBeenCalledWith(
      '100-0',
      'agent.action.device.daemon-installation-1',
    );
  });
});
