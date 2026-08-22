import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installPersonalPluginFromCodexDirectory,
  PersonalPluginRuntimeError,
  PersonalPluginRuntimeManager,
  setPersonalPluginEnabled,
  type PersonalPluginBrowserOpenAdapter,
  type PersonalPluginBrowserOpenRequest,
  type PersonalPluginMcpAttachRequest,
  type PersonalPluginMcpCallToolRequest,
  type PersonalPluginMcpRuntimeAdapter,
  type PersonalPluginMcpRuntimeHandle,
  type PersonalPluginMcpToolMetadata,
  type PersonalPluginProcessAdapter,
  type PersonalPluginProcessHandle,
  type PersonalPluginProcessStartRequest,
} from '../src/plugins/index.js';

const USER_ID = 'user-1';
const ORGANIZATION_ID = 'wt-1';
const SPACE_ID = 'space-1';
const AGENT_ID = 'agent-1';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf-8');
}

function createCowartPackage(root: string, options?: { mcp?: boolean }): string {
  const pkg = path.join(root, 'cowart');
  writeJson(path.join(pkg, '.codex-plugin', 'plugin.json'), {
    id: 'cowart',
    name: 'Cowart',
    version: '0.4.1',
    localServices: [
      {
        id: 'canvas',
        command: 'pnpm dev --host 127.0.0.1',
        url: 'http://127.0.0.1:43217/',
        env: { COWART_MODE: 'canvas' },
      },
    ],
  });
  if (options?.mcp) {
    writeJson(path.join(pkg, '.mcp.json'), {
      mcpServers: {
        cowart: {
          command: 'node',
          args: ['dist/mcp-server.js'],
          env: { COWART_MCP_MODE: 'fake' },
        },
      },
    });
  }
  writeText(
    path.join(pkg, 'skills', 'cowart-open-canvas', 'SKILL.md'),
    `---
name: cowart-open-canvas
description: Open the Cowart canvas.
---

# Cowart
`,
  );
  return pkg;
}

class FakeProcessAdapter implements PersonalPluginProcessAdapter {
  readonly starts: PersonalPluginProcessStartRequest[] = [];
  readonly stops: PersonalPluginProcessHandle[] = [];

  async start(request: PersonalPluginProcessStartRequest) {
    this.starts.push(request);
    return {
      pid: 43217 + this.starts.length,
      processId: `fake-${this.starts.length}`,
      url: request.expectedUrl,
    };
  }

  async stop(handle: PersonalPluginProcessHandle) {
    this.stops.push(handle);
  }
}

class FakeBrowserOpenAdapter implements PersonalPluginBrowserOpenAdapter {
  readonly opens: PersonalPluginBrowserOpenRequest[] = [];

  async open(request: PersonalPluginBrowserOpenRequest) {
    this.opens.push(request);
  }
}

const COWART_MCP_TOOLS: PersonalPluginMcpToolMetadata[] = [
  {
    name: 'mcp_cowart_read_canvas_state',
    description: 'Read the current Cowart canvas state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
  },
  {
    name: 'mcp_cowart_insert_shape',
    description: 'Insert a simple non-image shape into the Cowart canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['note', 'rect'] },
        text: { type: 'string' },
      },
      additionalProperties: false,
    },
    isReadOnly: false,
  },
];

class FakeMcpRuntimeAdapter implements PersonalPluginMcpRuntimeAdapter {
  readonly attaches: PersonalPluginMcpAttachRequest[] = [];
  readonly detaches: PersonalPluginMcpRuntimeHandle[] = [];
  readonly calls: PersonalPluginMcpCallToolRequest[] = [];
  failAttach = false;

  async attach(request: PersonalPluginMcpAttachRequest) {
    this.attaches.push(request);
    if (this.failAttach) {
      throw new Error('fake MCP boot failed');
    }
    return {
      handle: { runtimeId: request.runtimeId, processId: `mcp-${this.attaches.length}` },
      tools: COWART_MCP_TOOLS,
    };
  }

