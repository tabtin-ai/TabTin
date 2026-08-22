/**
 * File Pipeline Error Kind — 14 类字符串 SSoT
 *
 * 这是 file pipeline（read_file / parse_document / upload / OSS download / 后端
 * docparse）共享的**唯一**字符串错误分类体系。设计原则：
 *
 *   1. **全局唯一** —— 跨 local-docparse / agent-runtime / action-tools / Django
 *      / 客户端 UI / 移动端 toast 共享同一份 enum。不再各处自己 maintain 一份。
 *   2. **字符串域分离** —— file pipeline kind 由本包
 *      `codegen/error-codes.yaml` 生成；edit/browser producer kind 由
 *      `packages/tool-errors/codegen/kinds/*.yaml` 与 `codegen/bridges.yaml`
 *      生成，并经 `@tabtin/tool-errors` bridge 映射到 runtime kind。
 *   3. **两层映射（Wave 3）** —— 每类有：
 *        - 字面 enum 名（FilePipelineErrorCode 成员）
 *        - 字符串 error_kind（与 `@tabtin/agent-runtime` `error-kinds.ts` 全局
 *          ToolErrorKind 一致，UI / observability 用）
 *        - i18n key（`chat.toolError.<key>`，中文 / 英文文案同源派发）
 *      数字 `TabcodeErrorCode` / `FILE_PIPELINE_ERROR_NUMERIC` 协议已删除；
 *      active YAML 禁止 `numeric` 字段。历史对照仅见 Wave 3 迁移文档。
 *   4. **LLM-facing 英文 / UI 中文分层** —— LLM 看英文 message + actionable
 *      suggestion；UI 用 i18n key 渲染中文文案。两套不强行翻译彼此，避免漂移。
 *   5. **不留转换函数 / 兼容映射兜底** —— 旧 `LocalDocParseErrorClass` 自定义
 *      字符串 union 整体退役，仅保留一个 type alias `LocalDocParseErrorClass =
 *      FilePipelineErrorCode` 以便消费端按业务语义命名（type-level 等价于全局
 *      SSoT，**不是**字面值兼容 alias）；adapter 层的 lossy 压扁映射函数整个删除
 *      （旧实现把 6 个本地错误类压扁成 `UNSUPPORTED_OPERATION`，LLM 拿不到
 *      精确分类信号；W1 通过 `formatFilePipelineError` 派发 envelope 取代）。
 *
 * **W5 L17（2026-05-14）codegen 落地**：核心常量
 * （FilePipelineErrorCode / FILE_PIPELINE_ERROR_KINDS /
 * FILE_PIPELINE_ERROR_I18N_KEYS）派生自 `codegen/error-codes.yaml` SSoT，存放在
 * `_generated/error-codes.generated.ts`。**加新错误码改 yaml 跑 codegen，不改其它处**
 * （types.ts 自动跟随 / chat.json zh+en / strings_chat.xml zh+en 同步派生）。
 * **iOS 不在 codegen 范围**——iOS Configs Swift 字典需手动改（详见 yaml 文件头注释 + §七 L69）。
 *
 * **W5 L38（2026-05-14）**：拆 `IMAGE_RESIZE_FAILED` 独立 kind
 * `image_resize_failed`，与 FILE_TOO_LARGE 双语义脱耦。sharp 缩放失败
 * （unavailable / decode_failed / too_large_after_resize）走专属 enum。
 *
 * **`USER_ABORTED` 字面值故意复用 `'aborted'`**（与顶层 runtime catalog 的
 * `aborted` kind 同名）—— 不是笔误。设计取舍见总控 §八 反思 #2：file pipeline
 * 的"用户取消解析"与 chat-level "用户停止生成"在用户视角是同一件事，归一到
 * 同款 string kind 让 UI 不再多维护一份"aborted vs user_aborted"文案区分。
 *
 * **不要直接编辑 `_generated/error-codes.generated.ts`**——下次 codegen 会覆盖。
 * 改 yaml + 跑 `pnpm --filter @tabtin/file-pipeline-errors codegen`。
 */
