import { randomUUID } from 'node:crypto'
import { StreamEvents } from '../engine/contracts/stream-events.js';

import { jsonError } from '../capability/core/_utils.js'
import {
  HOST_UNSUPPORTED,
  INVALID_PARAM_FORMAT,
  REQUEST_TIMEOUT,
} from '../engine/errors/error-kinds.js'
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  Message,
  ToolUseBlock,
} from '../engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { str, arr, obj, toolInput } from './schema.js'
import { createInterruptAdapter } from '../permissions/interrupt-adapter.js'
import {
  HitlInteractionEvent,
  hitlMessageId,
  type HitlKind,
} from '../event/events/persist-events.js'
import { EventEmitter } from '../event/event-emitter.js'
import {
  AskRequiredEvent,
  SingleHitlResolvedEvent,
  type AskRequiredEventType,
} from '../event/events/hitl-events.js'
import {
  persistCurrentAssistantForHitlResume,
  requireAgentRunId,
} from '../permissions/hitl-persist.js'

/** ask 三件套事件 → HITL kind（与 Django relay `_SINGLE_HITL_INTERACTION_KIND_BY_EVENT` 一致）。 */
const HITL_KIND_BY_EVENT: Record<string, HitlKind> = {
  [StreamEvents.ASK_USER_REQUIRED]: 'ask_choice',
  [StreamEvents.ASK_FORM_REQUIRED]: 'ask_form',
  [StreamEvents.REQUEST_APPROVAL_REQUIRED]: 'permission_request',
}

/**
 * ask-tools.ts — Ask 工具协议演进（W7 → W4 → W4 R3 / 2026-05-11 →  / 2026-07-08）
 *
 * 历史：
 *   - W5/W7 上线时拆 `ask_choice` / `ask_form` / `request_approval` 三件套
 *   - W4（2026-05-11 上午）合并三件套为单 `ask_user`（questions[] + Other + header chip）
 *   - W4 R3（2026-05-11 dogfood 审计后）拆回多工具并存——纯 CLI 选型工具不需要
 *     表单 / 显式授权 UI；TabTin 是平台型产品，`ask_form`（11 种字段类型）与
 *     `request_approval`（risk_level + destructive 不可逆确认）各有独立产品语义，
 *     不可合并。
 *   - （2026-07-08）下架 `request_approval`——它的批准结果只是文本回流对话、
 *     不授予任何权限，后续具体工具调用仍会触发系统拦截（judge 管线），造成同一
 *     动作双重审批。高危动作安全兜底完全由系统拦截承担；意图级确认由 `ask_user`
 *     或纯文本承接。wire schema（RequestApprovalRequestSchema /
 *     REQUEST_APPROVAL_REQUIRED）与各端渲染保留，供历史对话回放。
 *
 *  后形态：**2 个工具并存**：
 *   - `ask_user`：questions[]，单/多选 + 自动 Other 选项 + W4 R2 5 分钟窗口 dedup
 *     守护 + header chip + option.preview。**继承 W4 全部改进**，并兼容
 *     ask_choice 场景。
 *   - `ask_form`：fields[]，复杂结构化表单（input/textarea/upload/toggle/color 等
 *     11 种字段类型），TabTin 平台型产品特有。
 *
 * 两个工具共享：
 *   - W4 R2 dedup 守护（按 toolName + content hash 区分，5 分钟窗口）
 *   - **正向 OUTPUT 文案**（dogfood 实测发现反向 "Do NOT" 指引让 LLM 觉得必须
 *     再确认，是 5 次重复 ask_choice 的根因之一——W4 R3 三件套统一改正向）
 *   - emit / wait / timeout 框架（emitAndWait 多态）
 *
 * `ask_user` 字段约定：
 *   - questions[1-4]；question.{id, prompt, header, options, allow_multiple?}
 *   - option.{id, label, description, preview?}；label/description 均必填
 *   - 可选顶层 title?（卡片标题）；每 question 自带 header chip（≤12 字符）
 *   - OUTPUT：`User has answered your questions: ... You can now continue ...`
 *     （W4 R2 删 Metadata 行后的纯正向单句）
 *   - Description：1 句用途 + 4 use case + 选项规范；plan mode 反向指令由
 *     plan.md `<agent_mode>` 段承载，不进工具 description
 *   - 自动注入 "Other"；无 metadata / annotations
 *
 *   wire 字段（保留但不进 ask_user 工具核心 schema）：
 *   - `preset_id`：composer-routed 字段，runtime 不消费——前端 composer-presets
 *     创建 ask_user 时透传给本侧 emit payload 用于回放路由，不影响 LLM 行为。
 *
 *   - 删除所有 `Do NOT` / `do NOT` 反向指引（host_unsupported / timeout 等
 *     fallback 路径也改成正向 / 中性）
 *   - dogfood 实测 Kimi 5 次重复 ask_choice 根因：三件套 schema 复杂 + 反向文案。
 *     合一后 schema 简洁、文案正向，LLM 重复发问应自然消失。
 *
 * W4 R2 必修 1：session-scoped 重复检测——dogfood Kimi 5 次 hash 一致重复发问
 *   是极端 case（LLM 卡循环 / 用户切模型 / 长会话漂移），即使 schema/文案 W4
 *   到位仍可能出现。本守护：同 session 内 5 分钟窗口同 hash 拒绝重新 emit
 *   stream event，直接返回合成正向 OUTPUT 复用上次答案——切断"同问反复弹卡"
 *   反模式。详见 `findRecentAnswer` / `recordAnswer`。
 */

export interface AskToolsDeps {
  emitStreamEvent?: (event: StreamEvent) => void
}

const ASK_USER_TIMEOUT_MS = 30 * 60 * 1000
const ASK_TOOL_EXECUTION_GRACE_MS = 5 * 1000
const OTHER_OPTION_ID = '__other__'
const DEFAULT_OTHER_OPTION = {
  id: OTHER_OPTION_ID,
  label: 'Other',
  description: 'Use a custom answer not covered by the listed options.',
} as const
const MAX_LLM_VALUE_CHARS = 2000
const TEXT_LIKE_FIELD_TYPES = new Set(['input', 'number', 'textarea', 'tags'])

/**
 * Tool description — 用途一句 + 四 use case + 选项规范。
 * Plan mode 反向指令由 plan.md `<agent_mode>` 段承载，不在工具 description
 * 里重复——避免每个工具都背一段 plan-only 文字。
 */
