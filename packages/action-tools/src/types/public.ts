export type {
  ToolResult,
  // CrawlCleanHtmlInput / CrawlCleanHtmlOutput：保留供 ElectronCrawlToolRunner /
  // CrawlToolImpl 等 impl 层使用——FC 工具 crawl_clean_html 已删（Wave 4a），
  // 但这两个类型描述底层 crawl runner 的入参/返回值形态，cli-server 路由仍走它。
  CrawlCleanHtmlInput,
  CrawlCleanHtmlOutput,
  AgentTool,
  ToolExecutorConfig,
} from './index';
export type {
  ToolExecutionTarget,
  ToolParameters,
  ToolManifest,
} from './manifest';

export {
  ToolErrorCode,
  type ToolError,
  type StandardToolOutput,
} from './errors';

export type { CDPConnectionStrategy } from '../cdp/CDPConnectionManager';

export type {
  ActActionType, ActAction,
  ExecuteActInput, ExecuteActOutput,
  ExecuteObserveInput, ExecuteObserveOutput,
  RequestSnapshotInput, RequestSnapshotOutput,
  BlockSignal,
} from '../tools/browser-types';

export type { CaptchaInfo, CaptchaType, CaptchaSuggestedAction } from '../impl/captcha/CaptchaDetector';
export type { CaptchaSolver, CaptchaSolveParams, CaptchaSolveResult } from '../impl/captcha/CaptchaSolver';
export type { CaptchaUserInterventionCallback } from '../impl/BrowserToolImpl';

export type { CDPActionType, CDPActionOptions, CDPOperationResult } from '../impl/helpers/CDPOperationHelper';

export type {
  OpenTabInput,
  OpenTabOutput,
  SwitchTabInput,
  SwitchTabOutput,
  CloseTabInput,
  CloseTabOutput,
} from '../tools/tab-management';

export type {
  NavigationState,
  TabInfo,
  GetTabsInput,
  GetTabsOutput,
  TabStateInput,
  TabStateOutput,
  NavTabInput,
  NavTabOutput,
  LoadTabUrlInput,
  LoadTabUrlOutput,
  WaitForInput,
  WaitForOutput,
} from '../tools/tab-navigation';

export type {
  EvalInput,
  EvalOutput,
} from '../tools/eval';

export type {
  ReadTerminalOutputInput,
  ReadTerminalOutputOutput,
  ListTerminalSessionsInput,
  ListTerminalSessionsOutput,
  AutoRespondRule,
  ExecuteInTerminalInput,
  ExecuteInTerminalOutput,
  WriteToTerminalInput,
  WriteToTerminalOutput,
} from '../tools/terminal';

// W7 (2026-05-05): SkillsReadInput / SkillsReadOutput 已下架——
// skills_read 新版迁至 agent-runtime SkillsCap。

export type {
  CaptureScreenshotInput,
  CaptureScreenshotOutput,
} from '../tools/screenshot';

export type {
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  FileEditInput,
  FileEditOutput,
  FileDeleteInput,
  FileDeleteOutput,
  CodeMkdirInput,
  CodeMkdirOutput,
  CodeMoveFileInput,
  CodeMoveFileOutput,
  CodeGlobInput,
  CodeGlobOutput,
  CodeGrepInput,
  CodeGrepOutput,
  CodeSemanticSearchInput,
  CodeSemanticSearchOutput,
  ReadDiagnosticsInput,
  ReadDiagnosticsOutput,
  DiagnosticItem,
} from '../tools/tabcode';

// Wave 4a (2026-05-01): CrawlHttpFetchInput / CrawlHttpFetchOutput 类型已删除
// （随 crawl-http.ts 一起，FC 工具走 CLI）。

export type {
  ResourceContentRef,
  ResourceAuthContextRef,
  ResourceErrorInfo,
  ResourceCategory,
  ResourceCaptureStatus,
  ResourceCapability,
  ResourceSource,
  DetectedResource,
  ResourceRecord,
  ResourceDetectionSummary,
  GetDetectedResourcesInput,
  GetDetectedResourcesOutput,
  ListResourcesInput,
  ListResourcesOutput,
  InspectResourceInput,
  InspectResourceOutput,
  CaptureResourceInput,
  CaptureResourceOutput,
  StreamInfo,
  StreamVariant,
  MediaElementInfo,
  DownloadResourceInput,
  DownloadResourceOutput,
  ParseM3U8Input,
  ParseM3U8Output,
  ParseStreamInput,
  ParseStreamOutput,
  M3U8Segment,
  DownloadStreamInput,
  DownloadStreamOutput,
  DownloadBatchInput,
  DownloadBatchOutput,
} from '../tools/resource-detection';

export type {
  GetRandomUAInput,
  GetRandomUAOutput,
  CheckProxyHealthInput,
  CheckProxyHealthOutput,
} from '../tools/anti-detect';

export type {
  ManageCookiesInput,
  ManageCookiesOutput,
  ClearSessionInput,
  ClearSessionOutput,
} from '../tools/session-tools';

export type {
  GeneratePdfInput,
  GeneratePdfOutput,
} from '../tools/pdf';

export type {
  PageToMarkdownInput,
  PageToMarkdownOutput,
} from '../tools/markdown';

export type {
  CrawlToolRunner,
  CrawlToolRunnerFactory,
} from '../impl/crawl-runner';

export type { FrontendAction, ActionResult } from '../adapters/ActionExecutorAdapter';

export type {
  RouteRule, NetworkLogEntry, ConsoleLogEntry,
} from '../tools/network';
