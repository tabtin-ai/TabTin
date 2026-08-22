/**
 * Browser route handler for Daemon CLI Server.
 *
 * Headless-capable routes delegate to BrowserApplicationPort.
 * GUI-only routes return a structured NOT_IMPLEMENTED error.
 */

import http from 'node:http';
import { type BrowserActionResult } from '@tabtin/browser-core';
import type { CliRequestContext } from '../../cli-context.js';
import type { BrowserApplicationPort } from '../../../../base/browser/browser-application-port.js';
import { errorResponse, okResponse, type SendJSON } from '../shared/error-handler.js';

/** route → session actionId 映射（Daemon 仅 record/replay；无 `run.*`，故 `/run/*` 不收录）。 */
const DAEMON_SESSION_ROUTES: Record<string, string> = {
  '/record/start': 'record.start',
  '/record/stop': 'record.stop',
  '/record/status': 'record.status',
  '/replay/run': 'replay.run',
  '/replay/list': 'replay.list',
};

/** 把 Orchestrator 的 ok/error 结果用 Daemon 端的 envelope 落地（wire envelope 仍归各端）。 */
function respondActionResult(res: http.ServerResponse, sendJSON: SendJSON, result: BrowserActionResult): void {
  // `electron-executor` 是 Electron eval 专用迁移缝，Daemon 注入的 hooks 永不产出它；
  // 这里仅为类型收窄兜底（真发生即 Orchestrator 契约被破坏，按 500 暴露而非静默）。
  // 用单一 `'kind' in result` 判断（不叠 `&&`），保证取反分支能干净收窄成 ok/error 联合。
  if ('kind' in result) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', 'daemon 收到 electron-executor 结果（不应发生）'));
    return;
  }
  if (result.ok) {
    sendJSON(res, result.status, okResponse(result.data));
  } else {
    sendJSON(res, result.status, errorResponse(result.error.code, result.error.message, {
      suggestions: result.error.suggestions,
      retryable: result.error.retryable,
      detail: result.error.detail,
    }));
  }
}

/**
 * resource/stream 路由 → 能力 actionId（BR-8 P3c③）。Daemon 上 `/parse-m3u8`、`/stream/parse`、
 * `/stream/info` 行为一致，`/download-stream`、`/stream/download` 行为一致，故 legacy 别名与
 * canonical 路由同映射（零行为变更）。`/download`、`/download-batch` 不在本切片范围，保留旧逻辑。
 */
const RESOURCE_STREAM_ROUTES: Record<string, string> = {
  '/resources': 'resource.list',
  '/resource/probe': 'resource.probe',
  '/resource/inspect': 'resource.inspect',
  '/resource/capture': 'resource.capture',
  '/resource/download': 'resource.download',
  '/resource/smart-download': 'resource.smart-download',
  '/parse-m3u8': 'stream.parse',
  '/stream/parse': 'stream.parse',
  '/stream/info': 'stream.info',
  '/download-stream': 'stream.download',
  '/stream/download': 'stream.download',
};

// ── Route handler ────────────────────────────────────────────────

interface BrowserRouteContext {
  url: string;
  route: string;
  body: any;
  res: http.ServerResponse;
  sendJSON: SendJSON;
  application: BrowserApplicationPort;
}

type BrowserRouteHandler = (context: BrowserRouteContext) => Promise<boolean>;

async function handleBrowserDescriptionRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  if (!(route === '/context' || route === '/capabilities')) return false;

  const actionId = route === '/context' ? 'context' : 'capabilities';
  const result = await context.application.execute(actionId, body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

async function runPageCommand(context: BrowserRouteContext, actionId: string): Promise<boolean> {
  respondActionResult(context.res, context.sendJSON, await context.application.executePageCommand(actionId, context.body));
  return true;
}

async function handleBrowserOpenRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/navigate' || context.route === '/open'
    ? runPageCommand(context, 'page.open')
    : false;
}
async function handleBrowserTabsRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/tabs' ? runPageCommand(context, 'page.tabs') : false;
}
async function handleBrowserTabSwitchRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/tab-switch' ? runPageCommand(context, 'page.switch') : false;
}
async function handleBrowserTabCloseRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/tab-close' ? runPageCommand(context, 'page.close') : false;
}
async function handleBrowserTabStateRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/tab-state' ? runPageCommand(context, 'page.state') : false;
}

