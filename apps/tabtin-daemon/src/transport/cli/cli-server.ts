/**
 * Daemon CLI Server
 *
 * HTTP server over Unix Socket (macOS/Linux) or Named Pipe (Windows).
 * Mirrors Electron's CLI Server so that the `tabtin` CLI tool can discover
 * and communicate with the running Daemon via `~/.tabtin/daemon-server.json`.
 *
 * All routes have concrete handler implementations.
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../platform/observability/logging/logger.js';
import { checkHardlineCommand } from '@tabtin/security-policy';
import { checkDaemonPathAccess } from '../../application/security/path-access.js';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import { okResponse } from '@tabtin/agent-wire';
import {
  SlidingWindowRateLimiter,
  parseBody,
  sendJSON as coreSendJSON,
  errorResponse as coreErrorResponse,
  validateCSRFHeaders,
  validateTokenAuth,
  type CLIServerInfo,
  createCLIHttpServer,
  writeDiscoveryFile,
  cleanupSocketFile,
  cleanupDiscoveryFile,
  getSurfaceByHttpPath,
  createSurfaceHttpHandler,
  configureSurfaceRuntime,
  createSurfacesEndpoint,
  scanMarketplaceManifests,
} from '@tabtin/cli-server-core';
import {
  configureCLIRoutes,
  handleTableRoute,
  handleSpaceRoute,
  handleFetchRoute,
  handleCodeRoute,
  handleDriveRoute,
  handleCapabilitiesRoute,
  handleExtensionsRoute,
  handleOSSRoute,
  handleSearchRoute,
} from '@tabtin/cli-routes';
import { configureDjangoProxy, clearDjangoProxy, updateDjangoProxyCredential } from './routes/shared/error-handler.js';
import { handleSlideRoute } from './routes/media/slide.js';
import { handleMediaRoute } from './routes/media/index.js';
import { handleVideoRoute } from './routes/media/video.js';
import { handleSpeechRoute } from './routes/media/speech.js';
import { handleDeviceRoute } from './routes/device/index.js';
import { handleTabsiteRoute } from './routes/media/tabsite.js';
import { handleBrowserRoute } from './routes/browser/index.js';
import { handleAgentRoute } from './routes/agent/index.js';
import { handleSkillsRoute } from './routes/skills/index.js';
import { handleStorageRoute } from './routes/storage/index.js';
import { djangoRequest, sendDjangoResult } from './routes/shared/error-handler.js';
import { createHeadlessAdapter } from '@tabtin/action-tools/headless';
import {
  CliRequestContext,
  type CliRequestContextOptions,
  type EnvironmentPort,
} from './cli-context.js';
import type { BrowserApplicationPort } from '../../base/browser/browser-application-port.js';
import type { DaemonStorageApplication } from '../../application/storage/daemon-storage.js';
// PlatformSurface 定义导入（Wave 3）：触发 chatExportMd 自动注册到 registry
import '@tabtin/cli-server-core/surfaces/chat-export-md';

const LOG_TAG = '[CLI Server]';

// ── W7：marketplace App 命令缓存（懒加载）──────────────────────────
// Daemon 进程下扫描 packages/apps/ 目录中 distribution=marketplace 的 manifest，
// 缓存结果供 /extensions/cli-commands 响应合并。
const __dirname = fileURLToPath(new URL('.', import.meta.url));
let _marketplaceCommandsCache: unknown[] | null = null;
function getMarketplaceCommands(): unknown[] {
  if (_marketplaceCommandsCache) return _marketplaceCommandsCache;
  const candidates = [
    join(__dirname, '..', '..', '..', '..', '..', 'packages', 'apps'),
    join(__dirname, '..', '..', '..', 'packages', 'apps'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) {
      _marketplaceCommandsCache = scanMarketplaceManifests(dir);
      return _marketplaceCommandsCache;
    }
  }
  _marketplaceCommandsCache = [];
  return _marketplaceCommandsCache;
}

// ── Types ────────────────────────────────────────────────────────

export interface DaemonCLIServerConfig {
  socketPath?: string;
  version?: string;
  spaceId?: string | null;
  logger?: Logger;
  serverUrl?: string;
  wsUrl?: string;
  credential?: string;
  organizationId?: string;
  /** ：install token payload.user_id，透传给 cli-context 供本地 skills/plugins 落盘使用。 */
  userId?: string;
  fingerprint?: string;
  browserApplicationPort?: BrowserApplicationPort | null;
  storageApplication?: DaemonStorageApplication;
  requestContext?: Omit<CliRequestContextOptions, 'environment' | 'spaceId' | 'browserApplication' | 'wsConnectionInfo'>;
  environment?: EnvironmentPort;
  /** Tests/embedded hosts may opt out of the process-wide discovery file. */
  publishDiscovery?: boolean;
}

