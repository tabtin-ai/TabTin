/**
 * format — File pipeline 错误统一格式化器
 *
 * 一站式生成 `{ errorKind, message, suggestion, i18nKey }` 四元组：
 *   - errorKind (string)：全局 ToolErrorKind / FilePipelineErrorCode 字符串
 *   - message (string)：LLM-facing 英文诊断（"是什么"）
 *   - suggestion (string | undefined)：LLM-facing 英文 actionable（"下一步")
 *   - i18nKey (string)：客户端 UI 渲染中文文案用
 *
 * Wave 3：仅输出字符串 `errorKind`（对应 envelope `error_kind`）；数字协议已删除。
 *
 * **LLM-facing 文案设计原则**（沉淀自 `formatLocalErrorForLLM` 经验）：
 *   - 告诉 LLM **下一步该做什么**（"DO NOT retry" / "tell the user to upload..."）
 *   - 区分"用户决定上传与否"vs"重试有用"——避免 token 死循环
 *   - 永远不暗示走 grep_search / web_search / shell pdftotext 等"绕路"
 *   - 没有明确下一步动作的 case（aborted）suggestion 字段返回 undefined，不
 *     强行编一句出来
 *   - **跨端通用措辞**（W1.2 第二轮 Review S1 反馈）：用 "upload the file via chat" 而不是
 *     "drag the file into chat"——桌面用拖拽 / mobile 用附件按钮，"upload" 是通用动作。
 *     LLM 转述时让 mobile 用户也能 get 下一步操作，不再被反复指引去"拖文件"。
 *
 * **UI 中文文案不在本文件**——通过 i18n key 渲染，源在
 * `apps/tabtin-electron/.../i18n/locales/{zh-CN,en-US}/chat.json#toolError`。
 */

import {
  FilePipelineErrorCode,
  FILE_PIPELINE_ERROR_I18N_KEYS,
  type FilePipelineFileSubject,
  type FilePipelineFailureMode,
} from './types.js';

export interface FilePipelineErrorContext {
  /** 文件名（短名，去掉路径）— 用于 LLM-facing message 给 LLM 上下文。 */
  filename?: string;
  /**
   * 原始错误 message（来自 worker / 网络层）— 用于 UNKNOWN 兜底 message
   * 与 NETWORK_ERROR / INVALID_PARAMETER 等需要透传 raw 异常文本的场景。
   *
   * **W5 L31（2026-05-14）契约变更**：format.ts 内部**不再** `rawMessage.startsWith()` /
   * `rawMessage.includes()` 字符串前缀检测来 fork suggestion 文案——所有 fork 决策
   * 改走结构化 `subject` + `failureMode` 字段。`rawMessage` 现在仅作为 raw 透传
   * 字段，不影响 message / suggestion 派发分支。
   *
   * 调用方（adapter / image-parser / pptx-parser 等）拼 ctx 时**不要再注入
   * 关键字**（"Auto-resize failed" / "does not start with PPTX magic bytes" 等
   * 历史关键字字面值检测分支已移除），改填 `failureMode` 即可。
   */
  rawMessage?: string;
  /** 文件 subject（image / document / presentation）— 影响 FILE_TOO_LARGE / UNSUPPORTED_FORMAT 等的 suggestion 措辞。 */
  subject?: FilePipelineFileSubject;
  /**
   * **W5 L31（2026-05-14）**：结构化失败模式信号，取代 rawMessage 字符串前缀检测。
   * 详见 `FilePipelineFailureMode` 类型定义。
   *
   * 当 error kind = UNSUPPORTED_FORMAT 时：
   *   - failureMode='magic_mismatch' → 派发"重新导出"专属指引（不推 chat 上传，
   *     chat 后端做同款 magic 检查会再失败）；与 subject 联动判断是 image 还是 PPTX
   *   - 否则走通用 fallthrough 文案
   *
   * 当 error kind = FILE_TOO_LARGE 时：
   *   - failureMode='oversize'（默认隐含）→ 走 size 上限文案
   *   - **不再支持 'resize_failed'**（W5 L38 拆为独立 IMAGE_RESIZE_FAILED enum）
   */
  failureMode?: FilePipelineFailureMode;
  /** 实际文件大小（字节）— 用于 FILE_TOO_LARGE 的 message。 */
  actualBytes?: number;
  /** 上限（字节）— 用于 FILE_TOO_LARGE 的 message。 */
  limitBytes?: number;
  /** 解析超时阈值（毫秒）— 用于 PARSE_TIMEOUT 的 message。 */
  timeoutMs?: number;
  /** 不支持的扩展名 / mime — 用于 UNSUPPORTED_FORMAT 的 message。 */
  format?: string;
  /** URL — 用于 NETWORK_ERROR 的 message。 */
  url?: string;
  /**
   * **W5 L38（2026-05-14）**：sharp 缩放失败的细分原因（仅 IMAGE_RESIZE_FAILED 用）。
   * 用于 LLM-facing message 区分 sharp 未装 / decode 失败 / 缩放后仍超大三类。
   */
  resizeFailureCause?: 'sharp_unavailable' | 'sharp_decode_failed' | 'too_large_after_resize';
}

