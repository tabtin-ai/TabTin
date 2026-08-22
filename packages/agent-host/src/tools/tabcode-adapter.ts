/**
 * tabcode-adapter — PRD 08 W1
 *
 * 把 `@tabtin/action-tools/tools` 暴露的 TabCode 工具适配成
 * agent-runtime `Tool` 形态，并在适配层加 read-before-edit / write 加固。
 *
 * LLM 可见 6 件套：read_file / write_file / edit_file / delete_file /
 *                 grep_search / glob_search
 *
 * **设计原则**：
 *   - **薄适配** —— 不复制 action-tools 实现，直接 import + 包装。
 *     两级匹配（exact / line-trimmed）/ atomicWriteFile /
 *     symlink 检测 / sensitive path block 等都由 action-tools 层完成。
 *   - **额外加固** —— stale-read（`error_kind=tool_stale_read`）检查在 adapter 层做。
 *     action-tools 不知道 LLM 上下文，没法做这层。
 *     （W2 删除 read-required 强制：LLM "没读过"不再阻断 edit；
 *     精确字符串 kind 兜底"瞎 edit"。）
 *   - **字段映射** —— `AgentTool.parameters → Tool.inputSchema` /
 *     `AgentTool.riskLevel → Tool.isReadOnly`。
 *   - **workspaceRoot 透传** —— 通过 `_workspace_root` 字段注入到
 *     action-tool 入参，让 action-tools 的 `resolveInWorkspace` 拿到正确
 *     基准目录。focus_context 对话接通后宿主层会覆盖此字段。
 *
 * **不做**（明确边界）：
 *   - 审批 / 沙箱 / HITL 改造（归"授权"对话）
 *   - file_id 自动注入（归 focus_context 对话）
 */

import { promises as fsPromises } from 'node:fs';
import {
  getLspServerManager,
  clearDeliveredDiagnosticsForFile,
  registerPendingLSPDiagnostic,
  type Diagnostic as LspDiagnostic,
} from '@tabtin/lsp-runtime';
import path from 'node:path';

import {
  FILE_DELETE_DESCRIPTION,
  fileDeleteTool as actionFileDeleteTool,
  fileEditTool as actionFileEditTool,
  fileReadTool as actionFileReadTool,
  fileWriteTool as actionFileWriteTool,
  codeGrepTool as actionCodeGrepTool,
  codeGlobTool as actionCodeGlobTool,
  readDiagnosticsTool as actionReadDiagnosticsTool,
} from '@tabtin/action-tools/tools';
import type { AgentTool } from '@tabtin/action-tools/types';
// 文件并发安全 Wave 2（2026-05-13）：ToolStaleReadError 是跨包 TOCTOU 校验
// 错误信号 —— throw 点在本文件 enrichWithWorkspaceRoot 注入的
// `_validate_before_write` hook，catch 点在 action-tools fileEditTool /
// fileWriteTool 写盘前 try/catch。详见 utils/tool-stale-read-error.ts jsdoc。
// Wave 3 整体收尾 L-32：导入 ValidateBeforeWriteHook 类型契约，跟 action-tools
// 一侧 invoke 用同款类型签名 —— 未来 hook signature 改动时 TS 双侧报错强制对齐。
import {
  ToolStaleReadError,
  type ValidateBeforeWriteHook,
} from '@tabtin/action-tools/headless';
import {
  classifyFsError,
  OS_ACCESS_ERRNO_CODES,
} from '@tabtin/os-errors';
import type { RunDocParserTask } from '@tabtin/local-docparse';
import type { RunTempPptxParse } from '@tabtin/file-pipeline';
import type { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';

import type {
  Tool,
  ToolContext,
  ToolResult,
} from '@tabtin/agent-runtime';
import {
  FileMaterializationTooLargeError,
  type FileMaterializationRef,
  type FileMaterializer,
} from './file-materializer.js';
import {
  FILE_NOT_FOUND,
  INVALID_PARAM_FORMAT,
  TOOL_STALE_READ,
} from '@tabtin/agent-runtime/tools';
import {
  canonicalizePath,
  errorResultEnvelope,
  clearReadFileState,
  mapActionErrorToRuntimeKind,
  recordReadFileState,
  STALE_READ_HINT,
  validateReadBeforeWrite,
  validateReadBeforeWriteSync,
} from './read-file-state.js';
import { withFileLock } from '@tabtin/action-tools/headless';
import {
  buildFileEditPatch,
  captureFileBeforeSnapshot,
  isFileEditPatchToolName,
  relativizeWorkspacePath,
  type FileBeforeSnapshot,
} from './file-edit-patch.js';

const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.';

interface ActionToolResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: unknown;
}

// ─── deps ─────────────────────────────────────────────────────────────

export interface TabCodeToolsDeps {
  /**
   * 解析 LLM 调用工具时所处的 workspace 根目录。adapter 把这个值注入到
   * action-tool 入参的 `_workspace_root` 字段，让 action-tools 的
   * `resolveInWorkspace` 用它而不是 `process.cwd()` 做相对路径基准。
   *
   * 缺省（不传）时退化为 `() => process.cwd()`。focus_context 对话上线
   * 后宿主层应该传"当前 chat 关联的 workspace 路径"。
   */
  workspaceRoot?: () => string | undefined;
  /** 宿主文件材料化端口。随工具闭包被主、子 Agent 共同复用。 */
  fileMaterializer?: FileMaterializer;
  /** @deprecated read_file 非文本路径不再消费本地解析 worker，字段仅为旧装配兼容保留。 */
  runDocParserTask?: RunDocParserTask;
  /**
   * Reads a document that was just materialized by read_file. Hosts inject
   * their existing document service here so one read_file call returns text
   * instead of requiring a second model-selected parse_document call.
   */
  parseMaterializedDocument?: (fileId: string, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * **W4 (2026-05-12)**：返回当前 session 的 tool-results 目录绝对路径
   * （如 `<sessionDir>/<sessionId>/tool-results`）。read_file 的 workspace
   * boundary 检查会把该目录加入豁免白名单 —— summarizeToolOutput /
   * enforceToolOutputBudget 持久化的引用文件不在 workspace 内，但 LLM
   * 需要用 read_file 沿着 banner 里的路径读回完整内容。
   *
   * **安全约束**：
   *   - 仅豁免 `read_file` 操作；write/edit/delete 不豁免
   *   - 仅豁免**当前 session** 的 tool-results 路径（不允许跨 session 访问）
   *   - 用**精确路径前缀匹配**（不用 glob/regex），避免 prompt injection 绕过
   *   - 缺省（headless / 测试 / 老宿主）时不启用豁免，LLM 看到 banner 但
   *     read_file 会被 workspace boundary 拦下来 —— 降级但不破坏现有功能
   *
   * 由宿主装配点（`ElectronToolProvider` / `DaemonToolProvider`）注入，
   * 从 `FileToolResultStorage` 同款 sessionDir 派生：
   *   `() => path.join(sessionDir, 'tool-results')`
   */
  getToolResultsDir?: () => string | undefined;
  /** @deprecated read_file 非文本路径不再消费 PPTX 临时解析回调，字段仅为旧装配兼容保留。 */
  runTempPptxParse?: RunTempPptxParse;
  /**
   * **2026-05-13 重做**：glob_search FC 路径下的结果上限覆盖。
   *
   * 默认 `GLOB_HEAD_LIMIT = 100`，对 LLM 完全不可见也不可调——任何"LLM
   * 可控的上限"字段都会诱导 LLM 漏传或大胆传，几千个文件路径灌进 context。
   * 这个字段仅给**测试**与**极端 SDK 集成方**使用（宿主注入覆盖上限，
   * 不对 LLM 暴露 schema 字段）。
   *
   * 注意：这个旋钮只影响 **FC 路径**（LLM 调 `glob_search`）。CLI 路径
   * （`tabtin code glob --head-limit ...`）由 action-tools 入参单独控制，
   * 不受本字段影响——CLI/FC schema 与默认值解耦是这次重做的核心动机。
   */
  globHeadLimit?: number;
  /**
   * **B3 (2026-05-12)** 是否在 read_file 文本路径末尾追加 cyber risk
   * `<system-reminder>`：
   *
   *   "Whenever you read a file, you should consider whether it would
   *   be considered malware. You CAN and SHOULD provide analysis of
   *   malware, what it is doing. But you MUST refuse to improve or
   *   augment the code."
   *
   * **默认 opt-in（false / undefined → 不附加）**：TabTin 走 OpenAI 兼容
   * 路径，各家 provider 都有自己的 safety 训练，每次 read 都附加 reminder
   * 是稳态 token 成本（按 1.35B 调用 × ~50 token 估算非常可观）。需要时
   * 由宿主装配点（如对接安全审查模型 / 用户开了"恶意代码分析"模式）
   * 显式传 true 启用。仅作用于成功的文本读分支（图像 / 目录 / 错误响应
   * 都不附加）。
   */
  enableCyberRiskReminder?: boolean;
}

// ─── W3 临时通道（PPTX）类型兼容 re-export ────────────────────────────

/**
 * **W3 (2026-05-13) → W4 (2026-05-13)**：原 RunTempPptxParse 等类型已迁移到
 * `@tabtin/file-pipeline/src/types.ts`，让历史 host import 继续有稳定类型。
 * adapter 不再重新定义；下方 re-export 仅供历史 host 代码兼容。
 */
export type {
  RunTempPptxParse,
  TempPptxParseChunkLike as TempPptxParseChunk,
  TempPptxParseResultLike as TempPptxParseResult,
} from '@tabtin/file-pipeline';

/**
 * **W3 时代 host shape**（W3 实施纪要写了 TempPptxParseSuccess / Failure 的具体
 * 字段，host 代码 import 这些 type 装配 fetch 返值）。W4 抽象层用 duck-type
 * 等价的 `TempPptxParseResultLike`（@tabtin/file-pipeline 内部）—— shape 相同
 * 字段相同，host 代码无需改 import。本两个 type 直接 alias 到新 SSoT。
 */
export type TempPptxParseSuccess = {
  success: true;
  chunks: import('@tabtin/file-pipeline').TempPptxParseChunkLike[];
  durationMs: number;
  pages: number;
  title: string;
  fileSizeBytes: number;
};

export type TempPptxParseFailure = {
  success: false;
  errorClass: FilePipelineErrorCode;
  message: string;
  durationMs: number;
};

// ─── envelope helpers ────────────────────────────────────────────────

/**
 * 把 action-tools `{ success, data, error }` envelope 转 agent-runtime `ToolResult`。
 *
 * **关键**：失败时把 action-tools 的结构化 `ToolError`（code + message）映射成
 * runtime `error_kind`，再走 `errorResultEnvelope` 输出。原实现只取 message
 * 拍成字符串，导致 `old_string_not_found` / `old_string_not_unique` 等
 * "LLM 自我纠正信号"被蒸发（W1 第一轮 Review #3 R1 硬证据）。
 */
/**
 * 把 action-tools envelope 转 ToolResult。
 *
 * **W1.3 第 3 轮 Review 1 M3 修复（2026-05-13）**：失败路径加 path 透传——
 * `errorResultEnvelope` → `toTabcodeJsonErrorMetadata` → `defaultTabcodeHint`
 * 整条链路都需要 path 才能从 envelope 抽提 filename + 扩展名，让 SSoT 不再
 * 用 "file" 占位字面值。真正拒绝的可执行文件走本路径时，hint 必须保留
 * 实际扩展名，避免 LLM 丢失用户操作对象。
 */
function actionResultToToolResult(
  result: ActionToolResult,
  options: { path?: string } = {},
): ToolResult {
  if (result.success) {
    return {
      content: JSON.stringify({ success: true, ...(result.data ?? {}) }),
    };
  }
  const normalized = normalizeActionError(result.error);
  const mapped = mapActionErrorToRuntimeKind(normalized);
  // Wave 2 / 2026-05-13 Round 1 technical reviewer M-1 共识修复：
  // STALE_READ 路径下 action-tools 一侧 catch 时把 `path: err.path` 塞进
  // standardizeLegacyResult 的 result 顶层（被 `...rest` spread 透传），这里
  // 显式提取传给 `errorResultEnvelope` 让 envelope 字段跟入口校验
  // (validateReadBeforeWrite errorResultEnvelope 已带 path) **字节一致**
  // —— 基线 B5-1 字节对齐承诺的 path 字段不再漏。
  const resultRecord = result as unknown as Record<string, unknown>;
  const path =
    typeof resultRecord.path === 'string' ? resultRecord.path : undefined;
  return errorResultEnvelope({
    errorKind: mapped.errorKind,
    message: mapped.message,
    suggestion: mapped.suggestion,
    path: path ?? options.path,
  });
}

// ─── OS error rethrow (PRD 08 W11) ───────────────────────────────────
//
// W1.5 把 capability 端 `read_file` / `write_file` / `delete_file` 退役
// 后，文件 OSError 黑名单 → 短路 → clear → 重试链路的承担方从
// `FileSystemCap` 转移到了 adapter 层。但 action-tools 的 `fileReadTool` /
// `fileWriteTool` / `fileDeleteTool` 用 `fsPromises` 直接操作 fs，并把所有
// 异常 catch 后转成 `{ success: false, error: msg }` envelope —— 原始 errno
// 被嵌入 message string 但不再以 throw 形态向上传递。
//
// 结果：orchestration 的 `maybeBlockToolOnOSError`（duck-type 接 OSError）
// 拿不到这层错误，黑名单永远写不进；**用户场景"~/Desktop/todo.txt 拒绝 →
// 黑名单 → 解封 → 重试"在新 adapter 路径下不工作**。
//
// 修法：在 adapter 收到 action-tools 失败 envelope 时，从 message 里反向
// 解析出 errno + path，调 `classifyFsError` 看是否能归类为 OSError；命中
// 即抛出 OSError-shaped Error 让 orchestration 接住。失败时静默退化到
// 普通 ToolResult（绝不阻塞 Agent 主流程）。
//
// 仅对**目标路径明确**的工具启用（read_file / write_file / delete_file）—
// edit_file / grep_search / glob_search 的失败语义是"业务错"而非"OS 拒绝"，
// 进黑名单会误锁链路。

// W11 TD-W11-3：errno 白名单合并到 `@tabtin/os-errors#OS_ACCESS_ERRNO_CODES`
// 单一源。`classifyFsError` 真正接受的就是这个集合——此处 regex 严格按同
// 一列表构造，消除"两份白名单维护漂移"的风险。action-tools 把原始 Node fs
// error message 二次加工（`normalizeActionError` / `mapActionErrorToRuntimeKind`）
// 后仍然保留 `EACCES: permission denied, open '/path'` 起手的 Node errno
// 前缀；此 regex 只抓 message 开头 token。
const FS_ERRNO_RE = new RegExp(
  `^(${OS_ACCESS_ERRNO_CODES.join('|')})\\b`,
);

/**
 * 试图把 action-tools 失败 envelope 反推成 OSError-shaped throw。命中即抛
 * `Error & { osError }`，由 orchestration 的 `maybeBlockToolOnOSError`
 * 接住写黑名单 / 转结构化 ToolResult。
 *
 * **不命中静默返回**——原 envelope 走 `actionResultToToolResult` 兜底。
 *
 * @param result   action-tools 工具失败 envelope
 * @param path     目标路径（adapter 已 canonicalize 到绝对路径）
 */
function maybeRethrowAsOSAccessError(
  result: ActionToolResult,
  path: string,
): void {
  if (result.success) return;
  if (!path) return;

  const normalized = normalizeActionError(result.error);
  const message = normalized.message ?? '';

  // action-tools envelope 的 error 字段把 fs error message 直接拍进
  // string；Node fs 错误 message 形如 `EACCES: permission denied, open
  // '/path'`，errno 在最前面。从开头 token 反推 errno code。
  const m = FS_ERRNO_RE.exec(message);
  if (!m) return;
  const errnoCode = m[1] as NodeJS.ErrnoException['code'];

  // 重建一个最小 fs error 形状交给 classifyFsError——它内部分平台分类。
  // 注意：这里 path 由 adapter 传入而非从 message 里 regex 提取，避免
  // 跨平台 / quoted path 的解析坑。
  const fakeFsErr = Object.assign(new Error(message), {
    code: errnoCode,
  }) as NodeJS.ErrnoException;

  const osError = classifyFsError(fakeFsErr, path, process.platform);
  if (!osError) return;

  // 抛 OSError-shaped error。agent-runtime 不直接 import @tabtin/safe-fs
  // 的 OSAccessError 类，用 duck-typed shape 兼容
  // `@tabtin/os-errors#isOSError` 判断（与 ShellCap 同套约定）。
  const err = new Error(`OSAccessError: ${osError.code}`);
  (err as Error & { osError: typeof osError }).osError = osError;
  err.name = 'OSAccessError';
  throw err;
}

/**
 * action-tools 失败 envelope 的 `error` 字段允许多种形态：
 *   - 结构化 `ToolError`（含 `code` / `message`）
 *   - 裸 string（更老代码路径 / 边界 ENOENT 等）
 *   - 其它任意 JSON
 *
 * 统一归一为 `{ code?, message }` 形状交给 `mapActionErrorToRuntimeKind` 决策。
 */
function normalizeActionError(err: unknown): { code?: string; message: string } {
  if (err == null) return { message: 'Unknown error' };
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message:
        typeof e.message === 'string'
          ? e.message
          : typeof e.code === 'string'
            ? e.code
            : JSON.stringify(err),
    };
  }
  return { message: String(err) };
}

