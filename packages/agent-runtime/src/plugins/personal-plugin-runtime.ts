import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

import {
  listPersonalPluginEnablement,
  type InstalledPersonalPlugin,
  type PersonalPluginMcpCapability,
} from './personal-plugin-registry.js';

export type PersonalPluginRuntimeState = 'running' | 'stopped';

export type PersonalPluginRuntimeErrorCode =
  | 'PERSONAL_PLUGIN_NOT_INSTALLED'
  | 'PERSONAL_PLUGIN_NOT_ENABLED'
  | 'PERSONAL_PLUGIN_SERVICE_NOT_DECLARED'
  | 'PERSONAL_PLUGIN_SERVICE_COMMAND_MISSING'
  | 'PERSONAL_PLUGIN_SERVICE_URL_MISSING'
  | 'PERSONAL_PLUGIN_PROJECT_DIR_MISSING'
  | 'PERSONAL_PLUGIN_MCP_NOT_DECLARED'
  | 'PERSONAL_PLUGIN_MCP_START_FAILED'
  | 'PERSONAL_PLUGIN_MCP_NOT_RUNNING'
  | 'PERSONAL_PLUGIN_MCP_TOOL_NOT_FOUND';

export class PersonalPluginRuntimeError extends Error {
  constructor(
    readonly code: PersonalPluginRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PersonalPluginRuntimeError';
  }
}

export interface PersonalPluginRuntimeProcessInfo {
  pid?: number;
  processId?: string;
  command: string;
  cwd: string;
}