export {
  FilePipelineErrorCode,
  FILE_PIPELINE_ERROR_KINDS,
  FILE_PIPELINE_ERROR_I18N_KEYS,
} from './_generated/error-codes.generated.js';

import {
  FILE_PIPELINE_ERROR_KINDS,
} from './_generated/error-codes.generated.js';

/**
 * 区分"图 / 文档 / 演示"三种场景的辅助 subject 字段。
 *
 * 同一 error kind 下根据 subject 给 LLM 不同的 actionable suggestion：
 *   - image: W2 改为软上限 5MB 自动缩放 / 硬上限 50MB 才拒；触发 FILE_TOO_LARGE
 *     说明原图 > 50MB（W5 L38 后 sharp 缩放失败走独立 IMAGE_RESIZE_FAILED）
 *   - document: 建议拖入 chat（async + RAG）—— **缺省语义**（PDF / DOCX / XLSX）
 *   - presentation: PPTX 专属（W4 L53 收）—— LLM 转述时用户心智里是"演示文稿
 *     / slides / PPT"，不是"document"。中文 i18n / LLM-facing message 用
 *     "presentation" / "slides" 措辞，避免"将这份文档拖入 chat"对用户造成
 *     "我上传的是 PPT 啊"的语义错位。
 *
 * 不另开 error kind 是因为 LLM 视角"file too large"是同一类（"我读不了这个
 * 大小"），suggestion 微调即可；细分到 IMAGE_TOO_LARGE / DOCUMENT_TOO_LARGE 两
 * 个 kind 会让 catalog / i18n 翻倍而无业务收益。
 *
 * **W1.2 Review 收尾（2026-05-13）**：`'unknown'` 成员已删除。
 * **W4 收尾（2026-05-13）**：`'presentation'` 加入（L53 收）。
 */
export type FilePipelineFileSubject = 'image' | 'document' | 'presentation';

/**
 * **W5 L31（2026-05-14）**：消费 `subject` + `failureMode` 字段做 fork 决策，
 * 取代 format.ts 内部 `rawMessage.startsWith` / `includes` 字符串前缀检测。
 *
 * 历史问题：format.ts 通过 `rawMessage` 字面值前缀（"Auto-resize failed" /
 * "does not start with PPTX magic" / "content does not match any known image format"）
 * 来 fork suggestion 文案——这是"接口承诺没兑现"反模式（反思 §八 #13）：函数
 * 签名给了 ctx 字段（`subject` 等）但没真消费，调用方把语义信号编码进 rawMessage
 * 字符串里跨包传，跨包字符串契约脆弱。
 *
 * 修法：调用方拼 ctx 时填 `failureMode`（结构化），format.ts 用 `failureMode`
 * 取代 rawMessage 检测。
 *
 *   - 'magic_mismatch'：扩展名是 PNG / PPTX / 等，但 magic bytes 不匹配
 *     （image / pptx 各自专属"重新导出"指引，不推 chat）
 *   - 'oversize'：原图 / 文档超过硬上限（拖 chat 走云端）
 *   - 'resize_failed'：sharp 缩放失败 —— **W5 L38 拆出独立 enum
 *     `IMAGE_RESIZE_FAILED`** 取代本字段。新代码不要再用 `failureMode='resize_failed'`，
 *     直接派 `IMAGE_RESIZE_FAILED` enum；保留本枚举值给历史调用方过渡，下个 wave 删除。
 *   - undefined：默认行为（按 error kind 走通用文案）
 */
export type FilePipelineFailureMode =
  | 'magic_mismatch'
  | 'oversize'
  | 'resize_failed'
  | undefined;