/**
 * 通用适配 helper：字段映射 + workspace 注入 + envelope 转换。
 *
 * **Export 级别**：W2+ 的 grep_search / glob_search 适配也将复用此函数，
 * 避免每个工具复制 80 行 wrapping 代码（Wave 1 第二轮 Review #3 D 项）。
 */
export function adaptAgentTool(
  agentTool: AgentTool,
  options: {
    deps: TabCodeToolsDeps;
    isReadOnly: boolean;
    policyActionKind?: Tool['policyActionKind'];
    /**
     * PRD 08 W12（L-23）：声明本工具吞入"半受信任"或"外部"字节，需要
     * 走 `<tool_output>` fence 防 prompt injection，即便 `isReadOnly` 也
     * 强制走 sanitize 链路。fence 是视觉边界，不抬审批等级（`riskLevel`
     * 推断只看 `isReadOnly`），只让 LLM 在 messages 里看到"这段是外部
     * 数据，别当 system 指令"。
     */
    disablePreStart?: boolean;
    /** 在 execute 之后调用，可观察 result + ctx 做 readFileState 更新。 */
    afterExecute?: (params: {
      input: Record<string, unknown>;
      result: ActionToolResult;
      ctx: ToolContext;
    }) => void | Promise<void>;
    /** 在 execute 之前调用；返回 ToolResult 表示提前拒绝（read-before-edit）。 */
    beforeExecute?: (params: {
      input: Record<string, unknown>;
      ctx: ToolContext;
    }) => Promise<ToolResult | null>;
    /**
     * LLM-facing description（必需）。
     *
     * Wave 2 / Task B：runtime 工具 description 的唯一真相源。
     * action-tools `AgentTool.description` 只保留人类 / Manifest 摘要，
     * **禁止**作为本字段的 fallback（不再支持 `?? agentTool.description`）。
     */
    llmDescription: string;
    /** 单工具结果上限（cursor 同款）。 */
    maxResultSizeChars?: number;
    concurrencySafe?: boolean;
    /**
     * PRD 08 W11：声明本工具对 OSError 透传敏感时启用——失败时尝试从
     * action-tools error message 反推 OS errno，命中就抛 OSError-shaped
     * Error 让 orchestration 接住写黑名单。callback 返回工具调用对应的
     * 目标绝对路径（用于 OSError.path 字段 + 黑名单 originalPath）。
     *
     * 仅 read_file / write_file / delete_file 启用——这三件套的失败
     * 语义最贴合"OS 拒绝"；edit_file / grep_search 等失败更可能是业务错，
     * 不能进黑名单（会误锁后续重试链路）。
     */
    osErrorPath?: (input: Record<string, unknown>) => string | undefined;
    /**
     * **文件并发安全 Wave 1（2026-05-13）**：声明本工具的临界区需要进程
     * 内 per-file 锁。callback 返回锁键（一般是 resolved 绝对路径，
     * file-lock 内部会再次 canonicalize 保证 realpath 一致）；返回 null
     * 表示本次调用不锁（如 path 无效的边界）。
     *
     * **装配期 assertion**：声明在 `LOCK_REQUIRED_TOOLS` 集合里的工具
     * （`edit_file` / `write_file`）必须填此 callback，否则装配期 throw
     * —— 缺失会让多 Agent 同改同文件静默覆盖，dogfood 才能发现，跟
     * `osErrorPath` 同套契约风格（行 320-345）。
     *
     * **临界区范围**：整个 `execute`（含 `beforeExecute` + `agentTool
     * .execute` + `afterExecute` 的 `refreshSnapshot`）都包在锁内。
     * `refreshSnapshot` 必须在锁内是关键不变量——出锁外让 A1 释放锁后
     * A2 进锁时还能拿到旧 mtime/content，TOCTOU 二次校验（Wave 2）会
     * 因此假阴性放行（PRD §A.4「这条特别重要」）。
     */
    requiresFileLock?: (input: Record<string, unknown>) => string | null;
    /**
     * per-file 回退（替代 shadow git）：声明本工具写盘前需要备份的目标绝对
     * 路径（一般 = resolveInputPath）。返回 null 表示本次不 track。adapter 在
     * agentTool.execute 之前、withFileLock 临界区内调 `ctx.fileHistory.trackEdit`。
     * `FILE_HISTORY_REQUIRED_TOOLS`（edit/write/delete）必须声明，否则装配期 throw。
     */
    tracksFileHistory?: (input: Record<string, unknown>) => string | null;
  },
): Tool {
  // Wave 2 / Task B：LLM description 必须显式由 runtime 提供，绝不能回落
  // action-tools 人类摘要（Manifest / ToolHub 展示文案）。
  if (
    typeof options.llmDescription !== 'string' ||
    options.llmDescription.trim().length === 0
  ) {
    throw new Error(
      `[tabcode-adapter] Tool '${agentTool.name}' is missing required 'llmDescription'. ` +
        `LLM-facing tool descriptions must come from agent-runtime; ` +
        `action-tools AgentTool.description is a human/Manifest summary only and must never be used as a runtime fallback.`,
    );
  }

  // W11 TD-W11-3：断言——`read_file` / `write_file` / `delete_file` 三个
  // **canonical tool name** 的直接 fs 操作工具必须配 `osErrorPath` callback。
  // 这三件套在 action-tools 层会真实触发 fs OSError（EACCES / EPERM …），
  // 反推 → 写黑名单 → 短路 → clear 链路依赖 osErrorPath 提供目标路径。
  // 缺了 callback 等于 silent 退化（黑名单永远不命中），dogfood 才能发现，
  // 装配期抛错让 regression 立即可见。
  //
  // 为什么用 tool name 而非 policyActionType：`policyActionType: 'file_read'`
  // 被多个搜索工具共享（grep_search / glob_search 等），但它们不走本地
  // fs open()，不会触发 OSError——不需要 osErrorPath。
  const TOOLS_REQUIRING_OS_ERROR_PATH = new Set([
    'read_file',
    'write_file',
    'delete_file',
  ]);
  if (
    TOOLS_REQUIRING_OS_ERROR_PATH.has(agentTool.name) &&
    !options.osErrorPath
  ) {
    throw new Error(
      `[tabcode-adapter] Tool '${agentTool.name}' is missing required 'osErrorPath' callback. ` +
        `File read/write/delete tools must forward OS errors to the OSError blacklist link; ` +
        `provide an osErrorPath(input) callback returning the target absolute path.`,
    );
  }

  // **文件并发安全 Wave 1（2026-05-13）** 装配期 assertion：edit_file /
  // write_file 必须配 `requiresFileLock` callback。缺了会让多 Agent / 单
  // Agent streaming 多 tool_call 同改同文件静默覆盖（PRD §一「①② 是
  // 100% 可复现的内部并发缺陷」），dogfood 才能发现 —— 装配期抛错让
  // regression 立即可见，与 osErrorPath 同套契约风格。
  //
  // `read_file` 不在表里——PRD §A.5 决策「不做读锁」，read 与 write 之间
  // 的并发由 Wave 2 TOCTOU 校验兜底。`delete_file` 不在表里——PRD §九
  // 明确「delete 加同款保护」由后续 PRD 处理，不属于本期 scope。
  const LOCK_REQUIRED_TOOLS = new Set(['edit_file', 'write_file']);
  if (
    LOCK_REQUIRED_TOOLS.has(agentTool.name) &&
    !options.requiresFileLock
  ) {
    throw new Error(
      `[tabcode-adapter] Tool '${agentTool.name}' is missing required 'requiresFileLock' callback. ` +
        `Edit/write tools must declare a per-file lock key to prevent concurrent file mutations from ` +
        `silently overwriting each other (single-Agent streaming multi-tool_call / multi-Agent same-process); ` +
        `provide a requiresFileLock(input) callback returning the resolved absolute path ` +
        `(or null when path is invalid / not applicable).`,
    );
  }

  // per-file 回退（替代 shadow git）装配期 assertion：文件变更类工具必须声明
  // tracksFileHistory，否则回退时该文件没有 before-backup（静默丢失回退能力）。
  // 与 requiresFileLock 同套契约风格——缺失即装配期 throw，让 regression 立现。
  const FILE_HISTORY_REQUIRED_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
  if (
    FILE_HISTORY_REQUIRED_TOOLS.has(agentTool.name) &&
    !options.tracksFileHistory
  ) {
    throw new Error(
      `[tabcode-adapter] Tool '${agentTool.name}' is missing required 'tracksFileHistory' callback. ` +
        `File-mutating tools must declare which absolute path to back up before execution so per-file ` +
        `rewind can restore it; provide a tracksFileHistory(input) callback returning the resolved ` +
        `absolute path (or null when not applicable).`,
    );
  }

  return {
    name: agentTool.name,
    description: options.llmDescription,
    inputSchema: agentTool.parameters as Tool['inputSchema'],
    isReadOnly: options.isReadOnly,
    ...(agentTool.riskLevel === 'safe' || agentTool.riskLevel === 'review' || agentTool.riskLevel === 'strict'
      ? { riskLevel: agentTool.riskLevel }
      : {}),
    disablePreStart: options.disablePreStart,
    concurrencySafe: options.concurrencySafe,
    policyActionKind: options.policyActionKind ?? 'file',
    maxResultSizeChars: options.maxResultSizeChars,
    async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = enrichWithWorkspaceRoot(rawInput, ctx, options.deps);

      // 临界区主体 —— beforeExecute → action-tool execute → afterExecute（含
      // refreshSnapshot）→ OSError 透传 → ToolResult 转换。声明为内嵌闭包
      // 而非外部函数，避免重复参数透传 + 让两条执行路径（带锁 / 不带锁）
      // 字节级一致。
      const runCritical = async (): Promise<ToolResult> => {
        if (options.beforeExecute) {
          const guard = await options.beforeExecute({ input, ctx });
          if (guard) return guard;
        }

        // per-file 回退（替代 shadow git）：写文件工具在真正写盘前备份"改之前"
        // 内容。声明式 tracksFileHistory 返回目标绝对路径；fileHistory 未注入
        // 时 no-op。在 agentTool.execute 之前、且（若声明 requiresFileLock）在
        // withFileLock 临界区内执行，防并发。
        //
        // 备份归属到本轮**顶层对话锚点** `ctx.fileHistoryAnchorId`（= beginSnapshot
        // 的 anchorId），而非"最新 snapshot"——并发 / 多 runtime / beginSnapshot
        // 失败都不会归错轮（file-history-core INV-6）。
        //
        // §3.9 规则 2：子 agent fork 时 `fileHistoryAnchorId` = 父轮 anchorId（由
        // query/fork-query 透传），所以子改的文件归到**父轮** anchor，回退父轮一并
        // 恢复子改动。`fileHistoryAnchorId` 缺失（legacy 测试 / 未注入）时回落
        // `ctx.agentRunId`（顶层 query 二者本就相等），与旧行为一致；两者都无则
        // 跳过 track，与"无锚点"语义一致。
        let patchAbsPath: string | null = null;
        if (options.tracksFileHistory) {
          patchAbsPath = options.tracksFileHistory(input);
          const anchorId = ctx.fileHistoryAnchorId ?? ctx.agentRunId;
          if (patchAbsPath && ctx.fileHistory && anchorId) {
            try {
              await ctx.fileHistory.trackEdit(anchorId, patchAbsPath);
            } catch {
              // fail-soft：备份失败不阻断工具执行（该文件本轮回退能力可能受限）。
            }
          }
        }

        // 编辑工具行级归因：在真正写盘前、同一把文件锁内读「改前」文本。
        // 不能等回合结束再从磁盘 / file-history 取差异——用户随后手改会混入。
        let beforeSnapshot: FileBeforeSnapshot | undefined;
        if (isFileEditPatchToolName(agentTool.name) && patchAbsPath) {
          beforeSnapshot = await captureFileBeforeSnapshot(patchAbsPath);
        }

        const result = await agentTool.execute(input);

        if (options.afterExecute) {
          try {
            await options.afterExecute({ input, result, ctx });
          } catch {
            // hook 失败不影响工具结果
          }
        }

        // PRD 08 W11：OSError 透传——在转 ToolResult 之前抛出，让
        // orchestration.maybeBlockToolOnOSError 接住写黑名单。
        // 不命中（含未声明 osErrorPath 的工具）继续走原 envelope 路径。
        if (options.osErrorPath) {
          const wsRoot = String(input._workspace_root || process.cwd());
          const path = options.osErrorPath(input);
          const resolved = path ? canonicalizePath(path, wsRoot) : undefined;
          if (resolved) {
            maybeRethrowAsOSAccessError(result, resolved);
          }
        }

        const toolResult = actionResultToToolResult(result);
        if (
          result.success
          && isFileEditPatchToolName(agentTool.name)
          && patchAbsPath
          && beforeSnapshot
        ) {
          const wsRoot = String(input._workspace_root || process.cwd());
          let afterSnapshot: FileBeforeSnapshot | undefined;
          if (agentTool.name === 'delete_file') {
            afterSnapshot = { kind: 'absent' };
          } else {
            afterSnapshot = await captureFileBeforeSnapshot(patchAbsPath);
          }
          toolResult.hostMetadata = {
            fileEditPatch: buildFileEditPatch({
              toolName: agentTool.name,
              relativePath: relativizeWorkspacePath(patchAbsPath, wsRoot),
              before: beforeSnapshot,
              after: afterSnapshot,
              input,
              data: result.data,
            }),
          };
        }
        return toolResult;
      };

      // **文件并发安全 Wave 1（2026-05-13）**：声明 requiresFileLock 且
      // callback 返回非空锁键时，整段临界区进 per-file 锁。锁键由 callback
      // 计算（一般是 resolved 绝对路径），file-lock 内部 canonicalizePath
      // 兜底 realpath 一致——传相对路径 / symlink / 大小写漂移都收敛到同
      // 一锁。
      //
      // 锁内顺序: beforeExecute（含 validateReadBeforeWrite）→ action-tool
      // .execute（含 atomicWriteFile）→ afterExecute（含 refreshSnapshot）
      // → OSError 透传 → ToolResult 转换。**refreshSnapshot 在锁内是关键
      // 不变量**（PRD §A.4），出锁外让 A1 释放锁后 A2 进锁时还能拿到旧
      // mtime/content，TOCTOU 二次校验（Wave 2）会因此假阴性放行。
      if (options.requiresFileLock) {
        const lockKey = options.requiresFileLock(input);
        if (lockKey) {
          const wsRoot = String(input._workspace_root || process.cwd());
          return await withFileLock(lockKey, runCritical, {
            abortSignal: ctx.abortSignal,
            baseDir: wsRoot,
          });
        }
      }

      return await runCritical();
    },
  };
}

function cloneToolInput(rawInput: unknown): Record<string, unknown> {
  return rawInput != null && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? { ...(rawInput as Record<string, unknown>) }
    : {};
}

function ensureWorkspaceRootField(
  base: Record<string, unknown>,
  ctx: ToolContext,
  deps: TabCodeToolsDeps,
): void {
  // ── _workspace_root（单字符串）：相对路径解析基准 ──────────────────
  // 路径权限治理 Wave 1 起，**仅用于相对路径解析**（resolveInWorkspace），
  // 不再参与 boundary 权限判定（多目录权限走 _allowed_paths）。
  // 既有显式 _workspace_root 优先（调用方 / 测试可显式覆盖）。
  if (typeof base._workspace_root !== 'string' || base._workspace_root.length === 0) {
    const ctxRoot = ctx.workspaceRoot;
    const depsRoot = deps.workspaceRoot?.();
    const resolved = ctxRoot || depsRoot || process.cwd();
    base._workspace_root = resolved;
  }
}