export interface PersonalPluginRuntimeStatus {
  runtimeId: string;
  state: PersonalPluginRuntimeState;
  organizationId: string;
  spaceId: string;
  agentId?: string;
  pluginId: string;
  serviceId?: string;
  url?: string;
  installPath?: string;
  projectDir?: string;
  process?: PersonalPluginRuntimeProcessInfo;
  mcp?: PersonalPluginMcpRuntimeStatus;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface PersonalPluginProcessHandle {
  pid?: number;
  processId?: string;
}

export interface PersonalPluginProcessStartRequest {
  runtimeId: string;
  pluginId: string;
  serviceId?: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  expectedUrl?: string;
  onExit?: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface PersonalPluginProcessStartResult extends PersonalPluginProcessHandle {
  url?: string;
}

export interface PersonalPluginProcessAdapter {
  start(request: PersonalPluginProcessStartRequest): Promise<PersonalPluginProcessStartResult>;
  stop(handle: PersonalPluginProcessHandle): Promise<void>;
}

export interface PersonalPluginMcpToolMetadata {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  isReadOnly: boolean;
}

export interface PersonalPluginMcpRuntimeStatus {
  state: 'attached' | 'detached';
  serverCount: number;
  tools: PersonalPluginMcpToolMetadata[];
}

export interface PersonalPluginMcpRuntimeHandle {
  runtimeId: string;
  processId?: string;
}

export interface PersonalPluginMcpAttachRequest {
  runtimeId: string;
  organizationId: string;
  spaceId: string;
  agentId?: string;
  pluginId: string;
  installPath: string;
  projectDir: string;
  env: Record<string, string>;
  mcp: PersonalPluginMcpCapability;
}

export interface PersonalPluginMcpAttachResult {
  handle: PersonalPluginMcpRuntimeHandle;
  tools: PersonalPluginMcpToolMetadata[];
}

export interface PersonalPluginMcpCallToolRequest {
  runtimeId: string;
  handle: PersonalPluginMcpRuntimeHandle;
  toolName: string;
  input: unknown;
}

export interface PersonalPluginMcpRuntimeAdapter {
  attach(request: PersonalPluginMcpAttachRequest): Promise<PersonalPluginMcpAttachResult>;
  detach(handle: PersonalPluginMcpRuntimeHandle): Promise<void>;
  callTool(request: PersonalPluginMcpCallToolRequest): Promise<unknown>;
}

export interface PersonalPluginBrowserOpenRequest {
  runtimeId: string;
  organizationId: string;
  spaceId: string;
  pluginId: string;
  url: string;
  title?: string;
}

export interface PersonalPluginBrowserOpenAdapter {
  open(request: PersonalPluginBrowserOpenRequest): Promise<void>;
}

export interface PersonalPluginRuntimeManagerOptions {
  /** （硬切）：组织级 Personal Plugin 存储数据根，缺省用 `resolveDataRoot()`。 */
  dataRoot?: string;
  processAdapter: PersonalPluginProcessAdapter;
  browserOpenAdapter?: PersonalPluginBrowserOpenAdapter;
  mcpRuntimeAdapter?: PersonalPluginMcpRuntimeAdapter;
  serviceReadinessProbe?: (url: string) => Promise<boolean>;
  serviceReadinessTimeoutMs?: number;
  serviceReadinessIntervalMs?: number;
}

export interface PersonalPluginRuntimeScope {
  organizationId: string;
  spaceId: string;
  agentId?: string;
  pluginId: string;
}

export interface LaunchPersonalPluginRuntimeOptions extends PersonalPluginRuntimeScope {
  /** （硬切）：解析已启用插件需要组织级 plugins 存储，dataRoot+userId 必填。 */
  dataRoot?: string;
  userId: string;
  projectDir: string;
  serviceId?: string;
  openBrowser?: boolean;
  title?: string;
  requireMcp?: boolean;
}

export type StopPersonalPluginRuntimeOptions = PersonalPluginRuntimeScope;
export type GetPersonalPluginRuntimeStatusOptions = PersonalPluginRuntimeScope;

export interface StopPersonalPluginRuntimesForPluginOptions {
  organizationId: string;
  pluginId: string;
}

export interface CallPersonalPluginMcpToolOptions extends PersonalPluginRuntimeScope {
  toolName: string;
  input?: unknown;
}

interface NormalizedLocalService {
  id?: string;
  command?: string;
  url?: string;
  port?: string | number;
  cwd?: string;
  env?: Record<string, string>;
}

interface RuntimeRecord extends PersonalPluginRuntimeStatus {
  processHandle?: PersonalPluginProcessHandle;
  mcpHandle?: PersonalPluginMcpRuntimeHandle;
}

interface PreparedPersonalPluginLaunch {
  scope: LaunchPersonalPluginRuntimeOptions;
  key: string;
  projectDir: string;
  enabledPlugin: InstalledPersonalPlugin;
  service: NormalizedLocalService;
  expectedUrl?: string;
  cwd: string;
  id: string;
  command: string;
  env: Record<string, string>;
  startedAt: string;
}

const defaultChildProcesses = new Map<string, ChildProcess>();
const DEFAULT_SERVICE_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_SERVICE_READINESS_INTERVAL_MS = 250;
const DEFAULT_SERVICE_READINESS_REQUEST_TIMEOUT_MS = 1_000;

function runtimeKey(scope: PersonalPluginRuntimeScope): string {
  return [
    scope.organizationId,
    scope.spaceId,
    scope.agentId ?? scope.spaceId,
    scope.pluginId,
  ].join('\u001f');
}

function runtimeId(scope: PersonalPluginRuntimeScope): string {
  const owner = scope.agentId ?? scope.spaceId;
  return `personal-plugin:${scope.organizationId}:${scope.spaceId}:${owner}:${scope.pluginId}`;
}

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new PersonalPluginRuntimeError(
      'PERSONAL_PLUGIN_PROJECT_DIR_MISSING',
      `Personal Plugin runtime requires ${label}`,
    );
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultServiceReadinessProbe(url: string): Promise<boolean> {
  if (!globalThis.fetch) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_SERVICE_READINESS_REQUEST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServiceReady(
  url: string,
  options: {
    probe?: (url: string) => Promise<boolean>;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<boolean> {
  const probe = options.probe ?? defaultServiceReadinessProbe;
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_SERVICE_READINESS_TIMEOUT_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_SERVICE_READINESS_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  do {
    const remainingMs = Math.max(1, deadline - Date.now());
    const attemptReady = await Promise.race([
      probe(url),
      sleep(Math.min(DEFAULT_SERVICE_READINESS_REQUEST_TIMEOUT_MS, remainingMs)).then(() => false),
    ]);
    if (attemptReady) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') env[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
  }
  return env;
}

function normalizeMcpEnv(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return undefined;
  const env: Record<string, string> = {};
  for (const server of Object.values(raw.mcpServers)) {
    if (!isRecord(server)) continue;
    Object.assign(env, normalizeEnv(server.env));
  }
  return env;
}

function normalizeLocalService(raw: unknown): NormalizedLocalService | null {
  if (!isRecord(raw)) return null;
  const port = raw.port;
  return {
    id: stringField(raw, 'id', 'name'),
    command: stringField(raw, 'command', 'run', 'script'),
    url: stringField(raw, 'url', 'localUrl', 'local_url'),
    port: typeof port === 'string' || typeof port === 'number' ? port : undefined,
    cwd: stringField(raw, 'cwd', 'workingDirectory', 'working_directory'),
    env: normalizeEnv(raw.env),
  };
}

function selectLocalService(
  plugin: InstalledPersonalPlugin,
  serviceId?: string,
): NormalizedLocalService {
  const services = plugin.capabilityManifest.localServices
    .map(normalizeLocalService)
    .filter((service): service is NormalizedLocalService => service !== null);
  const service = serviceId
    ? services.find((candidate) => candidate.id === serviceId)
    : services[0];
  if (!service) {
    throw new PersonalPluginRuntimeError(
      'PERSONAL_PLUGIN_SERVICE_NOT_DECLARED',
      `Personal Plugin has no declared local service: ${plugin.pluginId}`,
    );
  }
  if (!service.command) {
    throw new PersonalPluginRuntimeError(
      'PERSONAL_PLUGIN_SERVICE_COMMAND_MISSING',
      `Personal Plugin local service is missing a command: ${plugin.pluginId}`,
    );
  }
  return service;
}

function localServiceUrl(service: NormalizedLocalService): string | undefined {
  if (service.url) return service.url;
  if (service.port !== undefined && String(service.port).trim()) {
    return `http://127.0.0.1:${String(service.port).trim()}/`;
  }
  return undefined;
}

function resolveServiceCwd(installPath: string, service: NormalizedLocalService): string {
  if (!service.cwd) return installPath;
  const resolved = path.resolve(installPath, service.cwd);
  const relative = path.relative(path.resolve(installPath), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return installPath;
  return resolved;
}

export function createDefaultPersonalPluginProcessAdapter(): PersonalPluginProcessAdapter {
  return {
    async start(request) {
      const child = spawn(request.command, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        shell: true,
        stdio: 'ignore',
      });
      const processId = `pid:${child.pid ?? request.runtimeId}`;
      defaultChildProcesses.set(processId, child);
      child.once('exit', (code, signal) => {
        defaultChildProcesses.delete(processId);
        request.onExit?.({ code, signal });
      });
      child.unref();
      return { pid: child.pid, processId, url: request.expectedUrl };
    },
    async stop(handle) {
      const processId = handle.processId ?? (handle.pid ? `pid:${handle.pid}` : undefined);
      const child = processId ? defaultChildProcesses.get(processId) : undefined;
      if (child && !child.killed) {
        child.kill();
        return;
      }
      if (handle.pid) {
        try {
          process.kill(handle.pid);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') throw err;
        }
      }
    },
  };
}

export class PersonalPluginRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  constructor(private readonly options: PersonalPluginRuntimeManagerOptions) {}

  async launch(options: LaunchPersonalPluginRuntimeOptions): Promise<PersonalPluginRuntimeStatus> {
    const scope = { ...options, dataRoot: options.dataRoot ?? this.options.dataRoot };
    const key = runtimeKey(scope);
    const existing = this.runtimes.get(key);
    const reused = await this.reuseExistingRuntime(existing, options);
    if (reused) return reused;

    const prepared = await this.prepareLaunch(scope, key);
    const processResult = await this.startLocalService(prepared);
    const url = await this.resolveStartedServiceUrl(prepared, processResult);
    const mcpAttachResult = await this.attachMcpRuntimeIfNeeded(prepared, processResult);
    const record = this.buildRuntimeRecord(prepared, processResult, url, mcpAttachResult);
    this.runtimes.set(key, record);

    if (options.openBrowser !== false) {
      await this.openRuntimeBrowser(record, options.title);
    }

    return { ...record };
  }

  private async reuseExistingRuntime(
    existing: RuntimeRecord | undefined,
    options: LaunchPersonalPluginRuntimeOptions,
  ): Promise<PersonalPluginRuntimeStatus | null> {
    if (existing?.state !== 'running' || !existing.url) return null;
    if (options.openBrowser !== false) {
      await this.openRuntimeBrowser(existing, options.title);
    }
    return { ...existing };
  }

  private async prepareLaunch(
    scope: LaunchPersonalPluginRuntimeOptions,
    key: string,
  ): Promise<PreparedPersonalPluginLaunch> {
    const projectDir = assertNonEmpty(scope.projectDir, 'projectDir');
    const enabledPlugin = await this.resolveEnabledPlugin(scope);
    const service = selectLocalService(enabledPlugin, scope.serviceId);
    const expectedUrl = localServiceUrl(service);
    const cwd = resolveServiceCwd(enabledPlugin.installPath, service);
    const id = runtimeId(scope);
    const command = service.command!;
    const env = {
      ...(service.env ?? {}),
      COWART_PROJECT_DIR: projectDir,
    };
    return {
      scope,
      key,
      projectDir,
      enabledPlugin,
      service,
      expectedUrl,
      cwd,
      id,
      command,
      env,
      startedAt: new Date().toISOString(),
    };
  }

  private startLocalService(prepared: PreparedPersonalPluginLaunch): Promise<PersonalPluginProcessStartResult> {
    return this.options.processAdapter.start({
      runtimeId: prepared.id,
      pluginId: prepared.enabledPlugin.pluginId,
      serviceId: prepared.service.id,
      command: prepared.command,
      cwd: prepared.cwd,
      env: prepared.env,
      expectedUrl: prepared.expectedUrl,
      onExit: (exit) => this.markStopped(prepared.key, exit),
    });
  }

  private async resolveStartedServiceUrl(
    prepared: PreparedPersonalPluginLaunch,
    processResult: PersonalPluginProcessStartResult,
  ): Promise<string> {
    const url = processResult.url ?? prepared.expectedUrl;
    if (url) return url;
    await this.options.processAdapter.stop(processResult);
    throw new PersonalPluginRuntimeError(
      'PERSONAL_PLUGIN_SERVICE_URL_MISSING',
      `Personal Plugin local service did not provide a browser URL: ${prepared.enabledPlugin.pluginId}`,
    );
  }

  private async attachMcpRuntimeIfNeeded(
    prepared: PreparedPersonalPluginLaunch,
    processResult: PersonalPluginProcessStartResult,
  ): Promise<PersonalPluginMcpAttachResult | undefined> {
    if (prepared.scope.requireMcp === true && !this.options.mcpRuntimeAdapter) {
      await this.options.processAdapter.stop(processResult);
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_START_FAILED',
        `Personal Plugin MCP adapter is not configured: ${prepared.enabledPlugin.pluginId}`,
      );
    }
    if (!this.shouldAttachMcp(prepared)) return undefined;
    return this.attachMcpRuntime(prepared, processResult);
  }

  private shouldAttachMcp(prepared: PreparedPersonalPluginLaunch): boolean {
    return Boolean(
      this.options.mcpRuntimeAdapter &&
      (prepared.enabledPlugin.capabilityManifest.mcp || prepared.scope.requireMcp === true),
    );
  }

  private async attachMcpRuntime(
    prepared: PreparedPersonalPluginLaunch,
    processResult: PersonalPluginProcessStartResult,
  ): Promise<PersonalPluginMcpAttachResult> {
    try {
      const mcp = this.requireMcpCapability(prepared.enabledPlugin);
      const mcpEnv = {
        ...prepared.env,
        ...(normalizeMcpEnv(mcp.raw) ?? {}),
        COWART_PROJECT_DIR: prepared.projectDir,
        TABTIN_PLUGIN_INSTALL_PATH: prepared.enabledPlugin.installPath,
      };
      return await this.options.mcpRuntimeAdapter!.attach({
        runtimeId: prepared.id,
        organizationId: prepared.scope.organizationId,
        spaceId: prepared.scope.spaceId,
        agentId: prepared.scope.agentId,
        pluginId: prepared.enabledPlugin.pluginId,
        installPath: prepared.enabledPlugin.installPath,
        projectDir: prepared.projectDir,
        env: mcpEnv,
        mcp,
      });
    } catch (err) {
      await this.options.processAdapter.stop(processResult);
      if (err instanceof PersonalPluginRuntimeError) throw err;
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_START_FAILED',
        `Personal Plugin MCP runtime failed to start: ${(err as Error).message}`,
      );
    }
  }

  private buildRuntimeRecord(
    prepared: PreparedPersonalPluginLaunch,
    processResult: PersonalPluginProcessStartResult,
    url: string,
    mcpAttachResult: PersonalPluginMcpAttachResult | undefined,
  ): RuntimeRecord {
    return {
      runtimeId: prepared.id,
      state: 'running',
      organizationId: prepared.scope.organizationId,
      spaceId: prepared.scope.spaceId,
      agentId: prepared.scope.agentId,
      pluginId: prepared.enabledPlugin.pluginId,
      serviceId: prepared.service.id,
      url,
      installPath: prepared.enabledPlugin.installPath,
      projectDir: prepared.projectDir,
      process: {
        pid: processResult.pid,
        processId: processResult.processId,
        command: prepared.command,
        cwd: prepared.cwd,
      },
      processHandle: processResult,
      mcp: this.buildMcpStatus(prepared.enabledPlugin, mcpAttachResult),
      mcpHandle: mcpAttachResult?.handle,
      startedAt: prepared.startedAt,
    };
  }

  private buildMcpStatus(
    plugin: InstalledPersonalPlugin,
    mcpAttachResult: PersonalPluginMcpAttachResult | undefined,
  ): PersonalPluginMcpRuntimeStatus | undefined {
    if (!mcpAttachResult) return undefined;
    return {
      state: 'attached',
      serverCount: plugin.capabilityManifest.mcp?.serverCount ?? 0,
      tools: mcpAttachResult.tools,
    };
  }

  private async openRuntimeBrowser(
    runtime: Pick<RuntimeRecord, 'runtimeId' | 'organizationId' | 'spaceId' | 'pluginId' | 'url'>,
    title: string | undefined,
  ): Promise<void> {
    if (!runtime.url) return;
    await this.waitForBrowserUrl(runtime.url);
    await this.options.browserOpenAdapter?.open({
      runtimeId: runtime.runtimeId,
      organizationId: runtime.organizationId,
      spaceId: runtime.spaceId,
      pluginId: runtime.pluginId,
      url: runtime.url,
      title,
    });
  }

  private async waitForBrowserUrl(url: string): Promise<void> {
    await waitForServiceReady(url, {
      probe: this.options.serviceReadinessProbe,
      timeoutMs: this.options.serviceReadinessTimeoutMs,
      intervalMs: this.options.serviceReadinessIntervalMs,
    });
  }

  getStatus(options: GetPersonalPluginRuntimeStatusOptions): PersonalPluginRuntimeStatus {
    const existing = this.runtimes.get(runtimeKey(options));
    if (existing) return { ...existing };
    return {
      runtimeId: runtimeId(options),
      state: 'stopped',
      organizationId: options.organizationId,
      spaceId: options.spaceId,
      agentId: options.agentId,
      pluginId: options.pluginId,
    };
  }

  listMcpTools(options: GetPersonalPluginRuntimeStatusOptions): PersonalPluginMcpToolMetadata[] {
    const existing = this.runtimes.get(runtimeKey(options));
    if (existing?.state !== 'running' || existing.mcp?.state !== 'attached') return [];
    return existing.mcp.tools.map((tool) => ({ ...tool }));
  }

  async callMcpTool(options: CallPersonalPluginMcpToolOptions): Promise<unknown> {
    const existing = this.runtimes.get(runtimeKey(options));
    if (existing?.state !== 'running' || existing.mcp?.state !== 'attached' || !existing.mcpHandle) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_NOT_RUNNING',
        `Personal Plugin MCP runtime is not running: ${options.pluginId}`,
      );
    }
    const tool = existing.mcp.tools.find((candidate) => candidate.name === options.toolName);
    if (!tool) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_TOOL_NOT_FOUND',
        `Personal Plugin MCP tool is not available: ${options.toolName}`,
      );
    }
    if (!this.options.mcpRuntimeAdapter) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_NOT_RUNNING',
        `Personal Plugin MCP adapter is not configured: ${options.pluginId}`,
      );
    }
    return this.options.mcpRuntimeAdapter.callTool({
      runtimeId: existing.runtimeId,
      handle: existing.mcpHandle,
      toolName: options.toolName,
      input: options.input,
    });
  }

  async stop(options: StopPersonalPluginRuntimeOptions): Promise<PersonalPluginRuntimeStatus> {
    const key = runtimeKey(options);
    const existing = this.runtimes.get(key);
    if (!existing || existing.state === 'stopped') {
      return this.getStatus(options);
    }
    if (existing.processHandle) {
      try {
        if (existing.mcpHandle) {
          await this.options.mcpRuntimeAdapter?.detach(existing.mcpHandle);
        }
      } finally {
        await this.options.processAdapter.stop(existing.processHandle);
      }
    }
    this.markStopped(key, { code: null, signal: null });
    return this.getStatus(options);
  }

  async stopAllForPlugin(options: StopPersonalPluginRuntimesForPluginOptions): Promise<PersonalPluginRuntimeStatus[]> {
    const targets = Array.from(this.runtimes.values())
      .filter((record) => (
        record.state === 'running'
        && record.organizationId === options.organizationId
        && record.pluginId === options.pluginId
      ));

    const stopped: PersonalPluginRuntimeStatus[] = [];
    for (const target of targets) {
      stopped.push(await this.stop({
        organizationId: target.organizationId,
        spaceId: target.spaceId,
        agentId: target.agentId,
        pluginId: target.pluginId,
      }));
    }
    return stopped;
  }

  private async resolveEnabledPlugin(scope: LaunchPersonalPluginRuntimeOptions): Promise<InstalledPersonalPlugin> {
    const plugins = await listPersonalPluginEnablement({
      dataRoot: scope.dataRoot,
      userId: scope.userId,
      organizationId: scope.organizationId,
    });
    const plugin = plugins.find((candidate) => candidate.pluginId === scope.pluginId);
    if (!plugin) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_NOT_INSTALLED',
        `Personal Plugin is not installed: ${scope.pluginId}`,
      );
    }
    if (!plugin.enabled) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_NOT_ENABLED',
        `Personal Plugin is not enabled for this Agent: ${scope.pluginId}`,
      );
    }
    return plugin;
  }

  private requireMcpCapability(plugin: InstalledPersonalPlugin): PersonalPluginMcpCapability {
    const mcp = plugin.capabilityManifest.mcp;
    if (!mcp || mcp.serverCount <= 0) {
      throw new PersonalPluginRuntimeError(
        'PERSONAL_PLUGIN_MCP_NOT_DECLARED',
        `Personal Plugin has no declared MCP runtime: ${plugin.pluginId}`,
      );
    }
    return mcp;
  }

  private markStopped(
    key: string,
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    const existing = this.runtimes.get(key);
    if (!existing || existing.state === 'stopped') return;
    this.runtimes.set(key, {
      ...existing,
      state: 'stopped',
      mcp: existing.mcp
        ? { ...existing.mcp, state: 'detached', tools: [] }
        : undefined,
      stoppedAt: new Date().toISOString(),
      exitCode: exit.code,
      signal: exit.signal,
      processHandle: undefined,
      mcpHandle: undefined,
    });
  }
}