export type { CLIServerInfo };

export class DaemonCliServer {
  server: http.Server | null = null;
  info: CLIServerInfo | null = null;
  version = '0.0.0';
  logger: Logger | null = null;
  storageApplication: DaemonStorageApplication | null = null;
  context: CliRequestContext | null = null;
  activeRequests = 0;
  ownsDiscovery = false;

  start(config?: DaemonCLIServerConfig): CLIServerInfo {
    return startCLIServerInstance(this, config);
  }

  stop(): Promise<void> {
    return stopCLIServerInstance(this);
  }

  suspendIngress(): void {
    this.server?.close();
  }

  getActiveRequestCount(): number { return this.activeRequests; }
  getInfo(): CLIServerInfo | null { return this.info; }
  updateCredential(value: string): void {
    this.context?.updateWsCredential(value);
    if (activeCliServer === this) updateDjangoProxyCredential(value);
  }
  updateSpace(spaceId: string | null): void {
    this.context?.setSpaceId(spaceId);
    if (activeCliServer === this) configureSurfaceRuntime({ djangoRequest, spaceId: this.context?.getSpaceId() ?? null });
  }
}

const defaultCliServer = new DaemonCliServer();
let activeCliServer: DaemonCliServer | null = null;

function currentCliServer(): DaemonCliServer {
  return activeCliServer ?? defaultCliServer;
}

export type { WsConnectionInfo, CLISkillsMaterializer, CLISkillsInteropAdder } from './cli-context.js';

function requireCliContext(owner: DaemonCliServer = currentCliServer()): CliRequestContext {
  if (!owner.context) throw new Error('CLI request context is unavailable');
  return owner.context;
}

export const getCLISpaceId = (): string | null => currentCliServer().context?.getSpaceId() ?? null;
export const getCLIActionAdapter = () => currentCliServer().context?.getActionAdapter() ?? null;
export const getCLIWsConnectionInfo = () => currentCliServer().context?.getWsConnectionInfo() ?? null;
export const updateCLIWsCredential = (value: string): void => currentCliServer().updateCredential(value);
export const setCLISubagentCancelResolver = (value: ((childId: string) => boolean) | null): void => requireCliContext().setSubagentCancelResolver(value);
export const setCLISkillsMaterializer = (value: import('./cli-context.js').CLISkillsMaterializer | null): void => requireCliContext().setSkillsMaterializer(value);
export const setCLISkillsInteropAdder = (value: import('./cli-context.js').CLISkillsInteropAdder | null): void => requireCliContext().setSkillsInteropAdder(value);

// 历史上 daemon CLI server 缓存过 v1 UnifiedSecurityPolicy，由 daemon.ts
// 在收到 prompt.forward 时通过 setCLISecurityPolicy 同步。Hilt v3 切换后路由
// 安全检查改为 stateless 的 hardline check（见 evaluateCLIPolicy + 下方
// checkHardlineCommand / checkHardlinePath 调用），缓存接口已无依赖，整个