function applyWorkspaceSnapshotFields(base: Record<string, unknown>, ctx: ToolContext): void {
  // ── _allowed_paths / _allowed_files：v3 SSoT 工作区多目录边界 ──────
  //
  // P1-3 安全收紧：**显式从 ctx 派生而非"缺省填充"**。
  //
  // 旧实现（"empty array 才填充"）在 LLM 显式传 `_allowed_paths:
  // ['/Users/victim']` 时会让此值穿透到 action-tools。在 enforce 模式下
  // tool-orchestration 强制覆盖 ctx.permissionContext，所以无影响；但 legacy
  // 模式下 ctx.permissionContext 为空，adapter 不动 base.* 字段，LLM 注入的
  // 数组就一路到 action-tools 的 boundary 判定——攻击面虽小（红线 + 敏感
  // 路径仍兜底），但仍是真实安全裂缝。
  //
  // 现在：adapter 见到 `ctx.workspaceSnapshot` 就**强制覆盖** `_allowed_paths`
  // / `_allowed_files`（LLM 没机会注入这两个字段）；`undefined` 时**强制
  // 删除** input 上的同名字段（避免 LLM 残留），让 action-tools 退化到"没
  // 有可比较目录" + 红线 + 敏感路径兜底语义。
  const snapshot = ctx.workspaceSnapshot;
  if (snapshot) {
    base._allowed_paths = snapshot.allowedPaths;
    base._allowed_files = snapshot.allowedFiles;
  } else {
    // 显式删除 LLM 可能塞进来的字段——防止"adapter 不动则 LLM 数组穿透"。
    delete base._allowed_paths;
    delete base._allowed_files;
  }
}

function applyPermissionJudgementField(base: Record<string, unknown>, ctx: ToolContext): void {
  // ── _already_judged：是否已通过 v3 judge 管线 ─────────────────────
  //
  // P1-3 安全收紧：**显式从 ctx.permissionContext 派生**而非"缺省填充"。
  //
  // 旧实现"仅在 ctx.permissionContext.judgedDecision === 'allow' 时设 true"
  // 不会显式重置 LLM 注入的 true，让 legacy 路径下 LLM 可绕过 boundary。
  //
  // 现在：先 delete 抹平 LLM 残留，再从 ctx 派生——LLM 在 input 里写
  // `_already_judged: true` 也会被 adapter 抹平。enforce 模式由 tool-
  // orchestration 透传 `permissionContext`；legacy 模式 ctx.permissionContext
  // 为空 → 字段不存在 → action-tools 端 `=== true` 判断为 false → boundary
  // 正常生效。
  delete base._already_judged;
  if (ctx.permissionContext?.judgedDecision === 'allow') {
    base._already_judged = true;
  }
}

function applyToolResultsDirField(base: Record<string, unknown>, deps: TabCodeToolsDeps): void {
  // ── _tool_results_dir：W4 read_file 持久化引用文件豁免路径 ────────
  //
  // adapter 强制覆盖（先 delete 抹平 LLM 残留，再从 deps 派生）—— LLM 在
  // input 里写 `_tool_results_dir: '/etc'` 想绕过 workspace boundary 检查
  // 也会被 adapter 抹掉。值由宿主装配点透传当前 session 的 tool-results
  // 绝对路径，action-tools `checkFilePathSecurity` 在 read_file 路径下做
  // 精确前缀匹配豁免。
  delete base._tool_results_dir;
  const toolResultsDir = deps.getToolResultsDir?.();
  if (typeof toolResultsDir === 'string' && toolResultsDir.length > 0) {
    base._tool_results_dir = toolResultsDir;
  }
}

function parseStaleReadEnvelope(rawContent: ToolResult['content']): { error: string; hint?: string; path?: string } {
  let envelope: { error: string; hint?: string; path?: string } = {
    error: 'stale read',
    hint: undefined,
    path: undefined,
  };
  if (typeof rawContent === 'string') {
    try {
      envelope = JSON.parse(rawContent) as {
        error: string;
        hint?: string;
        path?: string;
      };
    } catch {
      // JSON.parse 失败 fallback：envelope 保持默认 placeholder，下游
      // suggestion / path 走 fallback 链 —— hook 仍 throw 可用错误。
    }
  }
  return envelope;
}

function installValidateBeforeWriteHook(base: Record<string, unknown>, ctx: ToolContext): void {
  delete base._validate_before_write;
  if (!ctx.readFileState) return;

  // **Wave 3 整体收尾 L-32 修复**：用 `ValidateBeforeWriteHook` 类型契约（导出自
  // `@tabtin/action-tools/headless`）跟 action-tools 一侧 invoke 保持类型一致。
  // 未来 hook signature 改动时 TS 双侧报错强制对齐。
  const hook: ValidateBeforeWriteHook = (params) => {
    const errorResult = validateReadBeforeWriteSync(
      ctx.readFileState,
      params.filePath,
      {
        currentMtimeMs: params.currentMtimeMs,
        currentContent: params.currentContent,
        baseDir: ctx.workspaceRoot,
      },
    );
    if (!errorResult) return;

    // throw ToolStaleReadError 携带本次校验失败的 envelope 字段，让
    // action-tools fileEditTool / fileWriteTool 一侧 catch 后构造跟入口
    // 校验「字节一致」的错误 envelope（基线 B5-1）。
    //
    // 从 errorResult.content（JSON string）反解出 message / hint / path
    // 字段：本路径走 jsonError（read-file-state.ts:errorResultEnvelope）
    // 构造，shape 固定为 `{ success: false,
    // error_kind: 'tool_stale_read', hint: ..., path: ..., error: ... }`。
    //
    // **类型 narrow**：ToolResult.content 类型是 `string | ContentBlock[]`，
    // 但 jsonError 路径产物必为 string（JSON.stringify 输出）。typeof 显式
    // narrow 让 JSON.parse 拿到 string 而非 ContentBlock[]。
    //
    // **Wave 3 整体收尾 L-34 修复**：JSON.parse 加 try/catch fallback。当前
    // errorResultEnvelope 必然产合法 JSON，但未来 envelope shape 改成
    // ContentBlock[] 路径（如加 telemetry 元数据 / 国际化结构）会让 JSON.parse
    // 撞 SyntaxError。catch 后走 fallback 让 hook 仍能构造可用的 STALE_READ
    // error（不至于让 SyntaxError 跨出 hook 边界变成 unknown_error）。
    const envelope = parseStaleReadEnvelope(errorResult.content);
    throw new ToolStaleReadError({
      errorKind: TOOL_STALE_READ,
      message: envelope.error,
      // L-23 修（Wave 2 Round 2 harness 收口 2026-05-13）：JSON.parse 失败
      // fallback 旧实现字面写整句 hint，跟 read-file-state.ts STALE_READ_HINT
      // 常量重复 → 「同样 stale 状态在不同入口看到不同 hint」分叉风险。
      // 改用统一常量收口，保证 envelope.hint 缺失时 fallback 跟 stale-read
      // 主路径字面对齐（基线 B5-1 / Wave 2 独立 reviewer 报告）。
      suggestion: envelope.hint ?? STALE_READ_HINT,
      path: envelope.path ?? params.filePath,
    });
  };
  base._validate_before_write = hook;
}

function enrichWithWorkspaceRoot(
  rawInput: unknown,
  ctx: ToolContext,
  deps: TabCodeToolsDeps,
): Record<string, unknown> {
  const base = cloneToolInput(rawInput);
  ensureWorkspaceRootField(base, ctx, deps);
  applyWorkspaceSnapshotFields(base, ctx);
  applyPermissionJudgementField(base, ctx);
  applyToolResultsDirField(base, deps);

  // ── _default_limit_injected：W4 read_file 默认 limit 注入标记 ──────
  //
  // 内部协议字段，仅 createFileReadTool 在「LLM 没传 offset/limit」时注入
  // 给 recordTextReadSnapshot 用，让 dedup state 归一化为
  // `limit: undefined`。LLM 不该传，这里**强制清洗**——LLM 在 input 里
  // 显式写 `_default_limit_injected: true` 也会被抹掉，避免污染
  // readFileState（详见 createFileReadTool 内 dedup 时序注释）。
  delete base._default_limit_injected;

  // ── _validate_before_write：文件并发安全 Wave 2 TOCTOU 二次校验 hook 透传 ──
  //
  // **2026-05-13 字节对照基线 B1-1**：跨包 hook 通过 input 内部协议字段
  // `_validate_before_write` 透传（PRD §B.3 原字面「闭包注入到 agentTool 对象」
  // **已 2026-05-13 修订**为本字段，子 Agent 实施时不要按 PRD 旧字面照做）。
  //
  // **为什么用 input 字段而不是 agentTool 对象 mutation**：fileEditTool /
  // fileWriteTool 是 `packages/action-tools/src/tools/tabcode/index.ts` 顶层
  // `export const` 导出的 module-level singleton。并发两个 execute 跑同一对象
  // 时闭包注入会让 `ctx.readFileState` 闭关引用错乱（JS 单线程不撞条件竞争，
  // 但「A.execute 拿到 B 闭包持有的 B.ctx」隐式 bug 排查极难）。input 是
  // per-call 独立对象，无此风险。
  //
  // **防伪造**：先 delete 抹平 LLM 残留，再从 ctx 重新注入 —— LLM 在 input
  // 里写 `_validate_before_write: () => {}` 想绕过校验也会被抹掉。跟
  // `_workspace_root` / `_already_judged` / `_default_limit_injected` 同款
  // 防伪造模式（维度 E）。
  //
  // **hook 是同步函数且 throw 而非 return**（基线 B1-2 + B1-3）：
  //   - 同步：caller（fileEditTool/fileWriteTool 写盘前 try/catch）调 hook
  //     时不需要 await，临界区禁 await 不变量收口在本 hook + caller 字面
  //     `await` 0 处。
  //   - throw：避免 caller 忘记检查返回值漏防御 —— action-tools 一侧 catch
  //     ToolStaleReadError 转 envelope return；其他 throw 原样透传到外层
  //     catch 走 unknown_error。
  installValidateBeforeWriteHook(base, ctx);

  return base;
}

/**
 * 解析调用方提供的 path 入参为 readFileState canonical key。
 *
 * 走 `canonicalizePath` 而非 `path.resolve`——后者在 macOS 上会留下
 * `/var/folders/...` vs `/private/var/folders/...` 的不一致，导致
 * read 写一份 key、edit 查另一份 key，read-before-edit 形同失效（W1
 * 第二轮 Review #1 case A / #3 A 项硬证据）。
 */
