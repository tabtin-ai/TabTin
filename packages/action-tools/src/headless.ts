/**
 * @tabtin/action-tools/headless
 *
 * Headless-friendly subset of action-tools for non-Electron environments
 * (e.g., Agent Daemon on remote servers).
 *
 * Only exports tools and types that work without Electron APIs
 * (no BrowserView, WebContentsView, or Electron IPC).
 */

// ========== Types ==========
export type {
  ToolResult,
  AgentTool,
  ToolExecutorConfig,
} from './types';

export type {
  ToolManifest,
} from './types/manifest';

export type {
  FrontendAction,
  ActionResult,
} from './adapters/ActionExecutorAdapter';

// ========== Manifest (pure data query, GUI-free — safe for headless) ==========
//
// 暴露 manifest 查询给 daemon 等 headless 消费者过滤工具时按 `llm_facing` 字段
// 决策（如 MCP server 不暴露 4 件套作为 D8「TabTin 不做 MCP 输出」的执行）。
// 这是纯静态数据查询，没有 runtime 副作用，可以放心放进 headless 子入口。
export {
  getToolManifests,
  getToolCapabilityMap,
} from './manifest';

export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
  type ToolError,
  type StandardToolOutput,
} from './types/errors';

// ========== Adapter ==========
export {
  ActionExecutorAdapter,
  type AdapterLogger,
} from './adapters/ActionExecutorAdapter';

// ========== Headless-compatible Tools ==========

export {
  terminalTools,
  type ExecuteInTerminalInput,
  type ExecuteInTerminalOutput,
} from './tools/terminal';

// W7 (2026-05-05): skillsReadTool / skillsTools / SkillsReadInput /
// SkillsReadOutput 已下架——skills_read 新版迁至 agent-runtime SkillsCap。

export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileDeleteTool,
  codeMkdirTool,
  codeMoveFileTool,
  codeGlobTool,
  codeGrepTool,
  codeSemanticSearchTool,
  readDiagnosticsTool,
  invalidateIndexerCache,
  tabcodeTools,
  type FileReadInput,
  type FileReadOutput,
  type FileWriteInput,
  type FileWriteOutput,
  type FileEditInput,
  type FileEditOutput,
  type FileDeleteInput,
  type FileDeleteOutput,
  type CodeMkdirInput,
  type CodeMkdirOutput,
  type CodeMoveFileInput,
  type CodeMoveFileOutput,
  type CodeGlobInput,
  type CodeGlobOutput,
  type CodeGrepInput,
  type CodeGrepOutput,
  type CodeSemanticSearchInput,
  type CodeSemanticSearchOutput,
  type ReadDiagnosticsInput,
  type ReadDiagnosticsOutput,
  type DiagnosticItem,
} from './tools/tabcode';

// ========== TabData Tools ==========
//
// Wave 4a (2026-05-01): 7 个 tabdata FC + 5 个 admin FC 全部删除（D4 全删 FC）。
// Agent 操作多维表格必须走 `tabtin table *` CLI（execute_in_terminal 调）。

// ========== TabSlide Tools (W6 retired 2026-05-04) ==========
// The tabslide AgentTool group has been removed; slide operations now use
// the Django REST API via the `tabtin slide *` CLI. Daemon no longer needs
// to inject a TabSlideAPI runtime bridge.

// ========== HTML Cleaner ==========
export { cleanHtml, generateSkeletonHtml } from './utils/html-cleaner';

// ========== Content Type Filter (browser --include) ==========
export {
  CONTENT_TYPES,
  parseContentTypeWhitelist,
  filterHtmlByContentTypes,
  turndownRemovalFromWhitelist,
} from './utils/content-type-filter';
export type { ContentType, TurndownContentRemoval } from './utils/content-type-filter';

// ========== Print Renderer (browser print) ==========
export {
  PRINT_TEXT_FORMATS,
  isPrintTextFormat,
  renderPrintContent,
} from './utils/print-renderer';
export type { PrintTextFormat, RenderPrintInput, RenderPrintResult } from './utils/print-renderer';

