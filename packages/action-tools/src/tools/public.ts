// Wave 4a (2026-05-01): web-fetch / web-fetch-batch / web-extract /
// web-extract-to-table / crawl-http FC 全部删除（D4 全删 FC）。
// Wave 4b (2026-05-01) L20: crawl_clean_html AgentTool 包装层删除——
// `tabtin browser print`（原 extract）CLI 路由的 Electron 实现现在直调
// `CrawlToolImpl.crawlCleanHtml`（与 Daemon 直调 getPageContent 对齐），
// 不再走 ActionExecutor 派发的间接路径。
// page-to-markdown / cleanHtml / fetch pipeline 等 impl 仍保留于 utils/ 与
// impl/，由 cli-server routes 内部调用。executeFetchPipeline / CrawlToolImpl
// 是 impl 层。

export {
  executeActTool,
  executeObserveTool,
  requestSnapshotTool,
  browserTools,
} from './browser';

export {
  openTabTool,
  switchTabTool,
  closeTabTool,
  tabManagementTools,
} from './tab-management';

export {
  getTabsTool,
  tabStateTool,
  navTabTool,
  loadTabUrlTool,
  waitForTool,
  tabNavigationTools,
} from './tab-navigation-tools';

export {
  listContextSpaceTool,
  closeContextTabTool,
  setActiveContextTabTool,
  restoreContextGroupTool,
  assignPaneContentTool,
  splitPaneWithTabTool,
  movePaneTool,
  dockPaneTool,
  contextSpaceTools,
} from './context-space';

export { evalTool, evalTools } from './eval';

export {
  readTerminalOutputTool,
  listTerminalSessionsTool,
  executeInTerminalTool,
  writeToTerminalTool,
  terminalTools,
} from './terminal';

// W7 (2026-05-05): skillsReadTool / skillsTools 已下架——
// skills_read 新版迁至 agent-runtime SkillsCap。

export { captureScreenshotTool, screenshotTools } from './screenshot';

export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  FILE_DELETE_DESCRIPTION,
  fileDeleteTool,
  codeGlobTool,
  codeGrepTool,
  codeSemanticSearchTool,
  invalidateIndexerCache,
  readDiagnosticsTool,
  tabcodeTools,
} from './tabcode';

// ── TabData tools ──
//
// Wave 4a (2026-05-01): 7 个 tabdata FC + 5 个 admin FC 全部删除（D4 全删 FC）。
// Agent 走 `tabtin table *` CLI。

// W6 (2026-05-04): TabSlide AgentTool group retired — slide ops use the
// Django HTTP API via `tabtin slide *` CLI, no FC / adapter mapping needed.

export {
  networkTools, routeTool, routeListTool, unrouteTool, networkLogTool, consoleLogTool,
  addRouteRule, getRouteRules, removeRouteRule,
  setOnRulesChanged,
} from './network';

export {
  resourceDetectionTools,
  getDetectedResourcesTool,
  listResourcesTool,
  inspectResourceTool,
  captureResourceTool,
} from './resource-detection';

export {
  resourceDownloadTools,
  downloadResourceTool,
  parseM3U8Tool,
  parseStreamTool,
  downloadStreamTool,
  downloadBatchTool,
} from './resource-download';

export {
  antiDetectTools,
  getRandomUATool,
  checkProxyHealthTool,
} from './anti-detect';

export {
  sessionTools,
  manageCookiesTool,
  clearSessionTool,
} from './session-tools';

export { allDomains, getHeadlessDomains } from './index';

export { pdfTools, generatePdfTool } from './pdf';
export { markdownTools, pageToMarkdownTool } from './markdown';