// ：工具描述只保留用途与参数硬约束；是否追问、何时用自然语言等协作节奏
// 统一由 system prompt 的 execution 段负责，避免双真源再次漂移。
const ASK_USER_DESCRIPTION =
  '让用户从 2-4 个具体选项里选一个。最适合方向性分叉（架构选型、技术栈、命名、范围等答案可枚举的决策点）。\n\n' +
  '**4 种典型场景**：\n' +
  '1. 收集用户偏好或需求\n' +
  '2. 澄清模糊的指令\n' +
  '3. 在工作过程中拿到实现层面的决策\n' +
  '4. 给用户提供"接下来往哪走"的选项\n\n' +
  '**选项规范**：\n' +
  '- 每个选项必须同时给 `label`（≤5 词短标签）+ `description`（说明"选这个会发生什么 / 取舍是什么"）。\n' +
  '- 系统自动追加「其他」。定制其文案时填 `other_option`（与 option 同字段：`label`/`description`，可选 `id`/`preview`；`id` 可省略）。不填用内置文案。不要把「其他」写进 `options`。\n' +
  '- 如果你推荐某个选项，把它放在第一个，label 末尾加 `(Recommended)`。\n' +
  '- 互斥方案用单选；可组合的特性用 `allow_multiple: true`。\n' +
  '- 一次调用最多 1-4 个相关问题（紧密相关的决策合并到同一次调用，节省往返）。\n\n' +
  '**本工具用于**：用户从有限**选项**里选。\n' +
  '**不是**：让用户填写密码 / URL / 多个文本字段；也不是对已决定动作的批准/拒绝。'

const ASK_FORM_DESCRIPTION =
  '让用户填多个具体字段（文本 / 数字 / URL / 凭证 / 日期等不可枚举为选项的值）。\n\n' +
  '**用法**：\n' +
  '- 每个文本类字段必须有非空的 `description` 或 `placeholder`，让用户知道该填什么形式。\n' +
  '- 只合并属于**同一表单**的字段（譬如"域名 + 上线日期 + 关键词"）；跨主题的字段拆成多次。\n' +
  '- 字段类型用 `input` / `number` / `textarea` / `select` / `multiselect` / `upload` / `toggle` / `slider` / `color` / `tags` / `group` 之一。\n\n' +
  '**本工具用于**：用户需提供具体值的多字段表单。\n' +
  '**不是**：从 2-4 个选项里选。'

// 阶段 6.6 议题 3 翻译 + 瘦身：保留 snake_case 字段名 / `ask_user` 工具名 /
// 缩写 UI / ASCII 等；自然语言翻译成中文；超 budget 的 prompt / options /
// preview 同步瘦身（示例搬到工具 description，硬契约留在字段）。
const askUserOptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: '本选项的稳定标识符（UI 用来追踪选择）。' },
    label: { type: 'string', minLength: 1, description: '用户看到并选择的显示文案。简洁（1-5 词）描述选项。' },
    description: { type: 'string', minLength: 1, description: '本选项的含义或选中后会发生什么。用来传达取舍 / 影响等上下文。' },
    preview: { type: 'string', description: '可选预览内容，选项聚焦时渲染（譬如 ASCII mockup / 代码片段 / 图示变体），方便对比选项。' },
  },
  required: ['id', 'label', 'description'],
  additionalProperties: false,
} as const

const askUserQuestionSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: '本问题的稳定标识符（UI / 响应 payload 用来对应答案）。',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      description: '要问用户的完整问题。清晰、具体、以问号结尾。',
    },
    header: {
      type: 'string',
      minLength: 1,
      maxLength: 12,
      description: '极简标签（≤12 字符），UI 显示为 chip / tag。譬如"认证方式" / "库" / "方案"。',
    },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: askUserOptionSchema,
      description: '可选项（2-4 个具体业务项）。彼此互斥，除非 allow_multiple=true。不要把「其他」写进这里——用 other_option 定制，或省略以用内置文案。',
    },
    other_option: {
      type: 'object',
      properties: {
        ...askUserOptionSchema.properties,
        id: {
          type: 'string',
          minLength: 1,
          description: '固定 `__other__`；可省略，系统会补上。',
        },
      },
      required: ['label', 'description'],
      additionalProperties: false,
      description: '可选。定制本问「其他」文案（与 option 同字段）。不传则用内置文案。',
    },
    allow_multiple: {
      type: 'boolean',
      default: false,
      description: '设为 true 允许用户多选；适合选项之间不互斥的场景。',
    },
  },
  // W4 R2 (P2-6) header 改 required（AskUserQuestion 协议）—— LLM
  // 不传 header 时 UI 没 chip，体感空 / 信息密度低；强制后 LLM 必须想清楚分类。
  required: ['id', 'prompt', 'header', 'options'],
  additionalProperties: false,
} as const

const askUserInputSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: askUserQuestionSchema,
      description: '要问用户的问题（1-4 个）。',
    },
    title: {
      type: 'string',
      description: '可选的问题卡片整体标题（面向用户）。缺省时 UI 用默认本地化标题。',
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as unknown as Tool['inputSchema']

// ─── ask_form schema（W4 R3 拆回三件套，恢复自 HEAD W7 实现）──────────

// ask_form 字段控件类型枚举（顺序即 LLM 看到的枚举顺序，勿随意调换）。
const ASK_FORM_FIELD_TYPES = [
  'input', 'number', 'textarea', 'select', 'multiselect',
  'upload', 'toggle', 'slider', 'color', 'tags', 'group',
] as const

/**
 * ：LLM 面向 ask_form schema 刻意瘦身——只暴露语义字段；i18n / 布局 /
 * visible_when / addons 等程序字段留在 composer preset 或 wire passthrough，
 * 不由 Agent FC 填写。`key` / placeholder / option.id 缺省时由 execute 补全。
 * items 不设 additionalProperties:false，对齐 todo，降低弱模型 nested 填充难度。
 */
const askFormFieldOptionSchema = obj({
  properties: {
    label: str({ minLength: 1, description: '选项显示文案。' }),
    id: str({ minLength: 1, description: '选项值标识符；可省略，会从显示文案自动生成。' }),
  },
  required: ['label'],
})

const askFormFieldSchema = obj({
  properties: {
    label: str({ minLength: 1, description: '用户看到的字段名或问题（必填）。' }),
    key: str({ minLength: 1, description: '字段稳定标识键；可省略，会从字段名自动生成。' }),
    title: str({ minLength: 1, description: '`label` 的别名；会归一化为字段名。' }),
    prompt: str({ minLength: 1, description: '`label` 的别名；适合把问题句写成表单字段。' }),
    question: str({ minLength: 1, description: '`label` 的别名；适合把问题句写成表单字段。' }),
    text: str({ minLength: 1, description: '`label` 的别名；会归一化为字段名。' }),
    name: str({ minLength: 1, description: '`key` / `label` 的别名；没有 label 时也可作为字段名。' }),
    id: str({ minLength: 1, description: '`key` 的别名；会归一化为字段稳定标识键。' }),
    type: str({
      enum: ASK_FORM_FIELD_TYPES,
      default: 'input',
      description: '控件类型，默认单行文本。',
    }),
    placeholder: str({
      description: '输入框占位提示；文本类可省略，会用字段名兜底。',
    }),
    description: str({ description: '字段说明（与占位提示二选一即可）。' }),
    options: arr(askFormFieldOptionSchema, {
      description: '下拉或多选时的选项列表。',
    }),
  },
})

const askFormInputSchema = toolInput({
  properties: {
    title: str({ minLength: 1, description: '表单的具体标题（面向用户）。' }),
    fields: arr(askFormFieldSchema, {
      minItems: 1,
      description:
        '表单字段数组；每项至少含 `label`，或含 `prompt` / `question` / `text` / `title` / `name` 之一作为字段名；禁止空对象 `{}`。' +
        '例：`[{"label":"今天的目标","type":"textarea"}]`',
    }),
  },
  required: ['title', 'fields'],
  additionalProperties: false,
})

export function createAskTools(deps: AskToolsDeps): Tool[] {
  return [createAskUserTool(deps), createAskFormTool(deps)]
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNonEmpty(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = nonEmpty(record[key])
    if (value) return value
  }
  return ''
}

/**
 * 校验失败 → 返回 jsonError ToolResult。
 * `toolName` 可选（默认 'ask_user'），ask_user / ask_form 共用此 helper。
 */
function validationError(field: string, message: string, toolName: string = 'ask_user'): ToolResult {
  return jsonError(`${toolName}: ${message}`, {
    error_kind: INVALID_PARAM_FORMAT,
    field,
    hint: 'Rewrite the request with concrete, user-facing text. Each option / field needs non-empty label and description.',
  })
}

function ensureUnique(values: string[], field: string, toolName: string = 'ask_user'): ToolResult | null {
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.trim().toLowerCase()
    if (seen.has(key)) {
      return validationError(field, `duplicate value "${value}" is not allowed`, toolName)
    }
    seen.add(key)
  }
  return null
}