async function handleBrowserGlanceRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  if (!(route === '/glance')) return false;

  const result = await context.application.execute('glance', body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

async function handleBrowserPrintRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/print') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executePrintCommand(context.body));
  return true;
}

async function handleBrowserEvalRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  if (!(route === '/execute' || route === '/eval')) return false;

  const result = await context.application.execute('eval', body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

async function handleBrowserWaitRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/wait' ? runPageCommand(context, 'page.wait') : false;
}

async function handleBrowserNavRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/nav' ? runPageCommand(context, 'page.nav') : false;
}

async function handleBrowserRandomUserAgentRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/random-ua' ? runPageCommand(context, 'page.random-user-agent') : false;
}

async function runSessionCommand(context: BrowserRouteContext, actionId: string): Promise<boolean> {
  respondActionResult(context.res, context.sendJSON, await context.application.executeSessionCommand(actionId, context.body));
  return true;
}

async function handleBrowserSessionCreateRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/create' ? runSessionCommand(context, 'session.create') : false;
}
async function handleBrowserSessionListRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/list' ? runSessionCommand(context, 'session.list') : false;
}
async function handleBrowserSessionSwitchRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/switch' ? runSessionCommand(context, 'session.switch') : false;
}
async function handleBrowserSessionCloseRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/close' ? runSessionCommand(context, 'session.close') : false;
}
async function handleBrowserSessionCloseAllRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/close-all' ? runSessionCommand(context, 'session.close-all') : false;
}
async function handleBrowserSessionSaveRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/save' ? runSessionCommand(context, 'session.save') : false;
}
async function handleBrowserSessionLoadRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session/load' ? runSessionCommand(context, 'session.load') : false;
}
async function handleBrowserSessionInfoRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/session' ? runSessionCommand(context, 'session.info') : false;
}
async function handleBrowserCookiesRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/cookies' ? runSessionCommand(context, 'session.cookies') : false;
}
async function handleBrowserClearSessionRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/clear-session' ? runSessionCommand(context, 'session.clear') : false;
}

async function handleBrowserActRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  if (!(route === '/act')) return false;

  const result = await context.application.execute('act', body);
  if (!result) return false;
  respondActionResult(res, sendJSON, result);
  return true;
}

async function handleBrowserResourceStreamRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  const actionId = RESOURCE_STREAM_ROUTES[route];
  if (!actionId) return false;

  const result = await context.application.execute(actionId, body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

async function handleBrowserJobRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  if (!(route === '/job/status' || route === '/job/cancel')) return false;

  const actionId = route === '/job/status' ? 'job.status' : 'job.cancel';
  const result = await context.application.execute(actionId, body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

async function handleBrowserBatchRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/batch') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executeBatchCommand(context.body));
  return true;
}

async function handleBrowserCollectTableRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/collect/table' ? runPageCommand(context, 'collect.table') : false;
}

async function handleBrowserNetworkRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/network') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executeNetworkCommand('network.list', context.body));
  return true;
}

async function handleBrowserNetworkToApiRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/network/to-api') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executeNetworkCommand('network.to-api', context.body));
  return true;
}

async function handleBrowserConsoleRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/console' ? runPageCommand(context, 'page.console') : false;
}

async function handleBrowserInterceptionRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/route' ? runPageCommand(context, 'page.route') : false;
}

async function handleBrowserUnrouteRoute(context: BrowserRouteContext): Promise<boolean> {
  return context.route === '/unroute' ? runPageCommand(context, 'page.unroute') : false;
}