// ========== HTML Content Extractor ==========
export {
  extractReadableContent,
  extractMainContent,
  resolveRelativeUrls,
  stripHtmlTags as stripHtmlToText,
  extractTitle as extractHtmlTitle,
} from './utils/html-content-extractor';

// ========== HTML → Markdown ==========
export {
  createConfiguredTurndown,
  createTurndownInstance,
  htmlToMarkdown,
  postProcessMarkdown,
} from './utils/html-to-markdown';

export type { TurndownOptions } from './utils/html-to-markdown';

// ========== Content Quality ==========
export {
  validateContentQuality,
} from './utils/content-quality';

export type {
  ContentQuality,
  ContentQualityReason,
} from './utils/content-quality';

// ========== Runtime Bridge ==========
export {
  setPtyManagerAPI,
  setPtyManagerBridge,
  resolvePtyManagerBridge,
  setTerminalRuntimeBridge,
  type PtyManagerAPI,
  setTableKernelAPI,
  type TableKernelAPI,
  setCrawlViewAPI,
  setScreenshotAPI,
  setPdfAPI,
  setPageToMarkdownAPI,
  setResourceDetectionAPI,
  setRunSessionAPI,
  setViewFactoryAPI,
  setHttpCrawlAPI,
  resolveHttpCrawlAPI,
  type HttpCrawlAPI,
  setBrowserEnvAPI,
  resolveBrowserEnvAPI,
  type BrowserEnvAPI,
  setOffscreenRenderAPI,
  resolveOffscreenRenderAPI,
  setUIThemeAPI,
  resolveUITheme,
} from './utils/runtime-bridge';

export type {
  PdfAPI,
  PageToMarkdownAPI,
  OffscreenRenderAPI,
  OffscreenRenderInput,
  OffscreenRenderResult,
  OffscreenRenderFormat,
  OffscreenRenderTheme,
  OffscreenRenderViewport,
  UITheme,
  UIThemeAPI,
} from './utils/runtime-bridge';

// Widget Wave 4：把 uploadFileToOSS re-export 到 headless 入口，让 show-widget
// 在 moduleResolution=node 的包里也能 import（不依赖 subpath exports）。
export { uploadFileToOSS } from './utils/oss-upload';
export type { OSSUploadOptions } from './utils/oss-upload';

// ========== Browser Tool Groups (registrable when headless browser is available) ==========
export { tabNavigationTools } from './tools/tab-navigation-tools';
export { screenshotTools } from './tools/screenshot';
export { pdfTools } from './tools/pdf';
export { markdownTools } from './tools/markdown';
export { evalTools } from './tools/eval';
export { antiDetectTools } from './tools/anti-detect';
export { tabManagementTools } from './tools/tab-management';
export { sessionTools } from './tools/session-tools';
export { resourceDetectionTools } from './tools/resource-detection';
export { resourceDownloadTools } from './tools/resource-download';

// ========== Crawl Runner ==========
export {
  setCrawlToolRunnerFactory,
  getCrawlToolRunnerFactory,
  type CrawlToolRunner,
  type CrawlToolRunnerFactory,
} from './impl/crawl-runner';

// ========== Web Fetch Pipeline ==========
export {
  executeFetchPipeline,
  type FetchPipelineOptions,
  type FetchPipelineResult,
} from './impl/web-fetch-pipeline';

// ========== DOM Resource Extractor ==========
export {
  extractLinksFromDom,
  extractImagesFromDom,
  type ExtractedLink,
} from './utils/dom-resource-extractor';

// ========== Security Utils ==========
export { validateProjectPath, type ValidateProjectPathOpts } from './utils/path-validation';

// ========== Path Canonicalize (Wave 1.5, 2026-05-13) ==========
// canonicalizePath 是跨入口共享的"读/写/锁键归一"基础设施。下沉到
// action-tools 是因为 file-lock 模块同期下沉到这里需要它，且 agent-runtime
// 一侧 read-file-state.ts 也通过本入口反向 re-export 桥接，让 read / lock /
// edit 跨入口走同一份 realpath 解析（解决 L-11 升级根因 "两套锁不串"）。
export { canonicalizePath } from './utils/canonical-path';