function isEmptyAskFormField(field: Record<string, unknown>): boolean {
  return Object.keys(field).length === 0
}

function isAskFormFieldType(value: unknown): value is (typeof ASK_FORM_FIELD_TYPES)[number] {
  return typeof value === 'string' && (ASK_FORM_FIELD_TYPES as readonly string[]).includes(value)
}

/** 从 label 生成 ASCII/Unicode 字母数字 slug，供缺省 key / option.id 使用。 */
function slugifyAskFormToken(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return slug || 'field'
}

/** 在 session 内保证 key / option.id 唯一（小写比较）。 */
function allocateUniqueAskFormKey(base: string, usedKeys: Set<string>): string {
  const trimmed = base.trim()
  let candidate = trimmed || 'field'
  if (!usedKeys.has(candidate.toLowerCase())) {
    usedKeys.add(candidate.toLowerCase())
    return candidate
  }
  let suffix = 2
  while (usedKeys.has(`${candidate}_${suffix}`.toLowerCase())) suffix++
  candidate = `${candidate}_${suffix}`
  usedKeys.add(candidate.toLowerCase())
  return candidate
}

function enrichAskFormOptions(
  options: unknown,
  usedOptionIds: Set<string>,
): unknown {
  if (!Array.isArray(options)) return options
  return options.map(opt => {
    if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return opt
    const record = opt as Record<string, unknown>
    const label = nonEmpty(record.label)
    let id = nonEmpty(record.id)
    const next: Record<string, unknown> = { ...record }
    if (label) next.label = label
    if (!id && label) id = allocateUniqueAskFormKey(slugifyAskFormToken(label), usedOptionIds)
    else if (id) id = allocateUniqueAskFormKey(id, usedOptionIds)
    if (id) next.id = id
    return next
  })
}

/** ask_form title 校验 */
function validateTitle(toolName: string, title: unknown): ToolResult | null {
  if (!nonEmpty(title)) {
    return validationError('title', '`title` must be non-empty', toolName)
  }
  return null
}

/** ask_form 字段校验（11 种字段类型 + 文本类必填 description / placeholder） */
function validateFields(toolName: string, fields: unknown): ToolResult | null {
  const list = Array.isArray(fields) ? (fields as Array<Record<string, unknown>>) : []
  if (list.length === 0) {
    return validationError('fields', '`fields` must contain at least one field', toolName)
  }
  for (let i = 0; i < list.length; i++) {
    const fieldError = validateField(toolName, list[i], i)
    if (fieldError) return fieldError
  }
  const keyError = ensureUnique(list.map(f => nonEmpty(f.key)), 'fields[*].key', toolName)
  if (keyError) return keyError
  return null
}

function validateField(
  toolName: string,
  field: Record<string, unknown>,
  index: number,
): ToolResult | null {
  if (isEmptyAskFormField(field)) {
    return validationError(
      `fields[${index}]`,
      'field is empty; provide at least a non-empty label for each field',
      toolName,
    )
  }
  if (!nonEmpty(field.label)) {
    return validationError(
      `fields[${index}].label`,
      "each field needs a non-empty 'label' (the user-facing field name); if you used 'title' or 'text', rename it to 'label'",
      toolName,
    )
  }
  if (!nonEmpty(field.key)) {
    return validationError(
      `fields[${index}].key`,
      "each field needs a non-empty 'key' after normalization; provide 'key' or a distinct 'label' so runtime can derive one",
      toolName,
    )
  }
  const fieldType = typeof field.type === 'string' ? field.type : 'input'
  if (TEXT_LIKE_FIELD_TYPES.has(fieldType) && !nonEmpty(field.description) && !nonEmpty(field.placeholder)) {
    return validationError(
      `fields[${index}]`,
      'text-like fields (input/number/textarea/tags) require a non-empty description or placeholder',
      toolName,
    )
  }
  return validateFieldOptions(toolName, field.options, index)
}

function validateFieldOptions(
  toolName: string,
  rawOptions: unknown,
  fieldIndex: number,
): ToolResult | null {
  if (!Array.isArray(rawOptions)) return null
  const options = rawOptions as Array<Record<string, unknown>>
  for (let j = 0; j < options.length; j++) {
    if (!nonEmpty(options[j].id)) return validationError(`fields[${fieldIndex}].options[${j}].id`, 'option id must be non-empty', toolName)
    if (!nonEmpty(options[j].label)) return validationError(`fields[${fieldIndex}].options[${j}].label`, 'option label must be non-empty', toolName)
  }
  const optionIdError = ensureUnique(options.map(o => nonEmpty(o.id)), `fields[${fieldIndex}].options[*].id`, toolName)
  if (optionIdError) return optionIdError
  const labelError = ensureUnique(options.map(o => nonEmpty(o.label)), `fields[${fieldIndex}].options[*].label`, toolName)
  if (labelError) return labelError
  return null
}

/**
 *  / ：ask_form 字段 enrich —— LLM 只填语义（label / type /
 * placeholder），runtime 补 key、默认 type、文本类 placeholder，以及 select 选项
 * id。保留 name→key、title/prompt/question/text→label 等别名归一化，避免模型把
 * "问题字段"按 ask_user/AskQuestion 习惯写成 prompt/id 时直接卡死。
 */
function enrichAskFormFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields
  const usedFieldKeys = new Set<string>()
  return fields.map(raw => enrichAskFormField(raw, usedFieldKeys))
}

function enrichAskFormField(raw: unknown, usedFieldKeys: Set<string>): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const field = raw as Record<string, unknown>
  if (isEmptyAskFormField(field)) return field
  const identity = normalizeAskFormFieldIdentity(field, usedFieldKeys)

  const next: Record<string, unknown> = { ...field, type: identity.fieldType }
  if (identity.label) next.label = identity.label
  if (identity.key) next.key = identity.key

  applyAskFormTextPlaceholder(next, field, identity)

  if (field.options !== undefined) {
    next.options = enrichAskFormOptions(field.options, new Set<string>())
  }

  return next
}