async function handleBrowserRouteListRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/route-list') return false;
  context.sendJSON(context.res, 501, errorResponse(
    'NOT_IMPLEMENTED',
    'Daemon 模式不维护可查询的拦截规则列表（page.route 为 per-page、不跨导航持久）。route / unroute 仍可用。',
    {
      suggestions: [
        '设置拦截: tabtin browser route --url-pattern "**/*.png" --status 403',
        '取消拦截: tabtin browser unroute --url-pattern "**/*.png"',
        '需要可查询的规则列表请使用 Electron 运行时',
      ],
    },
  ));
  return true;
}

async function handleBrowserDownloadRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/download') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executeDownloadCommand('download.single', context.body));
  return true;
}

async function handleBrowserDownloadBatchRoute(context: BrowserRouteContext): Promise<boolean> {
  if (context.route !== '/download-batch') return false;
  respondActionResult(context.res, context.sendJSON, await context.application.executeDownloadCommand('download.batch', context.body));
  return true;
}

async function handleBrowserRecordingRoute(context: BrowserRouteContext): Promise<boolean> {
  const { route, body, res, sendJSON } = context;
  // 显式列出 `route === '/x'`（而非 `if (route in MAP)`）：BR-7 契约检测
  // `scanDaemonServedRoutes` 按正则 `route === '(/x)'` 扫 daemon 服务的路由集合，
  // 与 act/observe 等同款写法；map 仅用于 route→actionId 查表。
  if (!(
    route === '/record/start' ||
    route === '/record/stop' ||
    route === '/record/status' ||
    route === '/replay/run' ||
    route === '/replay/list'
  )) return false;

  const result = await context.application.execute(DAEMON_SESSION_ROUTES[route], body);
  if (!result) return false;

  respondActionResult(res, sendJSON, result);
  return true;
}

const BROWSER_ROUTE_HANDLERS: BrowserRouteHandler[] = [
  handleBrowserDescriptionRoute,
  handleBrowserOpenRoute,
  handleBrowserTabsRoute,
  handleBrowserTabSwitchRoute,
  handleBrowserTabCloseRoute,
  handleBrowserTabStateRoute,
  handleBrowserGlanceRoute,
  handleBrowserPrintRoute,
  handleBrowserEvalRoute,
  handleBrowserWaitRoute,
  handleBrowserNavRoute,
  handleBrowserRandomUserAgentRoute,
  handleBrowserSessionCreateRoute,
  handleBrowserSessionListRoute,
  handleBrowserSessionSwitchRoute,
  handleBrowserSessionCloseRoute,
  handleBrowserSessionCloseAllRoute,
  handleBrowserSessionSaveRoute,
  handleBrowserSessionLoadRoute,
  handleBrowserSessionInfoRoute,
  handleBrowserCookiesRoute,
  handleBrowserClearSessionRoute,
  handleBrowserActRoute,
  handleBrowserResourceStreamRoute,
  handleBrowserJobRoute,
  handleBrowserBatchRoute,
  handleBrowserCollectTableRoute,
  handleBrowserNetworkRoute,
  handleBrowserNetworkToApiRoute,
  handleBrowserConsoleRoute,
  handleBrowserInterceptionRoute,
  handleBrowserUnrouteRoute,
  handleBrowserRouteListRoute,
  handleBrowserDownloadRoute,
  handleBrowserDownloadBatchRoute,
  handleBrowserRecordingRoute,
];

export async function handleBrowserRoute(
  url: string,
  _method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const route = url.replace(/^\/browser/, '');
  if (!body) body = {};

  const application = cliContext.getBrowserApplication();
  if (!application) throw new Error('BrowserRuntime 尚未初始化');
  const context: BrowserRouteContext = { url, route, body, res, sendJSON, application };
  for (const handler of BROWSER_ROUTE_HANDLERS) {
    if (await handler(context)) return;
  }

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的 browser 命令: ${url}`, {
    suggestions: [
      'Daemon 支持: open, act, glance, print, eval, wait, nav, tab list, session, cookies, clear-session',
      '使用 tabtin browser --help 查看所有可用命令',
    ],
  }));
}