  async detach(handle: PersonalPluginMcpRuntimeHandle) {
    this.detaches.push(handle);
  }

  async callTool(request: PersonalPluginMcpCallToolRequest) {
    this.calls.push(request);
    if (request.toolName === 'mcp_cowart_read_canvas_state') {
      return { ok: true, state: { version: 1, elements: [{ id: 'node-1', type: 'frame' }] } };
    }
    if (request.toolName === 'mcp_cowart_insert_shape') {
      return { ok: true, element: { id: 'note-1', type: 'note' }, input: request.input };
    }
    return { ok: false };
  }
}

async function installCowart(options?: { enable?: boolean; mcp?: boolean }) {
  const root = tempRoot('tabtin-cowart-runtime-');
  const dataRoot = path.join(root, 'data');
  const sourceDir = createCowartPackage(root, { mcp: options?.mcp });
  const installed = await installPersonalPluginFromCodexDirectory({
    sourceDir,
    dataRoot,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    sourceUri: 'git+https://github.com/acme/cowart.git',
    versionPin: 'v0.4.1',
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
  });
  if (options?.enable) {
    await setPersonalPluginEnabled({
      dataRoot,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      pluginId: 'cowart',
      enabled: true,
    });
  }
  return { root, dataRoot, installed };
}

function createManager(dataRoot: string, options?: {
  mcpRuntimeAdapter?: PersonalPluginMcpRuntimeAdapter;
  serviceReadinessProbe?: (url: string) => Promise<boolean>;
}) {
  const processAdapter = new FakeProcessAdapter();
  const browserOpenAdapter = new FakeBrowserOpenAdapter();
  const manager = new PersonalPluginRuntimeManager({
    dataRoot,
    processAdapter,
    browserOpenAdapter,
    mcpRuntimeAdapter: options?.mcpRuntimeAdapter,
    serviceReadinessProbe: options?.serviceReadinessProbe ?? (async () => true),
    serviceReadinessIntervalMs: 1,
  });
  return { manager, processAdapter, browserOpenAdapter };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-22T15:30:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PersonalPluginRuntimeManager', () => {
  it('launches enabled Cowart with install cwd, project env, status and browser open', async () => {
    const { dataRoot, installed } = await installCowart({ enable: true });
    const { manager, processAdapter, browserOpenAdapter } = createManager(dataRoot);
    const projectDir = path.join(tempRoot('tabtin-cowart-project-'), 'space-workdir');

    const status = await manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir,
      title: 'Cowart',
    });

    expect(status).toMatchObject({
      state: 'running',
      pluginId: 'cowart',
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      serviceId: 'canvas',
      url: 'http://127.0.0.1:43217/',
      installPath: installed.installPath,
      projectDir,
      process: {
        pid: 43218,
        processId: 'fake-1',
        command: 'pnpm dev --host 127.0.0.1',
        cwd: installed.installPath,
      },
    });
    expect(processAdapter.starts).toHaveLength(1);
    expect(processAdapter.starts[0]).toMatchObject({
      cwd: installed.installPath,
      env: {
        COWART_MODE: 'canvas',
        COWART_PROJECT_DIR: projectDir,
      },
      expectedUrl: 'http://127.0.0.1:43217/',
    });
    expect(browserOpenAdapter.opens).toEqual([
      expect.objectContaining({
        spaceId: SPACE_ID,
        pluginId: 'cowart',
        url: 'http://127.0.0.1:43217/',
        title: 'Cowart',
      }),
    ]);
    expect(manager.getStatus({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    })).toMatchObject({ state: 'running', url: 'http://127.0.0.1:43217/' });
  });

  it('waits for the local service URL before opening the browser tab', async () => {
    const { dataRoot } = await installCowart({ enable: true });
    const events: string[] = [];
    const processAdapter = new FakeProcessAdapter();
    const browserOpenAdapter: PersonalPluginBrowserOpenAdapter = {
      async open(request) {
        events.push(`open:${request.url}`);
      },
    };
    const serviceReadinessProbe = vi.fn(async (url: string) => {
      events.push(`probe:${url}`);
      return true;
    });
    const manager = new PersonalPluginRuntimeManager({
      dataRoot,
      processAdapter,
      browserOpenAdapter,
      serviceReadinessProbe,
    });

    await manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: path.join(tempRoot('tabtin-cowart-project-'), 'space-workdir'),
      title: 'Cowart',
    });

    expect(serviceReadinessProbe).toHaveBeenCalledWith('http://127.0.0.1:43217/');
    expect(events).toEqual([
      'probe:http://127.0.0.1:43217/',
      'open:http://127.0.0.1:43217/',
    ]);
  });

  it('retries readiness probes until the local service becomes reachable', async () => {
    vi.useRealTimers();
    const { dataRoot } = await installCowart({ enable: true });
    const events: string[] = [];
    let attempts = 0;
    const processAdapter = new FakeProcessAdapter();
    const browserOpenAdapter: PersonalPluginBrowserOpenAdapter = {
      async open(request) {
        events.push(`open:${request.url}`);
      },
    };
    const serviceReadinessProbe = vi.fn(async (url: string) => {
      attempts += 1;
      events.push(`probe-${attempts}:${url}`);
      return attempts >= 3;
    });
    const manager = new PersonalPluginRuntimeManager({
      dataRoot,
      processAdapter,
      browserOpenAdapter,
      serviceReadinessProbe,
      serviceReadinessIntervalMs: 1,
      serviceReadinessTimeoutMs: 50,
    });

    await manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: path.join(tempRoot('tabtin-cowart-project-'), 'space-workdir'),
      title: 'Cowart',
    });

    expect(serviceReadinessProbe).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      'probe-1:http://127.0.0.1:43217/',
      'probe-2:http://127.0.0.1:43217/',
      'probe-3:http://127.0.0.1:43217/',
      'open:http://127.0.0.1:43217/',
    ]);
  });

  it('continues opening the browser after readiness timeout instead of hanging forever', async () => {
    vi.useRealTimers();
    const { dataRoot } = await installCowart({ enable: true });
    const events: string[] = [];
    const processAdapter = new FakeProcessAdapter();
    const browserOpenAdapter: PersonalPluginBrowserOpenAdapter = {
      async open(request) {
        events.push(`open:${request.url}`);
      },
    };
    const serviceReadinessProbe = vi.fn(async (url: string) => {
      events.push(`probe:${url}`);
      return false;
    });
    const manager = new PersonalPluginRuntimeManager({
      dataRoot,
      processAdapter,
      browserOpenAdapter,
      serviceReadinessProbe,
      serviceReadinessIntervalMs: 1,
      serviceReadinessTimeoutMs: 3,
    });

    await manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: path.join(tempRoot('tabtin-cowart-project-'), 'space-workdir'),
      title: 'Cowart',
    });

    expect(serviceReadinessProbe).toHaveBeenCalled();
    expect(events.at(-1)).toBe('open:http://127.0.0.1:43217/');
  });

  it('returns diagnostic errors when Cowart is missing or not enabled', async () => {
    const root = tempRoot('tabtin-cowart-errors-');
    const { manager } = createManager(path.join(root, 'platform-data'));

    await expect(manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: root,
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_NOT_INSTALLED',
      name: 'PersonalPluginRuntimeError',
    } satisfies Partial<PersonalPluginRuntimeError>);

    const { dataRoot } = await installCowart({ enable: false });
    const disabled = createManager(dataRoot).manager;
    await expect(disabled.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: root,
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_NOT_ENABLED',
      name: 'PersonalPluginRuntimeError',
    } satisfies Partial<PersonalPluginRuntimeError>);
  });

  it('reuses an already running Cowart runtime without starting another process', async () => {
    const { dataRoot } = await installCowart({ enable: true });
    const { manager, processAdapter, browserOpenAdapter } = createManager(dataRoot);
    const baseInput = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: tempRoot('tabtin-cowart-project-'),
    };

    const first = await manager.launch(baseInput);
    const second = await manager.launch(baseInput);

    expect(second.runtimeId).toBe(first.runtimeId);
    expect(second.process?.processId).toBe(first.process?.processId);
    expect(processAdapter.starts).toHaveLength(1);
    expect(browserOpenAdapter.opens).toHaveLength(2);
  });

  it('stops Cowart explicitly and leaves status stopped', async () => {
    const { dataRoot } = await installCowart({ enable: true });
    const { manager, processAdapter } = createManager(dataRoot);
    const scope = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    };

    await manager.launch({ ...scope, projectDir: tempRoot('tabtin-cowart-project-') });
    const stopped = await manager.stop(scope);

    expect(processAdapter.stops).toEqual([
      expect.objectContaining({ pid: 43218, processId: 'fake-1' }),
    ]);
    expect(stopped).toMatchObject({
      state: 'stopped',
      pluginId: 'cowart',
      exitCode: null,
      signal: null,
    });
    expect(manager.getStatus(scope)).toMatchObject({ state: 'stopped' });
  });

  it('stops all running runtimes for a plugin before uninstall', async () => {
    const { dataRoot } = await installCowart({ enable: true, mcp: true });
    const mcpRuntimeAdapter = new FakeMcpRuntimeAdapter();
    const { manager, processAdapter } = createManager(dataRoot, { mcpRuntimeAdapter });
    const scope = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    };

    await manager.launch({
      ...scope,
      projectDir: tempRoot('tabtin-cowart-project-'),
      requireMcp: true,
    });
    const stopped = await manager.stopAllForPlugin({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    });

    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ state: 'stopped', pluginId: 'cowart' });
    expect(processAdapter.stops).toEqual([expect.objectContaining({ processId: 'fake-1' })]);
    expect(mcpRuntimeAdapter.detaches).toEqual([expect.objectContaining({ processId: 'mcp-1' })]);
    expect(manager.getStatus(scope)).toMatchObject({ state: 'stopped' });
  });

  it('keeps Cowart MCP tools unavailable before launch', async () => {
    const { dataRoot } = await installCowart({ enable: true, mcp: true });
    const mcpRuntimeAdapter = new FakeMcpRuntimeAdapter();
    const { manager } = createManager(dataRoot, { mcpRuntimeAdapter });
    const scope = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    };

    expect(manager.listMcpTools(scope)).toEqual([]);
    await expect(manager.callMcpTool({
      ...scope,
      toolName: 'mcp_cowart_read_canvas_state',
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_MCP_NOT_RUNNING',
    } satisfies Partial<PersonalPluginRuntimeError>);
  });

  it('attaches Cowart MCP on launch and exposes scoped fake tool calls', async () => {
    const { dataRoot, installed } = await installCowart({ enable: true, mcp: true });
    const mcpRuntimeAdapter = new FakeMcpRuntimeAdapter();
    const { manager, processAdapter } = createManager(dataRoot, { mcpRuntimeAdapter });
    const projectDir = path.join(tempRoot('tabtin-cowart-project-'), 'space-workdir');
    const scope = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    };

    const status = await manager.launch({ ...scope, projectDir, openBrowser: false });

    expect(status.mcp).toMatchObject({
      state: 'attached',
      serverCount: 1,
      tools: COWART_MCP_TOOLS,
    });
    expect(mcpRuntimeAdapter.attaches).toHaveLength(1);
    expect(mcpRuntimeAdapter.attaches[0]).toMatchObject({
      runtimeId: status.runtimeId,
      pluginId: 'cowart',
      installPath: installed.installPath,
      projectDir,
      env: {
        COWART_MODE: 'canvas',
        COWART_MCP_MODE: 'fake',
        COWART_PROJECT_DIR: projectDir,
        TABTIN_PLUGIN_INSTALL_PATH: installed.installPath,
      },
    });
    expect(processAdapter.starts[0]?.env.COWART_PROJECT_DIR).toBe(projectDir);
    expect(manager.listMcpTools(scope).map((tool) => tool.name)).toEqual([
      'mcp_cowart_read_canvas_state',
      'mcp_cowart_insert_shape',
    ]);
    await expect(manager.callMcpTool({
      ...scope,
      toolName: 'mcp_cowart_read_canvas_state',
    })).resolves.toEqual({
      ok: true,
      state: { version: 1, elements: [{ id: 'node-1', type: 'frame' }] },
    });
    await expect(manager.callMcpTool({
      ...scope,
      toolName: 'mcp_cowart_insert_shape',
      input: { type: 'note', text: 'Acceptance note' },
    })).resolves.toMatchObject({
      ok: true,
      element: { id: 'note-1', type: 'note' },
    });
  });

  it('relaunches Cowart without duplicate MCP attach', async () => {
    const { dataRoot } = await installCowart({ enable: true, mcp: true });
    const mcpRuntimeAdapter = new FakeMcpRuntimeAdapter();
    const { manager, processAdapter } = createManager(dataRoot, { mcpRuntimeAdapter });
    const baseInput = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: tempRoot('tabtin-cowart-project-'),
    };

    const first = await manager.launch(baseInput);
    const second = await manager.launch(baseInput);

    expect(second.runtimeId).toBe(first.runtimeId);
    expect(processAdapter.starts).toHaveLength(1);
    expect(mcpRuntimeAdapter.attaches).toHaveLength(1);
  });

  it('detaches Cowart MCP when runtime stops', async () => {
    const { dataRoot } = await installCowart({ enable: true, mcp: true });
    const mcpRuntimeAdapter = new FakeMcpRuntimeAdapter();
    const { manager } = createManager(dataRoot, { mcpRuntimeAdapter });
    const scope = {
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      pluginId: 'cowart',
    };

    const launched = await manager.launch({ ...scope, projectDir: tempRoot('tabtin-cowart-project-') });
    const stopped = await manager.stop(scope);

    expect(mcpRuntimeAdapter.detaches).toEqual([
      { runtimeId: launched.runtimeId, processId: 'mcp-1' },
    ]);
    expect(stopped.mcp).toMatchObject({ state: 'detached', tools: [] });
    expect(manager.listMcpTools(scope)).toEqual([]);
  });

  it('returns diagnostic MCP launch errors and stops the local service', async () => {
    const missingAdapter = await installCowart({ enable: true, mcp: true });
    const missingAdapterManager = createManager(missingAdapter.dataRoot);
    await expect(missingAdapterManager.manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: tempRoot('tabtin-cowart-project-'),
      requireMcp: true,
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_MCP_START_FAILED',
    } satisfies Partial<PersonalPluginRuntimeError>);
    expect(missingAdapterManager.processAdapter.stops).toHaveLength(1);

    const missingMcp = await installCowart({ enable: true, mcp: false });
    const missingMcpAdapter = new FakeMcpRuntimeAdapter();
    const missingMcpManager = createManager(missingMcp.dataRoot, {
      mcpRuntimeAdapter: missingMcpAdapter,
    });

    await expect(missingMcpManager.manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: tempRoot('tabtin-cowart-project-'),
      requireMcp: true,
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_MCP_NOT_DECLARED',
    } satisfies Partial<PersonalPluginRuntimeError>);
    expect(missingMcpManager.processAdapter.stops).toHaveLength(1);

    const brokenMcp = await installCowart({ enable: true, mcp: true });
    const brokenMcpAdapter = new FakeMcpRuntimeAdapter();
    brokenMcpAdapter.failAttach = true;
    const brokenMcpManager = createManager(brokenMcp.dataRoot, {
      mcpRuntimeAdapter: brokenMcpAdapter,
    });
    await expect(brokenMcpManager.manager.launch({
      organizationId: ORGANIZATION_ID,
      spaceId: SPACE_ID,
      userId: USER_ID,
      pluginId: 'cowart',
      projectDir: tempRoot('tabtin-cowart-project-'),
    })).rejects.toMatchObject({
      code: 'PERSONAL_PLUGIN_MCP_START_FAILED',
    } satisfies Partial<PersonalPluginRuntimeError>);
    expect(brokenMcpManager.processAdapter.stops).toHaveLength(1);
  });
});