function normalizeAskFormFieldIdentity(
  field: Record<string, unknown>,
  usedFieldKeys: Set<string>,
): { label: string; key: string; fieldType: (typeof ASK_FORM_FIELD_TYPES)[number] } {
  const label = firstNonEmpty(field, ['label', 'title', 'prompt', 'question', 'text', 'name'])
  const rawKey = firstNonEmpty(field, ['key', 'name', 'id'])
  const fieldType = isAskFormFieldType(field.type) ? field.type : 'input'
  const key = rawKey
    ? allocateUniqueAskFormKey(rawKey, usedFieldKeys)
    : label
      ? allocateUniqueAskFormKey(slugifyAskFormToken(label), usedFieldKeys)
      : ''
  return { label, key, fieldType }
}

function applyAskFormTextPlaceholder(
  next: Record<string, unknown>,
  field: Record<string, unknown>,
  identity: { label: string; fieldType: string },
): void {
  if (!TEXT_LIKE_FIELD_TYPES.has(identity.fieldType)) return
  const placeholder = nonEmpty(field.placeholder)
  const description = nonEmpty(field.description)
  if (!placeholder && !description && identity.label) next.placeholder = identity.label
}

/** 收集 ask_form fields[].key → label 映射（含 addons 内嵌 fields），用于 OUTPUT 结果文案显示 */
function collectFieldLabels(fields: unknown): Map<string, string> {
  const labels = new Map<string, string>()
  const list = Array.isArray(fields) ? (fields as Array<Record<string, unknown>>) : []
  for (const field of list) {
    const key = nonEmpty(field.key)
    const label = nonEmpty(field.label)
    if (key && label) labels.set(key, label)
  }
  return labels
}

type NormalizedOption = { id: string; label: string; description: string; preview?: string }

interface NormalizedQuestion {
  id: string
  prompt: string
  header: string
  allow_multiple: boolean
  /**
   * W4：保留字段以兼容前端 wire schema —— `allow_free_text` 历史用于
   * 决定是否渲染 free-text input。W4 后该字段恒为 true（自动注入的
   * "Other" 选项 = 自由文本入口），前端按选中 Other 弹出 input。
   */
  allow_free_text: boolean
  /** Agent 定制的「其他」文案；未传时不出现在 payload，前端走内置 i18n。 */
  other_option?: NormalizedOption
  options: NormalizedOption[]
}

function isOtherOptionLike(option: Pick<NormalizedOption, 'id' | 'label'>): boolean {
  return option.id === OTHER_OPTION_ID || option.label.toLowerCase() === 'other'
}

function toNormalizedOption(raw: Record<string, unknown>, id: string): NormalizedOption {
  const opt: NormalizedOption = {
    id,
    label: nonEmpty(raw.label),
    description: nonEmpty(raw.description),
  }
  if (typeof raw.preview === 'string' && raw.preview.trim()) opt.preview = raw.preview
  return opt
}

/** 解析 questions[].other_option；未传返回 undefined。 */
function parseCustomOtherOption(
  raw: unknown,
  field: string,
): { option?: NormalizedOption; error?: ToolResult } {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: validationError(field, 'other_option must be an object') }
  }
  const record = raw as Record<string, unknown>
  if (!nonEmpty(record.label)) {
    return { error: validationError(`${field}.label`, 'other_option label must be non-empty') }
  }
  if (!nonEmpty(record.description)) {
    return {
      error: validationError(`${field}.description`, 'other_option description must be non-empty'),
    }
  }
  return { option: toNormalizedOption(record, OTHER_OPTION_ID) }
}