const CLI_ROUTE_ACTION_MAP: Record<string, string> = {
  // 文件/代码操作
  '/code/write': 'write_file',
  '/code/edit': 'edit_file',
  '/code/delete': 'delete_file',
  '/code/read': 'read_file',
  '/code/glob': 'glob_search',
  '/code/grep': 'grep_search',
  // Browser 高权限操作（BT-012/BT-017）：所有 browser 路由纳入策略管控，
  // 消除 Space 级别 sandbox_policy 对 browser 操作无效的问题。
  // /execute 和 /eval 在页面上下文执行任意 JS，按终端执行策略管控。
  '/browser/execute': 'execute_in_terminal',
  '/browser/eval': 'execute_in_terminal',
  // 导航操作：写入 URL 到浏览器，网络访问类
  '/browser/open': 'browser_navigate',
  '/browser/navigate': 'browser_navigate',
  // 浏览器操作：act 在页面上执行写操作（点击、输入等），需要审批
  '/browser/act': 'execute_act',
  // 浏览器操作：glance 只读观察页面（原 observe/snapshot 收编），可以宽松
  '/browser/glance': 'execute_observe',
  // print 导出页面内容到文件（原 extract/markdown/pdf 收编）
  '/browser/print': 'browser_pdf',
  '/video/analyze': 'read_file',
  '/video/reframe': 'write_file',
  '/video/reframe/analyze': 'read_file',
  '/video/reframe/multi': 'write_file',
  '/video/orchestrate': 'write_file',
  '/video/build': 'write_file',
  '/video/gen': 'write_file',
};

// Prefix-based routes that should also pass through policy evaluation.
// Checked only when no exact match is found in CLI_ROUTE_ACTION_MAP.
const CLI_ROUTE_PREFIX_ACTIONS: ReadonlyArray<readonly [prefix: string, actionType: string]> = [
  ['/agent/message', 'execute_in_terminal'],
] as const;

// CC-006: sliding window rate limiter for grep-heavy CLI routes
const codeGrepRateLimiter = new SlidingWindowRateLimiter(20, 60_000);

interface CLIPolicyResult {
  action: 'block';
  reason: string;
  ruleName?: string;
}

function evaluateCLIPolicy(url: string, body: any, owner: DaemonCliServer): CLIPolicyResult | null {
  const actionType = resolveCLIActionType(url);
  if (!actionType) return null;
  return evaluateCommandPolicy(body) ?? evaluatePathPolicy(body, owner);
}

function resolveCLIActionType(url: string): string | undefined {
  return CLI_ROUTE_ACTION_MAP[url]
    ?? CLI_ROUTE_PREFIX_ACTIONS.find(([prefix]) => url.startsWith(prefix))?.[1];
}

function evaluateCommandPolicy(body: any): CLIPolicyResult | null {
  const command = body?.command || body?.expression || body?.code || '';
  if (typeof command !== 'string' || !command) return null;
  const cmdHit = checkHardlineCommand(command);
  return cmdHit.hit
    ? { action: 'block', reason: cmdHit.description ?? 'Command blocked by hardline', ruleName: cmdHit.pattern }
    : null;
}

function evaluatePathPolicy(body: any, owner: DaemonCliServer): CLIPolicyResult | null {
  const filePath = firstStringField(body, ['file_path', 'path', 'video_path', 'output_path', 'output']);
  if (typeof filePath !== 'string' || !filePath) return null;
    // 路径权限治理 Wave 4：CLI server 走 v3 SSoT —— 红线 + 敏感路径 +
    // workspace boundary 三段式（修 01 图谱 §断层 5）。
    // CLI 客户端（Go CLI、`tabtin` 命令等）不带 spaceId，按 dogfood 单
    // session 模式取"任一活跃 session 的 snapshot"；snapshot 缺失时
    // 退化到 process.cwd() 单条目录兜底（与 cli-server `workspaceRootForCode`
    // 同模式）。
    const snapshot = owner.context?.resolveWorkspaceSnapshot() ?? null;
    const access = checkDaemonPathAccess(filePath, 'write', {
      snapshot,
      fallbackRoots: [process.cwd()],
    });
  return access.allowed ? null : {
    action: 'block',
    reason: access.reason?.message ?? 'Path blocked by security policy',
    ruleName: access.reason?.reasonCode ?? 'security-policy',
  };
}

