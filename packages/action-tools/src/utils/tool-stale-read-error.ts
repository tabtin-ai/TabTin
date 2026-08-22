/**
 * ToolStaleReadError — Wave 2 跨包 TOCTOU 校验错误信号（2026-05-13）
 *
 * **触发场景**：fileEditTool / fileWriteTool 在写盘前最后一刻通过 input 内部协议
 * 字段 `_validate_before_write`（由 agent-runtime tabcode-adapter 注入）做
 * 二次 stale-read 校验时，发现 readFileState 跟磁盘 mtime/content 不一致 ——
 * adapter 注入的 hook 同步 throw 本错误，让 action-tools 一侧的 fileEditTool /
 * fileWriteTool catch 后转成跟入口校验「字节一致」的 envelope return 给 Agent。
 *
 * **为什么用类而不是普通 Error**：让 action-tools 一侧能 `instanceof` 精确识别
 * （而不是靠 message phrase 匹配），避免错误被外层 catch 误归为 unknown_error。
 *
 * **跨包传递路径**：
 *   - 定义点：本文件（action-tools/utils） — 被 agent-runtime 反向 import
 *   - throw 点：agent-runtime/tools/tabcode-adapter.ts `enrichWithWorkspaceRoot`
 *     注入的 `_validate_before_write` hook 内（同步 throw，临界区不变量）
 *   - catch 点：action-tools/tools/tabcode/index.ts 内 fileEditTool /
 *     fileWriteTool execute 写盘前的 try/catch（紧挨 atomicWriteFile 上方）
 *
 * **跟入口校验文案字节一致**（基线 B5-1）：
 *   - errorKind = `tool_stale_read`（Wave 3：不再携带 numeric TabcodeErrorCode）
 *   - message  = `File has been modified externally since you last read it (${canonical}). Your snapshot is stale.`
 *   - suggestion = `Re-read the file with read_file to refresh the in-memory snapshot, then retry.`
 *   - path = canonical 路径
 *
 * 调用方拿到错误后构造 `standardizeLegacyResult({ success: false, error:
 * err.message, error_code: ToolErrorCode.STALE_READ })` 即可 —— adapter 一侧
 * `mapActionErrorToRuntimeKind` 通过 `code === 'stale_read'` 显式 case 映射回
 * `tool_stale_read` + 同款 hint 文案，字节级一致到 LLM 看见的 envelope。
 *
 * **architecture note**：放在 `packages/action-tools/src/utils/` 是因为 action-tools
 * 不能反向依赖 agent-runtime；agent-runtime 一侧通过 `@tabtin/action-tools/headless`
 * import 本类。跟 file-lock.ts / canonical-path.ts 同模块位置（Wave 1.5 下沉
 * 后的「跨入口共享基础设施」聚集点）。
 */

export interface ToolStaleReadErrorPayload {
  /** runtime error_kind（`tool_stale_read`）。 */
  errorKind: string;
  /** 跟入口校验 message 字节一致（包含 canonical path）。 */
  message: string;
  /** 跟入口校验 suggestion / hint 字节一致。 */
  suggestion: string;
  /** canonical 绝对路径（用于日志 / 未来 envelope path 字段扩展）。 */
  path: string;
  /**
   * **Wave 3 整体收尾 L-35 修复**：原始错误对象，用于诊断时追溯 throw 点 stack。
   *
   * 跨包 throw → catch → envelope 转换路径中原始 stack 会丢失（catch 点构造新
   * standardizeLegacyResult envelope，原始 throw 点的 stack trace 不再可见）。
   * 把 cause 暴露成 Error 实例字段（**不是** ES2022 Error.cause options 参数，
   * 因为本包 tsconfig target=ES2020 不支持 Error 第二参数），让 dogfood 调试时
   * 通过 telemetry / 日志读 `err.cause` 字段拿完整 throw chain，缓解「stale 但
   * 说不清为什么」的追栈痛点。
   *
   * **为什么不升 ES2022 target**：本包是 action-tools 基础设施，升 target 牵动
   * 全包打包行为 + 跨包 import 兼容性，远超 L-35 修复 scope。`err.cause` 字段
   * 形态跟 ES2022 Error.cause 语义等价（用户读 err.cause 都能拿到），仅差「不在
   * Error.prototype.toString() 输出里」一点，dogfood 用 telemetry 读字段不受影响。
   */
  cause?: unknown;
}

export class ToolStaleReadError extends Error {
  readonly errorKind: string;
  readonly suggestion: string;
  readonly path: string;
  /** **L-35**：原始 throw chain（详 jsdoc on ToolStaleReadErrorPayload.cause）。 */
  readonly cause?: unknown;

  constructor(payload: ToolStaleReadErrorPayload) {
    super(payload.message);
    this.name = 'ToolStaleReadError';
    this.errorKind = payload.errorKind;
    this.suggestion = payload.suggestion;
    this.path = payload.path;
    if (payload.cause !== undefined) {
      this.cause = payload.cause;
    }
  }
}

/**
 * **Wave 3 整体收尾 L-32 修复**：`_validate_before_write` hook 跨包类型契约。
 *
 * 旧实现在 agent-runtime tabcode-adapter（注入侧）+ action-tools fileEditTool /
 * fileWriteTool（invoke 侧）双方都用 `(input as any)._validate_before_write`，
 * 类型契约只在注释里没 TypeScript 保证。如果未来 hook signature 改动（如加
 * fileSize 参数 / 改成异步），TS 不报错，要 dogfood 撞到。
 *
 * 本类型导出后：
 *   - **注入侧**（adapter `enrichWithWorkspaceRoot`）用 `as ValidateBeforeWriteHook`
 *     做类型断言，hook 函数体类型推断保护参数 + 返回值
 *   - **invoke 侧**（fileEditTool / fileWriteTool）用 `as ValidateBeforeWriteHook | undefined`
 *     做类型断言，调用时参数 / 返回值类型推断保护
 *   - **未来 hook signature 改动**时 TS 双侧报错，强制对齐
 *
 * 跟 ToolStaleReadError 同模块位置 —— 都是「跨包 TOCTOU 校验」基础设施聚集点。
 *
 * **设计取舍**：不导出到 input record 字段类型（如 `FileEditInput & { _validate_before_write?: ... }`）
 * 因为 input 类型在 action-tools 一侧定义，再让 agent-runtime 改 input 类型会引入
 * 反向依赖；本 hook 类型独立 export，两侧 import 同款类型保证契约一致。
 */
export type ValidateBeforeWriteHook = (params: {
  /** 校验的目标文件路径（caller 已 canonicalize）。 */
  filePath: string;
  /** 当前磁盘 mtime，**caller 必须 Math.floor 后**（基线 A1-4 / B3-1）。 */
  currentMtimeMs: number;
  /** 当前磁盘内容，**caller 必须 normalizeLineEndings + stripBOM 后**（A2-5）。 */
  currentContent: string;
}) => void;