function normalizeQuestions(input: unknown): { questions?: NormalizedQuestion[]; error?: ToolResult } {
  const questions = Array.isArray(input) ? (input as Array<Record<string, unknown>>) : []
  if (questions.length < 1 || questions.length > 4) {
    return { error: validationError('questions', '`questions` must contain 1-4 questions') }
  }
  const idError = ensureUnique(questions.map(q => nonEmpty(q.id)), 'questions[*].id')
  if (idError) return { error: idError }
  const promptError = ensureUnique(questions.map(q => nonEmpty(q.prompt)), 'questions[*].prompt')
  if (promptError) return { error: promptError }

  const normalized: Array<NormalizedQuestion | { error: ToolResult }> = questions.map((q, i) => {
    if (!nonEmpty(q.id)) {
      return { error: validationError(`questions[${i}].id`, 'question id must be non-empty') }
    }
    if (!nonEmpty(q.prompt)) {
      return { error: validationError(`questions[${i}].prompt`, 'question prompt must be non-empty') }
    }
    // W4 R2 (P2-6): header required，LLM 必须为每个 question 提供一个简短 chip 标签。
    if (!nonEmpty(q.header)) {
      return { error: validationError(`questions[${i}].header`, 'question header must be non-empty (max 12 chars chip / tag)') }
    }
    const options = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []
    if (options.length < 2 || options.length > 4) {
      return { error: validationError(`questions[${i}].options`, 'each question must have 2-4 options before the automatic Other option') }
    }
    const optionLabelError = ensureUnique(options.map(o => nonEmpty(o.label)), `questions[${i}].options[*].label`)
    if (optionLabelError) return { error: optionLabelError }
    const optionIdError = ensureUnique(options.map(o => nonEmpty(o.id)), `questions[${i}].options[*].id`)
    if (optionIdError) return { error: optionIdError }
    for (let j = 0; j < options.length; j++) {
      if (!nonEmpty(options[j].id)) {
        return { error: validationError(`questions[${i}].options[${j}].id`, 'option id must be non-empty') }
      }
      if (!nonEmpty(options[j].label)) {
        return { error: validationError(`questions[${i}].options[${j}].label`, 'option label must be non-empty') }
      }
      if (!nonEmpty(options[j].description)) {
        return { error: validationError(`questions[${i}].options[${j}].description`, 'option description must be non-empty') }
      }
    }

    const parsedOther = parseCustomOtherOption(q.other_option, `questions[${i}].other_option`)
    if (parsedOther.error) return { error: parsedOther.error }
    const customOther = parsedOther.option
    const resolvedOther = customOther ?? { ...DEFAULT_OTHER_OPTION }

    // 注入 Other：options 里已有则不重复追加；若同时给了 other_option 则覆盖其文案。
    const baseOptions = options.map(o => toNormalizedOption(o, nonEmpty(o.id)))
    const hasOther = baseOptions.some(isOtherOptionLike)
    const nextOptions = hasOther
      ? (customOther
        ? baseOptions.map(o => (isOtherOptionLike(o) ? resolvedOther : o))
        : baseOptions)
      : [...baseOptions, resolvedOther]

    const result: NormalizedQuestion = {
      id: nonEmpty(q.id),
      prompt: nonEmpty(q.prompt),
      header: nonEmpty(q.header),
      allow_multiple: q.allow_multiple === true,
      allow_free_text: true,
      options: nextOptions,
    }
    if (customOther) result.other_option = customOther
    return result
  })

  const firstError = normalized.find((q): q is { error: ToolResult } => 'error' in q)
  if (firstError) return { error: firstError.error }
  return { questions: normalized as NormalizedQuestion[] }
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '(empty)'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '(empty)'
  if (Array.isArray(value)) {
    return value.map(displayValue).join(', ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function textSnippet(value: unknown): string {
  const text = displayValue(value).replace(/\s+/g, ' ').trim()
  return text.length > MAX_LLM_VALUE_CHARS ? `${text.slice(0, MAX_LLM_VALUE_CHARS - 3)}...` : text
}

function quoteText(value: unknown): string {
  return `"${textSnippet(value).replace(/"/g, '\\"')}"`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * 构造 OUTPUT 文案。
 *
 * OUTPUT 文案遵循 AskUserQuestion 协议
 * `mapToolResultToToolResultBlockParam`：
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now
 *    continue with the user's answers in mind.`
 *
 * **W4 R2 P2-5**：删除 TabTin 自创的 `Metadata: status=...; tool=ask_user;
 * request_id=<uuid>.` 末尾行 —— 采用纯正向单句。
 * - LLM 可能误把 `request_id=<uuid>` 当工具 ID 触发 dogfood 死循环（W3 同模式）
 * - telemetry 走 stream events / trace（保留 request_id 在事件 payload）
 *
 * 各类响应统一走正向单句：
 *   - 用户回答 → answered（带答案明细）
 *   - 用户跳过 / 没选 → skipped（提示继续 best available）
 *   - host 不支持 / 超时 → 错误结构化（hint 也是中性而非反向）
 *
 * **删除所有 `Do NOT call X again` / `Do NOT proceed` / `do NOT request` 反向
 * 指引**——dogfood 实测发现这些反向句反而让 LLM 觉得"我必须再确认一次以免
 * 出错"，是 5 次重复 ask_choice 的根因之一。
 */
function formatSkippedResult(toolName: string, title: string): string {
  return (
    `User skipped your ${toolName} request${title ? ` ${quoteText(title)}` : ''}. ` +
    `Treat this as no answer and continue with the best available information; ` +
    `if you still need an answer, ask a different question.`
  )
}

/**
 * ask_form OUTPUT 文案（W4 R3 拆回三件套，正向）。
 * 对照 HEAD 中 formatAskFormResult：删除"Continue with the user's answer in mind"
 * 后跟的 metadata 行（W4 R2 P2-5：metadata 行让 LLM 误把 request_id 当工具 ID）。
 */
function formatAskFormResult(payload: { title?: string; fields?: unknown; addons?: unknown }, response: unknown): string {
  const title = nonEmpty(payload.title)
  const data = asRecord(response)
  if (data.skipped === true) return formatSkippedResult('ask_form', title)
  if (typeof data.text === 'string' && data.text.trim()) {
    return (
      `User has answered your ask_form request${title ? ` ${quoteText(title)}` : ''} ` +
      `with free text: ${quoteText(data.text)}. ` +
      `You can now continue with the user's answer in mind.`
    )
  }
  const labels = collectFieldLabels(payload.fields)
  const addons = Array.isArray(payload.addons) ? (payload.addons as Array<Record<string, unknown>>) : []
  for (const addon of addons) {
    const addonLabels = collectFieldLabels(addon.fields)
    for (const [key, label] of addonLabels) labels.set(key, label)
  }
  const fieldValues = asRecord(data.field_values)
  const parts = Object.entries(fieldValues).map(([key, value]) => {
    const label = labels.get(key) ?? key
    return `${quoteText(label)} (${key}) = ${quoteText(value)}`
  })
  if (parts.length === 0) {
    return (
      `User submitted your ask_form request${title ? ` ${quoteText(title)}` : ''} ` +
      `without explicit field values: ${quoteText(response)}. ` +
      `You can now continue with the best available information.`
    )
  }
  return (
    `User has answered your ask_form request${title ? ` ${quoteText(title)}` : ''}: ` +
    `${parts.join('; ')}. You can now continue with the user's answers in mind.`
  )
}

function formatAnsweredResult(
  payload: { title?: string; questions: NormalizedQuestion[] },
  response: unknown,
): string {
  const data = asRecord(response)
  const title = nonEmpty(payload.title)

  if (data.skipped === true) return formatSkippedResult('ask_user', title)

  // 历史兼容：用户用纯文本作答（旧 UI 退化路径）→ 统一进 free-text 描述。
  if (typeof data.text === 'string' && data.text.trim()) {
    return (
      `User has answered your ask_user request${title ? ` ${quoteText(title)}` : ''} ` +
      `with free text: ${quoteText(data.text)}. ` +
      `You can now continue with the user's answer in mind.`
    )
  }

  const questionById = new Map(payload.questions.map(q => [q.id, q]))
  const answerRows = Array.isArray(data.answers) ? (data.answers as Array<Record<string, unknown>>) : []

  const parts = answerRows.map(answer => {
    const questionId = nonEmpty(answer.question_id)
    const question = questionById.get(questionId)
    const prompt = nonEmpty(question?.prompt) || questionId || 'question'
    const options = question?.options ?? []
    const optionLabels = new Map(options.map(option => [option.id, option.label || option.id]))
    const selected = Array.isArray(answer.selected_options)
      ? (answer.selected_options as unknown[]).map(id => optionLabels.get(nonEmpty(id)) || nonEmpty(id)).filter(Boolean)
      : []
    const freeText = nonEmpty(answer.free_text)
    const values = [...selected]
    if (freeText) values.push(`free text: ${freeText}`)
    return `${quoteText(prompt)}=${quoteText(values.length > 0 ? values.join(', ') : 'no selection')}`
  })

  if (parts.length === 0) {
    // 兜底：响应不带结构化 answers，直接透传响应文本。
    return (
      `User has answered your ask_user request${title ? ` ${quoteText(title)}` : ''}: ` +
      `${quoteText(response)}. You can now continue with the user's answers in mind.`
    )
  }

  return (
    `User has answered your questions${title ? ` for ${quoteText(title)}` : ''}: ${parts.join(', ')}. ` +
    `You can now continue with the user's answers in mind.`
  )
}

// ─── W4 R2 必修 1：session-scoped 重复检测 ──────────────────────────
//
// 设计：
// - 同 sessionId 内，同 questions content hash 在 5 分钟窗口内被拒绝重新
//   emit stream event；直接返回合成 OUTPUT 引用上次答案。
// - hash 计算只含用户可见 questions 语义（prompt / header / options label+description /
//   allow_multiple），**不含**模型自造关联键（question.id / option.id）、
//   request_id / timestamp 等不稳定字段。
// - per-sessionId 缓存最多 50 条（FIFO 截断防内存泄漏）。
// - 测试用 `__resetAskUserDedupForTest()` 清空（生产代码禁调）。
//
// dogfood 实测：Kimi session 22773860 出现 5 次完全 hash 一致的 ask_choice
// 重复发问。即使 W4 schema 简化 + 文案正向后，极端 case（LLM 卡循环 / 用户
// 切模型 / 长会话漂移）仍可能发生。本守护是 W4 R2 必修 1 的最后一道防线。

const ASK_USER_DEDUP_WINDOW_MS = 5 * 60 * 1000
const ASK_USER_DEDUP_MAX_PER_SESSION = 50

interface AskUserDedupEntry {
  hash: string
  /** 上次的 OUTPUT 文案（已对应 W4 正向格式，不含 metadata 行）。 */
  lastAnswer: string
  ts: number
}

const askUserDedupBySessionId: Map<string, AskUserDedupEntry[]> = new Map()

function buildQuestionsHash(questions: NormalizedQuestion[]): string {
  // 稳定 JSON：保留 question / option 顺序（顺序变化对用户也是不同问法），
  // 但 strip 掉关联键和视觉辅助字段。`question.id` / `option.id` 是 UI
  // 回答关联键，不是用户可见语义；把它们放进 hash 会让模型每轮自增 id
  // 时绕过同问题 dedup。
  return JSON.stringify(
    questions.map(q => ({
      prompt: q.prompt,
      header: q.header,
      allow_multiple: q.allow_multiple,
      options: q.options.map(o => ({ label: o.label, description: o.description })),
    })),
  )
}

function findRecentAnswer(sessionId: string, hash: string, now: number): string | null {
  const entries = askUserDedupBySessionId.get(sessionId)
  if (!entries || entries.length === 0) return null
  const fresh = entries.filter(e => now - e.ts < ASK_USER_DEDUP_WINDOW_MS)
  if (fresh.length !== entries.length) {
    if (fresh.length === 0) askUserDedupBySessionId.delete(sessionId)
    else askUserDedupBySessionId.set(sessionId, fresh)
  }
  const hit = fresh.find(e => e.hash === hash)
  return hit ? hit.lastAnswer : null
}

function recordAnswer(sessionId: string, hash: string, lastAnswer: string, now: number): void {
  const prev = askUserDedupBySessionId.get(sessionId) ?? []
  const fresh = prev.filter(e => now - e.ts < ASK_USER_DEDUP_WINDOW_MS)
  // 同 hash 已存在 → 更新 ts/answer
  const idx = fresh.findIndex(e => e.hash === hash)
  if (idx >= 0) {
    fresh[idx] = { hash, lastAnswer, ts: now }
  } else {
    if (fresh.length >= ASK_USER_DEDUP_MAX_PER_SESSION) fresh.shift()
    fresh.push({ hash, lastAnswer, ts: now })
  }
  askUserDedupBySessionId.set(sessionId, fresh)
}

function formatRecentAnswerResult(prevAnswer: string): string {
  return (
    `User has already answered the same questions recently. ` +
    `Continue with the prior answer in mind.\n` +
    `Prior answer: ${prevAnswer}`
  )
}

// ─── ：连续 ask 熔断（措辞漂移绕过 content-hash 去重的确认死循环）──────
//
// W4 R2 的 content-hash dedup（buildQuestionsHash + findRecentAnswer）只拦「一字
// 不差的重复」。实测（ 快照）模型会把问法轻微改写（「是否继续?」→
// 「继续？」→「是否继续读取文件？」…）绕过 hash，连续 8+ 次弹「是否继续」确认卡，
// 每次用户答「是」后仍继续弹——典型自回归复读循环。
//
// 本守护与 dedup 正交：不看问法内容，只看「同一对话尾部连续多少次只调 ask 工具、
// 期间没有任何实质工具进展」。达到阈值即不再 emit 卡片，返回纠偏 OUTPUT 引导模型
// 直接执行实际下一步或纯文本回复用户。任意非 ask 工具调用都会自然打断连续计数
// （从 context.messages 尾部扫描，无需额外重置 hook）。
//
// 复位信号来自 context.messages：当前 assistant 消息（含本次 ask 的 tool_use）在
// 工具执行前已 push 进 state.messages（query.ts），context.messages 与之同引用，
// 因此尾部扫描即可得到含本次调用在内的连续 ask 次数。

// `request_approval` 已随  下架，保留在集合里是为了 resume 的历史消息
// 尾扫统计仍把它算作 ask 回合（不影响新调用——工具已不注册）。
const ASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user',
  'ask_form',
  'request_approval',
])

const LOGIN_WALL_GATE_MARKER = /<login_wall_gate domain="([^"]+)"(?: tab_id="([A-Za-z0-9_-]{1,128})")?>/