function firstStringField(body: any, fields: readonly string[]): string {
  for (const field of fields) {
    if (typeof body?.[field] === 'string' && body[field]) return body[field];
  }
  return '';
}

/**
 * 路径权限治理 Wave 4：模块级 v3 snapshot 解析器。
 *
 * `evaluateCLIPolicy` 是模块顶层函数（被 handleRequest 直接调用），不持有
 * server 实例引用；用模块级单例 + setter 注入避免改动 evaluateCLIPolicy 的
 * 签名（避免破坏与 @tabtin/cli-routes 的契约）。
 *
 * 由 daemon.ts 在 startCLIServer 之后调 setCLIWorkspaceSnapshotResolver 注入。
 */
export function setCLIWorkspaceSnapshotResolver(
  resolver: () => import('@tabtin/security-policy').WorkspaceSnapshot | null,
): void {
  requireCliContext().setWorkspaceSnapshotResolver(resolver);
}

// ── Helpers ──────────────────────────────────────────────────────

function getDirname(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return __dirname ?? process.cwd();
  }
}

function log(owner: DaemonCliServer, level: 'info' | 'warn' | 'error', msg: string, ...args: any[]): void {
  if (owner.logger) {
    owner.logger[level](`${LOG_TAG} ${msg}`, ...args);
  } else {
    const fn = level === 'error' ? console.error : console.log;
    fn(`${LOG_TAG} ${msg}`, ...args);
  }
}

/**
 * Verify that the process identified by `pid` is owned by the same OS user
 * as the current daemon process.
 * - Linux: reads /proc/<pid>/status
 * - macOS: uses `ps -p <pid> -o uid=`
 * - Windows: skipped (named pipes provide OS-level access control)
 * Returns false (deny) when the check fails on supported platforms.
 */
async function isCallerSameUser(pid: number): Promise<boolean> {
  if (process.platform === 'win32') return true; // named pipe ACLs handle isolation

  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const uidLine = status.split('\n').find((l) => l.startsWith('Uid:'));
      if (!uidLine) return false;
      const callerUid = parseInt(uidLine.split(/\s+/)[1] ?? '', 10);
      if (isNaN(callerUid)) return false;
      return callerUid === process.getuid!();
    } catch {
      return false;
    }
  }

  // macOS (darwin) and other Unix-like — use async execFile to avoid blocking the event loop.
  // execSync('ps ...') can block for up to its full timeout (3s), causing DoS under repeated calls.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    execFile('ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf-8' }, (err, stdout) => {
      clearTimeout(timer);
      if (err) { resolve(false); return; }
      const callerUid = parseInt(stdout.trim(), 10);
      if (isNaN(callerUid)) { resolve(false); return; }
      resolve(callerUid === process.getuid!());
    });
  });
}

// Alias for backward compatibility within this module
const sendJSON = coreSendJSON;
const errorResponse = coreErrorResponse;

function stubRoute(res: http.ServerResponse, domain: string): void {
  sendJSON(res, 501, errorResponse(
    'NOT_IMPLEMENTED',
    `/${domain} 命令在 Daemon 模式下尚未实现`,
    { suggestions: [
      '请使用 TabTin 桌面客户端（Electron）执行此操作',
      '或等待后续版本支持',
    ] },
  ));
}

// ── Request handler ──────────────────────────────────────────────

/**
 * TD-1/H-2：从 CLI 进来的请求里挑出 Agent run/session 上下文头，转发给 Django，
 * 让版本历史 / ChangeLog 归因为 agent。只透传白名单内的头。
 */
function pickAgentContextHeaders(
  req: http.IncomingMessage,
): Record<string, string> {
  const out: Record<string, string> = {};
  const runId = req.headers['x-tabtin-agent-run-id'];
  const sessionId = req.headers['x-tabtin-session-id'];
  if (typeof runId === 'string' && runId) out['X-Tabtin-Agent-Run-Id'] = runId;
  if (typeof sessionId === 'string' && sessionId) out['X-Tabtin-Session-Id'] = sessionId;
  return out;
}

