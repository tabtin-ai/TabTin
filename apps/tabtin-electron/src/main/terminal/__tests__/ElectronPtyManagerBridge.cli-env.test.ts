import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtyHostClient, PtyHostSession } from '@tabtin/pty-core';
import { PtyManager } from '../PtyManager';
import { ElectronPtyManagerBridge } from '../ElectronPtyManagerBridge';

vi.mock('electron', () => ({
  app: {
    getLocale: () => 'zh-CN',
  },
}));

const { ensureCLIServerReadyMock, getCLIServerInfoMock } = vi.hoisted(() => ({
  ensureCLIServerReadyMock: vi.fn(async () => undefined),
  getCLIServerInfoMock: vi.fn((): { socketPath?: string; token?: string } | null => null),
}));

vi.mock('../../cli/cli-server', () => ({
  ensureCLIServerReady: ensureCLIServerReadyMock,
  getCLIServerInfo: getCLIServerInfoMock,
}));

class MockHostSession implements PtyHostSession {
  pid = 9527;
  private spawnedHandler?: (event: { pid: number }) => void;
  private dataHandler?: (data: string) => void;
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void;

  write = vi.fn();
  pauseOutput = vi.fn();
  resumeOutput = vi.fn();
  resize = vi.fn();
  kill = vi.fn(() => {
    queueMicrotask(() => this.exitHandler?.({ exitCode: null, signal: 15 }));
  });

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler;
    return { dispose: vi.fn() };
  });

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  });

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler;
    return { dispose: vi.fn() };
  });

  triggerData(data: string): void {
    this.dataHandler?.(data);
  }

  triggerSpawned(pid: number): void {
    this.pid = pid;
    this.spawnedHandler?.({ pid });
  }
}

class MockPtyHostClient implements PtyHostClient {
  readonly sessions: MockHostSession[] = [];

  spawn = vi.fn(() => {
    const session = new MockHostSession();
    this.sessions.push(session);
    return session;
  });
}

class MockProcessTerminator {
  terminateTree = vi.fn();
}

describe('ElectronPtyManagerBridge CLI server env', () => {
  let ptyManager: PtyManager;
  let bridge: ElectronPtyManagerBridge;

  beforeEach(() => {
    ensureCLIServerReadyMock.mockReset();
    ensureCLIServerReadyMock.mockResolvedValue(undefined);
    getCLIServerInfoMock.mockReset();
    getCLIServerInfoMock.mockReturnValue(null);
    ptyManager = new PtyManager(new MockPtyHostClient(), new MockProcessTerminator() as never);
    bridge = new ElectronPtyManagerBridge(ptyManager);
  });

  afterEach(async () => {
    await bridge.dispose();
    ptyManager.cleanup();
  });

  function printTransportEnvCommand(): string {
    return [
      'node',
      '-e',
      JSON.stringify(
        'console.log(JSON.stringify({sock:process.env.TABTIN_SOCK||null,token:process.env._TABTIN_TRANSPORT_TOKEN||null}))',
      ),
    ].join(' ');
  }

  it.each([
    'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
    'Invoke-Expression $payload',
  ])('blocks opaque PowerShell before creating an Agent session: %s', async (command) => {
    const beforeSessionIds = ptyManager.getAllSessionIds();

    await expect(bridge.spawnAgentSessionDetached({
      command,
      agentMeta: {
        toolUseId: 'tool-security-floor',
        spaceId: 'space-security-floor',
        agentId: 'agent-security-floor',
        originatedBy: 'local-llm-shellcap',
      },
    })).rejects.toMatchObject({
      name: 'CommandValidationError',
      kind: 'validation',
      ruleName: 'opaque-powershell-execution',
    });

    expect(ptyManager.getAllSessionIds()).toEqual(beforeSessionIds);
  });

  it('injects current Electron CLI Server env into the child process', async () => {
    getCLIServerInfoMock.mockReturnValue({
      socketPath: '\\\\.\\pipe\\tabtin-electron-cli-11688',
      token: 'transport-token',
    });
    const result = await bridge.executeAgentCommand({
      command: printTransportEnvCommand(),
      agentMeta: {
        toolUseId: 'tool-cli-env',
        spaceId: 'space-cli-env',
        agentId: 'agent-cli-env',
        threadId: 'thread-cli-env',
        originatedBy: 'local-llm-shellcap',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sock: '\\\\.\\pipe\\tabtin-electron-cli-11688',
      token: 'transport-token',
    });
  });

  it('waits for CLI Server recovery before creating an Agent session', async () => {
    let resolveReady!: () => void;
    ensureCLIServerReadyMock.mockImplementation(() => new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));
    getCLIServerInfoMock.mockReturnValue({
      socketPath: '/tmp/recovered.sock',
      token: 'recovered-token',
    });

    const resultPromise = bridge.executeAgentCommand({
      command: printTransportEnvCommand(),
      agentMeta: {
        toolUseId: 'tool-cli-recovery',
        spaceId: 'space-cli-recovery',
        agentId: 'agent-cli-recovery',
        threadId: 'thread-cli-recovery',
        originatedBy: 'local-llm-shellcap',
      },
    });
    await Promise.resolve();

    expect(ensureCLIServerReadyMock).toHaveBeenCalledTimes(1);
    expect(ptyManager.getAllSessionIds()).toEqual([]);

    resolveReady();
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });

  it('does not mix explicit socket env with current Electron CLI Server token in child process', async () => {
    getCLIServerInfoMock.mockReturnValue({
      socketPath: '\\\\.\\pipe\\tabtin-electron-cli-server',
      token: 'server-token',
    });
    const result = await bridge.executeAgentCommand({
      command: printTransportEnvCommand(),
      env: {
        TABTIN_SOCK: 'explicit-sock',
      },
      agentMeta: {
        toolUseId: 'tool-cli-env-explicit',
        spaceId: 'space-cli-env-explicit',
        agentId: 'agent-cli-env-explicit',
        threadId: 'thread-cli-env-explicit',
        originatedBy: 'local-llm-shellcap',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sock: 'explicit-sock',
      token: null,
    });
  });

  it('does not mix explicit token env with current Electron CLI Server socket in child process', async () => {
    getCLIServerInfoMock.mockReturnValue({
      socketPath: '\\\\.\\pipe\\tabtin-electron-cli-server',
      token: 'server-token',
    });
    const result = await bridge.executeAgentCommand({
      command: printTransportEnvCommand(),
      env: {
        _TABTIN_TRANSPORT_TOKEN: 'explicit-token',
      },
      agentMeta: {
        toolUseId: 'tool-cli-env-explicit-token',
        spaceId: 'space-cli-env-explicit-token',
        agentId: 'agent-cli-env-explicit-token',
        threadId: 'thread-cli-env-explicit-token',
        originatedBy: 'local-llm-shellcap',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sock: null,
      token: 'explicit-token',
    });
  });
});