// ========== File Lock (Wave 1.5, 2026-05-13) ==========
// withFileLock 是跨入口共享的进程内 per-file 锁。下沉自
// `packages/agent-runtime/src/tools/file-lock.ts`。废弃了原 FileLockManager
// class —— 因调用方分散维护 timeout + abort 语义不统一被替换为 module-level
// 函数 API。adapter / ActionExecutorAdapter / Daemon MCP / FAB / action-bridge
// 全 4 个写入口共享同一个 lockMap,跨入口 H 不变量天然成立。
export {
  withFileLock,
  getFileLockMapSize,
  __resetFileLockMapForTest,
  type WithFileLockOptions,
} from './utils/file-lock';

// ========== Tool Stale Read Error (Wave 2, 2026-05-13) ==========
// ToolStaleReadError 是跨包 TOCTOU 校验错误信号。throw 点在 agent-runtime
// adapter 注入的 `_validate_before_write` hook，catch 点在 action-tools
// fileEditTool / fileWriteTool 写盘前 try/catch。
//
// 字节对照基线 B1-1 / B5-1 决策（2026-05-13）：跨包 hook 通过 input 内部
// 协议字段 `_validate_before_write` 传递（同步函数），hook throw 而非 return
// 避免 caller 忘记检查返回值漏防御。错误信号字节级跟入口校验
// `validateReadBeforeWrite` 一致（error_kind=tool_stale_read / message / hint
// 完全一致）。
export {
  ToolStaleReadError,
  type ToolStaleReadErrorPayload,
  // Wave 3 整体收尾 L-32：跨包 hook 类型契约导出，让 agent-runtime 一侧
  // 注入 hook 时跟 action-tools 一侧 invoke 用同一个类型签名。
  type ValidateBeforeWriteHook,
} from './utils/tool-stale-read-error';

// ========== Factory ==========

import { ActionExecutorAdapter, type AdapterLogger } from './adapters/ActionExecutorAdapter';
import { getHeadlessDomains } from './tools';
import { tabcodeTools } from './tools/tabcode';

/**
 * Create an ActionExecutorAdapter with only headless-compatible tools.
 * Suitable for Daemon environments (no Electron dependency).
 *
 * When `capabilities` is provided, domain groups whose `requires` are not
 * fully satisfied will be skipped. Terminal and skills are registered via
 * the `core` headless domain; full `tabcodeTools` is registered manually
 * here (the manifest tabcode domain only exposes the read-only subset).
 * The legacy tabslide adapter group was retired in W6 (2026-05-04).
 *
 * Wave 4a (2026-05-01)：tabdata 域工具（7+5）已删除，原 `core-headless`
 * 中的 `tabdataTools` 一并下架——Agent 走 `tabtin table *` CLI。
 *
 * Wave 4b (2026-05-01) L20：`crawl_clean_html` AgentTool 包装层删除。
 * Electron `cli/routes/browser/extraction.ts` 现直调 `CrawlToolImpl.crawlCleanHtml`，
 * 与 Daemon `cli/routes/browser.ts` 走 `DaemonBrowserService.getPageContent`
 * 对齐——cli-server `/browser/extract` 路由不再依赖 ActionExecutor 派发。
 */
export function createHeadlessAdapter(options?: {
  logger?: AdapterLogger;
  capabilities?: Set<string>;
}) {
  const adapter = new ActionExecutorAdapter({ logger: options?.logger });
  const caps = options?.capabilities;
  for (const { groups } of getHeadlessDomains()) {
    for (const group of groups) {
      if (caps && group.requires?.length && !group.requires.every(c => caps.has(c))) continue;
      adapter.registerTools(group.tools);
    }
  }
  adapter.registerTools(tabcodeTools);
  return adapter;
}