export interface FilePipelineErrorOutput {
  /** 全局 ToolErrorKind / FilePipelineErrorCode 字符串。 */
  errorKind: string;
  /** LLM-facing 英文诊断。 */
  message: string;
  /** LLM-facing 英文 actionable suggestion（aborted 等场景为 undefined）。 */
  suggestion?: string;
  /** i18n key 后缀（不含 `chat.toolError.` 前缀）。 */
  i18nKey: string;
}

/**
 * **展示用占位**（W1.1 review 反馈 + W2 L18 收敛）：不是策略上限，仅在调用方
 * 未传 `limitBytes` 时为 LLM message 提供数字占位。真正的上限定义在：
 *   - 临时通道：`packages/action-tools/src/tools/tabcode/index.ts`
 *     `MAX_IMAGE_FILE_BYTES_HARD = 50MB`（W2 改造后的硬上限）+ adapter
 *     `IMAGE_RESIZE_TRIGGER_BYTES = 5MB`（软上限触发缩放）
 *   - 持久通道：OSS bucket 配置
 *
 * **W2（2026-05-13）L18 收敛**：image 占位从 20 → 50（与 W2 硬上限一致）。
 * 旧 20MB 是硬拒上限的字面值，W2 改成"5MB 软上限自动缩放 + 50MB 硬上限拒绝"
 * 后旧 20 不再有任何业务含义。所有调用方应该显式传 `limitBytes`；占位仅作
 * fallback 兜底（极少触发）。
 */
const DEFAULT_DOC_LIMIT_MB = 50;
const DEFAULT_IMAGE_LIMIT_MB = 50;