export function detectLoginWallHintFromMessages(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { kind: 'login_wall'; domain: string; tab_id?: string } | null {
  let skippedSelf = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') {
      const hasAsk = Array.isArray(message.content)
        && message.content.some(
          block => block?.type === 'tool_use'
            && (block.name === 'ask_user' || block.name === 'ask_form'),
        )
      if (!hasAsk) continue
      if (!skippedSelf) {
        skippedSelf = true
        continue
      }
      return null
    }
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    const match = LOGIN_WALL_GATE_MARKER.exec(message.content)
    if (match) return {
      kind: 'login_wall',
      domain: match[1]!,
      ...(match[2] ? { tab_id: match[2] } : {}),
    }
  }
  return null
}

// 连续第 N 次「只调 ask 工具、无实质进展」时熔断。取 4：正常编排里
// ask_user → ask_form 这类合法链路最多连着 2-3 次；第 4 次连续
// 无进展的确认已是循环征兆（ 快照实测连续 8+ 次）。
const MAX_CONSECUTIVE_ASK_CALLS = 4

/**
 * 从 messages 尾部数「连续 assistant 回合只调用了 ask 工具」的次数。
 * 遇到以下任一情况即停止（连续被打断）：
 *   - assistant 回合含非 ask 工具的 tool_use（说明做了实质进展）
 *   - assistant 回合没有 tool_use（纯 thinking/text = 回合收尾边界）
 *   - assistant 回合 content 是字符串（无结构化 block）
 * user 消息（tool_result / 注入）跳过，不影响连续性。
 */
function countTrailingConsecutiveAskCalls(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const content = message.content
    if (!Array.isArray(content)) break
    const toolUses = content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    )
    if (toolUses.length === 0) break
    if (!toolUses.every(block => ASK_TOOL_NAMES.has(block.name))) break
    count++
  }
  return count
}

function formatAskLoopBreakerResult(toolName: string, streak: number): string {
  return (
    `You have opened ${streak} interaction cards (ask_user / ask_form) ` +
    `in a row without taking any other action in between — this is a confirmation loop, and this ` +
    `${toolName} card was not shown to the user. Take the concrete next step directly now (call the ` +
    `tool that actually makes progress on the task); if you genuinely cannot proceed without the user, ` +
    `reply to them in plain text summarizing the current state and exactly what you need.`
  )
}

function buildScheduledAskUserResponse(emitPayload: Record<string, unknown>): unknown | null {
  const questions = Array.isArray(emitPayload.questions)
    ? (emitPayload.questions as NormalizedQuestion[])
    : []
  if (questions.length === 0) return null
  return {
    answers: questions.map(question => ({
      question_id: question.id,
      selected_options: [question.options[0]?.id].filter((id): id is string => !!id),
    })),
  }
}