function resolveInputPath(
  input: Record<string, unknown>,
  workspaceRoot: string,
): string | undefined {
  const raw = input.path;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  // ：剥 LLM 从 shell 抄来的路径引号，与 action-tools resolveInWorkspace 对齐
  let cleaned = raw.trim();
  if (
    cleaned.length >= 2
    && ((cleaned.startsWith('"') && cleaned.endsWith('"'))
      || (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  while (cleaned.startsWith('"') || cleaned.startsWith("'")) cleaned = cleaned.slice(1);
  while (cleaned.endsWith('"') || cleaned.endsWith("'")) cleaned = cleaned.slice(0, -1);
  cleaned = cleaned.trim();
  if (!cleaned) return undefined;
  return canonicalizePath(cleaned, workspaceRoot);
}

// ─── factory ─────────────────────────────────────────────────────────

/**
 * 创建 6 件套 tabcode 工具。
 * 装配到 ElectronToolProvider / DaemonToolProvider 即可让 LLM 调到。
 */
export function createTabCodeTools(deps: TabCodeToolsDeps = {}): Tool[] {
  return [
    createFileReadTool(deps),
    createFileEditTool(deps),
    createFileWriteTool(deps),
    createFileDeleteTool(deps),
    createCodeGrepTool(deps),
    createCodeGlobTool(deps),
    // C13 (2026-05-13)：read_lints 工具从 LLM 可见列表退役。
    //
    // 退役理由（基于 dogfood 真实数据）：
    //   - 本机历史所有 session messages.jsonl 中 read_lints 出现 0 次
    //   - cursor 真实样本仅 38 次（远低于 read_file 几千次）
    //   - dogfood 诊断列为 P3，"dogfood 没触发 read_lints"
    //   → "LLM 主动查询诊断"的产品形态失败
    //
    // 取代方案（候选 A）：诊断作为 Agent 内部自检工具，全部走 attachment 被动注入：
    //   - C8 tabcode-adapter notifyLspAfterEdit 在 edit/write 后通知 LSP server
    //   - C9 buildLspDiagnosticInjectorHook 下一轮 LLM 请求前注入 <new-diagnostics>
    //   - C12 LSP 无 server 处理某语言时 fallback 到 spawn linter
    //
    // **保留 createReadDiagnosticsTool 函数实现**：仅供内部 spawn linter
    // fallback 共享 adapter 逻辑；LLM 可见工具面不再包含 read_lints。
    //
    // alias 同步删除：LLM 万一调到旧名，应拿到明确 unknown-tool，而不是被
    // did_you_mean 引回退役工具。
    //
    // createReadDiagnosticsTool(deps), // ← C13 退役，不进入 LLM tools[]。
  ];
}

// ─── read_file 非文本文件材料化 ────────────────────────────────────────
//
// read_file 只把文本内容直接返回给模型。图片、PDF、Office、媒体、压缩包等
// 非文本文件在通过 action-tools 的路径安全检查后，统一交给 host materializer
// 上传/材料化为 file_id / URL 引用；adapter 不再把二进制 bytes/base64 拼进
// tool_result 或 newMessages。

// L1 description 治理纪律 + 内容演进日志见 0_active_renderers.md
// `read_file_tool` notes 字段（单一真相源）。
//
// **常量命名约定**：本 const 必须叫 `READ_FILE_DESCRIPTION`（工具名大写 +
// `_DESCRIPTION` 后缀）—— packages/prompt-contract/eslint-rules/
// tool-description-length.js 会从这个命名推导工具 ID 反查 registry budget。
// 改名会让 ESLint 跳过 size 检查（false-positive 0 violation）。
const READ_FILE_DESCRIPTION =
  '从本地文件系统读文件。\n\n' +
  '**输入**：绝对路径或相对工作目录根的路径（不要加 `workspace/` 前缀）。**不是** chat 上传文档的 `file_id` UUID。\n\n' +
  '用法：\n' +
  '- 不传 offset/limit 时**默认从第 1 行读 2000 行**。超出时结果末尾有 `<system-reminder>` 给 total lines + 续读 offset。\n' +
  '- 单次最多返回 100000 字符；超出时按完整行截断，并在 `<system-reminder>` 中给出续读 offset。\n' +
  '- 返回 `cat -n` 格式：行号 + tab + 内容。**行号前缀仅显示用**，做精确字符串替换前必须剥掉行号 + tab，否则 OLD_STRING_NOT_FOUND。\n' +
  '- **完整读取两信号**：(1) `<system-reminder>This file has X total lines...` → 未读完；(2) `<persisted-output>...Full output saved to: <path>...` → 完整内容在该路径——机读内容优先用 jq / grep_search 收窄，确需精读某段才用本工具 path + offset/limit 读局部区间，不要整个读回。两信号皆无才能断言已读全。\n' +
  '- 末尾 `... (line truncated to 2000 chars)` = 单行过长（minified JS / 巨型日志）——不要 retry / 不要改 offset。\n' +
  '- 图片会在本次调用中作为视觉输入交给模型；PDF / Office / EPUB 会在本次调用中完成文档解析并返回正文，不要再调用 parse_document。音视频 / 压缩包 / 其它二进制会材料化为 file_id / URL 引用。\n' +
  '- 路径是目录时返回前 200 条文件名 + total_count reminder。\n' +
  '- 可读 shell 返回的 `full_output_path` / `output_file` 查看后台命令输出（大输出先收窄或派子 Agent 提炼，见上）。\n\n' +
  '失败处理：以 envelope `hint` / `error_kind` 为准（加密 / magic-mismatch / 扫描 PDF 等各有指引）。**不要重试**、不要自创兜底——envelope 是真相源。';

// ─── read_file ───────────────────────────────────────────────────────

/**
 * **W4 (2026-05-12)**：read_file 用行窗口和字符预算共同保护模型上下文：
 *
 *   1. 默认 `limit = DEFAULT_READ_FILE_LIMIT_LINES`—— LLM 不传 offset/limit
 *      时 runtime 自动注入，避免
 *      5MB+ 大文件全文进 LLM context 撑爆 200K window。LLM 看到 totalLines
 *      > 实际读到的行数即知文件超出默认窗口，可显式用 offset 续读。
 *   2. `READ_FILE_MAX_RESULT_CHARS` 是单次硬上限。显式传入巨大 limit 也按
 *      完整行截断，并返回精确续读 offset，避免通用预算器从中间切断内容。
 */
const DEFAULT_READ_FILE_LIMIT_LINES = 2_000;
const READ_FILE_MAX_RESULT_CHARS = 100_000;

const MIME_BY_EXT: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.epub': 'application/epub+zip',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

function guessMimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function categoryForMimeOrExt(filePath: string, mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return 'media';
  if (
    mimeType === 'application/pdf'
    || mimeType.includes('wordprocessingml')
    || mimeType.includes('spreadsheetml')
    || mimeType.includes('presentationml')
    || mimeType === 'application/epub+zip'
    || mimeType === 'application/msword'
    || mimeType === 'application/vnd.ms-excel'
    || mimeType === 'application/vnd.ms-powerpoint'
  ) {
    return 'document';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.zip' || ext === '.rar' || ext === '.tar' || ext === '.gz' || ext === '.7z') {
    return 'archive';
  }
  return 'binary';
}

function buildMaterializedFileToolResult(args: {
  ref: FileMaterializationRef;
  path: string;
  category: string;
}): ToolResult {
  const { ref, path: resolvedPath, category } = args;
  const hint = category === 'document'
    ? 'Document materialized successfully. You MUST call parse_document next with this file_id before answering the user; do not stop after read_file and do not retry read_file.'
    : 'Non-text file materialized by host. Use the returned file reference with the appropriate App/tool; do not retry read_file to inline bytes.';
  const visualMessages = category === 'image' && ref.url
    ? [{
        role: 'user' as const,
        content: [{
          type: 'image' as const,
          source: { type: 'url' as const, url: ref.url },
        }],
      }]
    : undefined;
  return {
    content: JSON.stringify({
      success: true,
      type: 'file_materialized',
      category,
      path: resolvedPath,
      filename: ref.filename,
      mime_type: ref.mimeType,
      size_bytes: ref.sizeBytes,
      file_id: ref.fileId,
      ...(ref.url ? { url: ref.url } : {}),
      hint,
    }),
    hostMetadata: {
      fileMaterialization: ref,
    },
    ...(visualMessages ? { newMessages: visualMessages } : {}),
  };
}

async function materializeNonTextReadFile(args: {
  ctx: ToolContext;
  resolvedPath: string;
  rawPath?: string;
  mimeType?: string;
  category?: string;
  fileMaterializer?: FileMaterializer;
  parseMaterializedDocument?: TabCodeToolsDeps['parseMaterializedDocument'];
}): Promise<ToolResult> {
  const { ctx, resolvedPath, rawPath } = args;
  const displayPath = resolvedPath || rawPath || '';
  if (!displayPath) {
    return errorResultEnvelope({
      errorKind: INVALID_PARAM_FORMAT,
      message: 'read_file could not resolve the requested file path for materialization.',
      suggestion: 'Pass a valid local file path.',
      path: rawPath,
    });
  }
  if (!args.fileMaterializer) {
    return errorResultEnvelope({
      errorKind: 'file_materialization_unavailable',
      message: 'Host file materialization is not available for read_file.',
      suggestion:
        'Ask the host/user to upload the file, or use a host that supports file materialization.',
      path: displayPath,
    });
  }

  const mimeType = args.mimeType ?? guessMimeFromExt(displayPath);
  const category = args.category ?? categoryForMimeOrExt(displayPath, mimeType);
  try {
    const ref = await args.fileMaterializer.materialize({
      path: displayPath,
      filename: path.basename(displayPath),
      mimeType,
      threadId: ctx.threadId,
      agentRunId: ctx.agentRunId,
      toolUseId: ctx.toolUseId,
      signal: ctx.abortSignal,
    });
    if (category === 'document' && args.parseMaterializedDocument) {
      const parsed = await args.parseMaterializedDocument(ref.fileId, ctx);
      return {
        ...parsed,
        ...(parsed.isError === true
          ? {}
          : { presentation: { kind: 'rich_content_only' } }),
        hostMetadata: {
          ...parsed.hostMetadata,
          fileMaterialization: ref,
        },
      };
    }
    return buildMaterializedFileToolResult({ ref, path: displayPath, category });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tooLarge = err instanceof FileMaterializationTooLargeError;
    return errorResultEnvelope({
      errorKind: tooLarge ? 'file_too_large' : 'file_materialization_failed',
      message: `Host file materialization failed: ${message}`,
      suggestion: tooLarge
        ? 'Read a smaller file or split the file before calling read_file again.'
        : 'Retry after the host materialization service is healthy.',
      path: displayPath,
    });
  }
}

// ─── W5 L43（2026-05-14）createFileReadTool::execute 拆 helper ──────────
//
// 原 execute 函数 ~340 行包含 dispatch + size 检查 + dedup + 错误兜底 +
// path 路由等多重职责。L43 拆 5 个 helper 让每个语义清晰、单独可测：
//   - tryAllDedupShortCircuit  : 文本 dedup 命中时返 stub
//   - materializeNonTextReadFile: 非文本文件交给 host 上传/材料化
//   - resolveTextResult        : 成功 + text 分支（record snapshot + 多行明文）
//   - resolveDirectoryResult   : 成功 + directory 分支（截断提示）
//
// execute 只剩 protocol 装配 + 流转控制（< 100 行）。
//
// 每个 helper 都是 module-level function，args 透传——不依赖 closure，便于
// 在测试中 mock。

/**
 * **L43**：尝试文本 dedup 短路。
 *
 * 命中任一返 stub；都没命中返 null（caller 走真读路径）。
 *
 * 图片、PDF、Office、媒体、压缩包等非文本文件不再走 read_file 级别的
 * binary dedup；它们统一交给 host fileMaterializer。是否按内容摘要
 * 复用已有上传对象，是 host 层能力，不应该由工具上下文 stub 伪装成已读。
 */
async function tryAllDedupShortCircuit(args: {
  input: Record<string, unknown>;
  ctx: ToolContext;
  wsRoot: string;
  resolvedForOSError: string | undefined;
}): Promise<ToolResult | null> {
  const { input, ctx, wsRoot, resolvedForOSError } = args;

  const textStub = await maybeReturnUnchangedReadStub(input, ctx, wsRoot, resolvedForOSError);
  if (textStub) return textStub;
  return null;
}

/**
 * **L43**：处理 action-tools 成功 + directory 分支（截断提示装配）。
 *
 * **A3 (2026-05-12)** 目录截断提示：action-tools 在 entries > 200 时设置
 * `truncated:true + total_count`，本 helper 把这个信号翻译成 `<system-reminder>`
 * 附在 JSON 后面，让 LLM 明确知道"目录还有更多条目"，提示用 grep_search /
 * glob 精确定位。
 */
function resolveDirectoryResult(args: {
  data: Record<string, unknown>;
  result: ActionToolResult;
}): ToolResult {
  const { data, result } = args;
  const baseEnvelope = actionResultToToolResult(result);
  if (data.truncated === true && typeof data.total_count === 'number') {
    const totalCount = data.total_count;
    const visibleCount = Array.isArray(data.entries) ? data.entries.length : 0;
    const reminder =
      `<system-reminder>Directory has ${totalCount} entries; ` +
      `only first ${visibleCount} shown (sorted alphabetically). ` +
      `Use grep_search / glob_search to locate specific files.` +
      `</system-reminder>`;
    const baseContent = typeof baseEnvelope.content === 'string'
      ? baseEnvelope.content
      : JSON.stringify(baseEnvelope.content);
    return { ...baseEnvelope, content: `${baseContent}\n\n${reminder}` };
  }
  return baseEnvelope;
}

interface PreparedReadFileCall {
  input: Record<string, unknown>;
  wsRoot: string;
  rawPath?: string;
  resolvedForOSError?: string;
}

function prepareReadFileCall(
  rawInput: unknown,
  ctx: ToolContext,
  deps: TabCodeToolsDeps,
): PreparedReadFileCall {
  const input = enrichWithWorkspaceRoot(rawInput, ctx, deps);
  const wsRoot = String(input._workspace_root || process.cwd());
  const rawPath = typeof input.path === 'string' ? input.path : undefined;
  const resolvedForOSError = rawPath ? canonicalizePath(rawPath, wsRoot) : undefined;
  return { input, wsRoot, rawPath, resolvedForOSError };
}

function injectDefaultReadLimit(input: Record<string, unknown>): void {
  const llmDidNotSetOffsetOrLimit =
    input.offset === undefined && input.limit === undefined;
  if (!llmDidNotSetOffsetOrLimit) return;
  input.limit = DEFAULT_READ_FILE_LIMIT_LINES;
  (input as Record<string, unknown>)._default_limit_injected = true;
}

async function resolveSuccessfulReadResult(args: {
  input: Record<string, unknown>;
  data: Record<string, unknown>;
  result: ActionToolResult;
  ctx: ToolContext;
  wsRoot: string;
  rawPath?: string;
  resolvedForOSError?: string;
  deps: TabCodeToolsDeps;
}): Promise<ToolResult> {
  const { input, data, result, ctx, wsRoot, rawPath, resolvedForOSError, deps } = args;
  if (
    data.type === 'non_text_file'
    || data.type === 'image'
  ) {
    const resolvedPath =
      typeof data.path === 'string' && data.path.length > 0
        ? data.path
        : resolvedForOSError ?? rawPath ?? '';
    const mimeType =
      typeof data.media_type === 'string'
        ? data.media_type
        : typeof data.mime_type === 'string'
          ? data.mime_type
          : resolvedPath
            ? guessMimeFromExt(resolvedPath)
            : undefined;
    const category =
      typeof data.category === 'string'
        ? data.category
        : resolvedPath && mimeType
          ? categoryForMimeOrExt(resolvedPath, mimeType)
          : 'binary';
    return await materializeNonTextReadFile({
      ctx,
      resolvedPath,
      rawPath,
      mimeType,
      category,
      fileMaterializer: deps.fileMaterializer,
      parseMaterializedDocument: deps.parseMaterializedDocument,
    });
  }
  if (typeof data.content === 'string') {
    await recordTextReadSnapshot(input, data, ctx, wsRoot);
    return buildTextReadToolResult(data, input, {
      enableCyberRiskReminder: deps.enableCyberRiskReminder,
    });
  }
  if (data.is_directory === true) {
    return resolveDirectoryResult({ data, result });
  }
  // 兜底：非文本非图像非目录（理论不应到这里）走通用 envelope
  return actionResultToToolResult(result);
}

async function resolveFailedReadResult(args: {
  result: ActionToolResult;
  rawPath?: string;
  resolvedForOSError?: string;
}): Promise<ToolResult> {
  const { result, rawPath, resolvedForOSError } = args;
  // 沿用 action-tools 原文案（W1.3 第 3 轮 Review 1 M3：path 透传让 SSoT
  // hint 能用真实 filename + 扩展名，read_file('./song.mp3') 等场景）。
  return actionResultToToolResult(result, {
    path: resolvedForOSError ?? rawPath,
  });
}

function createFileReadTool(deps: TabCodeToolsDeps): Tool {
  return {
    name: actionFileReadTool.name,
    description: READ_FILE_DESCRIPTION,
    inputSchema: actionFileReadTool.parameters as Tool['inputSchema'],
    isReadOnly: true,
    // L-23：workspace 文件是"半受信任"——用户 clone 的第三方仓库
    // README / 包 CHANGELOG / 代码注释里可能嵌入 "Ignore previous
    // instructions..." 这类间接 prompt injection。
    //
    // **W3（2026-05-10）fence 解耦**：fence 范围已收紧到 web_search /
    // parse_document / mcp_call_tool / mcp_*（"真外部 bytes"），本机文件
    // 不再走 fence。`disablePreStart` 字段保留服务 query.ts pre-start 决策
    // （L34 H2-B：disablePreStart 工具不走 pre-start 快路径，必经 permission 检查）。
    disablePreStart: true,
    policyActionKind: 'file',
    // adapter 已按完整行截断并附续读 offset。runtime 必须跳过通用摘要，否则
    // 会把可续读的结构化结果替换成 persisted-output，模型反而看不到 next offset。
    maxResultSizeChars: Infinity,
    /**
     * **L43（2026-05-14）拆分后 execute < 100 行**：只剩 protocol 装配 + 流转
     * 控制；image / text / directory / doc-failure 各自抽 helper。
     *
     * 流程：
     *   1. enrich + 解析 path / ext
     *   2. 文本 dedup 短路（命中即返 stub）
     *   3. 注入默认 limit（必须**在 dedup 之后**——dedup 比较 LLM 原始字段）
     *   4. 调 action-tools.execute（安全检查 + text/image 读 + binary hard-fail）
     *   5. OSError 透传（PRD 08 W11）
     *   6. 成功 → 按 data.type 分流（image / text / dir / 兜底）
     *   7. 失败 → 保留 action-tools 的结构化错误
     */
    async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      // (1) enrich
      const {
        input,
        wsRoot,
        rawPath,
        resolvedForOSError,
      } = prepareReadFileCall(rawInput, ctx, deps);

      // (2) 文本 dedup 短路
      const dedupStub = await tryAllDedupShortCircuit({
        input, ctx, wsRoot, resolvedForOSError,
      });
      if (dedupStub) return dedupStub;

      // (3) 注入默认 limit —— **关键时序**：必须在 dedup 之后
      //
      // dedup 通过 `ctx.messages` 历史比较 LLM **原始** input.offset/limit；
      // 如果 dedup 前注入，历史 input.limit === undefined 跟当前 input.limit
      // === 2000 永远错配，dedup 漏命中、每次重读（性能 regression）。
      // 同步通过 `_default_limit_injected` 标记给 `recordTextReadSnapshot` 用：
      // record entry 时归一化为 `limit: undefined`，让下一次 dedup 命中。
      injectDefaultReadLimit(input);

      // (4) 调 action-tools（安全检查 + text/image 读 + binary hard-fail）
      const result = (await actionFileReadTool.execute(
        input as unknown as Parameters<typeof actionFileReadTool.execute>[0],
      )) as ActionToolResult;

      // (5) OSError 透传 —— 在转 ToolResult 之前抛出，让 orchestration.maybeBlockToolOnOSError 接住写黑名单
      if (resolvedForOSError) {
        maybeRethrowAsOSAccessError(result, resolvedForOSError);
      }

      // (6) 成功 → 按 data.type 分流
      if (result.success) {
        const data = (result.data ?? {}) as Record<string, unknown>;
        return await resolveSuccessfulReadResult({
          input, data, result, ctx, wsRoot, rawPath, resolvedForOSError, deps,
        });
      }

      // (7) 失败 → 保留 action-tools 的结构化错误
      return await resolveFailedReadResult({
        result, rawPath, resolvedForOSError,
      });
    },
  };
}

// ─── env-gated debug log（零行为改动；TABTIN_DEBUG_TABCODE_DEDUP=1 启用） ──
//
// 用途：dogfood 现场观察 dedup 触发链路。生产默认关闭（process.env.TABTIN_DEBUG_TABCODE_DEDUP
// 不为 '1' 时早 return），开销可忽略。
//
// 输出形态：`[tabcode-dedup] <stage> {json}` 到 stderr（console.warn）。
// 用 `pnpm dev` / Electron 主进程 stdout buffer 可直接抓。
function dlog(stage: string, data: Record<string, unknown>): void {
  if (process.env.TABTIN_DEBUG_TABCODE_DEDUP !== '1') return;

  console.warn('[tabcode-dedup]', stage, JSON.stringify(data));
}

interface TextReadDedupEntry {
  offset?: number;
  limit?: number;
  timestamp: number;
}

interface TextReadDedupMatch {
  existingState: TextReadDedupEntry;
  offset: number;
  limit?: number;
}

function getTextReadDedupMatch(args: {
  input: Record<string, unknown>;
  existingState?: TextReadDedupEntry;
  resolvedPath: string;
  wsRoot: string;
  ctx: ToolContext;
}): TextReadDedupMatch | null {
  const { input, existingState, resolvedPath, wsRoot, ctx } = args;
  if (!existingState || existingState.offset === undefined) {
    dlog('dedup.bail.no_entry_or_offset_undefined', {
      hasEntry: !!existingState,
      entryOffsetUndefined: existingState?.offset === undefined,
    });
    return null;
  }

  const offset = typeof input.offset === 'number' ? (input.offset as number) : 1;
  const limit = typeof input.limit === 'number' && input.limit > 0
    ? (input.limit as number)
    : undefined;
  if (existingState.offset !== offset || existingState.limit !== limit) {
    dlog('dedup.bail.range_mismatch', {
      entryOffset: existingState.offset,
      entryLimit: existingState.limit,
      offset,
      limit,
    });
    return null;
  }
  if (!hasVisiblePriorReadResult(ctx, resolvedPath, offset, limit, wsRoot)) {
    dlog('dedup.bail.no_visible_prior_result', { resolvedPath, offset, limit });
    return null;
  }
  return { existingState, offset, limit };
}

async function maybeReturnMtimeDedupStub(
  resolvedPath: string,
  existingState: TextReadDedupEntry,
): Promise<ToolResult | null> {
  try {
    const rawMtime = (await fsPromises.stat(resolvedPath)).mtimeMs;
    const mtimeMs = Math.floor(rawMtime);
    dlog('dedup.mtime_check', {
      rawStatMtimeMs: rawMtime,
      flooredMtimeMs: mtimeMs,
      entryTimestamp: existingState.timestamp,
      delta: mtimeMs - existingState.timestamp,
      equal: mtimeMs === existingState.timestamp,
    });
    if (mtimeMs === existingState.timestamp) {
      dlog('dedup.HIT_returning_stub', { resolvedPath, mtimeMs });
      return {
        content: FILE_UNCHANGED_STUB,
      };
    }
    dlog('dedup.bail.mtime_mismatch', {
      rawStatMtimeMs: rawMtime,
      flooredMtimeMs: mtimeMs,
      entryTimestamp: existingState.timestamp,
    });
  } catch (err) {
    dlog('dedup.bail.stat_failed', {
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    // Stat failed; fall through to the full read path so the real error is surfaced.
  }
  return null;
}

async function maybeReturnUnchangedReadStub(
  input: Record<string, unknown>,
  ctx: ToolContext,
  wsRoot: string,
  resolvedPath?: string,
): Promise<ToolResult | null> {
  const state = ctx.readFileState;
  if (!state || !resolvedPath) {
    dlog('dedup.entry.bail_no_state_or_path', {
      hasState: !!state,
      resolvedPath: resolvedPath ?? null,
    });
    return null;
  }
  const stateKey = canonicalizePath(resolvedPath, wsRoot);
  const existingState = state.get(stateKey);
  dlog('dedup.entry', {
    rawPath: typeof input.path === 'string' ? input.path : null,
    resolvedPath,
    wsRoot,
    stateKey,
    stateMapSize: state.size,
    stateMapKeys: Array.from(state.keys()),
    hasEntry: !!existingState,
    entryOffset: existingState?.offset ?? null,
    entryLimit: existingState?.limit ?? null,
    entryTimestamp: existingState?.timestamp ?? null,
    inputOffset: typeof input.offset === 'number' ? input.offset : 'absent',
    inputLimit: typeof input.limit === 'number' ? input.limit : 'absent',
    ctxMessagesLength: ctx.messages.length,
  });
  const match = getTextReadDedupMatch({
    input,
    existingState,
    resolvedPath,
    wsRoot,
    ctx,
  });
  return match ? await maybeReturnMtimeDedupStub(resolvedPath, match.existingState) : null;
}

/**
 * 检查 ctx.messages 历史里是否有"等价的 prior read_file 调用"（同 path /
 * 同 offset / 同 limit）—— 用于 dedup 入口决定要不要返回 FILE_UNCHANGED_STUB。
 *
 * **W2（2026-05-10）**：read_file result 改成多行明文后，再从 tool_result.content
 * 反解 JSON 字段不可行；改为扫 assistant.tool_use 块的 input —— LLM 发出
 * read_file 时入参里就有 path / offset / limit，比从工具输出反推更稳。
 *
 * 该函数主要服务 fork 子 Agent 场景：fork 时继承了 readFileState Map（mtime
 * + offset/limit + content），但 ctx.messages 是子 Agent 自己的新对话——子
 * Agent 看不到父 Agent 的"earlier Read tool_result"。这种情况下 dedup 不
 * 该 fire（让子 Agent 真读一次），所以这里走 visible 检查兜底。
 *
 * **canonical baseDir 一致性**：`resolvedPath` 由 caller 传入时已是 canonical
 * 绝对路径（`canonicalizePath(rawPath, wsRoot)` 出来的），所以本函数 canonical
 * 时不再传 baseDir 是 idempotent；但 LLM 在 input.path 里偶尔会传相对路径
 * （workspace 相对），此时必须用 `wsRoot` 做 baseDir 才能 canonical 出与
 * resolvedPath 一致的 key——否则 dedup 漏命中（typically 不致命，但拖慢
 * 长会话）。
 */
function hasVisiblePriorReadResult(
  ctx: ToolContext,
  resolvedPath: string,
  offset: number,
  limit: number | undefined,
  wsRoot: string,
): boolean {
  const canonical = canonicalizePath(resolvedPath, wsRoot);
  let inspected = 0;
  let toolUseBlocks = 0;
  let pathMismatches = 0;
  let rangeMismatches = 0;
  const result = ctx.messages.some((message) => {
    const content = Array.isArray(message.content) ? message.content : [];
    return content.some((block) => {
      inspected++;
      if (block.type !== 'tool_use' || block.name !== 'read_file') return false;
      toolUseBlocks++;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const inputPath = typeof input.path === 'string' ? input.path : undefined;
      if (!inputPath) return false;
      let inputCanonical: string;
      try {
        inputCanonical = canonicalizePath(inputPath, wsRoot);
      } catch {
        return false;
      }
      if (inputCanonical !== canonical) {
        pathMismatches++;
        dlog('dedup.visible.path_mismatch', {
          inputPath,
          inputCanonical,
          expectedCanonical: canonical,
        });
        return false;
      }
      const inputOffset = typeof input.offset === 'number' ? input.offset : 1;
      const inputLimit =
        typeof input.limit === 'number' && input.limit > 0
          ? (input.limit as number)
          : undefined;
      const matches = inputOffset === offset && inputLimit === limit;
      if (!matches) {
        rangeMismatches++;
        dlog('dedup.visible.range_mismatch', {
          inputOffset,
          inputLimit,
          expectedOffset: offset,
          expectedLimit: limit,
        });
      }
      return matches;
    });
  });
  dlog('dedup.visible.summary', {
    found: result,
    inspectedBlocks: inspected,
    toolUseBlocks,
    pathMismatches,
    rangeMismatches,
  });
  return result;
}

/**
 * read_file 文本路径的 ToolResult 构造——直接输出多行明文（cat -n compact，
 * 与 action-tools `data.content` 一致）；不再走 `JSON.stringify` 通用 envelope。
 *
 * **W2（2026-05-10）**：
 * - 正文：`data.content` 已经是 `1\\tcontent\\n2\\tcontent...` 格式（行号 +
 *   tab + 行内容），直接作为 ToolResult.content 返回。LLM 看到的是真实
 *   多行文本（`\\n` 是字面换行而不是 escape 后的 `\\n` 字面量），不会再误判
 *   "被截断 / 被压缩"。
 * - 空文件：用 `<system-reminder>` 包裹的 warning 替代正文。
 * - offset 超过总行数：同样走 `<system-reminder>`，提示用户 offset 太大。
 *
 * **不再注入"meta hint"段**：靠 LLM 看 description + 行号本身就能判断是否
 * 完整（最大行号 ≤ 文件总行数即是完整）。多余的 meta 段反而打破
 * "自然多行明文"的视觉。
 */
// **B3 (2026-05-12)** cyber risk reminder 文案
const CYBER_RISK_REMINDER =
  '<system-reminder>\nWhenever you read a file, you should consider ' +
  'whether it would be considered malware. You CAN and SHOULD provide ' +
  'analysis of malware, what it is doing. But you MUST refuse to improve ' +
  'or augment the code. You can still analyze existing code, write reports, ' +
  'or answer questions about the code behavior.\n</system-reminder>';

function isReadOffsetBeyondFile(args: {
  content: string;
  totalLines?: number;
  startLine: number;
}): boolean {
  const { content, totalLines, startLine } = args;
  return (
    content === '' &&
    typeof totalLines === 'number' &&
    totalLines > 0 &&
    startLine > totalLines
  );
}

function buildDefaultLimitReminder(args: {
  content: string;
  wasDefaultLimit: boolean;
  totalLines?: number;
  numLines?: number;
  startLine: number;
}): string | null {
  const { content, wasDefaultLimit, totalLines, numLines, startLine } = args;
  if (
    !wasDefaultLimit ||
    typeof totalLines !== 'number' ||
    typeof numLines !== 'number' ||
    numLines <= 0 ||
    startLine + numLines - 1 >= totalLines
  ) {
    return null;
  }
  const lastLine = startLine + numLines - 1;
  const reminder =
    `<system-reminder>This file has ${totalLines} total lines. ` +
    `You only read lines ${startLine}-${lastLine} (default limit). ` +
    `Use read_file(path, offset=${lastLine + 1}, limit=...) to continue ` +
    `reading the rest, or grep_search to locate specific content.</system-reminder>`;
  return `${content}\n\n${reminder}`;
}

function buildReadFileCharacterLimitReminder(nextOffset: number): string {
  return (
    `<system-reminder>read_file output was truncated at ${READ_FILE_MAX_RESULT_CHARS} characters. ` +
    `Continue with offset=${nextOffset} to read the next section.</system-reminder>`
  );
}

function joinReadFileOutput(content: string, suffix?: string): string {
  return suffix ? `${content}\n\n${suffix}` : content;
}

function truncateReadFileOutput(args: {
  content: string;
  startLine: number;
  suffix?: string;
}): string {
  const { content, startLine, suffix } = args;
  const completeOutput = joinReadFileOutput(content, suffix);
  if (completeOutput.length <= READ_FILE_MAX_RESULT_CHARS) return completeOutput;

  const lines = content.split('\n');
  const keptLines: string[] = [];
  let keptLength = 0;
  for (const line of lines) {
    const candidateLength = keptLength + (keptLines.length > 0 ? 1 : 0) + line.length;
    const nextOffset = startLine + keptLines.length + 1;
    const candidateSuffix = [buildReadFileCharacterLimitReminder(nextOffset), suffix]
      .filter(Boolean)
      .join('\n\n');
    const outputLength = candidateLength + 2 + candidateSuffix.length;
    if (outputLength > READ_FILE_MAX_RESULT_CHARS) break;
    keptLines.push(line);
    keptLength = candidateLength;
  }

  const nextOffset = startLine + keptLines.length;
  return joinReadFileOutput(
    keptLines.join('\n'),
    [buildReadFileCharacterLimitReminder(nextOffset), suffix].filter(Boolean).join('\n\n'),
  );
}

function buildTextReadToolResult(
  data: Record<string, unknown>,
  input?: Record<string, unknown>,
  options?: { enableCyberRiskReminder?: boolean },
): ToolResult {
  const content = typeof data.content === 'string' ? data.content : '';
  const startLine = typeof data.start_line === 'number' ? data.start_line : 1;
  const totalLines = typeof data.total_lines === 'number' ? data.total_lines : undefined;
  const numLines = typeof data.num_lines === 'number' ? data.num_lines : undefined;
  const isEmpty = data.empty === true;
  const wasDefaultLimit = input?._default_limit_injected === true;

  // **顺序敏感**（W2 R1，2026-05-10）：必须先判 "offset 越界"，再判 "empty"。
  //
  // action-tools `fileReadTool.execute`（`packages/action-tools/src/tools/tabcode/index.ts`
  // 的 `if (!raw) { ... empty: true ... }`）对**两种**场景都会设 `empty: true`：
  //   1. 真空文件（content='', totalLines=0）
  //   2. offset 越界（content='', totalLines=N, startLine=N+1, numLines=0）—— slice
  //      后 raw='' 同样进 `if (!raw)` 分支
  //
  // 旧版本两个 if 顺序反了：先看 `isEmpty` 直接命中 "empty" warning，让 LLM
  // 看到 "the contents are empty" 误判文件是空的，可能去 write_file 全文覆盖
  // 一个 50 行的文件——这是产品级风险。
  //
  // 调整后：第一个 if 专管 "shorter than offset"，命中就提前 return；第二个 if
  // 兜底真空文件。两个 `<system-reminder>` 分支：
  //   - totalLines === 0 → "the contents are empty"
  //   - totalLines > 0 但 offset 超出 → "shorter than the provided offset (X). The file has Y lines."
  if (isReadOffsetBeyondFile({ content, totalLines, startLine })) {
    return {
      content: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`,
    };
  }

  if (isEmpty || (content === '' && totalLines === 0)) {
    return {
      content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    };
  }

  // **W4 (2026-05-12)** 默认 limit 截断提示：
  //
  // 场景——LLM 不传 offset/limit，runtime 注入 DEFAULT_READ_FILE_LIMIT_LINES
  // (2000) 避免大文件爆 context；如果文件实际超过 2000 行，**LLM 看到的输出
  // 末行号 = 2000 跟"刚好 2000 行的小文件"输出形态完全一样**——LLM 没办法
  // 区分"读完了"和"只看到前一段"，事故复现概率高（dogfood：用户问"帮我看
  // ElectronAgentHost.ts" 这种 5000 行文件，Agent 漏后半段静默回答错答案）。
  //
  // 修法（B2 决策）：仅在"被默认 limit 截断"时（_default_limit_injected
  // && totalLines > startLine + numLines - 1）追加一行 `<system-reminder>`
  // 给 LLM 明确"我只看了 1-N，文件实际有 M 行，要 offset 续读"。正常读全文
  // 不加，token 友好。
  //
  // 文案覆盖 "shorter than offset" / "empty" 两类边界
  // 同款 `<system-reminder>` 形态，让 LLM 习得统一的"reminder 必读"模式。
  const defaultLimitContent = buildDefaultLimitReminder({
    content,
    wasDefaultLimit,
    totalLines,
    numLines,
    startLine,
  });
  const defaultLimitReminder = defaultLimitContent?.slice(content.length + 2);
  const suffix = [
    defaultLimitReminder,
    options?.enableCyberRiskReminder === true ? CYBER_RISK_REMINDER : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    content: truncateReadFileOutput({ content, startLine, suffix: suffix || undefined }),
  };
}

/**
 * read_file 文本路径成功后写 readFileState 快照，用于跨 turn
 * stale-read 校验。仅文本（`data.content` 是 string）才 record；
 * 非文本文件都不进 record；它们会先被 host fileMaterializer 转成文件引用。
 *
 * 真实 mtime 写入快照——而不是 Date.now() 兜底，避免后续 stale 检测
 * 把"刚 read 完的文件"误判为 stale（W1 第二轮 Review #3 A 项）。
 */
function getTextReadSnapshotRange(input: Record<string, unknown>): { offset: number; limit?: number } {
  const offset = typeof input.offset === 'number' ? (input.offset as number) : 1;
  // **W4 (2026-05-12)**：标记 `_default_limit_injected === true` 时归一化
  // limit 为 undefined ——record entry 反映"LLM 原始没传 limit"的语义，让
  // 下次 dedup 同款"LLM 不传 limit"调用能命中（input.limit === undefined
  // === existingState.limit === undefined）。否则 entry.limit=2000（注入值）
  // 跟新调用的 input.limit=undefined 永远错配，dedup 失效。
  const llmExpressedNoLimit =
    (input as Record<string, unknown>)._default_limit_injected === true;
  const limit = llmExpressedNoLimit
    ? undefined
    : typeof input.limit === 'number' && input.limit > 0
      ? (input.limit as number)
      : undefined;
  return { offset, limit };
}

async function statTextReadSnapshot(resolved: string): Promise<{
  mtimeMs?: number;
  rawStatMtimeMs?: number;
}> {
  let mtimeMs: number | undefined;
  let rawStatMtimeMs: number | undefined;
  try {
    rawStatMtimeMs = (await fsPromises.stat(resolved)).mtimeMs;
    mtimeMs = Math.floor(rawStatMtimeMs);
  } catch (err) {
    dlog('record.stat_failed', {
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      resolved,
    });
    // stat 失败（极少见，文件刚被删？）→ 退化为 Date.now()
  }
  return { mtimeMs, rawStatMtimeMs };
}

async function recordTextReadSnapshot(
  input: Record<string, unknown>,
  data: Record<string, unknown>,
  ctx: ToolContext,
  wsRoot: string,
): Promise<void> {
  const text = typeof data.content === 'string' ? data.content : undefined;
  if (text == null) return;
  // action-tools 解析后的绝对路径优先（已经过 realpath）；否则按入参绝对化
  const pathFromData = typeof data.path === 'string' ? data.path : undefined;
  const resolved = pathFromData
    ? canonicalizePath(pathFromData)
    : resolveInputPath(input, wsRoot);
  if (!resolved) return;

  const { offset, limit } = getTextReadSnapshotRange(input);
  const contentRaw = typeof data.contentRaw === 'string' ? data.contentRaw : undefined;
  const stripped = contentRaw ?? stripLineNumbers(text);

  const { mtimeMs, rawStatMtimeMs } = await statTextReadSnapshot(resolved);

  // record 路径关键参数 dump：方便对照下一次 dedup 时的 stateKey / offset / limit / mtimeMs
  // 注意：recordReadFileState 内部 key = canonicalizePath(resolved, baseDir=wsRoot)；
  // 而本函数算 resolved 时调用 canonicalizePath(pathFromData) **不传 baseDir**。
  // 两者通常一致（pathFromData 已是绝对路径），但相对路径场景有漂移可能（latent）。
  dlog('record.write_state', {
    pathFromData: typeof data.path === 'string' ? data.path : null,
    resolved,
    wsRoot,
    finalKey: canonicalizePath(resolved, wsRoot),
    inputOffset: typeof input.offset === 'number' ? input.offset : 'absent',
    inputLimit: typeof input.limit === 'number' ? input.limit : 'absent',
    recordedOffset: offset,
    recordedLimit: limit ?? null,
    rawStatMtimeMs,
    flooredMtimeMs: mtimeMs,
    contentBytes: stripped.length,
  });

  recordReadFileState(ctx, resolved, stripped, {
    mtimeMs,
    offset,
    limit,
    baseDir: wsRoot,
  });
}

/** 把 action-tools read_file 输出的 cat -n compact `1\tcontent` 形态剥成原内容。 */
function stripLineNumbers(numbered: string): string {
  return numbered
    .split('\n')
    .map((line) => {
      const compact = line.match(/^\d+\t(.*)$/);
      if (compact) {
        return compact[1];
      }
      const arrow = line.match(/^\s*\d+→(.*)$/);
      if (arrow) {
        return arrow[1];
      }
      // Back-compat for historical pipe-prefixed snapshots.
      const idx = line.indexOf('|');
      if (idx > 0 && /^\s*\d+$/.test(line.slice(0, idx))) {
        return line.slice(idx + 1);
      }
      return line;
    })
    .join('\n');
}

// ─── edit_file ───────────────────────────────────────────────────────
//
// **常量命名约定**：`EDIT_FILE_DESCRIPTION`（工具名大写 + `_DESCRIPTION`）
// —— prompt-contract eslint tool-description-length 据此反查 registry budget。

const EDIT_FILE_DESCRIPTION =
  // **W5 (2026-05-12)** — 三视角 reviewer 收尾后定稿：
  //
  // 描述哲学："沉默容错 + 显式警告写入字面"——runtime 在匹配阶段会兜
  // curly quote / tab-space round-trip（LLM API 跟 IDE 渲染层导致的失误），
  // 但**不告诉 LLM 这件事**避免诱导虚构；同时**明确警告 new_string 按字面
  // 写入**，避免 reviewer S1 的"tab 文件 + 空格 new_string → 混合缩进损坏代码"。
  //
  // PRD 维度 A 验收清单原本要求"明示 fuzzy 兜底"——经技术 / 用户 /
  // 产品三视角 review 后修订为"沉默兜底 + 显式警告"（description 完全
  // 不提任何 fuzzy 行为）。LLM 看完 description 心智模型是"我必须给真
  // 实文件内容"，遇 sanitize round-trip 偶尔会被 runtime 兜住。
  '在文件里做精确字符串替换。\n\n' +
  '用法：\n' +
  '- **强烈建议**：编辑前在同一对话里先用 read_file 读目标文件，这样 old_string 可以从读出的内容里逐字复制——避免凭印象写虚构 old_string 失败（OLD_STRING_NOT_FOUND）。\n' +
  '- 从 read_file 输出里取文本时，保留**行号前缀之后**的精确缩进（tab / 空格）。行号前缀格式是：行号 + tab（如 "14\\t"），之后才是实际文件内容。**不要**把行号前缀的任何部分塞进 old_string 或 new_string。\n' +
  '- **new_string 按字面写入文件**：runtime 不会自动调整你给的缩进风格 / 引号风格 / 行尾。Python / Go 等 tab 缩进项目里写 new_string 时**必须用 tab**——给 4 空格会让该行变成空格、其他行仍是 tab，混合缩进让代码无法运行。引号同理：保持文件原本的风格（ASCII vs curly）。\n' +
  '- **优先**编辑代码库里已有的文件。**不要**创建新文件，除非明确要求。\n' +
  '- 只在用户明确要求时才用 emoji。除非要求，否则不要给文件加 emoji。\n' +
  '- 如果 old_string 在文件里**不唯一**，编辑会失败。要么提供更大的字符串带更多上下文让它唯一，要么用 replace_all=true 替换所有出现。\n' +
  '- replace_all 用于替换 / 重命名跨文件的字符串。重命名变量时特别有用。**注意：replace_all 要求 old_string 跟文件内容字面完全一致**——遇到引号 / 缩进风格不确定时，先用 read_file 复制原样，不要靠 runtime 兜底匹配。\n' +
  '- old_string 和 new_string 必须不同。\n' +
  '- 编辑 `.md` / `.mdx` 文件时，trailing whitespace 有语义（双 trailing space = Markdown hard line break），保留原样不要主动删除。';

function createFileEditTool(deps: TabCodeToolsDeps): Tool {
  return adaptAgentTool(actionFileEditTool, {
    deps,
    isReadOnly: false,
    // **文件并发安全 Wave 1（2026-05-13）**：per-file 锁防 LLM streaming 多
    // tool_call / 多 Agent 同进程并发改同文件。锁键 = `resolveInputPath`
    // 解析后的绝对路径（已含 canonicalize / realpath）；path 缺失返 null
    // 让 beforeExecute 走 INVALID_PARAMETER 错误路径，不进锁。
    requiresFileLock: (input) => {
      const wsRoot = String(input._workspace_root || process.cwd());
      return resolveInputPath(input, wsRoot) ?? null;
    },
    // per-file 回退：备份编辑前内容（与 requiresFileLock 同样的路径解析）。
    tracksFileHistory: (input) => {
      const wsRoot = String(input._workspace_root || process.cwd());
      return resolveInputPath(input, wsRoot) ?? null;
    },
    llmDescription: EDIT_FILE_DESCRIPTION,
    maxResultSizeChars: 4_000,
    async beforeExecute({ input, ctx }) {
      const wsRoot = String(input._workspace_root || process.cwd());
      const resolved = resolveInputPath(input, wsRoot);
      if (!resolved) {
        return errorResultEnvelope({
          errorKind: INVALID_PARAM_FORMAT,
          message: "'path' is required and must be a non-empty string",
          suggestion: 'Provide an absolute path or a path relative to the working directory root (do not prefix with workspace/).',
          op: 'edit_file',
          context: { reason: 'missing_path' },
        });
      }
      // 短路：old_string === new_string 等价 no-op
      if (
        typeof input.old_string === 'string' &&
        typeof input.new_string === 'string' &&
        input.old_string === input.new_string
      ) {
        return errorResultEnvelope({
          errorKind: INVALID_PARAM_FORMAT,
          message: 'old_string and new_string are identical; no edit to apply.',
          suggestion: 'Provide different new_string, or skip the edit if no change is needed.',
          path: resolved,
          op: 'edit_file',
          context: { path: resolved, reason: 'identical_old_new' },
        });
      }
      // 空 old_string + 非空文件 = 语义不明确（覆写？prepend？）
      if (typeof input.old_string === 'string' && input.old_string.length === 0) {
        return errorResultEnvelope({
          errorKind: INVALID_PARAM_FORMAT,
          message: 'old_string must not be empty. To create a new file, use write_file instead.',
          suggestion: 'Provide the exact text you want to replace, or use write_file to create / overwrite the file.',
          path: resolved,
          op: 'edit_file',
          context: { path: resolved, reason: 'empty_old_string' },
        });
      }
      // edit_file 不负责"创建新文件"——文件不存在直接拒，引导 LLM 用 write_file。
      // 否则 action-tools `fileEditTool.execute` 第一件事是 `fsPromises.stat()`，
      // 文件不存在抛 ENOENT，LLM 看到原始 OS 错误更迷糊（W1 第一轮 Review #1
      // BUG-4 硬证据；PRD §5.1 case 9 的"old_string='' 创建空文件"语义被废）。
      //
      // **W4 Lane F 拆类（2026-05-10）**：旧实现走 OLD_STRING_NOT_FOUND
      // 反直觉。改走专门的 `file_not_found`，区分「文件不存在」与「字符串未命中」。
      let fileExists = false;
      try {
        await fsPromises.access(resolved);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      if (!fileExists) {
        return errorResultEnvelope({
          errorKind: FILE_NOT_FOUND,
          message: `File does not exist: ${resolved}`,
          suggestion:
            'edit_file only modifies existing files. Use write_file to create a new file.',
          path: resolved,
          op: 'edit_file',
          context: { path: resolved, reason: 'file_not_found' },
        });
      }
      return validateReadBeforeWrite(ctx, resolved, {
        fileExists,
        readToolName: 'read_file',
        baseDir: wsRoot,
      });
    },
    async afterExecute({ input, result, ctx }) {
      if (!result.success) return;
      const wsRoot = String(input._workspace_root || process.cwd());
      const data = (result.data ?? {}) as Record<string, unknown>;
      const fileFromData = typeof data.file === 'string' ? data.file : undefined;
      const resolved = fileFromData
        ? canonicalizePath(fileFromData)
        : resolveInputPath(input, wsRoot);
      if (!resolved) return;
      // 编辑后从磁盘重新读真实最新内容 + mtime，避免下一轮 edit 把 stale
      // snapshot 当 fresh 用，触发"刚改完又被 stale 拦"。await 阻塞 ToolResult
      // 直到 snapshot 刷新完成（典型场景文件较小，IO 几 ms 量级）。
      await refreshSnapshot(resolved, ctx, wsRoot);
    },
  });
}

/**
 * edit_file / write_file 完成后 refreshSnapshot —— 重读全文 + 真实 mtime
 * 写入 readFileState：
 *
 *   readFileState.set(absoluteFilePath, {
 *     content: updatedFile,
 *     timestamp: mtimeMs,
 *     offset: undefined,
 *     limit: undefined,
 *   })
 *
 * **W2（2026-05-10）**：本函数不传 `offset` / `limit`（隐式
 * `offset: undefined, limit: undefined`）—— readFileState entry 进入 "post-edit
 * full state"，下一次 read_file 入口的 dedup 会因 `existingState.offset ===
 * undefined` 早 return（避免把 pre-edit 的 dedup stub 还给 LLM）。
 *
 * **C8（2026-05-13）**：refreshSnapshot 末尾顺手发 LSP didChange + didSave
 * 通知，让 LSP server 异步算诊断：
 *   - 编辑后调 `clearDeliveredDiagnosticsForFile(path)` 清 LRU
 *   - `lspManager.changeFile(...).catch(...)` 不 await（fire-and-forget）
 *   - `lspManager.saveFile(...).catch(...)` 不 await
 *
 * LSP manager 未初始化（getLspServerManager() 返回 undefined）时静默 noop，
 * 不影响工具结果。
 */
async function refreshSnapshot(
  filePath: string,
  ctx: ToolContext,
  baseDir?: string,
): Promise<void> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    const stat = await fsPromises.stat(filePath);
    recordReadFileState(ctx, filePath, content, {
      // **L-12 修复（Wave 2 / 2026-05-13）**：跨路径 mtime 量化统一用
      // `Math.floor(stat.mtimeMs)` —— 跟 `recordTextReadSnapshot`（行 1432）+
      // `validateReadBeforeWriteSync`（read-file-state.ts）字面对齐统一。
      //
      // 旧实现用 `stat.mtimeMs` 原值会让「刚 edit/write 完写盘前 TOCTOU 二次
      // 校验」假阳性撞 stale —— record / refresh 写 raw 微秒，validate 拿
      // floored 毫秒比 `currentMtimeMs <= snapshot.timestamp + 1`，跨平台
      // stat 精度差异（macOS 微秒 vs Linux 毫秒）让 snapshot.timestamp 比
      // currentMtimeMs 大一点点，每次刚 refresh 完都被 -1ms 容忍兜不住。
      mtimeMs: Math.floor(stat.mtimeMs),
      // 显式不传 offset/limit —— 含义是"reset 为 full state，覆盖 pre-edit
      // 的 (offset, limit) 痕迹"。recordReadFileState 内部会写入 undefined。
      baseDir,
    });
    // C8：LSP 通知（fire-and-forget，不阻塞 ToolResult 返回）
    notifyLspAfterEdit(filePath, content);
  } catch {
    // refresh 失败：下一轮 edit / write 会再次触发 stale check —— LLM 拿到
    // 明确 error_kind 自行决定是否 re-read，比静默忽略更安全
  }
}

/**
 * C8：编辑文件后通知 LSP server，让它异步算新诊断。
 *
 * 时序：
 *   1. clearDeliveredDiagnosticsForFile(path) —— 清 delivered LRU，让
 *      下一轮 attachment 注入能再次看到这个文件的诊断（即使诊断内容跟之前
 *      五元组相同——因为我们刚编辑过它）
 *   2. lspManager.changeFile(path, content).catch(logError) —— 不 await
 *   3. lspManager.saveFile(path).catch(logError) —— 不 await
 *
 * **不 await**：LSP 通知是 fire-and-forget，tool result 不依赖诊断到达。
 * 诊断在未来某刻通过 publishDiagnostics 异步到达，下一轮 LLM 请求前由
 * attachment 系统取出注入（C9 实现）。
 *
 * 静默 noop 条件：
 *   - getLspServerManager() 返回 undefined（singleton 未初始化）
 *   - 该 server 不处理这个扩展名（manager 内部判断）
 *   - LSP 调用 catch 失败（仅 log，不向上传播）
 *
 * 这意味着 lsp-runtime 完全 opt-in：宿主（Electron / Daemon）显式调用
 * `initializeLspServerManager(loader)` 才生效，否则 agent-runtime 行为不变。
 */
function notifyLspAfterEdit(filePath: string, content: string): void {
  const lspManager = getLspServerManager();
  if (!lspManager) return; // singleton 未初始化（opt-in 模式），静默 noop

  // ⚠ URI key 必须跟 LSPDiagnosticRegistry / passiveFeedback 一致。
  // passiveFeedback.ts:75-77 把 LSP server 推回的 URI 经 fileURLToPath() 转成
  // OS plain path 才入 registry（pendingDiagnostics + deliveredDiagnostics LRU
  // 都用 plain path 作 key）。如果这里传 `file://${filePath}` 形式，clearDelivered
  // 永远 miss → 编辑后已交付过的同一条诊断不会再次推送给 LLM（致命 bug，此处修正）。
  try {
    clearDeliveredDiagnosticsForFile(filePath);
  } catch {
    // clearDelivered 失败不阻塞后续通知
  }

  // C12: 路由判断——LSP 有 server 处理这个扩展名？有走 LSP 主路径，没走
  // spawn linter fallback（W4 Lane F）。无 LSP server 时用 spawn linter 兜底
  // （例如装了 typescript-language-server 但没装 rust-analyzer 时，Rust 文件
  // 仍可通过项目里的 cargo / rustfmt 拿到诊断）
  const lspServer = lspManager.getServerForFile(filePath);
  if (lspServer) {
    // LSP 主路径：fire-and-forget didChange/didSave
    void lspManager.changeFile(filePath, content).catch(() => {});
    void lspManager.saveFile(filePath).catch(() => {});
    return;
  }

  // LSP 没 server 处理这个文件 → W4 Lane F spawn linter fallback
  // 不 await，避免阻塞 tool result。失败完全静默（最坏情况就是这一轮没诊断注入）
  void runSpawnLinterFallback(filePath).catch(() => {});
}

/**
 * Spawn linter fallback —— LSP 无 server 处理该语言时启用。
 *
 * 调 action-tools 的 readDiagnosticsTool（spawn eslint/tsc/ruff/flake8 等），
 * 把结果转成 LSP DiagnosticFile 格式入 LSPDiagnosticRegistry——这样下一轮
 * lsp-diagnostic-injector hook 取出注入时，LSP 主路径和 fallback 路径的
 * 诊断格式完全一致，hook 端无感知。
 *
 * 无 LSP server 时用 spawn linter 兜底（支持没 LSP server 的语言，如 Rust /
 * Go 走项目本地 cargo / golangci-lint）。
 *
 * **历史决策**：早期版本带 `linters_skipped` 协议（区分"linter 没装" vs
 * "linter 跑了无错"）。但三轮 review 后发现：
 *   1. 字段保留但无消费者（DiagnosticFile 类型无 lintersSkipped 字段，
 *      attachment hook 也不展示）
 *   2. 没接 telemetry 出口
 *   3. 等于纯死代码
 * 已删除字段解构，简化为：linter 没诊断就 return。
 */
async function runSpawnLinterFallback(filePath: string): Promise<void> {
  try {
    const result = await actionReadDiagnosticsTool.execute({
      paths: [filePath],
    } as Record<string, unknown> as never);
    if (!result.success) return;

    const data = (result.data ?? {}) as {
      diagnostics?: Array<{
        file: string;
        line: number;
        column: number;
        severity: 'error' | 'warning' | 'info';
        message: string;
        source: string;
      }>;
      linters_run?: string[];
    };

    const items = data.diagnostics ?? [];
    if (items.length === 0) {
      // 没诊断就是没诊断，跟 LSP 主路径行为一致：不推空消息
      return;
    }

    // 转 TabTin DiagnosticItem → LSP Diagnostic
    const lspDiagnostics: LspDiagnostic[] = items.map((d) => ({
      message: d.message,
      severity:
        d.severity === 'error'
          ? 'Error'
          : d.severity === 'warning'
            ? 'Warning'
            : 'Info',
      range: {
        // readDiagnosticsTool 输出是 1-based line/column；LSP 是 0-based
        start: {
          line: Math.max(0, d.line - 1),
          character: Math.max(0, d.column - 1),
        },
        end: {
          line: Math.max(0, d.line - 1),
          character: Math.max(0, d.column),
        },
      },
      source: d.source,
    }));

    registerPendingLSPDiagnostic({
      serverName: `fallback:${data.linters_run?.join(',') ?? 'spawn'}`,
      files: [{ uri: filePath, diagnostics: lspDiagnostics }],
    });
  } catch {
    // spawn linter 失败完全静默——保证不影响 tool result
  }
}

// ─── write_file ──────────────────────────────────────────────────────

const WRITE_FILE_DESCRIPTION =
  '把文件写入本地文件系统（文本 / 源码）。\n\n' +
  '用法：\n' +
  '- 路径上已有文件时会被覆盖。\n' +
  '- 写已有文件前**强烈建议**先了解当前内容。外部改动后可能以 `error_kind=tool_stale_read` 拒绝。\n' +
  '- 已有文件的小块变更用精确字符串替换；本工具用于**新建**或**整文件重写**。\n' +
  '- **不是** office/pdf/xlsx/docx/pptx 等二进制产物——勿用本工具写二进制 office/pdf。\n' +
  '- **不要**主动创建 *.md / README，除非用户明确要求。唯一例外：仅当为新建或整篇更新长 TabDoc 正文而需要临时 Markdown 草稿时，path **必须**是工作区相对路径 `.agent-drafts/<slug>.md`（不要写到工作区根如 `draft.md`）；随后用 `tabtin doc create|save-content --markdown @.agent-drafts/<slug>.md` 提交。该文件只用于可靠上传，不得作为用户交付物汇报。\n' +
  '- 除非用户要求，不要写 emoji。';

function createFileWriteTool(deps: TabCodeToolsDeps): Tool {
  return adaptAgentTool(actionFileWriteTool, {
    deps,
    isReadOnly: false,
    // **文件并发安全 Wave 1（2026-05-13）**：per-file 锁覆盖整文件覆写 +
    // append 两种语义。append=true 同样进锁——追加期间被外部并发覆盖会
    // 让"追加内容"丢失（OS read-modify-write 没有原子性保证），跟整文件
    // 覆写同款风险（PRD §A.1「append 也要锁」）。锁键 = resolveInputPath
    // 后绝对路径，path 缺失返 null 让 beforeExecute 走 INVALID_PARAMETER。
    requiresFileLock: (input) => {
      const wsRoot = String(input._workspace_root || process.cwd());
      return resolveInputPath(input, wsRoot) ?? null;
    },
    // per-file 回退：备份覆写/追加前内容（新建文件时记 absent，回退即删除）。
    tracksFileHistory: (input) => {
      const wsRoot = String(input._workspace_root || process.cwd());
      return resolveInputPath(input, wsRoot) ?? null;
    },
    llmDescription: WRITE_FILE_DESCRIPTION,
    maxResultSizeChars: 1_000,
    osErrorPath: (input) => (typeof input.path === 'string' ? input.path : undefined),
    async beforeExecute({ input, ctx }) {
      const wsRoot = String(input._workspace_root || process.cwd());
      const resolved = resolveInputPath(input, wsRoot);
      if (!resolved) {
        return errorResultEnvelope({
          errorKind: INVALID_PARAM_FORMAT,
          message: "'path' is required and must be a non-empty string",
          suggestion: 'Provide an absolute path or a path relative to the working directory root (do not prefix with workspace/).',
          op: 'write_file',
          context: { reason: 'missing_path' },
        });
      }
      let fileExists = false;
      try {
        await fsPromises.access(resolved);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      // append 模式（input.append=true）等同于追加，不属于"覆写"——跳过
      // read-before-write 检查。
      if (input.append === true) return null;
      return validateReadBeforeWrite(ctx, resolved, {
        fileExists,
        readToolName: 'read_file',
        baseDir: wsRoot,
      });
    },
    async afterExecute({ input, result, ctx }) {
      if (!result.success) return;
      const wsRoot = String(input._workspace_root || process.cwd());
      const data = (result.data ?? {}) as Record<string, unknown>;
      const fileFromData = typeof data.path === 'string' ? data.path : undefined;
      const resolved = fileFromData
        ? canonicalizePath(fileFromData)
        : resolveInputPath(input, wsRoot);
      if (!resolved) return;
      await refreshSnapshot(resolved, ctx, wsRoot);
    },
  });
}

// ─── delete_file ─────────────────────────────────────────────────────

function createFileDeleteTool(deps: TabCodeToolsDeps): Tool {
  return adaptAgentTool(actionFileDeleteTool, {
    deps,
    isReadOnly: false,
    llmDescription: FILE_DELETE_DESCRIPTION,
    maxResultSizeChars: 500,
    osErrorPath: (input) => (typeof input.path === 'string' ? input.path : undefined),
    // per-file 回退：删除前备份文件内容，回退时可恢复被删文件。
    tracksFileHistory: (input) => {
      const wsRoot = String(input._workspace_root || process.cwd());
      return resolveInputPath(input, wsRoot) ?? null;
    },
    async beforeExecute({ input }) {
      // path 必填校验提前到 adapter 层 —— action-tools `fileDeleteTool.execute`
      // 也会校验，但 adapter 提前命中可以走 errorResultEnvelope 的统一错误协议
      // （op + context 字段 + suggestion），跟 write_file / edit_file 同款。
      const wsRoot = String(input._workspace_root || process.cwd());
      const resolved = resolveInputPath(input, wsRoot);
      if (!resolved) {
        return errorResultEnvelope({
          errorKind: INVALID_PARAM_FORMAT,
          message: "'path' is required and must be a non-empty string",
          suggestion: 'Provide an absolute path or a path relative to the working directory root (do not prefix with workspace/).',
          op: 'delete_file',
          context: { reason: 'missing_path' },
        });
      }
      return null;
    },
    afterExecute({ input, result, ctx }) {
      if (!result.success) return;
      const wsRoot = String(input._workspace_root || process.cwd());
      const resolved = resolveInputPath(input, wsRoot);
      if (resolved) clearReadFileState(ctx, resolved, { baseDir: wsRoot });
    },
  });
}

// ─── grep_search ───────────────────────────────────────────────────────

const CODE_GREP_DEFAULT_HEAD_LIMIT = 250;
const CODE_GREP_MAX_HEAD_LIMIT = 2000;

/**
 * T2-C5 (2026-05-12)：把 ripgrep 输出里的绝对路径转成相对 wsRoot 的相对路径。
 *
 * **目的**：大仓库 ripgrep 输出每行多带 50-100 字节的绝对路径前缀，250 个匹配
 * 累计 12-25KB token 浪费——直接砍掉绝对路径节省 LLM context。
 *
 * **设计核心**：仅对 POSIX 风格绝对路径（line 以 `/` 开头）+ wsRoot 同样是
 * POSIX 时启用。**不处理 Windows 路径**——Windows 输出格式 `C:\foo:5:bar` 里
 * 盘符冒号跟 ripgrep `:N:` 行号冒号边界冲突，risk-vs-reward 不划算
 * （见 `applyHeadLimit-windows-path.test.ts` L-12 audit 已钉死 Windows 行为）。
 *
 * **算法**：
 *   - 跳过空行（preserve `\n`）
 *   - 跳过非 `/` 开头的行（已是相对路径 / 截断 marker / context 上下文行）
 *   - 找第一个 `:` 作为 path/rest 边界（POSIX 路径本身不含 `:`）
 *   - path 不是 wsRoot 子路径时保持原样（如 `/etc/foo.conf` 在 grep 跨 wsRoot 边界场景）
 */
/**
 * T2 follow-up B3 (2026-05-12)：files_with_matches 模式按 mtime 倒序 + filename
 * tiebreak（`Promise.allSettled(stats)` 并发 + `mtimeMs` 倒序 + filename tiebreak）。
 *
 * **场景**：用户问"最近改的 React 组件用了 useState 的有哪些"——按 mtime 排可把
 * 最近改动的文件顶到前面；默认 ripgrep 目录遍历顺序（按字母排）让 LLM 自己挑。
 * 本函数：先 stat 再 mtime 排序，字母 tiebreak。
 * `process.env.NODE_ENV === 'test'` 时只按 filename 排（保证测试稳定）。
 *
 * **路径解析**：raw 路径已经 relativize 过（行 1817），是相对 wsRoot 的相对路径；
 * stat 时拼回绝对路径。`Promise.allSettled` 让单个 ENOENT（grep 扫到→stat 之间文件被删）
 * 不破整批；失败 entry 当 mtime=0 排到末尾。
 */
async function sortFilenamesByMtime(
  filenames: string[],
  wsRoot: string,
): Promise<string[]> {
  if (filenames.length === 0) return filenames;
  if (process.env.NODE_ENV === 'test') {
    return [...filenames].sort((a, b) => a.localeCompare(b));
  }
  const stats = await Promise.allSettled(
    filenames.map(async (rel) => {
      const abs = wsRoot && rel.startsWith('/') === false ? `${wsRoot}/${rel}` : rel;
      const s = await fsPromises.stat(abs);
      return s.mtimeMs ?? 0;
    }),
  );
  return filenames
    .map((file, i) => {
      const r = stats[i]!;
      return [file, r.status === 'fulfilled' ? r.value : 0] as const;
    })
    .sort((a, b) => {
      const timeDiff = b[1] - a[1];
      if (timeDiff === 0) return a[0].localeCompare(b[0]);
      return timeDiff;
    })
    .map((entry) => entry[0]);
}

function relativizeRipgrepOutputPaths(raw: string, wsRoot: string): string {
  if (!raw || !wsRoot.startsWith('/')) return raw;
  const wsRootWithSep = wsRoot.endsWith('/') ? wsRoot : wsRoot + '/';
  const lines = raw.split('\n');
  const relativized = lines.map((line) => {
    if (!line || !line.startsWith('/')) return line;
    const colonIdx = line.indexOf(':');
    const filePath = colonIdx > 0 ? line.substring(0, colonIdx) : line;
    if (!filePath.startsWith(wsRootWithSep)) return line;
    const rel = filePath.substring(wsRootWithSep.length);
    return colonIdx > 0 ? rel + line.substring(colonIdx) : rel;
  });
  return relativized.join('\n');
}

interface GrepPaging {
  headLimit: number;
  offset: number;
}

function normalizeGrepPaging(input: Record<string, unknown>): GrepPaging {
  // T2-L1 (reviewer 反馈)：Number.isFinite 防 NaN——`typeof NaN === 'number'`
  // 为 true，原代码 Math.max(1, NaN) = NaN，clamp 链整体 NaN 化导致输出空数组
  // + 显示 truncated。schema 是 number 类型 LLM 漏传 NaN 概率低，加防御零成本。
  const rawGrepLimit = input.head_limit;
  const headLimit = typeof rawGrepLimit === 'number' && Number.isFinite(rawGrepLimit)
    ? Math.min(CODE_GREP_MAX_HEAD_LIMIT, Math.max(1, rawGrepLimit))
    : CODE_GREP_DEFAULT_HEAD_LIMIT;
  const rawGrepOffset = input.offset;
  const offset = typeof rawGrepOffset === 'number' && Number.isFinite(rawGrepOffset)
    ? Math.max(0, rawGrepOffset)
    : 0;
  return { headLimit, offset };
}

function ensureGrepOutputMode(input: Record<string, unknown>): string {
  // W4 Lane F：默认 output_mode = `'files_with_matches'`。让 LLM 漏传
  // output_mode 时拿到文件名列表而不是动辄 100KB 的 content 模式输出，先决定再细查。
  // **覆盖风险**：传 `output_mode: 'content'` 显式调用方不受影响。
  if (input.output_mode === undefined) {
    input.output_mode = 'files_with_matches';
  }
  return input.output_mode as string;
}

async function sortGrepRawForLimit(
  raw: string,
  outputMode: string,
  wsRootForRelativize: string,
): Promise<string> {
  // T2 follow-up B3 (2026-05-12)：files_with_matches 模式按 mtime 倒序。
  // **为什么排在 applyHeadLimit 之前**：先排序，再切片（"按 mtime 排序后取前 N 个"）。
  // 这保证 `head_limit=10` 时拿到的是"最近 10 个改的"而不是"按字母前 10 个"。
  // **不影响 content/count 模式**：那两个模式输出是 `path:N:content` / `path:N`，
  // 同一文件出现多行——按 mtime 重排会破坏 ripgrep 的同文件聚合输出。
  if (outputMode !== 'files_with_matches' || !raw.trim()) return raw;
  const filenames = raw.split('\n').filter(Boolean);
  const sorted = await sortFilenamesByMtime(filenames, wsRootForRelativize);
  return sorted.join('\n');
}

function emptyGrepOutputText(outputMode: string): string {
  if (outputMode === 'content') return 'No matches found.';
  if (outputMode === 'count') {
    // T2-M3 (reviewer 反馈)：count 模式 0 匹配先输出 "No matches found"
    // 再追加 summary，给 LLM 双重信号
    return 'No matches found.\n\nFound 0 total occurrences across 0 files.';
  }
  return 'No files found.';
}

function addFilesWithMatchesSummary(args: {
  finalText: string;
  outputMode: string;
  totalMatches?: number;
  headLimit: number;
  offset: number;
}): string {
  const { finalText, outputMode, totalMatches, headLimit, offset } = args;
  if (outputMode !== 'files_with_matches' || finalText === '(no matches in this page)') {
    return finalText;
  }
  // T2 follow-up B3 (2026-05-12)：非 0 匹配时加 `Found N files` 汇总头
  // （`Found ${numFiles} files (limit: ${headLimit})\n${list}`）——
  // LLM 一眼看清"找了多少 / 截了没截 / 列出哪些"。
  // 截断时跟 applyHeadLimit 自带的 truncate 文案叠加，给三段信号：
  //   `Found N files (limit: 250)\n<list>\n... truncated (showing 250 of N, ...)`
  const totalForSummary =
    totalMatches !== undefined
      ? totalMatches
      : finalText.split('\n').filter((l) => !l.startsWith('... truncated') && l).length;
  const fileWord = totalForSummary === 1 ? 'file' : 'files';
  const limitInfo =
    totalMatches !== undefined
      ? ` (limit: ${headLimit}, offset: ${offset})`
      : '';
  return `Found ${totalForSummary} ${fileWord}${limitInfo}\n${finalText}`;
}

function formatGrepOutputText(args: {
  truncated: { text: string; totalMatches?: number };
  outputMode: string;
  headLimit: number;
  offset: number;
}): string {
  const { truncated, outputMode, headLimit, offset } = args;
  if (!truncated.text.trim()) return emptyGrepOutputText(outputMode);
  return addFilesWithMatchesSummary({
    finalText: truncated.text,
    outputMode,
    totalMatches: truncated.totalMatches,
    headLimit,
    offset,
  });
}

const GREP_SEARCH_DESCRIPTION =
  '按 regex 在工作目录文件**内容**中搜索。' +
  '**用途**：单 pattern 的精确文本 / 正则定位。' +
  '**不是**：按文件名模式找文件（用 glob_search）；Agent 长期记忆。' +
  '批量多 pattern / 管道组合过滤可在终端一条命令完成（受限只读模式仅放行白名单内只读复合命令；不在白名单时仍用本工具分次搜索）。' +
  '默认 output_mode="files_with_matches"；看匹配行传 "content"。' +
  '默认情况下 pattern 只在单行内匹配；跨行传 multiline:true。字面量花括号需 escape（如 `interface\\{\\}`）。' +
  '大结果用 head_limit + offset 翻页；开放式探索交给 agent 工具。';

const GREP_OUTPUT_MODE_DESCRIPTION =
  '输出模式。默认 `files_with_matches`，只返回命中文件路径；' +
  '`content` 返回文件路径、行号和命中行内容；' +
  '`count` 只返回每个文件的匹配次数。需要查看命中行文本时必须传 `content`。';

function createCodeGrepTool(deps: TabCodeToolsDeps): Tool {
  const base = actionCodeGrepTool;
  const schema = { ...base.parameters } as Record<string, unknown>;
  const props = { ...(schema.properties as Record<string, unknown>) };
  props.output_mode = {
    ...(props.output_mode as Record<string, unknown>),
    description: GREP_OUTPUT_MODE_DESCRIPTION,
  };
  props.head_limit = {
    type: 'number',
    description:
      // 阶段 6.6 议题 3 翻译。
      '返回的最大匹配数（全局上限，默认 250）。与 `max_results`（ripgrep `-m` 的单文件上限）不同，本字段截断合并后的总输出。',
  };
  props.offset = {
    type: 'number',
    description: '分页跳过前 N 个匹配。和 head_limit 配合用。',
  };
  schema.properties = props;
  // Wave3：关闭未知键，避免拼写参数静默泄漏；内部 `_workspace_root` 在
  // execute 内注入，不经 schema 校验路径。
  schema.additionalProperties = false;

  return {
    name: base.name,
    description: GREP_SEARCH_DESCRIPTION,
    inputSchema: schema as Tool['inputSchema'],
    isReadOnly: true,
    // L-23：grep hit 直接复述匹配文件 N 行内容到 LLM 上下文——这些
    // 内容来自 workspace 文件（含第三方代码 / README），跟 read_file
    // 同等的 prompt-injection 暴露面。**W3 后 fence 不再包本机工具**
    // （见 tool-output-sanitizer.ts W3 file header）；`disablePreStart: true`
    // 保留服务 query.ts pre-start 决策（grep 命中可能很大，不走 pre-start
    // 让 permission 链路兜底）。
    disablePreStart: true,
    concurrencySafe: true,
    policyActionKind: 'file',
    maxResultSizeChars: 20_000,
    async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = enrichWithWorkspaceRoot(rawInput, ctx, deps);
      const { headLimit, offset } = normalizeGrepPaging(input);
      const outputMode = ensureGrepOutputMode(input);

      // T2-C5 + T2-M2 (2026-05-12 reviewer 反馈)：抓 wsRoot 给 relativize 用，**跳过
      // input._workspace_root**——直接走 ctx.workspaceRoot / deps.workspaceRoot()。
      //
      // **为什么不读 input._workspace_root**：enrichWithWorkspaceRoot 对 _workspace_root
      // 的处理跟 _allowed_paths / _already_judged 等其他下划线字段不同——LLM 传的非空
      // 值会被保留（保留 "显式 _workspace_root 入参覆盖 ctx" 的现有契约，见 tabcode-
      // adapter.test.ts:1589-1607）。这意味着 LLM 可以用伪造 `_workspace_root: "/"`
      // 让 relativize 从根盘符砍前缀，把系统文件路径"看起来像"项目内文件。
      //
      // **影响**：不引入新越权能力（action 层 hardline / _allowed_paths boundary 仍
      // 强制覆盖），但加深 obfuscation——LLM 看到的 relative path 跟用户感知的 wsRoot
      // 不一致。绕过 input.* 直接读 ctx 是最便宜的彻底防伪造（零回归）。
      const wsRootForRelativize =
        ctx.workspaceRoot || deps.workspaceRoot?.() || '';

      delete input.head_limit;
      delete input.offset;

      const result = await (base as AgentTool).execute(input);
      if (!result.success) return actionResultToToolResult(result);

      const data = (result.data ?? {}) as Record<string, unknown>;
      const rawWithAbsPaths = typeof data.output === 'string' ? data.output : '';

      // T2-C5 (2026-05-12)：relativize 在 applyHeadLimit 之前——applyHeadLimit
      // 用 `/^(.*):(\d+):/` 匹配 ripgrep match 行的边界，path 长短不影响 regex 命中
      // （Windows 路径已由 relativize 函数主动跳过，applyHeadLimit-windows-path.test.ts
      // 钉死的行为不会破）。
      const raw = relativizeRipgrepOutputPaths(rawWithAbsPaths, wsRootForRelativize);

      const rawForLimit = await sortGrepRawForLimit(raw, outputMode, wsRootForRelativize);
      const truncated = applyHeadLimit(rawForLimit, headLimit, offset, outputMode);

      // T2-C1 (2026-05-12)：0 匹配按 output_mode 给清晰文案。
      //
      // **背景**：原行为 `output: ""` 空字符串—— c39cd8b2 事故现场（version 29）
      // LLM 看到空 output 靠"自行推断没匹配"。本次推对了，下次未必：尤其当 LLM 用
      // 复杂 pattern 时，空 output 跟"工具坏了"难以区分。
      //
      // **三种 mode 文案**：
      //   - content：`No matches found.`
      //   - count：`Found 0 total occurrences across 0 files.`
      //   - files_with_matches：`No files found.`
      //
      // **applyHeadLimit 的"(no matches in this page)"** 是 offset 越界场景，**保留不动**
      // ——它表达"分页越界"而非"0 匹配"，跟本分支语义不冲突。
      const finalText = formatGrepOutputText({ truncated, outputMode, headLimit, offset });

      return {
        content: JSON.stringify({
          success: true,
          output: finalText,
          ...(truncated.totalMatches !== undefined
            ? { total_matches: truncated.totalMatches, head_limit: headLimit, offset }
            : {}),
        }),
      };
    },
  };
}

/**
 * @internal
 *
 * grep_search 输出截断 / 分页的纯函数。导出仅供测试钉死边界（L-12 audit）。
 *
 * **设计核心**：判定"这一行是不是 ripgrep match 行"靠 `rgLinePattern.test()`，
 * **不**提取 path / line 子组。这意味着即便贪婪 `(.*)` 对 Windows 路径
 * `C:\Users\123\foo:5:x` 选了"错"的 `:数字:` 边界，**整行依然算 1 个匹配**——
 * head_limit 计数仍然正确（详见 L-12 audit 与 `applyHeadLimit-windows-path.test.ts`）。
 *
 * 行号信息在调用方不需要：分页只关心"匹配行数"和"匹配行所在 lines[i] 索引"。
 */
export function applyHeadLimit(
  raw: string,
  headLimit: number,
  offset: number,
  outputMode: string,
): { text: string; totalMatches?: number } {
  if (!raw) return { text: '' };

  if (outputMode === 'content') {
    const lines = raw.split('\n');
    const matchLines: number[] = [];
    // rg --no-heading --line-number 两种输出形态：
    //   1. **多文件搜索**（path 是目录或 ripgrep 自动加 path 前缀）：
    //      `path:lineNo:content` —— 用 `^(.*):(\d+):/` 匹配（贪婪 (.*) 跳过路径段）
    //      Windows 路径 `C:\Users\...:42:bar` 也走这条
    //   2. **单文件搜索**（path 是文件，ripgrep 默认省略 path 前缀）：
    //      `lineNo:content` —— 多文件 regex 匹不上，需 `^(\d+):/` 兜底
    //      （T2-M11 reviewer 反馈：c39cd8b2 LLM 实际传单文件路径，PRD §十 第 9 条修复）
    //
    // 跳过判断：先试多文件（更紧的 regex），fallback 单文件——保证两种形态下
    // matchLines 都正确填充，分页 / 截断信号准确。`--context` 上下文行
    // （`path:N-content` 用 `-` 分隔 / `N-content` 单文件 context）两种 regex 都不命中。
    const rgLinePatternMulti = /^(.*):(\d+):/;
    const rgLinePatternSingle = /^(\d+):/;
    for (let i = 0; i < lines.length; i++) {
      if (rgLinePatternMulti.test(lines[i]) || rgLinePatternSingle.test(lines[i])) {
        matchLines.push(i);
      }
    }
    const total = matchLines.length;
    if (total <= offset) return { text: '(no matches in this page)', totalMatches: total };

    const startIdx = matchLines[offset];
    const endMatchIdx = Math.min(offset + headLimit, total);
    const endIdx = endMatchIdx < total ? matchLines[endMatchIdx] : lines.length;
    const sliced = lines.slice(startIdx, endIdx).join('\n');
    if (endMatchIdx < total) {
      return {
        text: sliced + `\n\n... truncated (showing ${headLimit} of at least ${total} matches, offset=${offset}). Use offset=${endMatchIdx} for next page.`,
        totalMatches: total,
      };
    }
    return { text: sliced, totalMatches: total > headLimit + offset ? total : undefined };
  }

  const entries = raw.split('\n').filter(Boolean);
  const total = entries.length;
  if (total <= offset) return { text: '(no matches in this page)', totalMatches: total };
  const sliced = entries.slice(offset, offset + headLimit);
  if (offset + headLimit < total) {
    // T2 final R1/R2 (MED-A1)：files_with_matches / count 模式截断文案补 `Use offset=N for next page`
    // 续读提示，跟 content 模式（行 1841 已有）+ description 承诺 "超出时附 offset 续读提示"
    // 字面对齐。原文案 `(${headLimit} of ${total}, offset=${offset})` 缺下一页 offset →
    // LLM 看到截断要自己算 offset+headLimit，违反 description 承诺。
    return {
      text:
        sliced.join('\n') +
        `\n\n... truncated (showing ${headLimit} of ${total}, offset=${offset}). ` +
        `Use offset=${offset + headLimit} for next page.`,
      totalMatches: total,
    };
  }
  return { text: sliced.join('\n') };
}

// ─── glob_search ───────────────────────────────────────────────────────

// **2026-05-13 重做**：4.5 时代 adapter 把 `head_limit` 暴露给 LLM、默认 100
// 但可调到 1000、还开 `head_limit=0=unlimited` escape hatch——这是误设计。
// 任何"LLM 可控的结果上限"字段都会诱导漏传或大胆传，把几千个文件路径灌
// 进 context；同时复杂的 clamp 链路（NaN 防御、unlimited 分支、stripped 字段）
// 完全是为了一个本不该存在的旋钮。
//
// 新设计（LLM 看不到结果上限旋钮）：
//   - LLM schema 只暴露 `glob_pattern` + `target_directory` 两个参数
//   - 硬上限 100，对 LLM 完全不可见也不可调
//   - 测试 / 极端 SDK 集成方通过 `TabCodeToolsDeps.globHeadLimit` 注入覆盖
//   - CLI 路径（`tabtin code glob --head-limit / --include-ignored`）经
//     action-tools 入参单独支持——CLI/FC schema 与默认值解耦是核心动机
//
// **保留**：mtime 倒序（最新在前）、JSON envelope 输出形态、`No files found.`
// 0 匹配文案。这些都不是 4.5 的烂账，是合理设计。
//
// 注：避免 jsdoc `/* ... */` 边界与 markdown `**\/*` glob 冲突，本注释用 `//` 块。

/** glob_search FC 路径硬上限。CLI 路径不受本常量约束。 */
const GLOB_HEAD_LIMIT = 100;

const GLOB_SEARCH_DESCRIPTION =
  '按 glob 模式找工作目录里的文件（如 "**/*.ts"、"src/**/*.{ts,tsx}"）。' +
  '按修改时间倒序返回路径，默认尊重 .gitignore，排除 node_modules / .git 等。' +
  '**用途**：已知文件名模式时定位文件。' +
  '**不是**：按文件内容 regex 搜索（用 grep_search）；shell `find`；绝不用递归 list_directory 代替搜索。' +
  '开放式探索交给 agent 工具。';

function createCodeGlobTool(deps: TabCodeToolsDeps): Tool {
  const base = actionCodeGlobTool;

  // LLM 看到的 schema 重写为只含两个参数。
  //
  // **为什么不直接 reuse `base.parameters`**：action-tools 的
  // `codeGlobTool.parameters` 还含 `include_ignored` 给 CLI 端用
  // （`tabtin code glob --include-ignored`）。FC 路径下 LLM 不应该感知
  // 这个旋钮——任何"绕过 .gitignore"的暗示都会诱导 LLM 在搜不到时
  // 试图打开 ignore。adapter 主动屏蔽，让 LLM schema 与 CLI 入参解耦。
  const llmInputSchema = {
    type: 'object',
    properties: {
      glob_pattern: {
        type: 'string',
        description: '通配符模式（譬如 `**/*.ts` / `src/**/*.{ts,tsx}` / `src/**/test_*.py`）。',
      },
      target_directory: {
        type: 'string',
        description: '搜索目录（相对工作目录根或绝对路径）。省略时搜整个工作目录。',
      },
    },
    required: ['glob_pattern'],
  } as unknown as Tool['inputSchema'];

  return {
    name: base.name,
    description: GLOB_SEARCH_DESCRIPTION,
    inputSchema: llmInputSchema,
    isReadOnly: true,
    // L-23：返回的文件路径串本身可能携带攻击者控制的目录名（极端但
    // 可能：clone 的恶意仓库存"<system>恶意指令</system>.md"作为文件
    // 名）。**W3 后 fence 不再包本机工具**——路径列表直接明文给 LLM；
    // `disablePreStart: true` 保留服务 pre-start 决策。
    disablePreStart: true,
    concurrencySafe: true,
    policyActionKind: 'file',
    maxResultSizeChars: 100_000,
    async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = enrichWithWorkspaceRoot(rawInput, ctx, deps);

      // **关键防御**：LLM 看不到 head_limit / include_ignored 字段，但
      // 不能假设它不会"创造性地"传——通过 JSON 输入字面注入任何字段
      // 都会穿透到 action-tools。delete 是 belt-and-suspenders 保险。
      delete input.head_limit;
      delete input.include_ignored;

      const result = await (base as AgentTool).execute(input);
      if (!result.success) return actionResultToToolResult(result);

      const data = (result.data ?? {}) as { files?: unknown };
      const files = Array.isArray(data.files)
        ? (data.files as unknown[]).filter((f): f is string => typeof f === 'string')
        : [];

      // 0 匹配：固定 3 词文案 `No files found.`。
      // 故意不附加"试试更宽松的 pattern"之类的引导——LLM 有能力自行推理
      // "0 ≠ 没有"，多余的引导是噪音。
      if (files.length === 0) {
        return {
          content: JSON.stringify({ success: true, output: 'No files found.' }),
        };
      }

      // headLimit 来源优先级：deps 注入（测试 / 极端 SDK）→ 硬默认 100。
      // **LLM 入参完全不参与**——这是这次重做的核心。
      const headLimit = typeof deps.globHeadLimit === 'number' && deps.globHeadLimit > 0
        ? deps.globHeadLimit
        : GLOB_HEAD_LIMIT;
      const truncated = files.length > headLimit;
      const sliced = truncated ? files.slice(0, headLimit) : files;

      // 截断文案——前缀 `(Results are truncated` 必须保留，前端
      // `CodeSearchCard.tsx::isTruncationNoticeLine` 和 `fileToolCards.ts`
      // 用这个前缀把截断说明行从"路径行"里识别出来，避免被当成 1 条匹配。
      // grep 截断文案同前缀，统一识别。
      //
      // 引导 LLM 用更具体的 pattern；加上"M+ files"显式提示总数，
      // 让 LLM 明确知道被砍了多少。
      let outputText = sliced.join('\n');
      if (truncated) {
        outputText +=
          `\n\n(Results are truncated: showing first ${headLimit} of ${files.length}+ files. ` +
          `Use a more specific pattern.)`;
      }

      // envelope 字段瘦身：
      //   - 删 `head_limit` —— 4.5 时代回显是因为 LLM 传过这个字段；现在 LLM
      //     根本不传，回显就是噪音（前端 fileToolCards 也没消费这个字段）
      //   - 保留 `total_files` —— 前端 CodeSearchCard 用它显示总数
      //   - 保留 `truncated:true`（条件） —— telemetry 价值
      return {
        content: JSON.stringify({
          success: true,
          output: outputText,
          total_files: files.length,
          ...(truncated ? { truncated: true } : {}),
        }),
      };
    },
  };
}

// ─── diagnostics fallback（不进入 LLM tools[]）────────────────────────
//
// 输出形态：`{ file, line, col, rule, severity, message }` 结构化诊断条目。
// 本包装器仅给 runtime 内部 fallback 复用，不再作为 LLM 可见工具注册。
//
// 仅供内部 fallback；不进入 createTabCodeTools，因此不会暴露给 LLM。
// 仍要求 llmDescription：与 adaptAgentTool 契约一致，但不进入 LLM tools[]。
const READ_LINTS_INTERNAL_DESCRIPTION =
  '读工作目录文件的 linter / 类型检查诊断（ESLint / tsc / ruff / flake8）。' +
  '**只在**你编辑过或将要编辑的文件上调；不要用太大的 scope。';

function createReadDiagnosticsTool(deps: TabCodeToolsDeps): Tool {
  return adaptAgentTool(actionReadDiagnosticsTool, {
    deps,
    isReadOnly: true,
    concurrencySafe: true,
    policyActionKind: 'file',
    llmDescription: READ_LINTS_INTERNAL_DESCRIPTION,
    maxResultSizeChars: 30_000,
  });
}