/**
 * Type guard：判断任意字符串是否是合法的 `FilePipelineErrorCode` 字面值。
 *
 * **W1.3 第 3 轮 Review 2 S1（2026-05-13）**：持久通道（main agent fetchCloudSummary）
 * 拿到后端 `failure_code: string` 字段后需要派发到 SSoT，但 backend 字面值是 `string`
 * 类型——直接传给 `formatFilePipelineErrorChinesePrompt` 会 TS 报错；旧记录或后端未填
 * failure_code 时（值为 ''）也需要兜底。本 type guard 让调用方一行代码完成校验 + 兜底：
 *
 * ```ts
 * const code = isFilePipelineErrorCode(data.failure_code)
 *   ? data.failure_code
 *   : FilePipelineErrorCode.UNKNOWN_ERROR
 * ```
 */
export function isFilePipelineErrorCode(
  value: unknown,
): value is import('./_generated/error-codes.generated.js').FilePipelineErrorCode {
  return (
    typeof value === 'string' &&
    (FILE_PIPELINE_ERROR_KINDS as readonly string[]).includes(value)
  );
}

// ─── Channel-level size limits（W4 L44/L54 SSoT 化） ──────────────────
/**
 * **W4（2026-05-13）L44 + L54 收敛**：把以前散在 4 处的硬编码字面值统一到本
 * SSoT 包，让 image 硬上限 / 软上限 / 临时通道文档上限**所有调用方**都从这里
 * import。
 *
 * 历史散落点（已全部 import 本文件常量）：
 *   1. `packages/action-tools/src/tools/tabcode/index.ts::MAX_IMAGE_FILE_BYTES_HARD`
 *   2. `packages/agent-runtime/src/tools/image-resize.ts::IMAGE_RESIZE_TRIGGER_BYTES`
 *   3. `packages/agent-runtime/src/tools/image-resize.ts::MAX_IMAGE_FILE_BYTES_HARD`
 *   4. `apps/tabtin_django/apps/services/docparse/temp_parse_api.py::MAX_FILE_BYTES`
 *      （Python 端通过 SSoT 文档同步，不直接 import；本 const 是真相源，py
 *      变更必须同步注释引用）
 *   5. `packages/agent-runtime/src/tools/tabcode-adapter.ts::LOCAL_DOC_PARSE_MAX_FILE_SIZE_MB`
 *
 * **变更上限时**：直接改本文件常量即可，所有 4 处自动跟随；不再有"改一处忘
 * 另一处"的 race（反思 §八 #9 同款问题在 size 维度的预防）。
 */

/**
 * 图片缩放触发阈值（字节）。> 该值走 sharp 长边 2048px JPEG 90% 缩放。
 * 5MB 是 GPT-4V / Claude 单图 token 估算的甜区——再大也是浪费 base64 体积，
 * tile/pixel 计算本来就有 cap（OpenAI 2048×2048 / Anthropic 1568×1568）。
 */
export const IMAGE_RESIZE_TRIGGER_BYTES = 5 * 1024 * 1024;

/**
 * 图片硬上限（字节）。> 该值无论缩放都拒。
 * 50MB 给"用户拍的高分辨率手机照片 / RAW 转 PNG"留 headroom，再大就强烈建议
 * 走 chat 上传走云端 OSS（无大小限制）。
 */
export const MAX_IMAGE_FILE_BYTES_HARD = 50 * 1024 * 1024;

/**
 * 文档硬上限（字节）。临时通道（read_file）与持久通道（chat 上传）共享同一
 * 上限。> 该值走 SSoT `FILE_TOO_LARGE` envelope 引导用户分页 / 走异步 RAG。
 */
export const MAX_DOC_FILE_BYTES_HARD = 50 * 1024 * 1024;

// ─── 派生数（MB 单位，给 i18n / LLM-facing message 用） ───────────────
export const IMAGE_RESIZE_TRIGGER_MB = IMAGE_RESIZE_TRIGGER_BYTES / (1024 * 1024);
export const MAX_IMAGE_FILE_MB_HARD = MAX_IMAGE_FILE_BYTES_HARD / (1024 * 1024);
export const MAX_DOC_FILE_MB_HARD = MAX_DOC_FILE_BYTES_HARD / (1024 * 1024);