function buildScheduledAskToolResult(args: {
  toolName: 'ask_user' | 'ask_form' | 'request_approval'
  emitPayload: Record<string, unknown>
  hashKey: string
  formatAnswered: (response: unknown) => string
  context: ToolContext
}): ToolResult | null {
  if ((contextRuntimeMode(args.context) !== 'scheduled') || args.toolName !== 'ask_user') {
    return null
  }
  const response = buildScheduledAskUserResponse(args.emitPayload)
  if (!response) return null
  const answerText = args.formatAnswered(response)
  const sessionId = nonEmpty(args.context.threadId)
  if (sessionId) recordAnswer(sessionId, `${args.toolName}:${args.hashKey}`, answerText, Date.now())
  return { content: answerText }
}

function contextRuntimeMode(context: ToolContext): string {
  return context.runtimeMode ?? 'interactive'
}

/** Test-only：清空全部 dedup 缓存。生产代码 **禁止** 调用。 */
export function __resetAskUserDedupForTest(): void {
  askUserDedupBySessionId.clear()
}

/**
 * ask 工具统一 emit + wait 框架（W4 R3）。
 *
 * `toolName` / `eventType` 区分工具；`emitPayload` 是已构造好的 wire payload
 * （含 tool_name / interaction_type / blocking_policy / intent / form_mode 等所有
 * 必填字段）；`hashKey` 用于 W4 R2 dedup（按 toolName + content 区分，避免不同
 * 工具的同 hash 误命中）；`formatAnswered` 把 user response 转成 OUTPUT 文案。
 */
async function emitAndWait(args: {
  toolName: 'ask_user' | 'ask_form'
  eventType: AskRequiredEventType
  emitPayload: Record<string, unknown>
  hashKey: string
  formatAnswered: (response: unknown) => string
  deps: AskToolsDeps
  context: ToolContext
}): Promise<ToolResult> {
  const { toolName, eventType, emitPayload, hashKey, formatAnswered, deps, context } = args
  const emitter = context.emitStreamEvent ?? deps.emitStreamEvent
  //  批次 5：「emit 卡片 + 挂起等人 + 超时」统一走 interrupt 单原语。
  // 主循环构造的 ToolContext 已注入（QueryDeps.interrupt）；直调场景（测试 /
  // 旧宿主）缺席时就地用同一个适配器包 context 原语——单一实现，无第二条路径。
  const interrupt = context.interrupt ?? createInterruptAdapter({
    emitStreamEvent: emitter,
    waitForUserInput: context.waitForUserInput,
    threadId: context.threadId ?? '',
  })
  const runtimeMode = contextRuntimeMode(context)

  const scheduledResult = buildScheduledAskToolResult({
    toolName,
    emitPayload,
    hashKey,
    formatAnswered,
    context,
  })
  if (scheduledResult) return scheduledResult

  if (!emitter || !interrupt.isAvailable()) {
    return jsonError(`${toolName} requires HITL capability which is not available in this host`, {
      error_kind: HOST_UNSUPPORTED,
      status: 'unsupported',
      hint: 'Continue with the best available information, or ask the user directly in plain text only if the answer is still essential.',
    })
  }

  // W4 R2 必修 1：session-scoped 重复检测（按 toolName + content hash 区分）。
  // 三件套共享 dedup 缓存——同业务对话 thread 内 5 分钟窗口同 (toolName, hash)
  // 命中直接返回上次答案合成 OUTPUT，不重新 emit 卡片。
  //
  // 取 `context.threadId`（业务对话维度）而非 `context.runtimeId`
  // —— dedup 是为了"用户对话里同一类问题不要反复弹卡片"，业务 thread 是正确
  // 维度；runtime UUID 每次 createRuntime 都换，dedup 会失效。
  const sessionId = nonEmpty(context.threadId)
  const dedupHash = `${toolName}:${hashKey}`
  const now = Date.now()
  if (sessionId) {
    const recent = findRecentAnswer(sessionId, dedupHash, now)
    if (recent) return { content: formatRecentAnswerResult(recent) }
  }

  // ：连续 ask 熔断——dedup 拦不住措辞漂移的确认循环，这里按「尾部连续只调
  // ask 工具、无实质进展」的次数兜底。达阈值不 emit 卡片，返回纠偏 OUTPUT。
  const consecutiveAskCalls = countTrailingConsecutiveAskCalls(context.messages)
  if (consecutiveAskCalls >= MAX_CONSECUTIVE_ASK_CALLS) {
    return { content: formatAskLoopBreakerResult(toolName, consecutiveAskCalls) }
  }

  const requestId = randomUUID()
  const expiresAt = Date.now() + ASK_USER_TIMEOUT_MS
  // HITL transcript：与主 LLM / 工具产物同一条 persist 管线（buildHitlInteractionPersistEvent
  // → 同 emitter → host eventInterceptor → jsonl + Django）。kind 在此作用域已知，
  // pending / resolved 用同一 message_id upsert 同一行，无需 host 侧翻译层。
  const hitlKind = HITL_KIND_BY_EVENT[eventType]
  // ：卡片 *_required 与落库共用同源 message_id，删前端 hitl-ask-* 合成路径。
  const messageId = hitlKind ? hitlMessageId(hitlKind, requestId) : undefined
  // ：只要会写 HITL transcript，启动前就要有非空 agentRunId（禁止空串降级）。
  const agentRunId = hitlKind
    ? requireAgentRunId(context.agentRunId, `ask-tools.${toolName}`)
    : undefined
  const requestPayload = {
    request_id: requestId,
    expires_at: expiresAt,
    runtime_mode: runtimeMode,
    // （第一刀 · P0 修复）：crash resume 需要用 LLM 的 `tool_use.id`
    // 作 tool_result 的 pairing key（`requestId` 是 runtime 自生 UUID，与
    // assistant tool_use.id 不同）。透传到 HitlInteractionEvent.payload →
    // Django `PendingInteraction.payload.tool_use_id` → resume wire 出站 →
    // restorer 走真实 pairing。context.toolUseId 缺席（旧宿主 / 测试 stub）
    // 时保留 undefined，restorer 会 fallback 到 requestKey（保持旧路径不回归）。
    ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
    ...emitPayload,
    // ：权威 message_id 必须压过 emitPayload，与 persist 同源。
    ...(messageId ? { message_id: messageId } : {}),
  }
  const hitlEvents = new EventEmitter(emitter)
  const emitHitlPersist = (
    status: 'pending' | 'resolved' | 'expired' | 'cancelled',
    result?: Record<string, unknown>,
  ) => {
    if (!hitlKind || !agentRunId) return
    hitlEvents.emit(new HitlInteractionEvent({
      kind: hitlKind,
      requestKey: requestId,
      status,
      payload: requestPayload,
      agentRunId,
      expiresAtMs: expiresAt,
      ...(messageId ? { messageId } : {}),
      ...(result ? { result } : {}),
      ...(status !== 'pending' ? { resolvedAtMs: Date.now() } : {}),
    }))
  }

  // 单 HITL 终态回流（ + ）：挂起结束后对称补发 single_hitl_resolved
  // 让 Django relay 落 PG 终态 + reliable 重广播到 topic，观察镜像 / 其它端
  // 据此收敛关面板。cancelled 出现在 renderer dismiss 走 cancel-hitl IPC 送来
  // `{ cancelled: true }` 响应体的路径（不是超时也不是用户答复）。
  const emitResolved = (
    outcome: 'answered' | 'skipped' | 'expired' | 'cancelled',
    response?: Record<string, unknown>,
  ) => {
    emitter(new SingleHitlResolvedEvent({
        request_id: requestId,
        interrupt_id: requestId,
        ...(sessionId ? { thread_id: sessionId } : {}),
        outcome,
        schema_version: 1,
    }).toStreamEvent())
    // 终态 transcript：按 outcome 分档——
    //   expired  → 'expired'（超时 / waiter reject）
    //   cancelled → 'cancelled'（用户 dismiss / mode 切换 / rollback）
    //   answered / skipped → 'resolved'（用户明确回复）
    const status: 'resolved' | 'expired' | 'cancelled' =
      outcome === 'expired' ? 'expired' :
      outcome === 'cancelled' ? 'cancelled' :
      'resolved'
    emitHitlPersist(status, { ...(response ?? {}), outcome })
  }

  // （P0 修复）：crash mid-await 时，主循环整轮 co-locate persist
  // 不会被 emit 出去 → assistant tool_use 永不落库 → restorer inject 的
  // tool_result 变成 orphan。挂起前先补一次 partial persist（同 messageId
  // upsert），让 crash 后 `restoreMessages` 能带出 tool_use，restorer 走真实
  // pairing——见 `hitl-persist.ts` 契约。
  persistCurrentAssistantForHitlResume({
    emitStreamEvent: emitter,
    messages: context.messages,
    assistantMessageId: context.assistantMessageId,
    agentRunId: context.agentRunId,
    subagentRunId: context.assistantSubagentRunId,
  })

  // emit 卡片事件（wire 协议不动）+ 挂起等人 + 超时——收进 interrupt 单原语。
  // interrupt.interrupt 同步 emit requestEvent 后才 await；先启动它（卡片事件先出），
  // 再补 pending transcript persist——保证 *_required 仍是首个 emit（消费端 / 测试口径）。
  const outcomePromise = interrupt.interrupt({
    kind: toolName,
    interruptId: requestId,
    requestEvent: new AskRequiredEvent(eventType, requestPayload).toStreamEvent(),
    timeoutMs: ASK_USER_TIMEOUT_MS,
  })
  // pending transcript：与 *_required 卡片对称落库（重载 / 换端可恢复面板）。
  emitHitlPersist('pending')
  const outcome = await outcomePromise

  if (outcome.status === 'resolved') {
    const responseRecord = asRecord(outcome.value)
    // renderer 显式 dismiss 走 `{ cancelled: true, reason?: string }` 响应体
    // （cancel-hitl IPC）：ask 面板已被关，走 cancelled 终态收口——区别于
    // skipped（「用户略过」）与 expired（「超时无人应答」）。
    if (responseRecord.cancelled === true) {
      emitResolved('cancelled')
      const reason = typeof responseRecord.reason === 'string' && responseRecord.reason.trim()
        ? responseRecord.reason.trim()
        : 'User cancelled the request from the client UI.'
      return { content: `User has dismissed the ${toolName} request without answering. Reason: ${reason}. Continue with the best available information; do not re-open the same request.` }
    }
    const answerText = formatAnswered(outcome.value)
    if (sessionId) recordAnswer(sessionId, dedupHash, answerText, Date.now())
    emitResolved(responseRecord.skipped === true ? 'skipped' : 'answered', responseRecord)
    return { content: answerText }
  }
  // 超时 / waiter 异常 → 交互无答案终结；同样发终态让面板收敛，避免超时后
  // 卡片一直挂着（与跳过同源隐患）。
  emitResolved('expired')
  return jsonError(outcome.message, {
    error_kind: REQUEST_TIMEOUT,
    status: 'timeout',
    hint: 'Summarize what you still need and continue with the best available information; ask the user directly in plain text only if the answer is still essential.',
  })
}