async function dispatchCLIRoute(
  owner: DaemonCliServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  body: any,
): Promise<boolean> {
  const routeHandlers: ReadonlyArray<readonly [string, () => Promise<void> | void]> = [
    ['/table/', () => handleTableRoute(url, method, body, res, sendJSON)],
    ['/slide/', () => handleSlideRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/image/', () => handleMediaRoute(url.replace(/^\/image/, '/media'), method, body, res, sendJSON)],
    ['/media/', () => handleMediaRoute(url, method, body, res, sendJSON)],
    ['/video/', () => handleVideoRoute(url, method, body, res, sendJSON)],
    ['/audio/', () => handleSpeechRoute(url.replace(/^\/audio/, '/speech'), method, body, res, sendJSON)],
    ['/speech/', () => handleSpeechRoute(url, method, body, res, sendJSON)],
    ['/space/', () => handleSpaceRoute(url, method, body, res, sendJSON)],
    ['/code/', () => handleCodeRouteWithRateLimit(url, method, body, res)],
    ['/device/', () => handleDeviceRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/capabilities/', () => handleCapabilitiesRoute(url, method, body, res, sendJSON)],
    ['/extensions/', () => handleExtensionsRoute(url, method, body, res, sendJSON, { marketplaceCommands: getMarketplaceCommands() })],
    ['/site/', () => handleTabsiteRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/skills/', () => handleSkillsRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/storage/', () => handleStorageRoute(url, method, body, res, sendJSON, requireStorageApplication(owner))],
    ['/browser/', () => handleBrowserRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/agent/', () => handleAgentRoute(url, method, body, res, sendJSON, requireCliContext(owner))],
    ['/oss/', () => handleOSSRoute(url, method, body, res, sendJSON)],
    ['/drive/', () => handleDriveRoute(url, method, body, res, sendJSON)],
    ['/session/', () => stubRoute(res, 'session')],
    ['/api/', () => proxyDjangoRequest(req, res, url, method, body)],
    ['/desktop/', () => stubRoute(res, 'desktop')],
  ];
  if (url === '/fetch') {
    await handleFetchRoute(url, method, body, res, sendJSON);
    return true;
  }
  if (url === '/search' || url.startsWith('/search?')) {
    await handleSearchRoute(url, method, body, res, sendJSON);
    return true;
  }
  const matched = routeHandlers.find(([prefix]) => url.startsWith(prefix));
  if (!matched) return false;
  await matched[1]();
  return true;
}

async function handleCodeRouteWithRateLimit(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
): Promise<void> {
  if (url === '/code/grep' && !codeGrepRateLimiter.tryAcquire()) {
    sendJSON(res, 429, errorResponse('RATE_LIMIT_EXCEEDED', 'Too many grep requests. Max 20 per minute.'));
    return;
  }
  await handleCodeRoute(url, method, body, res, sendJSON);
}

async function proxyDjangoRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  body: any,
): Promise<void> {
  const result = await djangoRequest(method, url, body, {
    logTag: '[CLI Proxy]',
    extraHeaders: pickAgentContextHeaders(req),
  });
  sendDjangoResult(res, sendJSON, result);
}

export function getActiveCLIRequestCount(): number {
  return currentCliServer().getActiveRequestCount();
}

async function handleRequestCore(
  owner: DaemonCliServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url || '/';

  if (validateCSRFHeaders(req, res)) return;

  if (url === '/health') { sendHealth(owner, res); return; }
  if (url === '/dev/token') { await sendDevToken(owner, req, res); return; }

  if (validateTokenAuth(req, res, owner.info?.token ?? null, [
    '确保在 Daemon 管理的终端中运行命令',
    '运行 tabtin-daemon init 重新配置',
  ])) return;

  try {
    // /surfaces endpoint（Wave 4）：暴露 registry 清单供 Go CLI / Agent 发现新能力
    if (url === '/surfaces') {
      const surfacesHandler = createSurfacesEndpoint();
      await surfacesHandler(req, res);
      return;
    }

    // PlatformSurface 路由分发（Wave 3）：在手写路由之前查找 registry，
    // 命中则走 surface HTTP adapter（内部自行 parseBody），不再落入下方手写路由。
    const matchedSurface = getSurfaceByHttpPath(url);
    if (matchedSurface) {
      const surfaceHandler = createSurfaceHttpHandler(matchedSurface);
      await surfaceHandler(req, res);
      return;
    }

    const body = await parseBody(req);
    const method = (req.method || 'GET').toUpperCase();

    // ── Security policy middleware ──────────────────────
    // Hilt v3 切换后 CLIPolicyResult.action 只剩 'block' 一种形态（confirm
    // 流程下沉到 ApprovalManager / DaemonActionBridge，不在 CLI 路由层做）。
    // 原本的 `if (action === 'confirm')` 分支已是 TS narrowing 不可达的死代码，
    // 一并清理。POLICY_CONFIRM_REQUIRED 错误码定义仍留在 cli-server-core，待
    // W6 重组业务码时按 surface 拆分。
    const policyDecision = evaluateCLIPolicy(url, body, owner);
    if (policyDecision) {
      const ruleHint = policyDecision.ruleName ? ` [rule: ${policyDecision.ruleName}]` : '';
      sendJSON(res, 403, errorResponse('POLICY_BLOCKED', policyDecision.reason + ruleHint));
      return;
    }

    if (await dispatchCLIRoute(owner, req, res, url, method, body)) return;

    sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知路由: ${url}`, {
      suggestions: ['使用 tabtin --help 查看可用命令'],
    }));
  } catch (err: any) {
    sendRequestError(owner, res, err);
  }
}

async function handleRequest(owner: DaemonCliServer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  owner.activeRequests += 1;
  try {
    await handleRequestCore(owner, req, res);
  } finally {
    owner.activeRequests -= 1;
  }
}

function sendHealth(owner: DaemonCliServer, res: http.ServerResponse): void {
  sendJSON(res, 200, okResponse({
    status: 'ok', version: owner.version, spaceId: owner.context?.peekSpaceId() ?? null, source: 'daemon',
    uptime: process.uptime(), pid: process.pid,
  }));
}

async function sendDevToken(owner: DaemonCliServer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const header = req.headers['x-tabtin-caller-pid'];
  const callerPid = header ? Number(header) : NaN;
  if (isNaN(callerPid) || callerPid <= 0) {
    log(owner, 'warn', '[/dev/token] missing or invalid x-tabtin-caller-pid header — access denied');
    sendJSON(res, 403, errorResponse('FORBIDDEN', 'x-tabtin-caller-pid header is required'));
    return;
  }
  if (!await isCallerSameUser(callerPid)) {
    log(owner, 'warn', `[/dev/token] UID mismatch for caller PID ${callerPid} — access denied`);
    sendJSON(res, 403, errorResponse('FORBIDDEN', 'Caller process does not belong to the same OS user'));
    return;
  }
  log(owner, 'info', `[/dev/token] token refreshed (caller PID: ${callerPid})`);
  sendJSON(res, 200, okResponse({ token: owner.info?.token, sock: owner.info?.socketPath }));
}

function sendRequestError(owner: DaemonCliServer, res: http.ServerResponse, err: any): void {
  log(owner, 'error', 'Request error:', err);
  const knownErrors: Record<string, readonly [number, string, string]> = {
    'Body read timeout': [408, 'REQUEST_TIMEOUT', '请求体读取超时，请重试'],
    'Request body too large': [413, 'PAYLOAD_TOO_LARGE', '请求体过大，最大允许 10MB'],
    'Invalid JSON body': [400, 'VALIDATION_ERROR', '请求体必须是合法 JSON'],
  };
  const known = err instanceof Error ? knownErrors[err.message] : undefined;
  if (known) {
    sendJSON(res, known[0], errorResponse(known[1], known[2]));
    return;
  }
  sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal server error', { retryable: true }));
}

// ── Public API ───────────────────────────────────────────────────

function checkExistingDaemon(): { pid: number; socketPath: string } | null {
  try {
    const configDir = getHomeTabtinPath();
    const filePath = join(configDir, 'daemon-server.json');
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data?.pid || data.pid === process.pid) return null;
    try {
      process.kill(data.pid, 0);
      return { pid: data.pid, socketPath: data.sock || '' };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function startCLIServer(config?: DaemonCLIServerConfig): CLIServerInfo {
  return defaultCliServer.start(config);
}

function startCLIServerInstance(owner: DaemonCliServer, config?: DaemonCLIServerConfig): CLIServerInfo {
  if (owner.server) {
    log(owner, 'warn', 'Server already running');
    return owner.info!;
  }
  if (activeCliServer && activeCliServer !== owner) {
    throw new Error('A DaemonCliServer is already active in this process');
  }
  let context: CliRequestContext | null = null;
  let created: ReturnType<typeof createCLIHttpServer>;
  try {
    activeCliServer = owner;

    const existing = checkExistingDaemon();
    if (existing) {
      log(owner, 'warn', `Another Daemon is already running (PID ${existing.pid}, socket: ${existing.socketPath}). Replacing its discovery file.`);
    }

    context = applyCLIServerConfig(owner, config);

  context.setActionAdapter(createHeadlessAdapter());

  // Wave 4b：把宿主特有能力注入 @tabtin/cli-routes 共享路由模块。
  // djangoRequest 走 Daemon 的 proxyConfig（device credential），
  // actionExecutor 走 createHeadlessAdapter().executeAction，
  // workspaceRoot 用 process.cwd() 让 git/grep 等命令拿到正确的工作目录。
  configureCLIRoutes({
    djangoRequest,
    getSpaceId: () => context!.getSpaceId(),
    getActionExecutor: () => {
      const adapter = context!.getActionAdapter();
      if (!adapter) return null;
      return (action) => adapter.executeAction(action) as any;
    },
    workspaceRootForCode: () => process.cwd(),
  });

  // PlatformSurface 运行时注入（Wave 3）：与 configureCLIRoutes 同款模式
  configureSurfaceRuntime({
    djangoRequest,
    spaceId: context.getSpaceId(),
  });

    created = createCLIHttpServer((req, res) => handleRequest(owner, req, res), {
      socketPath: config?.socketPath,
      socketName: 'daemon-cli.sock',
      onError: (err) => log(owner, 'error', 'Server error:', err),
      onListening: (socketPath) => {
        log(owner, 'info', `Listening on ${socketPath}`);
        if (config?.publishDiscovery === false) return;
        queueMicrotask(() => {
          if (!owner.info) return;
          if (writeDiscoveryFile('daemon-server.json', owner.info, { source: 'daemon' })) {
            log(owner, 'info', 'Daemon discovery file written');
          } else {
            log(owner, 'warn', 'Failed to write discovery file — CLI tools may not auto-discover this daemon');
          }
        });
      },
    });
  } catch (error) {
    context?.setSpaceId(null);
    owner.logger = null;
    owner.storageApplication = null;
    owner.version = '0.0.0';
    clearDjangoProxy();
    if (activeCliServer === owner) activeCliServer = null;
    throw error;
  }
  const { server, info } = created;

  owner.server = server;
  owner.info = info;
  owner.context = context;
  owner.ownsDiscovery = config?.publishDiscovery !== false;

  // Attempt to put tabtin CLI on PATH via node_modules/.bin
  addLocalCLIToPath();

  return info;
}

function applyCLIServerConfig(owner: DaemonCliServer, config?: DaemonCLIServerConfig): CliRequestContext {
  const context = applyBasicCLIServerConfig(owner, config);
  if (!config?.serverUrl || !config.credential) return context;
  configureDjangoProxy({
    serverUrl: config.serverUrl,
    credential: config.credential,
    organizationId: config.organizationId || '',
  });
  context.setWsConnectionInfo({
    serverUrl: config.serverUrl,
    wsUrl: config.wsUrl || '',
    credential: config.credential,
    organizationId: config.organizationId || '',
    userId: config.userId || '',
    fingerprint: config.fingerprint || '',
  });
  return context;
}

function applyBasicCLIServerConfig(owner: DaemonCliServer, config?: DaemonCLIServerConfig): CliRequestContext {
  if (!config) throw new Error('CLI server configuration is required');
  const environment = config.environment ?? {
    get: (name: string) => process.env[name],
    set: (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    },
  };
  const context = new CliRequestContext(environment, {
    ...config.requestContext,
    spaceId: config.spaceId ?? null,
    browserApplication: config.browserApplicationPort ?? null,
  });
  owner.storageApplication = config.storageApplication ?? null;
  if (config?.logger) owner.logger = config.logger;
  if (config?.version) owner.version = config.version;
  if (config.spaceId !== undefined) context.setSpaceId(config.spaceId ?? null);
  return context;
}

function requireStorageApplication(owner: DaemonCliServer): DaemonStorageApplication {
  if (!owner.storageApplication) throw new Error('CLI storage application is unavailable');
  return owner.storageApplication;
}

function addLocalCLIToPath(): void {
  const thisDir = getDirname();
  const possibleBinDirs = [
    join(thisDir, '..', '..', 'node_modules', '.bin'),       // apps/tabtin-daemon/node_modules/.bin
    join(thisDir, '..', '..', '..', '..', 'node_modules', '.bin'), // monorepo root node_modules/.bin
  ].filter((d) => existsSync(d));
  if (possibleBinDirs.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = possibleBinDirs.join(sep) + sep + (process.env.PATH || '');
  }
}

// RM-P1-2: 改为 Promise<void>，等待 server.close() 完成并强制断开已有连接，
// 防止已有连接继续使用已置 null 的 serverInfo 导致 401 错误
export function stopCLIServer(): Promise<void> {
  return currentCliServer().stop();
}

function stopCLIServerInstance(owner: DaemonCliServer): Promise<void> {
  if (!owner.server) {
    clearCLIServerState(owner);
    return Promise.resolve();
  }

  const instance = owner.server;
  const savedSocketPath = owner.info?.socketPath ?? null;
  const ownedDiscovery = owner.ownsDiscovery;

  // 先清理状态，新请求将立即收到 401（serverInfo=null 触发 auth check 失败）
  clearCLIServerState(owner, false);

  return new Promise<void>((resolve) => {
    let cleaned = false;
    const cleanupFiles = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupSocketFile(savedSocketPath ?? '');
      if (ownedDiscovery) cleanupDiscoveryFile('daemon-server.json');
      if (activeCliServer === owner) {
        activeCliServer = null;
        clearDjangoProxy();
      }
    };

    const timer = setTimeout(() => {
      log(owner, 'warn', 'Server close timed out after 5s, forcing shutdown');
      instance.close();
      cleanupFiles();
      resolve();
    }, 5000);

    if (typeof (instance as any).closeAllConnections === 'function') {
      (instance as any).closeAllConnections();
    }

    instance.close((err) => {
      clearTimeout(timer);
      if (err) log(owner, 'warn', `Server close error: ${err.message}`);
      else log(owner, 'info', 'Server stopped');
      cleanupFiles();
      resolve();
    });
  });
}

/** Stop accepting new socket connections without interrupting active requests. */
export function suspendCLIServerIngress(): void {
  currentCliServer().suspendIngress();
}

function clearCLIServerState(owner: DaemonCliServer, releaseActive = true): void {
  owner.server = null;
  owner.info = null;
  owner.logger = null;
  owner.storageApplication = null;
  owner.version = '0.0.0';
  owner.context?.setSpaceId(null);
  owner.context = null;
  owner.ownsDiscovery = false;
  if (releaseActive && activeCliServer === owner) {
    activeCliServer = null;
    clearDjangoProxy();
  }
}

export function getCLIServerInfo(): CLIServerInfo | null {
  return currentCliServer().getInfo();
}

/**
 * Switch the active CLI Space and re-configure surface runtime.
 *
 * State + env mirror live in `./cli-context.js`; this wrapper additionally
 * triggers `configureSurfaceRuntime` so PlatformSurface handlers see the new
 * Space immediately.
 */
export function setCLISpaceContext(spaceId: string | null): void {
  currentCliServer().updateSpace(spaceId);
}