function formatMb(bytes: number | undefined, fallbackMb: number): string {
  if (typeof bytes !== 'number' || bytes <= 0) return `${fallbackMb}MB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 仅在 `actualBytes` 有合法值时返回 ` (actual: NMB)`；否则返回空字符串。
 * 避免历史 message "exceeds 50MB limit (actual: 50MB)" 把"未知大小"退化为
 * 上限字面值的误导（W1.1 review 反馈）。
 */
function actualSuffix(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '';
  return ` (actual: ${(bytes / (1024 * 1024)).toFixed(1)}MB)`;
}

/**
 * 统一格式化器：根据 FilePipelineErrorCode 生成完整 envelope payload。
 *
 * **不区分 LLM-facing 调用方与 UI 调用方**——五元组同时返回；调用方各自取所需。
 * 这样 LLM-facing 英文 message 和 UI 中文文案（通过 i18nKey 渲染）始终从同
 * 一处派发，避免各端独立翻译漂移（北极星：UI 中文 vs LLM 英文语义对得上）。
 */
export function formatFilePipelineError(
  code: FilePipelineErrorCode,
  ctx: FilePipelineErrorContext = {},
): FilePipelineErrorOutput {
  const errorKind = code; // string enum 与 error_kind 一一对应
  const i18nKey = FILE_PIPELINE_ERROR_I18N_KEYS[code];

  const filename = ctx.filename ?? 'file';
  // 缺省走 document 分支（PDF / DOCX / XLSX 是 file pipeline 主流场景）。
  // image 调用方需显式传 `subject: 'image'`。
  const subject: FilePipelineFileSubject = ctx.subject ?? 'document';

  switch (code) {
    case FilePipelineErrorCode.FILE_NOT_FOUND: {
      // **W1.2（第二轮 Review 中-2）**：区分本地路径 vs 远端 URL 两种场景。
      //   - 本地路径：用户拼错路径概率高 → glob_search 兜底有效
      //   - 远端 URL：OSS 签名过期 / 资源已删的概率高 → glob_search 永远 0 匹配，
      //     让 LLM 走"让用户重传"路径，避免 1-2 turn 弯路
      const isRemoteUrl = typeof ctx.url === 'string' && /^https?:\/\//i.test(ctx.url);
      if (isRemoteUrl) {
        return {
          errorKind,
          message: `Remote resource not found: ${ctx.url ?? filename}.`,
          suggestion:
            `The URL may be expired (OSS signed URLs typically expire within hours) or the resource ` +
            `was deleted. DO NOT retry the same URL — ask the user to re-upload the file or share a ` +
            `fresh link.`,
          i18nKey,
        };
      }
      return {
        errorKind,
        message: `File not found: ${filename}.`,
        suggestion:
          `Verify the path is correct (consider similar filenames in the directory). ` +
          `Use glob_search to discover the actual path before retrying.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.FILE_TOO_LARGE: {
      const actual = actualSuffix(ctx.actualBytes);
      // **W4 (2026-05-13) L53 消费**：subject='presentation' 走 PPTX 专属文案。
      // 用户心智里"演示文稿/slides"≠"document"——LLM 转述时该用对应措辞。
      if (subject === 'presentation') {
        const limit = formatMb(ctx.limitBytes, DEFAULT_DOC_LIMIT_MB);
        return {
          errorKind,
          message:
            `Presentation exceeds the ${limit} local-parse size limit${actual}.`,
          suggestion:
            `Tell the user to upload the presentation via chat (drag-and-drop on desktop ` +
            `or use the attach/+ button on mobile) — chat upload uses async server-side ` +
            `parsing without size limits and indexes slides into RAG for follow-up queries. ` +
            `DO NOT retry — the same file size will exceed the local limit again.`,
          i18nKey,
        };
      }
      if (subject === 'image') {
        const limit = formatMb(ctx.limitBytes, DEFAULT_IMAGE_LIMIT_MB);
        // **W5 L38（2026-05-14）**：sharp 缩放失败已拆为独立 enum
        // `IMAGE_RESIZE_FAILED` 独立 kind，不再走 FILE_TOO_LARGE rawMessage
        // 检测。如果调用方仍传 `failureMode='resize_failed'`，作为软兜底防御
        // 性走 IMAGE_RESIZE_FAILED 文案路径——但新代码应直接派 IMAGE_RESIZE_FAILED
        // enum，不要走 FILE_TOO_LARGE。
        if (ctx.failureMode === 'resize_failed') {
          // 委托回 IMAGE_RESIZE_FAILED 文案（防御性兜底；新代码不应走这里）
          return formatFilePipelineError(FilePipelineErrorCode.IMAGE_RESIZE_FAILED, ctx);
        }
        return {
          errorKind,
          message:
            `Image exceeds the ${limit} read_file hard size limit${actual}. ` +
            `Even after auto-resize the image cannot be read via the temporary 0-OSS path. ` +
            `(Note: read_file auto-resizes images >5MB to long edge 2048px JPEG; this error ` +
            `means the original is over the 50MB hard cap.)`,
          suggestion:
            `Tell the user to upload the image via chat (drag-and-drop on desktop or use the ` +
            `attach/+ button on mobile) — chat upload uses async parsing with vision-model ` +
            `extraction and supports much larger images. Alternatively, ask the user to ` +
            `manually downsample the image to under ${limit} before retrying read_file. ` +
            `DO NOT retry without one of these user actions — the same file will fail again.`,
          i18nKey,
        };
      }
      const limit = formatMb(ctx.limitBytes, DEFAULT_DOC_LIMIT_MB);
      return {
        errorKind,
        message:
          `Document exceeds the ${limit} local-parse size limit${actual}.`,
        suggestion:
          `Tell the user to upload the file via chat (drag-and-drop on desktop or use the ` +
          `attach/+ button on mobile) — chat upload uses async parsing without size ` +
          `limits and indexes into RAG for follow-up queries. ` +
          `DO NOT retry — the same file size will exceed the local limit again.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.PERMISSION_DENIED:
      return {
        errorKind,
        message: `Permission denied for ${filename}.`,
        suggestion:
          `The path may be outside the workspace boundary or marked sensitive. ` +
          `Tell the user to grant access, move the file into the workspace, or work with ` +
          `a different path. DO NOT retry without permission.`,
        i18nKey,
      };

    case FilePipelineErrorCode.ENCRYPTED:
      return {
        errorKind,
        message: `File is password-protected: ${filename}.`,
        suggestion:
          `Tell the user to provide an unprotected version of the file. DO NOT retry — ` +
          `encryption cannot be bypassed by re-reading.`,
        i18nKey,
      };

    case FilePipelineErrorCode.CORRUPTED:
      return {
        errorKind,
        message: `File is corrupted or has an invalid structure: ${filename}.`,
        suggestion:
          `Tell the user the file may need to be re-exported from the source application. ` +
          `DO NOT retry — repeating the same read will fail the same way.`,
        i18nKey,
      };

    case FilePipelineErrorCode.SCANNED_PDF:
      return {
        errorKind,
        message:
          `Scanned-image PDF detected (${filename}): no text layer to extract. ` +
          `Local OCR is not supported on temporary read paths to avoid silent billing.`,
        suggestion:
          `Tell the user to upload the file via chat (drag-and-drop on desktop or use the ` +
          `attach/+ button on mobile) — server-side VLM extraction (billed per page) can read ` +
          `scanned content. DO NOT retry locally.`,
        i18nKey,
      };

    case FilePipelineErrorCode.GARBLED_TEXT_LAYER:
      return {
        errorKind,
        message:
          `Text layer quality is too low to be reliable (likely OCR'd from images): ${filename}.`,
        suggestion:
          `Tell the user to upload the file via chat (drag-and-drop on desktop or use the ` +
          `attach/+ button on mobile) for server-side VLM re-extraction. Reading the unreliable ` +
          `text layer would mislead downstream analysis — DO NOT retry locally.`,
        i18nKey,
      };

    case FilePipelineErrorCode.UNSUPPORTED_FORMAT: {
      const format = ctx.format ? ` (${ctx.format})` : '';
      // **W5 L31（2026-05-14）**：用结构化 ctx.failureMode + ctx.subject 取代
      // 历史 `rawMessage.startsWith` / `includes` 字符串前缀检测。
      // 调用方拼 ctx 时填 `failureMode='magic_mismatch' + subject='image' | 'presentation'`
      // 即可走专属"重新导出"指引（不推 chat —— chat 后端做同款 magic 检查会再失败）。
      // **不再消费 rawMessage 字面值前缀**——跨包字符串契约脆弱反模式（反思 §八 #13）。
      if (ctx.failureMode === 'magic_mismatch') {
        if (subject === 'image') {
          return {
            errorKind,
            message:
              `File has ${ctx.format ?? 'image'} extension but content does not match any known ` +
              `image format: ${filename}.${ctx.rawMessage ? ` ${ctx.rawMessage}` : ''}`,
            suggestion:
              `Tell the user the file extension says ${ctx.format ?? 'image'} but the actual ` +
              `bytes don't match — likely mislabeled (e.g. WeChat sticker often has .png ext ` +
              `but is actually .webp), corrupted, or renamed from a different format. ` +
              `Ask the user to: (1) check the original source / re-export as a true ${ctx.format ?? 'image'} ` +
              `via Preview / Photos / image editor; (2) if mislabeled (e.g. .webp saved as .png), ` +
              `rename to the actual extension. DO NOT recommend uploading via chat — chat ` +
              `parsing performs the same magic check and will fail the same way for mislabeled binaries.`,
            i18nKey,
          };
        }
        if (subject === 'presentation') {
          return {
            errorKind,
            message:
              `File has ${ctx.format ?? '.pptx'} extension but content is neither a valid PPTX ` +
              `(ZIP container) nor an OLE Compound File: ${filename}.${ctx.rawMessage ? ` ${ctx.rawMessage}` : ''}`,
            suggestion:
              `Tell the user the file extension says ${ctx.format ?? '.pptx'} but the actual bytes ` +
              `don't match — likely (1) the file is corrupted / truncated / partially downloaded, ` +
              `(2) it was renamed from a different format (e.g. .key Keynote / .pdf), or ` +
              `(3) it is a legacy .ppt that was simply renamed (.ppt → .pptx without conversion). ` +
              `Ask the user to: (a) verify the file opens in PowerPoint / Keynote first; ` +
              `(b) if it's a legacy .ppt, open in PowerPoint and "Save As" → .pptx (modern format); ` +
              `(c) if downloaded, re-download in case of truncation. ` +
              `DO NOT recommend uploading via chat — the chat upload pipeline performs the same ` +
              `ZIP magic check (python-pptx BadZipFile) and will fail the same way.`,
            i18nKey,
          };
        }
        // failureMode='magic_mismatch' 但 subject 既非 image 也非 presentation
        // → 走通用 fallthrough 文案（document / undefined subject 没有专属
        // magic-mismatch 引导 case 因为 PDF/DOCX/XLSX 走 worker，不在 adapter
        // 层做 magic 校验）
      }
      // W4 L53 消费：subject='presentation' 用 PPT 措辞
      const fileNoun =
        subject === 'presentation' ? 'presentation' :
        subject === 'image' ? 'image' :
        'file';
      return {
        errorKind,
        message:
          `Local parser does not support this ${fileNoun} format${format}: ${filename}. ` +
          `read_file supports text files, images (jpeg/png/gif/webp/bmp/svg/heic), PDF / DOCX / XLSX, ` +
          `modern PPTX (via temp channel), and EPUB.`,
        suggestion:
          // **W1.3 第 3 轮 Review 1 M1 修复（2026-05-13）**：原 hint 把 .doc / .xls / .key
          // 推到 chat 但后端 docparse 实际不支持这三类（xlsx parser 仅 .xlsx；keynote 无 parser；
          // doc 同样无 parser，需先转为新格式）。同时音视频 / HEIC / archive 在 chat 也不支持。
          // 拆分为三类引导：(1) PPTX 走 chat 通道；(2) 老办公格式先转为新格式；(3) 媒体 /
          // 压缩包 / 可执行文件根本不在 file pipeline 范围。
          // **#4733（2026-07）**：音频拖入聊天会自动 ASR；本 DocParse 路径仍不解析音视频。
          // 视频 / 压缩包 / 可执行文件仍无读取路径。
          `If the format is .pptx (modern PowerPoint), tell the user to upload via chat ` +
          `(drag-and-drop on desktop or use the attach/+ button on mobile) — the chat upload ` +
          `pipeline supports PPTX via server-side parsing. ` +
          `If the format is legacy Office (.doc / .xls / .ppt) or Apple iWork (.key / .pages / .numbers), ` +
          `tell the user to first export / convert to a modern format (.docx / .xlsx / .pptx / .pdf) ` +
          `and re-upload — uploading the legacy file via chat will fail the same way. ` +
          `For audio (.mp3 / .wav / .m4a / .ogg), chat upload auto-transcribes via ASR — this ` +
          `document-parse path does not read audio bytes. For video (.mp4 / .mov), archives ` +
          `(.zip / .tar.gz / .rar), executables, or unknown binary formats, neither read_file nor ` +
          `document parse can extract content — tell the user there is no path to read this file ` +
          `content here; do not suggest document-parse retries. DO NOT retry — the same file format will fail.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.PARSE_TIMEOUT: {
      // **W1.2 Review 收尾（2026-05-13）**：未传 timeoutMs 时旧版本拼出
      // "after configureds" 这种别扭英文短语（'configured' + 's'），LLM
      // 转述给用户读到一脸问号。改为成句的 fallback。
      const timeoutPhrase =
        typeof ctx.timeoutMs === 'number'
          ? `after ${(ctx.timeoutMs / 1000).toFixed(1)}s`
          : `after the configured timeout`;
      // **W4 L53 消费**：subject='presentation' 用 "presentation parsing timed out"
      // 让 LLM 转述给用户时用对应措辞。
      const noun = subject === 'presentation' ? 'Presentation' : 'Document';
      return {
        errorKind,
        message:
          `${subject === 'presentation' ? 'PPTX' : 'Local'} parsing timed out for ${filename} ${timeoutPhrase}. ` +
          `The ${noun.toLowerCase()} may be very large or contain complex structures.`,
        suggestion:
          `Tell the user to upload the ${noun.toLowerCase()} via chat (drag-and-drop on desktop or use the ` +
          `attach/+ button on mobile) for asynchronous parsing without a time limit. ` +
          `DO NOT retry — the same file will time out the same way locally.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.USER_ABORTED:
      return {
        errorKind,
        message: `Local read aborted for ${filename} (user cancelled).`,
        // 用户主动取消——没有"下一步动作"要给 LLM。suggestion 留空，避免生造
        // 一句让 LLM 误以为还能"重试"。
        suggestion: undefined,
        i18nKey,
      };

    case FilePipelineErrorCode.NETWORK_ERROR: {
      const url = ctx.url ? `: ${ctx.url}` : '';
      return {
        errorKind,
        message:
          `Network error while fetching${url}. ${ctx.rawMessage ?? 'Connection failed or HTTP error.'}`,
        suggestion:
          `Check connectivity and retry once. If the resource is OSS-hosted, the signed URL ` +
          `may have expired — tell the user to re-upload the file.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.INVALID_PARAMETER:
      return {
        errorKind,
        message:
          ctx.rawMessage
          ?? `Invalid or missing parameter for file operation on ${filename}.`,
        suggestion:
          `Check the tool input schema and provide the required parameter (e.g. path must be a non-empty string).`,
        i18nKey,
      };

    case FilePipelineErrorCode.IMAGE_RESIZE_FAILED: {
      // **W5 L38（2026-05-14）拆 IMAGE_RESIZE_FAILED 独立 kind**：
      // sharp 缩放失败（unavailable / sharp_decode_failed / too_large_after_resize）
      // 走专属语义，与 FILE_TOO_LARGE "原图超 50MB 硬上限" 物理脱耦。历史
      // W2.1 用 rawMessage 含 "Auto-resize failed" 前缀做 FILE_TOO_LARGE 内部
      // fork 已改为本独立 enum 派发——跨包字符串契约 → 结构化 enum 契约。
      const cause = ctx.resizeFailureCause;
      const causePhrase =
        cause === 'sharp_unavailable' ? 'sharp library is not installed in this host' :
        cause === 'sharp_decode_failed' ? 'sharp could not decode this file (often unsupported variant: animated WEBP / HEIC without libheif / corrupted bytes)' :
        cause === 'too_large_after_resize' ? 'even after auto-resize the result still exceeds the size budget' :
        'the local image processor (sharp) failed unexpectedly';
      return {
        errorKind,
        message:
          `Local image processing failed for ${filename}${actualSuffix(ctx.actualBytes)}: ${causePhrase}. ` +
          `read_file cannot return this image even though the file size may be under the 50MB hard cap.`,
        suggestion:
          `Tell the user the local image processor (sharp) failed on this file — ` +
          `often due to an unsupported variant (e.g. animated WEBP, HEIC without libheif), ` +
          `corruption, or sharp not installed in this host. ` +
          `Ask the user to upload the image via chat (drag-and-drop on desktop or attach/+ ` +
          `on mobile) for cloud parsing, which uses a different image pipeline. ` +
          `DO NOT retry locally — the same file will fail the same way.`,
        i18nKey,
      };
    }

    case FilePipelineErrorCode.UNKNOWN_ERROR:
    default: {
      // **W1.2 Review 收尾（2026-05-13）**：raw 技术词（如 "segfault" /
      // "ECONNABORTED 0x10054"）原封暴露给 LLM 后会被转述给用户，但用户看
      // 不懂这些底层符号。把 raw 简化掉 —— LLM 只看到通用 "unknown error"，
      // 转述给用户的话不会带专业术语。debug 上下文需要的话由调用方记入
      // envelope.metadata 给观测平台用，不污染 LLM-facing message。
      return {
        errorKind,
        message: `File operation failed for ${filename} (unknown error).`,
        suggestion:
          `Tell the user to upload the file via chat (drag-and-drop on desktop or use the ` +
          `attach/+ button on mobile) for the cloud parser — it has a more robust parsing ` +
          `pipeline. If the file is in a standard format and chat upload also fails, contact ` +
          `support. DO NOT retry locally — the underlying error is unclassified and likely to ` +
          `recur with the same input.`,
        i18nKey,
      };
    }
  }
}

/**
 * 持久通道（main agent 拖文件到 chat 后注入 effectivePrompt 的中文转述文本）。
 *
 * **W1.3 第 3 轮 Review 反馈（2026-05-13）**：原先 main agent 的 `formatUserFacingLocalError`
 * 只在 host 类（ElectronAgentHost / DaemonAgentHost）里硬编码 3 类（ENCRYPTED / CORRUPTED /
 * FILE_TOO_LARGE）中文文案，其余 10 类走 `[文档: ${filename} — 本地解析失败（${errorClass}）]`
 * 这种"裸 enum 字面值"兜底；同时 `fetchCloudSummary` 拿到后端 `status=failed` 时直接 return
 * null，让 LLM 完全看不到失败原因。Review 2 S1 判断这是 W1 北极星在用户最主要入口的真实缺口
 * —— 用户 99% 是从 chat 上传文件，而非 read_file 工具。
 *
 * 本函数把 13 类的中文转述文本与 SSoT 物理同源，main agent 与 chat.json i18n 文案不再漂移。
 *
 * **设计取舍 vs `formatFilePipelineError`**：
 *   - `formatFilePipelineError` 返回 LLM-facing 英文 envelope（read_file 工具的 hint 字段，
 *     LLM 直接看英文 actionable，不转译）
 *   - 本函数返回的是要注入到 LLM 上下文的 **中文 prompt 文本**——LLM 看完后用自己的语气
 *     把中文意思转述给用户（main agent 持久通道注入路径）
 *   - 两套并存的原因：上下文角色不同。read_file 是 LLM 主动调用拿 envelope，main agent
 *     prompt injection 是给 LLM 一段背景信息让它转述。强行复用会让 LLM 把英文 hint 直接
 *     转贴给用户，体验差。
 *
 * **不放 file_id / UUID**：与现有 `formatUserFacingLocalError` 设计约束一致——内部技术
 * 标识符不进用户看得见的 prompt 路径。
 */
export interface FilePipelineChinesePromptContext {
  /** 文件名（短名） */
  filename: string;
  /** 本地解析路径专属：上限（MB）—— 用于 FILE_TOO_LARGE 文案 */
  localLimitMb?: number;
  /** main agent parse_document 工具的内部 file_id（仅 FILE_TOO_LARGE 走分页 hint 时用） */
  fileIdForParseDocument?: string;
  /** 后端 error_message raw（可选，用于 UNKNOWN_ERROR 兜底） */
  rawMessage?: string;
}

export function formatFilePipelineErrorChinesePrompt(
  code: FilePipelineErrorCode,
  ctx: FilePipelineChinesePromptContext,
): string {
  const { filename, localLimitMb, fileIdForParseDocument, rawMessage } = ctx;
  const header = `[文档: ${filename}`;

  switch (code) {
    case FilePipelineErrorCode.FILE_NOT_FOUND:
      return (
        `${header} — 未找到该文件或资源链接已失效。\n` +
        `请告知用户：附件可能已被删除或上传链接已过期，建议重新上传文件。]`
      );

    case FilePipelineErrorCode.FILE_TOO_LARGE: {
      const limit = localLimitMb ? `${localLimitMb}MB` : '本地处理上限';
      const internalHint = fileIdForParseDocument
        ? `\n[INTERNAL file_id=${fileIdForParseDocument}] — Agent 可用此 file_id 通过 parse_document 工具分页读取`
        : '';
      return (
        `${header} — 该文件体积较大（超过 ${limit}）。\n` +
        `请告知用户：由于体积限制无法一次性读入全文，Agent 可按用户关心的章节/关键词` +
        `分段读取该文档（需要时直接向用户说明"请告诉我你想了解文档的哪一部分"即可）。` +
        internalHint +
        ']'
      );
    }

    case FilePipelineErrorCode.PERMISSION_DENIED:
      return (
        `${header} — 没有访问该文件的权限。\n` +
        `请告知用户：文件可能在 Space / 资源访问边界之外，或被标记为敏感文件，` +
        `Agent 无法读取；可尝试将文件复制到当前工作区后重新上传。]`
      );

    case FilePipelineErrorCode.ENCRYPTED:
      return (
        `${header} — 该文档受密码保护，无法读取内容。\n` +
        `请告知用户上传未加密版本，或在源文件中移除密码后重新上传。` +
        `（云端也无法绕过密码保护）]`
      );

    case FilePipelineErrorCode.CORRUPTED:
      return (
        `${header} — 该文档无法解析（文件结构异常或格式不受支持）。\n` +
        `请告知用户：如果确认文件来源正常，可能是导出工具兼容性问题；` +
        `建议用户尝试将原文件重新导出为标准 PDF / DOCX / XLSX 后再上传，或联系客服反馈问题。]`
      );

    case FilePipelineErrorCode.SCANNED_PDF:
      return (
        `${header} — 这是扫描件 PDF（无文本层），云端会用图像识别（VLM）按页提取文字。\n` +
        `请告知用户：扫描件按页计费，处理时间较长；如果文档页数较多请耐心等待结果。]`
      );

    case FilePipelineErrorCode.GARBLED_TEXT_LAYER:
      return (
        `${header} — PDF 文本层质量过低（疑似从图片 OCR 而来，可信度不足）。\n` +
        `云端会改用图像识别（VLM）按页重新提取——请告知用户：VLM 重提取按页计费，` +
        `处理时间较长。]`
      );

    case FilePipelineErrorCode.UNSUPPORTED_FORMAT:
      return (
        `${header} — 这个文件格式云端文档解析器不支持。\n` +
        `请告知用户：常见可解析格式为 PDF / DOCX / XLSX / PPTX 等办公文档与文本类；` +
        `音频（.mp3 / .wav / .m4a 等）拖入聊天会自动语音识别，本路径（文档解析）不读音频；` +
        `视频（.mp4 / .mov）、压缩包（.zip / .tar.gz）、可执行文件等本地与云端文档解析都不支持；` +
        `老格式（.doc / .xls / .key）建议先转为新格式（.docx / .xlsx / .pptx）。]`
      );

    case FilePipelineErrorCode.PARSE_TIMEOUT:
      return (
        `${header} — 云端解析超时（文件可能过大或结构复杂）。\n` +
        `请告知用户：可以稍后重试，或者把文档拆成更小的几份后再上传。]`
      );

    case FilePipelineErrorCode.USER_ABORTED:
      // 用户主动取消——main agent 不应再把附件兜底文案塞进上下文。调用方应该
      // 直接 return null 跳过附件注入。这里给一句兜底文本仅为防御性 fallback。
      return `${header} — 已取消读取]`;

    case FilePipelineErrorCode.NETWORK_ERROR:
      return (
        `${header} — 网络问题导致云端解析失败。\n` +
        `请告知用户：如果是 OSS 链接过期，可重新上传文件；如果是网络中断，稍后重试即可。]`
      );

    case FilePipelineErrorCode.INVALID_PARAMETER:
      return (
        `${header} — 文档解析请求参数有误。\n` +
        `请告知用户：这通常是上传链路异常，建议重新上传一次。]`
      );

    case FilePipelineErrorCode.UNKNOWN_ERROR:
    default: {
      // 不暴露 raw 技术错误（如 "segfault" / "ECONNABORTED"）给用户——只保留中文兜底，
      // raw message 由调用方写入观测平台（telemetry）而非 prompt 上下文。
      // **W1.3 强化**：包含 _ 用作分隔的内部 errorClass 不应直接显示给用户。
      void rawMessage; // 显式标记不消费 raw（让 lint 不告警）
      return (
        `${header} — 文档读取失败（云端解析器未能识别失败原因）。\n` +
        `请告知用户：建议把文件换一种格式重新导出后再上传（例如 PDF → DOCX 或反之）；` +
        `如果同一文件多次失败，建议联系客服。]`
      );
    }
  }
}