function createAskUserTool(deps: AskToolsDeps): Tool {
  return {
    name: 'ask_user',
    policyActionKind: 'object_read',
    isReadOnly: true,
    isConcurrencySafe: () => false,
    description: ASK_USER_DESCRIPTION,
    inputSchema: askUserInputSchema,
    executionTimeoutMs: ASK_USER_TIMEOUT_MS + ASK_TOOL_EXECUTION_GRACE_MS,
    execute: async (input, context) => {
      const params = input as Record<string, unknown>
      const title = nonEmpty(params.title)
      const { questions, error } = normalizeQuestions(params.questions)
      if (error) return error
      const payload: { title?: string; questions: NormalizedQuestion[] } = {
        title: title || undefined,
        questions: questions!,
      }
      const contextHint = detectLoginWallHintFromMessages(context.messages)
      return emitAndWait({
        toolName: 'ask_user',
        eventType: StreamEvents.ASK_USER_REQUIRED,
        emitPayload: {
          tool_name: 'ask_user',
          interaction_type: 'ask_user',
          blocking_policy: 'hard',
          intent: 'choose',
          form_mode: 'questions',
          ...(title ? { title } : {}),
          questions: questions!,
          ...(contextHint ? { context_hint: contextHint } : {}),
        },
        hashKey: buildQuestionsHash(questions!),
        formatAnswered: (response) => formatAnsweredResult(payload, response),
        deps,
        context,
      })
    },
  }
}

function createAskFormTool(deps: AskToolsDeps): Tool {
  return {
    name: 'ask_form',
    policyActionKind: 'object_read',
    isReadOnly: true,
    isConcurrencySafe: () => false,
    description: ASK_FORM_DESCRIPTION,
    inputSchema: askFormInputSchema,
    executionTimeoutMs: ASK_USER_TIMEOUT_MS + ASK_TOOL_EXECUTION_GRACE_MS,
    execute: async (input, context) => {
      const params = input as Record<string, unknown>
      const titleError = validateTitle('ask_form', params.title)
      if (titleError) return titleError
      const enrichedFields = enrichAskFormFields(params.fields)
      const fieldsError = validateFields('ask_form', enrichedFields)
      if (fieldsError) return fieldsError
      const title = nonEmpty(params.title)
      const fieldKeys = Array.isArray(enrichedFields)
        ? (enrichedFields as Array<Record<string, unknown>>).map(f => nonEmpty(f.key)).join('|')
        : ''
      return emitAndWait({
        toolName: 'ask_form',
        eventType: StreamEvents.ASK_FORM_REQUIRED,
        emitPayload: {
          tool_name: 'ask_form',
          interaction_type: 'ask_user',
          blocking_policy: 'hard',
          intent: 'collect',
          form_mode: 'fields',
          title,
          fields: enrichedFields,
          ...(params.addons !== undefined ? { addons: params.addons } : {}),
          ...(params.submit_label !== undefined ? { submit_label: params.submit_label } : {}),
        },
        hashKey: `${title}|${fieldKeys}`,
        formatAnswered: (response) =>
          formatAskFormResult(
            { title, fields: enrichedFields, addons: params.addons },
            response,
          ),
        deps,
        context,
      })
    },
  }
}
